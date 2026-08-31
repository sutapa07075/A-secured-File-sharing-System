const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

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

// Shared by every auth method (Google, email/password) — sets both cookies
// and records the login, so each flow just needs the resulting user row.
async function completeLogin(res, req, user) {
  const accessToken = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  res.cookie('access_token', accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', refreshToken, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
  await logAction({
    actorId: user.id, actorEmail: user.email, action: 'login',
    ip: req.ip, userAgent: req.headers['user-agent']
  });
}

// ---------------------------------------------------------------------------
// Email + password registration and login
// ---------------------------------------------------------------------------
router.post('/register', authLimiter, async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = await pool.query(`SELECT id, password_hash, google_sub FROM users WHERE email = $1`, [email]);
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.google_sub && !row.password_hash) {
      return res.status(409).json({ error: 'This email already has an account via Google sign-in. Use "Continue with Google" instead.' });
    }
    return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const insert = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, last_login_at)
     VALUES ($1,$2,$3, now()) RETURNING id, email`,
    [email, passwordHash, displayName || email.split('@')[0]]
  );
  const user = insert.rows[0];

  await completeLogin(res, req, user);
  res.status(201).json({ ok: true });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { rows } = await pool.query(`SELECT id, email, password_hash, google_sub FROM users WHERE email = $1`, [email]);
  const row = rows[0];

  // Deliberately vague on which part was wrong — don't help an attacker
  // enumerate which emails have accounts.
  if (!row) return res.status(401).json({ error: 'Incorrect email or password' });

  if (!row.password_hash) {
    return res.status(401).json({
      error: row.google_sub
        ? 'This account uses Google sign-in. Use "Continue with Google" instead.'
        : 'Incorrect email or password'
    });
  }

  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect email or password' });

  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
  await completeLogin(res, req, { id: row.id, email: row.email });
  res.json({ ok: true });
});

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

    await completeLogin(res, req, user);

    // No .html extension — keeps this consistent with every other internal
    // link, so serve's clean-URL redirect never has a chance to fire.
    res.redirect(process.env.FRONTEND_ORIGIN + '/dashboard');
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

// Current user info for UI chrome (sidebar avatar/name/email).
router.get('/me', async (req, res) => {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const { rows } = await pool.query(`SELECT email, display_name, avatar_url FROM users WHERE id = $1`, [payload.sub]);
    if (rows.length === 0) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ email: rows[0].email, displayName: rows[0].display_name, avatarUrl: rows[0].avatar_url });
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

module.exports = router;
