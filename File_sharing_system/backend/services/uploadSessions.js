const crypto = require('crypto');

/**
 * Tracks in-progress chunked uploads: one AES-256-GCM cipher stream per docId,
 * fed sequentially as chunks arrive, with each encrypted chunk immediately
 * shipped to B2 as a multipart "part".
 *
 * LIMITATION: this state lives in process memory, so it only works if the same
 * server instance handles every chunk of a given upload (fine behind a single
 * Node process / sticky sessions). If you scale to multiple API instances behind
 * a load balancer without sticky sessions, move this map into Redis (store cipher
 * state isn't serializable, so in practice that means: either (a) enforce sticky
 * sessions on uploads, or (b) switch to the WebCrypto zero-knowledge variant where
 * the browser encrypts each chunk independently and the server just relays bytes).
 */
const sessions = new Map();

const CHUNK_UPLOAD_TTL_MS = 60 * 60 * 1000; // abandon stale sessions after 1 hour

function createSession({ docId, dek, iv, uploadId, b2Key }) {
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const session = {
    docId,
    dek,
    iv,
    cipher,
    uploadId,
    b2Key,
    nextPartNumber: 1,
    parts: [],
    bytesReceived: 0,
    createdAt: Date.now(),
    authTag: null
  };
  sessions.set(docId, session);
  return session;
}

function getSession(docId) {
  const session = sessions.get(docId);
  if (!session) return null;
  if (Date.now() - session.createdAt > CHUNK_UPLOAD_TTL_MS) {
    sessions.delete(docId);
    return null;
  }
  return session;
}

function deleteSession(docId) {
  sessions.delete(docId);
}

// periodic sweep for abandoned sessions
setInterval(() => {
  const now = Date.now();
  for (const [docId, s] of sessions.entries()) {
    if (now - s.createdAt > CHUNK_UPLOAD_TTL_MS) sessions.delete(docId);
  }
}, 10 * 60 * 1000).unref();

module.exports = { createSession, getSession, deleteSession };
