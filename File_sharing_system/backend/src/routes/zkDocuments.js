const express = require('express');
const crypto = require('crypto');
const { pool, withUserContext } = require('../db/pool');
const storage = require('../services/storage');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const { logAction } = require('../utils/audit');

const router = express.Router();

// The body here is already ciphertext produced by WebCrypto in the browser —
// the server just relays bytes to B2. It never sees plaintext or a usable key.
const rawCiphertext = express.raw({ type: '*/*', limit: '100mb' });

function b64(buf) { return Buffer.from(buf, 'base64'); }

// ---------------------------------------------------------------------------
// Upload: client has already encrypted the file (and filename) with a random
// per-file key generated in the browser, and wrapped that key for the owner
// with the owner's own RSA-OAEP public key. Nothing plaintext or unwrappable
// reaches this route.
// ---------------------------------------------------------------------------
router.post('/documents', requireAuth, uploadLimiter, rawCiphertext, async (req, res) => {
  const filenameCiphertext = req.headers['x-filename-ciphertext'];
  const filenameIv = req.headers['x-filename-iv'];
  const fileIv = req.headers['x-file-iv'];
  const wrappedKeyOwner = req.headers['x-wrapped-key-owner'];
  const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';

  if (!filenameCiphertext || !filenameIv || !fileIv || !wrappedKeyOwner) {
    return res.status(400).json({ error: 'Missing required encryption headers' });
  }

  const docId = crypto.randomUUID();
  const b2Key = `zk-documents/${req.user.id}/${docId}`;

  try {
    await storage.uploadObject(b2Key, req.body, 'application/octet-stream');

    await withUserContext({ userId: req.user.id, email: req.user.email }, async (client) => {
      await client.query(
        `INSERT INTO zk_documents (id, owner_id, filename_ciphertext, filename_iv, mime_type, size_bytes, b2_key, file_iv)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [docId, req.user.id, b64(filenameCiphertext), b64(filenameIv), mimeType, req.body.length, b2Key, b64(fileIv)]
      );
      await client.query(
        `INSERT INTO zk_document_keys (document_id, subject_type, user_id, wrapped_key, role)
         VALUES ($1,'user',$2,$3,'edit')`,
        [docId, req.user.id, b64(wrappedKeyOwner)]
      );
    });

    await logAction({ actorId: req.user.id, actorEmail: req.user.email, action: 'zk_upload', documentId: docId, ip: req.ip, userAgent: req.headers['user-agent'] });
    res.status(201).json({ id: docId });
  } catch (err) {
    console.error('ZK upload failed', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---------------------------------------------------------------------------
// List: return ciphertext filenames + this user's wrapped key for each doc.
// The browser unwraps the key with its own private key, then decrypts the
// filename locally. The server never learns either.
// ---------------------------------------------------------------------------
router.get('/documents', requireAuth, async (req, res) => {
  const { rows } = await withUserContext({ userId: req.user.id, email: req.user.email }, (client) =>
    client.query(
      `SELECT d.id, d.filename_ciphertext, d.filename_iv, d.mime_type, d.size_bytes, d.created_at, d.owner_id,
              k.wrapped_key
       FROM zk_documents d
       JOIN zk_document_keys k ON k.document_id = d.id AND k.user_id = $1
       WHERE d.deleted_at IS NULL
       ORDER BY d.created_at DESC`,
      [req.user.id]
    )
  );

  res.json({
    documents: rows.map((d) => ({
      id: d.id,
      filenameCiphertext: d.filename_ciphertext.toString('base64'),
      filenameIv: d.filename_iv.toString('base64'),
      mimeType: d.mime_type,
      sizeBytes: d.size_bytes,
      createdAt: d.created_at,
      isOwner: d.owner_id === req.user.id,
      wrappedKey: d.wrapped_key.toString('base64')
    }))
  });
});

// ---------------------------------------------------------------------------
// Fetch the wrapped key for a document via a share-link code (anonymous).
// The actual unlocking key lives only in the link's URL fragment, which the
// browser never sends here — so this response alone is still useless to
// anyone who doesn't have the fragment.
// ---------------------------------------------------------------------------
router.get('/documents/:id/link-key', async (req, res) => {
  const { id } = req.params;
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code query param required' });

  const { rows } = await pool.query(
    `SELECT k.wrapped_key, d.filename_ciphertext, d.filename_iv, d.mime_type, d.file_iv
     FROM zk_document_keys k JOIN zk_documents d ON d.id = k.document_id
     WHERE k.document_id = $1 AND k.share_code = $2 AND d.deleted_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [id, code]
  );
  if (rows.length === 0) return res.status(403).json({ error: 'Invalid or expired link' });

  const row = rows[0];
  res.json({
    wrappedKey: row.wrapped_key.toString('base64'),
    filenameCiphertext: row.filename_ciphertext.toString('base64'),
    filenameIv: row.filename_iv.toString('base64'),
    fileIv: row.file_iv.toString('base64'),
    mimeType: row.mime_type
  });
});

// ---------------------------------------------------------------------------
// Download: pure ciphertext relay. Decryption happens entirely client-side.
// ---------------------------------------------------------------------------
router.get('/documents/:id/download', optionalAuth, async (req, res) => {
  const { id } = req.params;
  const { code } = req.query;

  const doc = await resolveZkAccess({ docId: id, user: req.user, shareCode: code });
  if (!doc) return res.status(403).json({ error: 'Access denied' });

  try {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-File-Iv', doc.file_iv.toString('base64'));
    const cipherStream = storage.getObjectStream(doc.b2_key);
    cipherStream.on('error', (err) => { console.error('B2 stream error', err); res.destroy(err); });

    await logAction({ actorId: req.user?.id, actorEmail: req.user?.email, action: 'zk_download', documentId: id, ip: req.ip, userAgent: req.headers['user-agent'] });
    cipherStream.pipe(res);
  } catch (err) {
    console.error('ZK download failed', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ---------------------------------------------------------------------------
// Share with a named user: client has already unwrapped the file key locally
// (with the owner's private key) and re-wrapped it with the grantee's public
// key (fetched via GET /api/zk/keys/lookup). This route just stores the result.
// ---------------------------------------------------------------------------
router.post('/documents/:id/share/user', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { granteeUserId, wrappedKey, role = 'view' } = req.body;
  if (!granteeUserId || !wrappedKey) return res.status(400).json({ error: 'granteeUserId and wrappedKey required' });

  const owns = await pool.query(`SELECT id FROM zk_documents WHERE id = $1 AND owner_id = $2`, [id, req.user.id]);
  if (owns.rows.length === 0) return res.status(403).json({ error: 'Only the owner can share this document' });

  await pool.query(
    `INSERT INTO zk_document_keys (document_id, subject_type, user_id, wrapped_key, role)
     VALUES ($1,'user',$2,$3,$4)
     ON CONFLICT (document_id, user_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, role = EXCLUDED.role`,
    [id, granteeUserId, b64(wrappedKey), role]
  );

  await logAction({ actorId: req.user.id, actorEmail: req.user.email, action: 'zk_share_user', documentId: id, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Share via link: client generates a random link key locally, wraps the file
// key with it (AES-GCM), and sends only the wrapped result + a share code.
// The link key itself is put in the URL fragment by the client and never
// transmitted to the server.
// ---------------------------------------------------------------------------
router.post('/documents/:id/share/link', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { wrappedKey, role = 'view', expiresInHours } = req.body;
  if (!wrappedKey) return res.status(400).json({ error: 'wrappedKey required' });

  const owns = await pool.query(`SELECT id FROM zk_documents WHERE id = $1 AND owner_id = $2`, [id, req.user.id]);
  if (owns.rows.length === 0) return res.status(403).json({ error: 'Only the owner can share this document' });

  const shareCode = crypto.randomBytes(8).toString('base64url');
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000) : null;

  await pool.query(
    `INSERT INTO zk_document_keys (document_id, subject_type, share_code, wrapped_key, role, expires_at)
     VALUES ($1,'link',$2,$3,$4,$5)`,
    [id, shareCode, b64(wrappedKey), role, expiresAt]
  );

  await logAction({ actorId: req.user.id, actorEmail: req.user.email, action: 'zk_share_link', documentId: id, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ shareCode }); // caller appends #key=<linkKey> client-side
});

router.delete('/documents/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const doc = await pool.query(`SELECT b2_key FROM zk_documents WHERE id = $1 AND owner_id = $2`, [id, req.user.id]);
  if (doc.rows.length === 0) return res.status(403).json({ error: 'Only the owner can delete this document' });

  // Crypto-shred: drop every wrapped key copy first, so the ciphertext is
  // unrecoverable even before the B2 object is physically removed.
  await pool.query(`DELETE FROM zk_document_keys WHERE document_id = $1`, [id]);
  await pool.query(`UPDATE zk_documents SET deleted_at = now() WHERE id = $1`, [id]);
  storage.deleteObject(doc.rows[0].b2_key).catch((err) => console.error('B2 cleanup failed', err));

  await logAction({ actorId: req.user.id, actorEmail: req.user.email, action: 'zk_delete', documentId: id, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ ok: true });
});

async function resolveZkAccess({ docId, user, shareCode }) {
  const { rows } = await pool.query(`SELECT * FROM zk_documents WHERE id = $1 AND deleted_at IS NULL`, [docId]);
  const doc = rows[0];
  if (!doc) return null;
  if (user && doc.owner_id === user.id) return doc;

  if (shareCode) {
    const perm = await pool.query(
      `SELECT id FROM zk_document_keys WHERE document_id = $1 AND share_code = $2 AND (expires_at IS NULL OR expires_at > now())`,
      [docId, shareCode]
    );
    if (perm.rows.length > 0) return doc;
  }
  if (user) {
    const perm = await pool.query(`SELECT id FROM zk_document_keys WHERE document_id = $1 AND user_id = $2`, [docId, user.id]);
    if (perm.rows.length > 0) return doc;
  }
  return null;
}

module.exports = router;
