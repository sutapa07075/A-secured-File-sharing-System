/**
 * All key generation, wrapping, and encrypt/decrypt happens here, entirely
 * client-side. Nothing in this file ever sends a plaintext key or a passphrase
 * to the server — only ciphertext and wrapped (still-encrypted) keys leave
 * the browser.
 */
const VaultCrypto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function fromB64(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  // ---- Passphrase -> wrapping key (protects the RSA private key at rest) ----
  async function deriveWrappingKey(passphrase, saltBytes) {
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 250000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ---- Per-user RSA-OAEP keypair, used to wrap/unwrap file keys for sharing ----
  async function generateUserKeypair() {
    return crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['wrapKey', 'unwrapKey']
    );
  }

  async function wrapPrivateKeyWithPassphrase(privateKey, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappingKey = await deriveWrappingKey(passphrase, salt);
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    const plaintext = enc.encode(JSON.stringify(jwk));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, plaintext);
    return { wrappedPrivateKey: toB64(ciphertext), iv: toB64(iv), salt: toB64(salt) };
  }

  async function unwrapPrivateKeyWithPassphrase(wrappedPrivateKeyB64, ivB64, saltB64, passphrase) {
    const wrappingKey = await deriveWrappingKey(passphrase, fromB64(saltB64));
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64) }, wrappingKey, fromB64(wrappedPrivateKeyB64)
    );
    const jwk = JSON.parse(dec.decode(plaintext));
    return crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['unwrapKey']);
  }

  async function exportPublicKeyB64(publicKey) {
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);
    return toB64(enc.encode(JSON.stringify(jwk)));
  }
  async function importPublicKeyFromB64(b64) {
    const jwk = JSON.parse(dec.decode(fromB64(b64)));
    return crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['wrapKey']);
  }

  // ---- Per-file symmetric key (the FEK) ----
  async function generateFileKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async function encryptBuffer(fileKey, buffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);
    return { ciphertext, iv: toB64(iv) }; // GCM auth tag is appended to ciphertext automatically
  }

  async function decryptBuffer(fileKey, ciphertext, ivB64) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, fileKey, ciphertext);
  }

  // ---- Wrapping the file key for a named user (RSA-OAEP) ----
  async function wrapFileKeyForUser(fileKey, recipientPublicKey) {
    const wrapped = await crypto.subtle.wrapKey('raw', fileKey, recipientPublicKey, { name: 'RSA-OAEP' });
    return toB64(wrapped);
  }
  async function unwrapFileKeyForUser(wrappedB64, myPrivateKey) {
    return crypto.subtle.unwrapKey(
      'raw', fromB64(wrappedB64), myPrivateKey, { name: 'RSA-OAEP' }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  }

  // ---- Wrapping the file key for a share link (random symmetric key, lives only in the URL fragment) ----
  async function generateLinkKey() {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey']);
    const raw = await crypto.subtle.exportKey('raw', key);
    return { key, rawB64: toB64(raw) };
  }
  async function importLinkKeyFromB64(rawB64) {
    return crypto.subtle.importKey('raw', fromB64(rawB64), { name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey']);
  }
  async function wrapFileKeyForLink(fileKey, linkKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey('raw', fileKey, linkKey, { name: 'AES-GCM', iv });
    // pack iv + wrapped bytes together so the server only needs one field
    const packed = new Uint8Array(iv.length + wrapped.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(wrapped), iv.length);
    return toB64(packed);
  }
  async function unwrapFileKeyForLink(wrappedB64, linkKey) {
    const packed = fromB64(wrappedB64);
    const iv = packed.slice(0, 12);
    const wrapped = packed.slice(12);
    return crypto.subtle.unwrapKey('raw', wrapped, linkKey, { name: 'AES-GCM', iv }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  return {
    toB64, fromB64,
    generateUserKeypair, wrapPrivateKeyWithPassphrase, unwrapPrivateKeyWithPassphrase,
    exportPublicKeyB64, importPublicKeyFromB64,
    generateFileKey, encryptBuffer, decryptBuffer,
    wrapFileKeyForUser, unwrapFileKeyForUser,
    generateLinkKey, importLinkKeyFromB64, wrapFileKeyForLink, unwrapFileKeyForLink
  };
})();
