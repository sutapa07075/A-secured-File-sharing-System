(() => {
  const form = document.getElementById('loginForm');
  const submitBtn = document.getElementById('submitBtn');
  const errorBanner = document.getElementById('errorBanner');

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.add('show');
  }
  function hideError() {
    errorBanner.classList.remove('show');
  }

  // Show a message if we were redirected here after an OAuth failure or timeout.
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'google_failed') showError('Google sign-in failed. Please try again.');
  if (params.get('error') === 'github_failed') showError('GitHub sign-in failed. Please try again.');
  if (params.get('error') === 'google_not_configured') showError('Google sign-in is not set up on this server yet.');
  if (params.get('error') === 'github_not_configured') showError('GitHub sign-in is not set up on this server yet.');
  if (params.get('timeout') === '1') {
    document.getElementById('timeoutToast').classList.add('show');
    setTimeout(() => document.getElementById('timeoutToast').classList.remove('show'), 4000);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
      showError('Please enter both email and password.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in…';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Unable to log in. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log in';
        return;
      }

      window.location.href = data.user.role === 'teacher' ? '/teacher-dashboard.html'
        : data.user.role === 'admin' ? '/admin-dashboard.html'
        : '/dashboard.html';
    } catch (err) {
      showError('Network error. Please check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
    }
  });
})();
