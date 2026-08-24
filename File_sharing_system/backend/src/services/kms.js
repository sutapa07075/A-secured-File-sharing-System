const crypto = require('crypto');

/**
 * KMS abstraction.
 *
 * This local implementation wraps/unwraps per-file DEKs using a master key
 * that lives ONLY in process env (never in Postgres, never in the repo).
 *
 * IN PRODUCTION: replace wrapKey/unwrapKey with real calls to AWS KMS
 * (`@aws-sdk/client-kms` Encrypt/Decrypt) or HashiCorp Vault's transit engine.
 * Nothing else in the codebase needs to change — everything else only talks
 * to this module, never to the master key directly.
 */

const MASTER_KEY = Buffer.from(process.env.KMS_MASTER_KEY, 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('KMS_MASTER_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32');
}

const KEY_ID = 'local-master-v1'; // bump this if you ever rotate the master key

function wrapKey(dek) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // pack iv + authTag + ciphertext together so pool.js schema only needs one BYTEA column
  return {
    wrappedDek: Buffer.concat([iv, authTag, wrapped]),
    keyId: KEY_ID
  };
}

function unwrapKey(wrappedDek, keyId) {
  if (keyId !== KEY_ID) {
    throw new Error(`Unknown KMS key id "${keyId}" — cannot unwrap. Was the master key rotated?`);
  }
  const iv = wrappedDek.subarray(0, 12);
  const authTag = wrappedDek.subarray(12, 28);
  const ciphertext = wrappedDek.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { wrapKey, unwrapKey };
