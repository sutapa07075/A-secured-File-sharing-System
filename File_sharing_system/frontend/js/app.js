// Defensive reset: force any leftover UI state closed on every load, including
// bfcache restores (e.g. browser back/forward), which can otherwise resurrect
// a modal or progress bar that was left open in a previous DOM snapshot.
window.addEventListener('pageshow', () => {
  const modal = document.getElementById('shareModal');
  if (modal) modal.hidden = true;
  const progress = document.getElementById('uploadProgress');
  if (progress) progress.hidden = true;
});

const API_BASE = window.location.origin.replace(/:\d+$/, ':4000'); // adjust if API is on a different host

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...opts
  });
  if (res.status === 401 && path !== '/api/auth/refresh') {
    const refreshed = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) return api(path, opts); // retry once after refresh
    window.location.href = '/index.html';
    throw new Error('Not authenticated');
  }
  return res;
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

// ---------------- Dashboard logic ----------------
if (document.getElementById('docList')) {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const docList = document.getElementById('docList');
  const emptyState = document.getElementById('emptyState');
  const progressRow = document.getElementById('uploadProgress');
  const progressBar = document.getElementById('progressBar');
  const progressLabel = document.getElementById('progressLabel');

  let activeShareDocId = null;

  async function loadDocuments() {
    const res = await api('/api/documents');
    if (!res.ok) return;
    const { documents } = await res.json();
    docList.innerHTML = '';
    emptyState.hidden = documents.length > 0;
    documents.forEach((doc) => docList.appendChild(renderDocRow(doc)));
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
        <button class="btn-ghost small" data-action="view">View</button>
        <button class="btn-ghost small" data-action="download">Download</button>
        ${doc.isOwner ? '<button class="btn-ghost small" data-action="share">Share</button>' : ''}
        ${doc.isOwner ? '<button class="btn-ghost small" data-action="delete">Delete</button>' : ''}
      </div>
    `;
    row.querySelector('[data-action="view"]').addEventListener('click', () => {
      window.open(`reader.html?doc=${doc.id}`, '_blank');
    });
    row.querySelector('[data-action="download"]').addEventListener('click', () => {
      window.location.href = `${API_BASE}/api/documents/${doc.id}/download`;
    });
    const shareBtn = row.querySelector('[data-action="share"]');
    if (shareBtn) shareBtn.addEventListener('click', () => openShareModal(doc));
    const delBtn = row.querySelector('[data-action="delete"]');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${doc.filename}"? This cannot be undone.`)) return;
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      loadDocuments();
    });
    return row;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Files at or above this size use the chunked multipart flow so the browser
  // never has to hold the whole encrypted body in memory at once, and a dropped
  // connection only loses the in-flight chunk, not the whole upload.
  const CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20MB
  const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — must be >= B2's 5MB multipart minimum

  function setProgress(pct) {
    progressBar.style.width = pct + '%';
    progressLabel.textContent = pct + '%';
  }

  async function uploadFile(file) {
    const isPublic = document.getElementById('isPublicCheckbox').checked;
    const description = document.getElementById('descriptionInput').value.trim();
    progressRow.hidden = false;
    setProgress(0);
    try {
      if (file.size >= CHUNK_THRESHOLD_BYTES) {
        await uploadFileChunked(file, { isPublic, description });
      } else {
        await uploadFileSingleShot(file, { isPublic, description });
      }
    } finally {
      progressRow.hidden = true;
    }
    document.getElementById('isPublicCheckbox').checked = false;
    document.getElementById('descriptionInput').hidden = true;
    document.getElementById('descriptionInput').value = '';
    loadDocuments();
  }

  function uploadFileSingleShot(file, { isPublic, description }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/documents/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-Is-Public', isPublic ? 'true' : 'false');
      if (description) xhr.setRequestHeader('X-Description', encodeURIComponent(description));
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText)));
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(file);
    });
  }

  async function uploadFileChunked(file, { isPublic, description }) {
    const initRes = await api('/api/documents/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream' })
    });
    if (!initRes.ok) throw new Error('Could not start upload');
    const { docId, chunkSizeBytes } = await initRes.json();
    const chunkSize = chunkSizeBytes || CHUNK_SIZE_BYTES;

    try {
      let offset = 0;
      while (offset < file.size) {
        const slice = file.slice(offset, offset + chunkSize);
        const buf = await slice.arrayBuffer();

        const chunkRes = await api(`/api/documents/upload/${docId}/chunk`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf
        });
        if (!chunkRes.ok) throw new Error('Chunk upload failed');

        offset += chunkSize;
        setProgress(Math.min(100, Math.round((offset / file.size) * 100)));
      }

      const completeRes = await api(`/api/documents/upload/${docId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', isPublic, description: description || null })
      });
      if (!completeRes.ok) throw new Error('Could not finalize upload');
    } catch (err) {
      api(`/api/documents/upload/${docId}/abort`, { method: 'POST' }).catch(() => {});
      throw err;
    }
  }

  document.getElementById('isPublicCheckbox').addEventListener('change', (e) => {
    document.getElementById('descriptionInput').hidden = !e.target.checked;
  });

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]).catch((e) => alert('Upload failed: ' + e.message));
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
  );
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file).catch((err) => alert('Upload failed: ' + err.message));
  });

  document.getElementById('refreshBtn').addEventListener('click', loadDocuments);
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/index.html';
  });

  // ---- Share modal ----
  const shareModal = document.getElementById('shareModal');
  let confirmedGranteeEmail = null;

  function openShareModal(doc) {
    activeShareDocId = doc.id;
    document.getElementById('shareDocName').textContent = doc.filename;
    document.getElementById('linkResult').hidden = true;
    document.getElementById('granteeEmail').value = '';
    document.getElementById('granteeFound').hidden = true;
    document.getElementById('granteeNotFound').hidden = true;
    document.getElementById('inviteBtn').disabled = true;
    confirmedGranteeEmail = null;
    shareModal.hidden = false;
  }
  document.getElementById('closeShareModal').addEventListener('click', () => (shareModal.hidden = true));

  document.getElementById('createLinkBtn').addEventListener('click', async () => {
    const role = document.getElementById('linkRole').value;
    const res = await api(`/api/documents/${activeShareDocId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'link', role })
    });
    if (!res.ok) return alert('Could not create link');
    const { shareUrl } = await res.json();
    // shareUrl is built server-side and already includes the document id + code.
    document.getElementById('linkResultInput').value = shareUrl;
    document.getElementById('linkResult').hidden = false;
  });

  document.getElementById('copyLinkBtn').addEventListener('click', () => {
    document.getElementById('linkResultInput').select();
    document.execCommand('copy');
  });

  // Verify the email belongs to a real registered user before allowing an
  // invite, and show exactly who will be invited so there's no ambiguity.
  document.getElementById('checkEmailBtn').addEventListener('click', async () => {
    const email = document.getElementById('granteeEmail').value.trim();
    const foundBox = document.getElementById('granteeFound');
    const notFoundBox = document.getElementById('granteeNotFound');
    const inviteBtn = document.getElementById('inviteBtn');
    foundBox.hidden = true;
    notFoundBox.hidden = true;
    inviteBtn.disabled = true;
    confirmedGranteeEmail = null;
    if (!email) return;

    const res = await api(`/api/documents/users/lookup?email=${encodeURIComponent(email)}`);
    if (res.status === 404) {
      notFoundBox.textContent = 'No Vault account found for that email. They need to sign in with Google once before you can share with them.';
      notFoundBox.hidden = false;
      return;
    }
    if (!res.ok) {
      notFoundBox.textContent = 'Could not check that email right now — try again.';
      notFoundBox.hidden = false;
      return;
    }
    const { email: matchedEmail, displayName, avatarUrl } = await res.json();
    document.getElementById('granteeAvatar').src = avatarUrl || '';
    document.getElementById('granteeName').textContent = `${displayName || matchedEmail} (${matchedEmail})`;
    foundBox.hidden = false;
    confirmedGranteeEmail = matchedEmail;
    inviteBtn.disabled = false;
  });

  document.getElementById('granteeEmail').addEventListener('input', () => {
    // Any edit to the email invalidates a previous confirmation, so you can
    // never invite someone you didn't actually verify.
    confirmedGranteeEmail = null;
    document.getElementById('inviteBtn').disabled = true;
    document.getElementById('granteeFound').hidden = true;
    document.getElementById('granteeNotFound').hidden = true;
  });

  document.getElementById('inviteBtn').addEventListener('click', async () => {
    if (!confirmedGranteeEmail) return;
    const role = document.getElementById('granteeRole').value;
    const res = await api(`/api/documents/${activeShareDocId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'restricted', granteeEmail: confirmedGranteeEmail, role })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return alert(body.error || 'Could not share with that person');
    }
    alert(`Shared with ${confirmedGranteeEmail}`);
    document.getElementById('granteeEmail').value = '';
    document.getElementById('granteeFound').hidden = true;
    document.getElementById('inviteBtn').disabled = true;
    confirmedGranteeEmail = null;
  });

  loadDocuments();
}
