const crypto = require('crypto');
const { Transform } = require('stream');
const kms = require('./kms');

/** Generate a fresh random 256-bit data encryption key for one file. */
function generateDek() {
  return crypto.randomBytes(32);
}

/** Wrap a DEK via KMS before it's ever written to Postgres. */
function wrapDek(dek) {
  return kms.wrapKey(dek); // { wrappedDek, keyId }
}

/** Unwrap a DEK via KMS at download/decrypt time. Never persisted in plaintext. */
function unwrapDek(wrappedDek, keyId) {
  return kms.unwrapKey(wrappedDek, keyId);
}

/**
 * Returns a Transform stream that encrypts data chunks on the fly with AES-256-GCM.
 * Use: fileStream.pipe(encryptStream).pipe(b2UploadStream)
 * After the stream ends, call encryptStream.getAuthTag() and store it — required to decrypt.
 */
function createEncryptStream(dek) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  let authTag = null;

  const transform = new Transform({
    transform(chunk, enc, cb) {
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      this.push(cipher.final());
      authTag = cipher.getAuthTag();
      cb();
    }
  });

  transform.iv = iv;
  transform.getAuthTag = () => authTag;
  return transform;
}

/**
 * Returns a Transform stream that decrypts AES-256-GCM data on the fly.
 * authTag must be known up front (GCM verifies integrity at the very end of the stream).
 */
function createDecryptStream(dek, iv, authTag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(authTag);
  return new Transform({
    transform(chunk, enc, cb) {
      cb(null, decipher.update(chunk));
    },
    flush(cb) {
      try {
        cb(null, decipher.final()); // throws if auth tag doesn't match -> tampering detected
      } catch (err) {
        cb(err);
      }
    }
  });
}

/** Small helper for encrypting short strings (filenames, share emails) with a per-record key. */
function encryptField(plaintext, dek) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decryptField(ciphertext, iv, authTag, dek) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = {
  generateDek,
  wrapDek,
  unwrapDek,
  createEncryptStream,
  createDecryptStream,
  encryptField,
  decryptField
};
