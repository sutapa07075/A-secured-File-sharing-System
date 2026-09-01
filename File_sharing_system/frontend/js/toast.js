/**
 * Bottom-of-screen toast notifications. Replaces window.alert() everywhere —
 * alert() is a blocking modal that halts JS execution until dismissed, which
 * is exactly the "no feedback until you dismiss a popup" problem we're fixing.
 * Usage: toast('Uploaded report.pdf'); toast('Could not share', { type: 'error' });
 */
function toast(message, { type = 'info', duration = 4000 } = {}) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}
