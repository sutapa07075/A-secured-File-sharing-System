(async () => {
  const user = await requirePageAccess(['admin']);
  if (!user) return;

  async function loadUsers() {
    const { users } = await api('/api/admin/users');
    document.getElementById('usersTable').innerHTML = `
      <table class="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Provider</th><th>Role</th><th>Joined</th><th></th></tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${escapeHtml(u.name || '—')}</td>
              <td>${escapeHtml(u.email)}</td>
              <td>${escapeHtml(u.provider)}</td>
              <td>
                <select class="roleSelect" data-id="${u.id}" style="padding:4px 6px; border:1px solid var(--line); border-radius:6px;">
                  ${['student', 'teacher', 'admin'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
                </select>
              </td>
              <td>${fmtDate(u.created_at)}</td>
              <td><button class="btn btn-small btn-outline saveRoleBtn" data-id="${u.id}">Save</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    document.querySelectorAll('.saveRoleBtn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const role = document.querySelector(`.roleSelect[data-id="${id}"]`).value;
        try {
          await api(`/api/admin/users/${id}/role`, { method: 'PUT', body: { role } });
          alert('Role updated.');
        } catch (e) { alert(e.message); }
      });
    });
  }

  async function loadClasses() {
    const { classes } = await api('/api/admin/classes');
    document.getElementById('classesTable').innerHTML = classes.length ? `
      <table class="data-table">
        <thead><tr><th>Class</th><th>Subject</th><th>Teacher</th><th>Students</th><th>Code</th><th>Created</th></tr></thead>
        <tbody>
          ${classes.map((c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td>${escapeHtml(c.subject)}</td>
              <td>${escapeHtml(c.teacher_name)} (${escapeHtml(c.teacher_email)})</td>
              <td>${c.student_count}</td>
              <td>${escapeHtml(c.class_code)}</td>
              <td>${fmtDate(c.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="empty-state">No classes yet.</p>';
  }

  async function loadTests() {
    const { tests } = await api('/api/admin/tests');
    document.getElementById('testsTable').innerHTML = tests.length ? `
      <table class="data-table">
        <thead><tr><th>Test</th><th>Class</th><th>Teacher</th><th>Questions</th><th>Submissions</th><th>Marks</th><th>Status</th></tr></thead>
        <tbody>
          ${tests.map((t) => `
            <tr>
              <td>${escapeHtml(t.title)}</td>
              <td>${escapeHtml(t.class_name)} (${escapeHtml(t.subject)})</td>
              <td>${escapeHtml(t.teacher_name)}</td>
              <td>${t.question_count}</td>
              <td>${t.submission_count}</td>
              <td>${t.total_marks}</td>
              <td><span class="badge ${t.is_published ? 'badge-published' : 'badge-draft'}">${t.is_published ? 'Published' : 'Draft'}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="empty-state">No tests yet.</p>';
  }

  loadUsers();
  loadClasses();
  loadTests();
})();
