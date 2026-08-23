const express = require('express');
const crypto = require('crypto');
const { pool, withUserContext } = require('../db/pool');
const storage = require('../services/storage');
const cryptoSvc = require('../services/crypto');
const redis = require('../services/redis');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const { logAction } = require('../utils/audit');
const uploadSessions = require('../services/uploadSessions');

const router = express.Router();

// Chunks arrive as raw bodies, not JSON — 12MB cap gives headroom over the
// frontend's 8MB chunk size for encryption overhead.
const rawChunk = express.raw({ type: '*/*', limit: '12mb' });

// B2's multipart API requires every part except the last to be >= 5MB.
const MIN_PART_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Upload: stream the request body straight through encryption into B2.
// Nothing plaintext ever touches disk on the server.
// ---------------------------------------------------------------------------
router.post('/upload', requireAuth, uploadLimiter, async (req, res) => {
  const filename = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'untitled';
  const mimeType = req.headers['content-type'] || 'application/octet-stream';
  const docId = crypto.randomUUID();
  const b2Key = `documents/${req.user.id}/${docId}`;

  try {
    const dek = cryptoSvc.generateDek();
    const encryptStream = cryptoSvc.createEncryptStream(dek);

    // Pipe: incoming request -> AES-256-GCM encrypt -> Backblaze B2
    req.pipe(encryptStream);
    await storage.uploadObject(b2Key, encryptStream, 'application/octet-stream');

    const authTag = encryptStream.getAuthTag();
    const { wrappedDek, keyId } = cryptoSvc.wrapDek(dek);

    // Encrypt the filename too (field-level encryption) using the same per-file DEK
    const nameEnc = cryptoSvc.encryptField(filename, dek);

    await withUserContext({ userId: req.user.id, email: req.user.email }, (client) =>
      client.query(
        `INSERT INTO documents
          (id, owner_id, filename_encrypted, filename_iv, filename_auth_tag,
           mime_type, size_bytes, b2_key, wrapped_dek, dek_iv, file_iv, file_auth_tag, kms_key_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          docId, req.user.id,
          nameEnc.ciphertext, nameEnc.iv, nameEnc.authTag,
          mimeType, req.headers['content-length'] || null,
          b2Key, wrappedDek, Buffer.alloc(0), encryptStream.iv, authTag, keyId
        ]
      )
    );

    await logAction({
      actorId: req.user.id, actorEmail: req.user.email, action: 'upload',
      documentId: docId, ip: req.ip, userAgent: req.headers['user-agent']
    });

    res.status(201).json({ id: docId, filename });
  } catch (err) {
    console.error('Upload failed', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---------------------------------------------------------------------------
// Chunked upload — for large files. Flow:
//   1. POST /upload/init      -> creates the doc id, B2 multipart upload, and an
//                                 in-memory encryption session (see uploadSessions.js)
//   2. PUT  /upload/:id/chunk -> client sends chunks IN ORDER; server encrypts each
//                                 with the running AES-256-GCM cipher and forwards it
//                                 to B2 as a multipart "part"
//   3. POST /upload/:id/complete -> finalizes the B2 multipart upload, captures the
//                                 GCM auth tag, wraps the DEK, writes the DB row
// ---------------------------------------------------------------------------
router.post('/upload/init', requireAuth, uploadLimiter, async (req, res) => {
  const { filename, mimeType } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  const docId = crypto.randomUUID();
  const b2Key = `documents/${req.user.id}/${docId}`;

  try {
    const dek = cryptoSvc.generateDek();
    const iv = crypto.randomBytes(12);
    const uploadId = await storage.createMultipartUpload(b2Key, mimeType || 'application/octet-stream');

    uploadSessions.createSession({ docId, dek, iv, uploadId, b2Key });

    res.status(201).json({ docId, chunkSizeBytes: MIN_PART_BYTES });
  } catch (err) {
    console.error('Chunked upload init failed', err);
    res.status(500).json({ error: 'Could not start upload' });
  }
});

router.put('/upload/:docId/chunk', requireAuth, uploadLimiter, rawChunk, async (req, res) => {
  const { docId } = req.params;
  const session = uploadSessions.getSession(docId);
  if (!session) return res.status(404).json({ error: 'Upload session not found or expired' });

  try {
    const encryptedChunk = session.cipher.update(req.body);
    const partNumber = session.nextPartNumber++;
    const { ETag } = await storage.uploadPart(session.b2Key, session.uploadId, partNumber, encryptedChunk);

    session.parts.push({ ETag, PartNumber: partNumber });
    session.bytesReceived += req.body.length;

    res.json({ partNumber, bytesReceived: session.bytesReceived });
  } catch (err) {
    console.error('Chunk upload failed', err);
    res.status(500).json({ error: 'Chunk upload failed' });
  }
});

router.post('/upload/:docId/complete', requireAuth, uploadLimiter, async (req, res) => {
  const { docId } = req.params;
  const { filename, mimeType } = req.body;
  const session = uploadSessions.getSession(docId);
  if (!session) return res.status(404).json({ error: 'Upload session not found or expired' });

  try {
    // flush any remaining ciphertext out of the GCM cipher and finalize the auth tag
    const finalChunk = session.cipher.final();
    if (finalChunk.length > 0) {
      const partNumber = session.nextPartNumber++;
      const { ETag } = await storage.uploadPart(session.b2Key, session.uploadId, partNumber, finalChunk);
      session.parts.push({ ETag, PartNumber: partNumber });
    }
    const authTag = session.cipher.getAuthTag();

    await storage.completeMultipartUpload(session.b2Key, session.uploadId, session.parts);

    const { wrappedDek, keyId } = cryptoSvc.wrapDek(session.dek);
    const nameEnc = cryptoSvc.encryptField(filename || 'untitled', session.dek);

    await withUserContext({ userId: req.user.id, email: req.user.email }, (client) =>
      client.query(
        `INSERT INTO documents
          (id, owner_id, filename_encrypted, filename_iv, filename_auth_tag,
           mime_type, size_bytes, b2_key, wrapped_dek, dek_iv, file_iv, file_auth_tag, kms_key_id, chunk_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          docId, req.user.id,
          nameEnc.ciphertext, nameEnc.iv, nameEnc.authTag,
          mimeType || 'application/octet-stream', session.bytesReceived,
          session.b2Key, wrappedDek, Buffer.alloc(0), session.iv, authTag, keyId,
          session.parts.length
        ]
      )
    );

    uploadSessions.deleteSession(docId);

    await logAction({
      actorId: req.user.id, actorEmail: req.user.email, action: 'upload',
      documentId: docId, ip: req.ip, userAgent: req.headers['user-agent'],
      metadata: { chunked: true, parts: session.parts.length }
    });

    res.status(201).json({ id: docId, filename: filename || 'untitled' });
  } catch (err) {
    console.error('Complete upload failed', err);
    // best-effort cleanup so we don't leave an orphaned multipart upload in B2
    storage.abortMultipartUpload(session.b2Key, session.uploadId).catch(() => {});
    uploadSessions.deleteSession(docId);
    res.status(500).json({ error: 'Could not finalize upload' });
  }
});

