(() => {
  const form = document.getElementById('registerForm');
  const passwordInput = document.getElementById('password');
  const rulesList = document.getElementById('rules');
  const submitBtn = document.getElementById('submitBtn');
  const errorBanner = document.getElementById('errorBanner');

  const ruleEls = {
    length: document.getElementById('rule-length'),
    uppercase: document.getElementById('rule-uppercase'),
    number: document.getElementById('rule-number'),
    special: document.getElementById('rule-special'),
  };

  function checkPassword(password) {
    return {
      length: password.length >= 6,
      uppercase: /[A-Z]/.test(password),
      number: /[0-9]/.test(password),
      special: /[^A-Za-z0-9]/.test(password),
    };
  }

  function renderRules(results) {
    let allMet = true;
    for (const key of Object.keys(results)) {
      const met = results[key];
      ruleEls[key].classList.toggle('met', met);
      if (!met) allMet = false;
    }
    return allMet;
  }

  passwordInput.addEventListener('focus', () => {
    rulesList.classList.add('show');
  });

  passwordInput.addEventListener('input', () => {
    rulesList.classList.add('show');
    const results = checkPassword(passwordInput.value);
    const allMet = renderRules(results);
    submitBtn.disabled = !allMet;
  });

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.add('show');
  }

  function hideError() {
    errorBanner.classList.remove('show');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = passwordInput.value;

    const results = checkPassword(password);
    if (!renderRules(results)) {
      showError('Please meet all password requirements before continuing.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Something went wrong. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
        return;
      }

      window.location.href = '/dashboard.html';
    } catch (err) {
      showError('Network error. Please check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
})();
