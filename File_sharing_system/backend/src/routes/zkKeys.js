const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

const router = express.Router();

/**
 * The server only ever stores:
 *  - the user's PUBLIC key (useless to an attacker)
 *  - the user's PRIVATE key, encrypted client-side with a key derived from a
 *    passphrase the server never sees (PBKDF2 happens in the browser)
 * So a full DB leak here yields an encrypted blob an attacker can't open
 * without also guessing the user's passphrase.
 */

// Register (or overwrite, e.g. after rotating) this user's keypair bundle.
router.post('/keys', requireAuth, async (req, res) => {
  const { publicKey, wrappedPrivateKey, iv, salt } = req.body;
  if (!publicKey || !wrappedPrivateKey || !iv || !salt) {
    return res.status(400).json({ error: 'publicKey, wrappedPrivateKey, iv, salt are all required' });
  }

  await pool.query(
    `UPDATE users SET
       public_key = $1,
       wrapped_private_key = $2,
       private_key_iv = $3,
       private_key_salt = $4,
       key_created_at = now()
     WHERE id = $5`,
    [
      Buffer.from(publicKey, 'base64'),
      Buffer.from(wrappedPrivateKey, 'base64'),
      Buffer.from(iv, 'base64'),
      Buffer.from(salt, 'base64'),
      req.user.id
    ]
  );

  await logAction({ actorId: req.user.id, actorEmail: req.user.email, action: 'zk_keys_registered', ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ ok: true });
});

// Fetch my own wrapped bundle, e.g. to unlock the vault on a new device/tab.
router.get('/keys/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT public_key, wrapped_private_key, private_key_iv, private_key_salt, key_created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  const row = rows[0];
  if (!row || !row.wrapped_private_key) return res.status(404).json({ error: 'No keypair registered yet' });

  res.json({
    publicKey: row.public_key.toString('base64'),
    wrappedPrivateKey: row.wrapped_private_key.toString('base64'),
    iv: row.private_key_iv.toString('base64'),
    salt: row.private_key_salt.toString('base64'),
    keyCreatedAt: row.key_created_at
  });
});

// Look up someone else's PUBLIC key so you can share a document with them.
router.get('/keys/lookup', requireAuth, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param required' });

  const { rows } = await pool.query(
    `SELECT id, public_key FROM users WHERE email = $1 AND public_key IS NOT NULL`,
    [email]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'That person has no zero-knowledge keypair yet (they need to open Vault ZK once).' });
  }
  res.json({ userId: rows[0].id, publicKey: rows[0].public_key.toString('base64') });
});

module.exports = router;
