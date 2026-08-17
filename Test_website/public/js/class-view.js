(async () => {
  const user = await requirePageAccess(['teacher', 'student']);
  if (!user) return;

  const classId = new URLSearchParams(window.location.search).get('id');
  if (!classId) { window.location.href = '/dashboard.html'; return; }

  let isTeacher = false;

  async function load() {
    const { class: klass, tests, role } = await api(`/api/classes/${classId}`);
    isTeacher = role === 'teacher';

    document.getElementById('classSubject').textContent = klass.subject;
    document.getElementById('className').textContent = klass.name;

    if (isTeacher) {
      document.getElementById('teacherActions').style.display = 'block';
      document.getElementById('classCodeNote').innerHTML =
        `<div class="note-banner">Share this code with students to join: <strong>${escapeHtml(klass.class_code)}</strong></div>`;
    }

    const listEl = document.getElementById('testList');
    if (!tests.length) {
      listEl.innerHTML = '<p class="empty-state">No tests yet.</p>';
      return;
    }

    listEl.innerHTML = tests.map((t) => {
      const statusBadge = isTeacher
        ? `<span class="badge ${t.is_published ? 'badge-published' : 'badge-draft'}">${t.is_published ? 'Published' : 'Draft'}</span>`
        : '';
      const teacherLinks = isTeacher
        ? `<a class="btn btn-small btn-outline" href="/edit-test.html?id=${t.id}" style="text-decoration:none;">Edit</a>
           <a class="btn btn-small btn-outline" href="/test-results.html?id=${t.id}" style="text-decoration:none;">Results</a>`
        : `<a class="btn btn-small btn-accent" href="/take-test.html?id=${t.id}" style="text-decoration:none;">Open</a>`;

      return `
        <div class="question-card">
          <div class="q-top">
            <div>
              <h3 style="margin:0 0 4px;">${escapeHtml(t.title)} ${statusBadge}</h3>
              <p style="margin:0; font-size:13px; color:#8a8478;">
                ${t.description ? escapeHtml(t.description) + ' · ' : ''}
                ${t.duration_minutes} min · ${t.total_marks} marks
                ${t.scheduled_start ? ' · opens ' + fmtDate(t.scheduled_start) : ''}
                ${t.scheduled_end ? ' · closes ' + fmtDate(t.scheduled_end) : ''}
              </p>
            </div>
            <div style="display:flex; gap:8px;">${teacherLinks}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('newTestBtn').addEventListener('click', () => {
    document.getElementById('newTestPanel').style.display = 'block';
  });

  document.getElementById('createTestSubmit').addEventListener('click', async () => {
    const title = document.getElementById('testTitle').value.trim();
    const duration = parseInt(document.getElementById('testDuration').value, 10) || 30;
    const start = document.getElementById('testStart').value;
    const end = document.getElementById('testEnd').value;
    const description = document.getElementById('testDescription').value.trim();
    const errEl = document.getElementById('createTestError');
    errEl.textContent = '';
    if (!title) { errEl.textContent = 'Title is required.'; return; }
    try {
      const { test } = await api('/api/tests', {
        method: 'POST',
        body: {
          classId: parseInt(classId, 10),
          title,
          description,
          durationMinutes: duration,
          scheduledStart: start ? new Date(start).toISOString() : null,
          scheduledEnd: end ? new Date(end).toISOString() : null,
        },
      });
      window.location.href = `/edit-test.html?id=${test.id}`;
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  load();
})();
