// Encrypts/decrypts question content at rest using AES-256-GCM.
//
// IMPORTANT — read this if you're evaluating the security model:
// This is server-side encryption at rest, not true end-to-end encryption.
// The server holds ENCRYPTION_KEY (from .env) and CAN decrypt content when
// asked to. What actually keeps the admin from reading questions is that the
// admin-facing routes in this app are written to never call decrypt() and
// never return encrypted blobs to the client. That's an access-control
// guarantee enforced in application code, not a cryptographic guarantee like
// WhatsApp's E2EE (where the server never has a decryption key at all).
//
// If you need real E2EE later: keys would need to be generated per-class on
// the client, encrypted individually for each teacher/student's public key,
// and the server would only ever store/forward ciphertext it cannot open.
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY is missing or not a 64-char hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(keyHex, 'hex');
}

// Encrypts a plaintext string (or JSON-serializable value).
// Returns a single string safe to store in a TEXT column:
//   base64(iv) . base64(authTag) . base64(ciphertext)
function encrypt(value) {
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

// Reverses encrypt(). Returns the original string.
function decrypt(packed) {
  if (!packed) return null;
  const [ivB64, tagB64, dataB64] = packed.split('.');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// Convenience for values that were JSON before encryption (e.g. MCQ options array).
function decryptJSON(packed) {
  const text = decrypt(packed);
  return text === null ? null : JSON.parse(text);
}

module.exports = { encrypt, decrypt, decryptJSON };
