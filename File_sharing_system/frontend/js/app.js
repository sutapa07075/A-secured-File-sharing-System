// Defensive reset: force any leftover UI state closed on every load, including
// bfcache restores (e.g. browser back/forward), which can otherwise resurrect
// a modal that was left open in a previous DOM snapshot.
window.addEventListener('pageshow', () => {
  const modal = document.getElementById('shareModal');
  if (modal) modal.hidden = true;
});

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const API_BASE = window.location.origin.replace(/:\d+$/, ':4000'); // adjust if API is on a different host

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...opts
  });
  if (res.status === 401 && path !== '/api/auth/refresh') {
    const refreshed = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) return api(path, opts); // retry once after refresh
    window.location.href = '/';
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------- Dashboard logic ----------------
if (document.getElementById('docList')) {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const docList = document.getElementById('docList');
  const emptyState = document.getElementById('emptyState');

  let activeShareDocId = null;

  async function loadDocuments() {
    const res = await api('/api/documents');
    if (!res.ok) return;
    const { documents } = await res.json();
    docList.innerHTML = '';
    emptyState.hidden = documents.length > 0;
    documents.forEach((doc) => docList.appendChild(renderDocCard(doc)));
  }

  function renderDocCard(doc) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = `
      <div class="doc-thumb" data-action="view">
        <span class="doc-thumb-icon">${thumbFallbackIcon(doc.mimeType)}</span>
      </div>
      <div class="doc-card-body">
        <div class="doc-card-name" data-action="view" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</div>
        <div class="doc-card-sub">${formatBytes(doc.sizeBytes)} · ${formatDate(doc.createdAt)}</div>
      </div>
      <div class="doc-card-actions">
        <button data-action="download">Download</button>
        ${doc.isOwner ? '<button data-action="share">Share</button>' : ''}
        ${doc.isOwner ? '<button data-action="delete">Delete</button>' : ''}
      </div>
    `;
    card.querySelectorAll('[data-action="view"]').forEach((el) =>
      el.addEventListener('click', () => window.open(`reader?doc=${doc.id}`, '_blank'))
    );
    card.querySelector('[data-action="download"]').addEventListener('click', () => {
      window.location.href = `${API_BASE}/api/documents/${doc.id}/download`;
    });
    const shareBtn = card.querySelector('[data-action="share"]');
    if (shareBtn) shareBtn.addEventListener('click', () => openShareModal(doc));
    const delBtn = card.querySelector('[data-action="delete"]');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${doc.filename}"? This cannot be undone.`)) return;
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      toast(`Deleted ${doc.filename}`);
      loadDocuments();
    });

    generateThumbnail(doc, card.querySelector('.doc-thumb'));
    return card;
  }

  function thumbFallbackIcon(mimeType = '') {
    if (mimeType === 'application/pdf') return '&#128196;';
    if (mimeType.startsWith('image/')) return '&#128247;';
    if (mimeType.startsWith('video/')) return '&#127909;';
    if (mimeType.startsWith('audio/')) return '&#127925;';
    return '&#128196;';
  }

  // Renders a real thumbnail into the card: images load directly, PDFs get
  // their first page rendered client-side via PDF.js. Everything else keeps
  // the generic icon set above — server-side thumbnail generation for other
  // formats (docx, etc.) is a larger follow-up, not attempted here.
  async function generateThumbnail(doc, thumbEl) {
    if (doc.mimeType && doc.mimeType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = `${API_BASE}/api/documents/${doc.id}/view`;
      img.alt = doc.filename;
      img.loading = 'lazy';
      img.onerror = () => {}; // keep the fallback icon already in place
      thumbEl.innerHTML = '';
      thumbEl.appendChild(img);
      return;
    }

    if (doc.mimeType === 'application/pdf' && window.pdfjsLib) {
      try {
        const res = await api(`/api/documents/${doc.id}/view`);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const scale = 220 / viewport.width; // render at roughly the card's display width
        const scaledViewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;

        thumbEl.innerHTML = '';
        thumbEl.appendChild(canvas);
      } catch (err) {
        console.error('PDF thumbnail render failed for', doc.filename, err);
        // fallback icon stays as-is
      }
    }
  }

  // ---------------- Upload queue (Drive-style, bottom-right panel) ----------------
  const CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20MB — above this, use the chunked upload path
  const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — must be >= B2's 5MB multipart minimum

  const queuePanel = document.getElementById('uploadQueuePanel');
  const queueList = document.getElementById('uqpList');
  const queueTitle = document.getElementById('uqpTitle');
  let queueItems = []; // { id, file, el, fillEl, statusEl, retryBtn, status }
  let queueSeq = 0;

  function updateQueueTitle() {
    const active = queueItems.filter((q) => q.status === 'uploading' || q.status === 'queued').length;
    const done = queueItems.filter((q) => q.status === 'done').length;
    const failed = queueItems.filter((q) => q.status === 'error').length;
    if (active > 0) {
      queueTitle.textContent = `Uploading ${active} file${active > 1 ? 's' : ''}…`;
    } else if (failed > 0) {
      queueTitle.textContent = `${done} uploaded, ${failed} failed`;
    } else {
      queueTitle.textContent = `${done} upload${done === 1 ? '' : 's'} complete`;
    }
  }

  function addQueueItem(file) {
    const id = ++queueSeq;
    const el = document.createElement('div');
    el.className = 'uqp-item';
    el.innerHTML = `
      <span class="uqp-icon">${thumbFallbackIconPlain(file.type)}</span>
      <div class="uqp-item-body">
        <div class="uqp-item-name">${escapeHtml(file.name)}</div>
        <div class="uqp-item-track"><div class="uqp-item-fill"></div></div>
      </div>
      <span class="uqp-status">0%</span>
    `;
    queueList.appendChild(el);
    queuePanel.hidden = false;
    queueList.classList.remove('collapsed');

    const item = {
      id, file,
      el,
      fillEl: el.querySelector('.uqp-item-fill'),
      statusEl: el.querySelector('.uqp-status'),
      status: 'queued'
    };
    queueItems.push(item);
    updateQueueTitle();
    return item;
  }

  function thumbFallbackIconPlain(mimeType = '') {
    if (mimeType === 'application/pdf') return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    return '📄';
  }

  function setItemProgress(item, pct) {
    item.status = 'uploading';
    item.fillEl.style.width = pct + '%';
    item.statusEl.textContent = pct + '%';
    updateQueueTitle();
  }

  function setItemDone(item) {
    item.status = 'done';
    item.fillEl.style.width = '100%';
    item.statusEl.textContent = '✓';
    item.statusEl.classList.add('done');
    updateQueueTitle();
  }

  function setItemError(item, onRetry) {
    item.status = 'error';
    item.fillEl.classList.add('error');
    item.statusEl.innerHTML = '';
    item.statusEl.classList.add('error');
    const retryBtn = document.createElement('button');
    retryBtn.className = 'uqp-retry';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      item.statusEl.classList.remove('error');
      item.fillEl.classList.remove('error');
      onRetry();
    });
    item.statusEl.appendChild(retryBtn);
    updateQueueTitle();
  }

  document.getElementById('uqpMinimize').addEventListener('click', () => {
    queueList.classList.toggle('collapsed');
  });
  document.getElementById('uqpClose').addEventListener('click', () => {
    queuePanel.hidden = true;
    queueList.innerHTML = '';
    queueItems = [];
  });

  // Files "stack" like Drive: every selected/dropped file gets its own queue
  // row immediately, then they upload one at a time (sequential — safer
  // against the server's per-minute rate limits than firing them in parallel).
  async function queueFiles(files) {
    const isPublic = document.getElementById('isPublicCheckbox').checked;
    const description = document.getElementById('descriptionInput').value.trim();
    const opts = { isPublic, description };

    const items = Array.from(files).map((file) => ({ file, item: addQueueItem(file) }));

    for (const { file, item } of items) {
      await runUpload(file, item, opts);
    }

    document.getElementById('isPublicCheckbox').checked = false;
    document.getElementById('descriptionInput').hidden = true;
    document.getElementById('descriptionInput').value = '';
    loadDocuments();
  }

  async function runUpload(file, item, opts) {
    try {
      if (file.size >= CHUNK_THRESHOLD_BYTES) {
        await uploadFileChunked(file, opts, (pct) => setItemProgress(item, pct));
      } else {
        await uploadFileSingleShot(file, opts, (pct) => setItemProgress(item, pct));
      }
      setItemDone(item);
      toast(`Uploaded ${file.name}`, { type: 'success' });
      loadDocuments(); // refresh as each file finishes, not just at the end of the whole batch
    } catch (err) {
      setItemError(item, () => runUpload(file, item, opts));
      toast(`Failed to upload ${file.name}: ${err.message}`, { type: 'error' });
    }
  }

  function uploadFileSingleShot(file, { isPublic, description }, onProgress) {
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
        onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText)));
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(file);
    });
  }

  async function uploadFileChunked(file, { isPublic, description }, onProgress) {
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
        onProgress(Math.min(100, Math.round((offset / file.size) * 100)));
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
    if (fileInput.files.length) queueFiles(fileInput.files);
    fileInput.value = ''; // allow re-selecting the same file(s) later
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
  );
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) queueFiles(e.dataTransfer.files);
  });

  document.getElementById('refreshBtn').addEventListener('click', loadDocuments);
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
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
    if (!res.ok) return toast('Could not create link', { type: 'error' });
    const { shareUrl } = await res.json();
    // shareUrl is built server-side and already includes the document id + code.
    document.getElementById('linkResultInput').value = shareUrl;
    document.getElementById('linkResult').hidden = false;
  });

  document.getElementById('copyLinkBtn').addEventListener('click', () => {
    document.getElementById('linkResultInput').select();
    document.execCommand('copy');
    toast('Link copied');
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
      return toast(body.error || 'Could not share with that person', { type: 'error' });
    }
    toast(`Shared with ${confirmedGranteeEmail}`, { type: 'success' });
    document.getElementById('granteeEmail').value = '';
    document.getElementById('granteeFound').hidden = true;
    document.getElementById('inviteBtn').disabled = true;
    confirmedGranteeEmail = null;
  });

  loadDocuments();
}
