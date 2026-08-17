(async () => {
  const user = await requirePageAccess(['teacher']);
  if (!user) return;

  const testId = new URLSearchParams(window.location.search).get('id');
  if (!testId) { window.location.href = '/teacher-dashboard.html'; return; }

  async function loadResults() {
    const { test, submissions } = await api(`/api/submissions/tests/${testId}/results`);
    document.getElementById('testTitle').textContent = `Results — ${test.title}`;

    const el = document.getElementById('resultsTable');
    el.innerHTML = submissions.length
      ? `<table class="data-table">
          <thead><tr><th>Student</th><th>Status</th><th>Score</th><th>Submitted</th><th></th></tr></thead>
          <tbody>
            ${submissions.map((s) => `
              <tr>
                <td>${escapeHtml(s.student_name || s.student_email)}</td>
                <td><span class="badge ${s.status === 'graded' ? 'badge-graded' : 'badge-pending'}">${s.status.replace(/_/g, ' ')}</span></td>
                <td>${s.score === null ? '—' : s.score} / ${test.total_marks}</td>
                <td>${fmtDate(s.submitted_at)}</td>
                <td><button class="btn btn-small btn-outline gradeBtn" data-id="${s.id}" data-name="${escapeHtml(s.student_name || s.student_email)}">${s.status === 'submitted_pending_review' ? 'Grade' : 'View'}</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>`
      : '<p class="empty-state">No submissions yet.</p>';

    document.querySelectorAll('.gradeBtn').forEach((btn) => {
      btn.addEventListener('click', () => openGrading(btn.dataset.id, btn.dataset.name));
    });
  }

  async function openGrading(submissionId, studentName) {
    const { items } = await api(`/api/submissions/${submissionId}`);
    const panel = document.getElementById('gradingPanel');
    panel.style.display = 'block';
    document.getElementById('gradingStudent').textContent = `Grading: ${studentName}`;

    document.getElementById('gradingItems').innerHTML = items.map((it, i) => `
      <div class="question-card">
        <strong>Q${i + 1}. (${it.marks} mark${it.marks === 1 ? '' : 's'})</strong>
        <p>${escapeHtml(it.content)}</p>
        <p style="background:#f7f5f2; padding:10px; border-radius:6px;"><strong>Answer:</strong> ${escapeHtml(it.studentAnswer) || '<em>No answer given</em>'}</p>
        ${it.type === 'mcq_single'
          ? `<p style="font-size:13px; color:${it.isCorrect ? 'var(--ok)' : 'var(--error)'};">${it.isCorrect ? 'Correct' : 'Incorrect'} — auto-graded (${it.awardedMarks ?? 0} / ${it.marks})</p>`
          : `<div class="form-row" style="align-items:flex-end;">
              <div>
                <label>Marks awarded (out of ${it.marks})</label>
                <input type="number" class="award-input" data-answer-id="${it.answerId}" min="0" max="${it.marks}" step="0.5" value="${it.awardedMarks ?? ''}">
              </div>
              <div style="flex:0;">
                <button class="btn btn-small btn-accent saveAwardBtn" data-answer-id="${it.answerId}">Save</button>
              </div>
            </div>`
        }
      </div>
    `).join('');

    document.querySelectorAll('.saveAwardBtn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const answerId = btn.dataset.answerId;
        const input = document.querySelector(`.award-input[data-answer-id="${answerId}"]`);
        const val = parseFloat(input.value);
        if (Number.isNaN(val) || val < 0) { alert('Enter a valid non-negative number.'); return; }
        try {
          await api(`/api/submissions/answers/${answerId}/grade`, { method: 'PUT', body: { awardedMarks: val } });
          await loadResults();
          openGrading(submissionId, studentName);
        } catch (e) { alert(e.message); }
      });
    });
  }

  loadResults();
})();
