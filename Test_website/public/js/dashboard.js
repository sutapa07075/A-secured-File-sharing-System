(async () => {
  const user = await requirePageAccess(['student']);
  if (!user) return;

  document.getElementById('joinBtn').addEventListener('click', () => {
    document.getElementById('joinPanel').style.display = 'block';
  });

  document.getElementById('joinSubmit').addEventListener('click', async () => {
    const code = document.getElementById('classCode').value.trim();
    const errEl = document.getElementById('joinError');
    errEl.textContent = '';
    if (!code) { errEl.textContent = 'Enter a class code.'; return; }
    try {
      await api('/api/classes/join', { method: 'POST', body: { classCode: code } });
      document.getElementById('classCode').value = '';
      document.getElementById('joinPanel').style.display = 'none';
      await loadEverything();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  async function loadEverything() {
    const { classes } = await api('/api/classes/enrolled');
    const grid = document.getElementById('classGrid');
    grid.innerHTML = classes.length
      ? classes.map((c) => `
          <a class="tile" href="/class-view.html?id=${c.id}">
            <div class="tile-subject">${escapeHtml(c.subject)}</div>
            <h3>${escapeHtml(c.name)}</h3>
            <p>Taught by ${escapeHtml(c.teacher_name || 'Unknown')}</p>
          </a>
        `).join('')
      : '<p class="empty-state">You haven\'t joined any classes yet. Ask your teacher for a class code.</p>';

    // Aggregate upcoming published tests across all enrolled classes.
    const upcomingEl = document.getElementById('upcomingList');
    upcomingEl.innerHTML = '<p class="empty-state">Loading…</p>';
    const allTests = [];
    for (const c of classes) {
      try {
        const detail = await api(`/api/classes/${c.id}`);
        detail.tests.forEach((t) => allTests.push({ ...t, className: c.name, subject: c.subject }));
      } catch (e) { /* skip class on error */ }
    }
    const now = new Date();
    const upcoming = allTests
      .filter((t) => !t.scheduled_end || new Date(t.scheduled_end) >= now)
      .sort((a, b) => new Date(a.scheduled_start || 0) - new Date(b.scheduled_start || 0));

    upcomingEl.innerHTML = upcoming.length
      ? `<table class="data-table">
          <thead><tr><th>Test</th><th>Class</th><th>Opens</th><th>Closes</th><th>Marks</th><th></th></tr></thead>
          <tbody>
            ${upcoming.map((t) => `
              <tr>
                <td>${escapeHtml(t.title)}</td>
                <td>${escapeHtml(t.className)} (${escapeHtml(t.subject)})</td>
                <td>${fmtDate(t.scheduled_start)}</td>
                <td>${fmtDate(t.scheduled_end)}</td>
                <td>${t.total_marks}</td>
                <td><a class="btn btn-small btn-accent" href="/take-test.html?id=${t.id}" style="text-decoration:none;">Open</a></td>
              </tr>
            `).join('')}
          </tbody>
        </table>`
      : '<p class="empty-state">No upcoming tests right now.</p>';
  }

  loadEverything();
})();
