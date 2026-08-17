(async () => {
  const user = await requirePageAccess(['teacher']);
  if (!user) return;

  document.getElementById('newClassBtn').addEventListener('click', () => {
    document.getElementById('newClassPanel').style.display = 'block';
  });

  document.getElementById('createClassSubmit').addEventListener('click', async () => {
    const name = document.getElementById('className').value.trim();
    const subject = document.getElementById('classSubject').value.trim();
    const errEl = document.getElementById('createClassError');
    errEl.textContent = '';
    if (!name || !subject) { errEl.textContent = 'Both fields are required.'; return; }
    try {
      await api('/api/classes', { method: 'POST', body: { name, subject } });
      document.getElementById('className').value = '';
      document.getElementById('classSubject').value = '';
      document.getElementById('newClassPanel').style.display = 'none';
      loadClasses();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  async function loadClasses() {
    const { classes } = await api('/api/classes/mine');
    const grid = document.getElementById('classGrid');
    grid.innerHTML = classes.length
      ? classes.map((c) => `
          <a class="tile" href="/class-view.html?id=${c.id}">
            <div class="tile-subject">${escapeHtml(c.subject)}</div>
            <h3>${escapeHtml(c.name)}</h3>
            <p>${c.student_count} student${c.student_count === 1 ? '' : 's'} · code <strong>${escapeHtml(c.class_code)}</strong></p>
          </a>
        `).join('')
      : '<p class="empty-state">You haven\'t created any classes yet.</p>';
  }

  loadClasses();
})();
