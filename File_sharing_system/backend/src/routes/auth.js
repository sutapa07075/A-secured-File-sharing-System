const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { pool } = require('../db/pool');
const { authLimiter } = require('../middleware/rateLimit');
const { logAction } = require('../utils/audit');

const router = express.Router();

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict'
};

function issueAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_TTL || '15m'
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
    [userId, tokenHash, expiresAt]
  );
  return raw;
}

// Step 1: redirect the browser to Google's consent screen
router.get('/google', (req, res) => {
  const url = googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'consent'
  });
  res.redirect(url);
});

// Step 2: Google redirects back here with a ?code=
router.get('/google/callback', authLimiter, async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing authorization code' });

    const { tokens } = await googleClient.getToken(code);
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload(); // { sub, email, name, picture, ... }

    const upsert = await pool.query(
      `INSERT INTO users (google_sub, email, display_name, avatar_url, last_login_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (google_sub)
       DO UPDATE SET last_login_at = now(), display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url
       RETURNING id, email`,
      [payload.sub, payload.email, payload.name, payload.picture]
    );
    const user = upsert.rows[0];

    const accessToken = issueAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    res.cookie('access_token', accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
    res.cookie('refresh_token', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });

    await logAction({
      actorId: user.id, actorEmail: user.email, action: 'login',
      ip: req.ip, userAgent: req.headers['user-agent']
    });

    res.redirect(process.env.FRONTEND_ORIGIN + '/dashboard.html');
  } catch (err) {
    console.error('OAuth callback failed', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Rotate: exchange a valid refresh token cookie for a new access token (+ new refresh token)
router.post('/refresh', authLimiter, async (req, res) => {
  const raw = req.cookies?.refresh_token;
  if (!raw) return res.status(401).json({ error: 'Missing refresh token' });

  const tokenHash = hashToken(raw);
  const { rows } = await pool.query(
    `SELECT rt.id, rt.user_id, rt.revoked, rt.expires_at, u.email
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record || record.revoked || new Date(record.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Refresh token invalid or expired' });
  }

  // rotate: revoke the old one, issue a new one (limits blast radius of a leaked token)
  await pool.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1`, [record.id]);
  const newRefresh = await issueRefreshToken(record.user_id);
  const accessToken = issueAccessToken({ id: record.user_id, email: record.email });

  res.cookie('access_token', accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', newRefresh, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  const raw = req.cookies?.refresh_token;
  if (raw) {
    await pool.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`, [hashToken(raw)]);
  }
  res.clearCookie('access_token', COOKIE_OPTS);
  res.clearCookie('refresh_token', COOKIE_OPTS);
  res.json({ ok: true });
});

module.exports = router;
