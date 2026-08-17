(async () => {
  const user = await requirePageAccess(['student']);
  if (!user) return;

  const testId = new URLSearchParams(window.location.search).get('id');
  if (!testId) { window.location.href = '/dashboard.html'; return; }

  let submissionId = null;
  let saveTimers = {};
  let countdownInterval = null;

  function debounceSave(questionId, value) {
    clearTimeout(saveTimers[questionId]);
    saveTimers[questionId] = setTimeout(async () => {
      try {
        await api(`/api/submissions/${submissionId}/answers/${questionId}`, { method: 'PUT', body: { answer: value } });
      } catch (e) { /* silent — will retry on next change or submit */ }
    }, 500);
  }

  async function submitTest(auto = false) {
    clearInterval(countdownInterval);
    try {
      const result = await api(`/api/submissions/${submissionId}/submit`, { method: 'POST' });
      document.getElementById('statusBanner').innerHTML =
        `<div class="note-banner">${auto ? 'Time\'s up — your test was submitted automatically.' : 'Submitted!'}
         Auto-graded score so far: ${result.autoScore}${result.pendingManualGrading ? ' (some answers still need manual grading).' : '.'}</div>`;
      document.getElementById('submitBtn').disabled = true;
      document.querySelectorAll('#questionList input, #questionList textarea').forEach((el) => el.disabled = true);
    } catch (e) {
      alert(e.message);
    }
  }

  document.getElementById('submitBtn').addEventListener('click', () => {
    if (confirm('Submit the test now? You cannot change answers after submitting.')) submitTest(false);
  });

  try {
    const startRes = await api(`/api/submissions/tests/${testId}/start`, { method: 'POST' });
    submissionId = startRes.submission.id;

    const { test, questions } = await api(`/api/tests/${testId}`);
    document.getElementById('testTitle').textContent = test.title;
    document.getElementById('testMeta').textContent = `${questions.length} questions · ${test.total_marks} marks total`;

    const listEl = document.getElementById('questionList');
    listEl.innerHTML = questions.map((q, i) => `
      <div class="question-card">
        <strong>Q${i + 1}. (${q.marks} mark${q.marks === 1 ? '' : 's'})</strong>
        <p>${escapeHtml(q.content)}</p>
        ${q.type === 'mcq_single'
          ? q.options.map((o, oi) => `
              <div class="option-row">
                <input type="radio" name="q_${q.id}" value="${escapeHtml(o)}" id="q_${q.id}_${oi}">
                <label for="q_${q.id}_${oi}">${escapeHtml(o)}</label>
              </div>
            `).join('')
          : `<input type="text" placeholder="Your answer" data-qid="${q.id}" class="text-answer" style="width:100%; padding:10px;">`
        }
      </div>
    `).join('');

    questions.forEach((q) => {
      if (q.type === 'mcq_single') {
        document.querySelectorAll(`input[name="q_${q.id}"]`).forEach((radio) => {
          radio.addEventListener('change', (e) => debounceSave(q.id, e.target.value));
        });
      } else {
        const input = document.querySelector(`.text-answer[data-qid="${q.id}"]`);
        input.addEventListener('input', (e) => debounceSave(q.id, e.target.value));
      }
    });

    // Countdown based on when this attempt started + the test's duration.
    const deadline = new Date(new Date(startRes.submission.started_at).getTime() + test.duration_minutes * 60000);
    countdownInterval = setInterval(() => {
      const msLeft = deadline - new Date();
      if (msLeft <= 0) {
        document.getElementById('timer').textContent = "Time's up";
        submitTest(true);
        return;
      }
      const mins = Math.floor(msLeft / 60000);
      const secs = Math.floor((msLeft % 60000) / 1000);
      document.getElementById('timer').textContent = `${mins}:${secs.toString().padStart(2, '0')} left`;
    }, 1000);
  } catch (e) {
    document.getElementById('statusBanner').innerHTML = `<div class="note-banner" style="background:var(--error-soft); color:var(--error);">${escapeHtml(e.message)}</div>`;
    document.getElementById('submitBtn').style.display = 'none';
  }
})();