router.post('/upload/:docId/abort', requireAuth, async (req, res) => {
  const { docId } = req.params;
  const session = uploadSessions.getSession(docId);
  if (session) {
    await storage.abortMultipartUpload(session.b2Key, session.uploadId).catch(() => {});
    uploadSessions.deleteSession(docId);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// List documents the user owns or has been granted access to (RLS enforces this)
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  const rows = await withUserContext({ userId: req.user.id, email: req.user.email }, (client) =>
    client.query(
      `SELECT id, mime_type, size_bytes, created_at,
              filename_encrypted, filename_iv, filename_auth_tag, wrapped_dek, dek_iv, file_iv, file_auth_tag, kms_key_id, owner_id
       FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC`
    )
  );

  const docs = rows.rows.map((d) => {
    try {
      const dek = cryptoSvc.unwrapDek(d.wrapped_dek, d.kms_key_id);
      const filename = cryptoSvc.decryptField(d.filename_encrypted, d.filename_iv, d.filename_auth_tag, dek);
      return {
        id: d.id, filename, mimeType: d.mime_type, sizeBytes: d.size_bytes,
        createdAt: d.created_at, isOwner: d.owner_id === req.user.id
      };
    } catch {
      return { id: d.id, filename: '(decryption error)', mimeType: d.mime_type, createdAt: d.created_at };
    }
  });

  res.json({ documents: docs });
});

// ---------------------------------------------------------------------------
// Download: stream ciphertext out of B2, decrypt on the fly, verify GCM auth tag.
// ---------------------------------------------------------------------------
router.get('/:id/download', optionalAuth, async (req, res) => {
  const { id } = req.params;
  const { code } = req.query; // share-link code for anonymous/link access

  const doc = await resolveAccess({ docId: id, user: req.user, shareCode: code });
  if (!doc) return res.status(403).json({ error: 'Access denied' });

  try {
    const dek = cryptoSvc.unwrapDek(doc.wrapped_dek, doc.kms_key_id);
    const filename = cryptoSvc.decryptField(doc.filename_encrypted, doc.filename_iv, doc.filename_auth_tag, dek);
    const decryptStream = cryptoSvc.createDecryptStream(dek, doc.file_iv, doc.file_auth_tag);

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    const cipherStream = storage.getObjectStream(doc.b2_key);
    cipherStream.on('error', (err) => {
      console.error('B2 stream error', err);
      res.destroy(err);
    });
    decryptStream.on('error', (err) => {
      // GCM auth failure => tampered/corrupted ciphertext, refuse to serve it
      console.error('Decryption/integrity check failed', err.message);
      res.destroy(err);
    });

    await logAction({
      actorId: req.user?.id, actorEmail: req.user?.email, action: 'download',
      documentId: id, ip: req.ip, userAgent: req.headers['user-agent']
    });

    cipherStream.pipe(decryptStream).pipe(res);
  } catch (err) {
    console.error('Download failed', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ---------------------------------------------------------------------------
// Sharing: create a permission grant (link, restricted-by-email, or revoke)
// ---------------------------------------------------------------------------
router.post('/:id/share', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { scope, granteeEmail, role = 'view', expiresInHours } = req.body;

  if (!['restricted', 'link'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be "restricted" or "link"' });
  }

  const owns = await withUserContext({ userId: req.user.id, email: req.user.email }, (client) =>
    client.query(`SELECT id FROM documents WHERE id = $1 AND owner_id = $2`, [id, req.user.id])
  );
  if (owns.rows.length === 0) return res.status(403).json({ error: 'Only the owner can share this document' });

  const shareCode = scope === 'link' ? crypto.randomBytes(8).toString('base64url') : null;
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000) : null;

  const result = await pool.query(
    `INSERT INTO permissions (document_id, scope, grantee_email, role, share_code, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, share_code`,
    [id, scope, scope === 'restricted' ? granteeEmail : null, role, shareCode, expiresAt, req.user.id]
  );

  await logAction({
    actorId: req.user.id, actorEmail: req.user.email, action: 'share',
    documentId: id, ip: req.ip, userAgent: req.headers['user-agent'],
    metadata: { scope, granteeEmail, role }
  });

  const shareUrl = shareCode ? `${process.env.SHARE_LINK_BASE_URL}/${shareCode}` : null;
  res.status(201).json({ permissionId: result.rows[0].id, shareUrl });
});

router.delete('/:id/share/:permissionId', requireAuth, async (req, res) => {
  const { id, permissionId } = req.params;
  const owns = await pool.query(`SELECT id FROM documents WHERE id = $1 AND owner_id = $2`, [id, req.user.id]);
  if (owns.rows.length === 0) return res.status(403).json({ error: 'Only the owner can revoke sharing' });

  await pool.query(`DELETE FROM permissions WHERE id = $1 AND document_id = $2`, [permissionId, id]);
  await logAction({
    actorId: req.user.id, actorEmail: req.user.email, action: 'revoke',
    documentId: id, ip: req.ip, userAgent: req.headers['user-agent']
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Delete: crypto-shred (drop the wrapped DEK) so the B2 ciphertext becomes
// permanently unrecoverable immediately, then clean up the object async.
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const doc = await pool.query(`SELECT b2_key FROM documents WHERE id = $1 AND owner_id = $2`, [id, req.user.id]);
  if (doc.rows.length === 0) return res.status(403).json({ error: 'Only the owner can delete this document' });

  await pool.query(
    `UPDATE documents SET deleted_at = now(), wrapped_dek = '\\x00', file_auth_tag = '\\x00' WHERE id = $1`,
    [id]
  );
  storage.deleteObject(doc.rows[0].b2_key).catch((err) => console.error('B2 cleanup failed', err));

  await logAction({
    actorId: req.user.id, actorEmail: req.user.email, action: 'delete',
    documentId: id, ip: req.ip, userAgent: req.headers['user-agent']
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helper: resolve whether the requester (owner / restricted grantee / link code)
// is allowed to read this document, returning the full row if so.
// ---------------------------------------------------------------------------
async function resolveAccess({ docId, user, shareCode }) {
  const cacheKey = `perm:${docId}:${user?.id || 'anon'}:${shareCode || ''}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached === 'denied') return null;

  const { rows } = await pool.query(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`, [docId]);
  const doc = rows[0];
  if (!doc) return null;

  if (user && doc.owner_id === user.id) return doc;

  if (shareCode) {
    const perm = await pool.query(
      `SELECT * FROM permissions WHERE document_id = $1 AND share_code = $2
       AND (expires_at IS NULL OR expires_at > now())`,
      [docId, shareCode]
    );
    if (perm.rows.length > 0) return doc;
  }

  if (user) {
    const perm = await pool.query(
      `SELECT * FROM permissions WHERE document_id = $1 AND grantee_email = $2
       AND (expires_at IS NULL OR expires_at > now())`,
      [docId, user.email]
    );
    if (perm.rows.length > 0) return doc;
  }

  await redis.set(cacheKey, 'denied', 'EX', 30).catch(() => {});
  return null;
}

module.exports = router;
