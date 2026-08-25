// Defensive reset: same bfcache guard as app.js — don't let a stale modal or
// progress bar reappear from a cached DOM snapshot.
window.addEventListener('pageshow', () => {
  const modal = document.getElementById('shareModal');
  if (modal) modal.hidden = true;
  const progress = document.getElementById('uploadProgress');
  if (progress) progress.hidden = true;
});

const ZK_API_BASE = window.location.origin.replace(/:\d+$/, ':4000');

async function zkApi(path, opts = {}) {
  const res = await fetch(`${ZK_API_BASE}${path}`, { credentials: 'include', ...opts });
  if (res.status === 401 && path !== '/api/auth/refresh') {
    const refreshed = await fetch(`${ZK_API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) return zkApi(path, opts);
    window.location.href = '/index.html';
    throw new Error('Not authenticated');
  }
  return res;
}

let myPrivateKey = null;
let myPublicKeyB64 = null;

const unlockCard = document.getElementById('unlockCard');
const mainArea = document.getElementById('mainArea');
const passphraseInput = document.getElementById('passphraseInput');
const unlockBtn = document.getElementById('unlockBtn');
const setupNote = document.getElementById('setupNote');
const unlockHint = document.getElementById('unlockHint');

async function init() {
  const res = await zkApi('/api/zk/keys/me');
  if (res.status === 404) {
    setupNote.hidden = false;
    unlockHint.textContent = 'No vault yet — choose a passphrase to create one.';
  }
  unlockBtn.addEventListener('click', () => (res.status === 404 ? setupVault() : unlockVault(res)));
  passphraseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockBtn.click(); });
}

async function setupVault() {
  const passphrase = passphraseInput.value;
  if (passphrase.length < 8) return alert('Use at least 8 characters for your vault passphrase.');

  const keypair = await VaultCrypto.generateUserKeypair();
  const { wrappedPrivateKey, iv, salt } = await VaultCrypto.wrapPrivateKeyWithPassphrase(keypair.privateKey, passphrase);
  const publicKeyB64 = await VaultCrypto.exportPublicKeyB64(keypair.publicKey);

  const res = await zkApi('/api/zk/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: publicKeyB64, wrappedPrivateKey, iv, salt })
  });
  if (!res.ok) return alert('Could not create your vault. Try again.');

  myPrivateKey = keypair.privateKey;
  myPublicKeyB64 = publicKeyB64;
  enterVault();
}

async function unlockVault(bundleRes) {
  const passphrase = passphraseInput.value;
  if (!passphrase) return;
  try {
    const bundle = await bundleRes.json();
    myPrivateKey = await VaultCrypto.unwrapPrivateKeyWithPassphrase(bundle.wrappedPrivateKey, bundle.iv, bundle.salt, passphrase);
    myPublicKeyB64 = bundle.publicKey;
    enterVault();
  } catch (err) {
    alert('Wrong passphrase, or this vault was created in a different browser.');
  }
}

function enterVault() {
  unlockCard.hidden = true;
  mainArea.hidden = false;
  loadDocuments();
}

// ---------------- Upload ----------------
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const progressRow = document.getElementById('uploadProgress');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');

function setProgress(pct) {
  progressBar.style.width = pct + '%';
  progressLabel.textContent = pct + '%';
}

async function uploadFile(file) {
  progressRow.hidden = false;
  setProgress(10);
  try {
    const fileKey = await VaultCrypto.generateFileKey();
    const fileBuffer = await file.arrayBuffer();
    setProgress(30);

    const { ciphertext: fileCiphertext, iv: fileIv } = await VaultCrypto.encryptBuffer(fileKey, fileBuffer);
    const nameBuffer = new TextEncoder().encode(file.name);
    const { ciphertext: nameCiphertext, iv: nameIv } = await VaultCrypto.encryptBuffer(fileKey, nameBuffer);
    setProgress(55);

    const myPublicKey = await VaultCrypto.importPublicKeyFromB64(myPublicKeyB64);
    const wrappedKeyOwner = await VaultCrypto.wrapFileKeyForUser(fileKey, myPublicKey);
    setProgress(70);

    const res = await zkApi('/api/zk/documents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename-Ciphertext': VaultCrypto.toB64(nameCiphertext),
        'X-Filename-Iv': nameIv,
        'X-File-Iv': fileIv,
        'X-Wrapped-Key-Owner': wrappedKeyOwner,
        'X-Mime-Type': file.type || 'application/octet-stream'
      },
      body: fileCiphertext
    });
    if (!res.ok) throw new Error(await res.text());
    setProgress(100);
  } finally {
    progressRow.hidden = true;
  }
  loadDocuments();
}

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]).catch((e) => alert('Upload failed: ' + e.message));
});
['dragenter', 'dragover'].forEach((evt) => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((evt) => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file).catch((err) => alert('Upload failed: ' + err.message));
});

// ---------------- List + download ----------------
const docList = document.getElementById('docList');
const emptyState = document.getElementById('emptyState');
let activeShareDoc = null;

async function loadDocuments() {
  const res = await zkApi('/api/zk/documents');
  if (!res.ok) return;
  const { documents } = await res.json();
  docList.innerHTML = '';
  emptyState.hidden = documents.length > 0;

  for (const doc of documents) {
    try {
      const fileKey = await VaultCrypto.unwrapFileKeyForUser(doc.wrappedKey, myPrivateKey);
      const nameBuffer = await VaultCrypto.decryptBuffer(fileKey, VaultCrypto.fromB64(doc.filenameCiphertext), doc.filenameIv);
      const filename = new TextDecoder().decode(nameBuffer);
      docList.appendChild(renderDocRow({ ...doc, filename, fileKey }));
    } catch (err) {
      console.error('Could not decrypt document metadata', err);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderDocRow(doc) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  row.innerHTML = `
    <span class="doc-icon">&#128274;</span>
    <div class="doc-meta">
      <div class="doc-name">${escapeHtml(doc.filename)}</div>
      <div class="doc-sub">${formatBytes(doc.sizeBytes)} · ${formatDate(doc.createdAt)}</div>
    </div>
    <div class="doc-actions">
      <button class="btn-ghost small" data-action="download">Download</button>
      ${doc.isOwner ? '<button class="btn-ghost small" data-action="share">Share</button>' : ''}
      ${doc.isOwner ? '<button class="btn-ghost small" data-action="delete">Delete</button>' : ''}
    </div>
  `;
  row.querySelector('[data-action="download"]').addEventListener('click', () => downloadAndDecrypt(doc));
  const shareBtn = row.querySelector('[data-action="share"]');
  if (shareBtn) shareBtn.addEventListener('click', () => openShareModal(doc));
  const delBtn = row.querySelector('[data-action="delete"]');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${doc.filename}"? This cannot be undone.`)) return;
    await zkApi(`/api/zk/documents/${doc.id}`, { method: 'DELETE' });
    loadDocuments();
  });
  return row;
}

