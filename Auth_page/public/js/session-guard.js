// Watches for user inactivity on protected pages (e.g. dashboard.html) and logs the
// user out automatically, both by calling /api/logout and redirecting to /login.html.
// The number below should be a little under the server's SESSION_TIMEOUT_MINUTES so
// the user gets a warning before the server-side session cookie actually expires.
(() => {
  const INACTIVITY_LIMIT_MS = 15 * 60 * 1000; // keep in sync with SESSION_TIMEOUT_MINUTES
  const WARNING_BEFORE_MS = 30 * 1000; // show a warning 30s before logging out

  let inactivityTimer;
  let warningTimer;

  function showWarningToast() {
    const toast = document.getElementById('timeoutToast');
    if (toast) {
      toast.textContent = 'You will be logged out soon due to inactivity.';
      toast.classList.add('show');
    }
  }

  async function doLogout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (e) {
      // ignore network errors on logout, still redirect
    }
    window.location.href = '/login.html?timeout=1';
  }

  function resetTimers() {
    clearTimeout(inactivityTimer);
    clearTimeout(warningTimer);
    const toast = document.getElementById('timeoutToast');
    if (toast) toast.classList.remove('show');

    warningTimer = setTimeout(showWarningToast, INACTIVITY_LIMIT_MS - WARNING_BEFORE_MS);
    inactivityTimer = setTimeout(doLogout, INACTIVITY_LIMIT_MS);
  }

  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, resetTimers, { passive: true });
  });

  // Periodically confirm the server still considers the session valid
  // (in case the cookie expired in another tab, or the server restarted).
  setInterval(async () => {
    try {
      const res = await fetch('/api/me');
      if (!res.ok) {
        window.location.href = '/login.html?timeout=1';
      }
    } catch (e) {
      // ignore transient network errors
    }
  }, 60 * 1000);

  resetTimers();
})();
