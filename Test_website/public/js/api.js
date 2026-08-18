// Small wrapper around fetch() used by every dashboard page: adds JSON headers,
// throws with the server's error message on failure, and returns parsed JSON.
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Renders the shared top navigation bar and wires up the logout button.
// Call once per page: renderTopbar(user, 'Page title override (optional)')
function renderTopbar(user) {
  const bar = document.createElement('div');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="brand">NITDGP TESTCENTRE</div>
    <div class="userbox">
      <span>${user.name || user.email} · <strong>${user.role}</strong></span>
      <button id="logoutBtn">Log out</button>
    </div>
  `;
  document.body.prepend(bar);
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
}

// Confirms the user is logged in and (optionally) has the right role before
// rendering the page. Redirects appropriately if not. Returns the user object.
async function requirePageAccess(allowedRoles) {
  try {
    const data = await api('/api/me');
    if (allowedRoles && !allowedRoles.includes(data.user.role)) {
      const target = data.user.role === 'teacher' ? '/teacher-dashboard.html'
        : data.user.role === 'admin' ? '/admin-dashboard.html'
        : '/dashboard.html';
      window.location.href = target;
      return null;
    }
    renderTopbar(data.user);
    return data.user;
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
}

// SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" — UTC, but with no
// timezone marker. Handing that straight to `new Date(...)` makes browsers
// parse it as LOCAL time instead of UTC, silently shifting it by the user's
// UTC offset. Full ISO strings (from scheduledStart/End, which already have a
// 'T' and usually a 'Z') are left untouched.
function parseServerTimestamp(value) {
  if (typeof value === 'string' && value.includes(' ') && !value.includes('T')) {
    return new Date(value.replace(' ', 'T') + 'Z');
  }
  return new Date(value);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = parseServerTimestamp(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}