async function downloadAndDecrypt(doc) {
  const res = await zkApi(`/api/zk/documents/${doc.id}/download`);
  if (!res.ok) return alert('Download failed');
  const fileIv = res.headers.get('X-File-Iv');
  const ciphertext = await res.arrayBuffer();
  const plaintext = await VaultCrypto.decryptBuffer(doc.fileKey, ciphertext, fileIv);

  const blob = new Blob([plaintext], { type: doc.mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = doc.filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('refreshBtn').addEventListener('click', loadDocuments);
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await zkApi('/api/auth/logout', { method: 'POST' });
  window.location.href = '/index.html';
});

// ---------------- Share modal ----------------
const shareModal = document.getElementById('shareModal');
function openShareModal(doc) {
  activeShareDoc = doc;
  document.getElementById('shareDocName').textContent = doc.filename;
  document.getElementById('linkResult').hidden = true;
  document.getElementById('granteeEmail').value = '';
  shareModal.hidden = false;
}
document.getElementById('closeShareModal').addEventListener('click', () => (shareModal.hidden = true));

document.getElementById('createLinkBtn').addEventListener('click', async () => {
  const role = document.getElementById('linkRole').value;
  const { key: linkKey, rawB64: linkKeyRaw } = await VaultCrypto.generateLinkKey();
  const wrappedKey = await VaultCrypto.wrapFileKeyForLink(activeShareDoc.fileKey, linkKey);

  const res = await zkApi(`/api/zk/documents/${activeShareDoc.id}/share/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wrappedKey, role })
  });
  if (!res.ok) return alert('Could not create link');
  const { shareCode } = await res.json();

  const shareUrl = `${window.location.origin}/zk-share.html?doc=${activeShareDoc.id}&code=${shareCode}#key=${linkKeyRaw}`;
  document.getElementById('linkResultInput').value = shareUrl;
  document.getElementById('linkResult').hidden = false;
});

document.getElementById('copyLinkBtn').addEventListener('click', () => {
  document.getElementById('linkResultInput').select();
  document.execCommand('copy');
});

document.getElementById('inviteBtn').addEventListener('click', async () => {
  const granteeEmail = document.getElementById('granteeEmail').value.trim();
  const role = document.getElementById('granteeRole').value;
  if (!granteeEmail) return;

  const lookupRes = await zkApi(`/api/zk/keys/lookup?email=${encodeURIComponent(granteeEmail)}`);
  if (!lookupRes.ok) return alert((await lookupRes.json()).error || 'Could not find that person');
  const { userId, publicKey } = await lookupRes.json();

  const granteePublicKey = await VaultCrypto.importPublicKeyFromB64(publicKey);
  const wrappedKey = await VaultCrypto.wrapFileKeyForUser(activeShareDoc.fileKey, granteePublicKey);

  const res = await zkApi(`/api/zk/documents/${activeShareDoc.id}/share/user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ granteeUserId: userId, wrappedKey, role })
  });
  if (!res.ok) return alert('Could not share with that person');
  document.getElementById('granteeEmail').value = '';
  alert(`Shared with ${granteeEmail}`);
});

init();
