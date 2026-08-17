(async () => {
  const user = await requirePageAccess(['teacher']);
  if (!user) return;

  const testId = new URLSearchParams(window.location.search).get('id');
  if (!testId) { window.location.href = '/teacher-dashboard.html'; return; }

  let currentTest = null;

  function optionRowHtml(index) {
    return `
      <div class="option-row" data-index="${index}">
        <input type="radio" name="correctOption" value="${index}" ${index === 0 ? 'checked' : ''}>
        <input type="text" placeholder="Option ${index + 1}">
        <button type="button" class="btn btn-small btn-danger removeOptionBtn">Remove</button>
      </div>
    `;
  }

  function resetOptionRows() {
    const rows = document.getElementById('optionRows');
    rows.innerHTML = optionRowHtml(0) + optionRowHtml(1);
    wireOptionRemovers();
  }

  function wireOptionRemovers() {
    document.querySelectorAll('.removeOptionBtn').forEach((btn) => {
      btn.onclick = () => {
        const rows = document.querySelectorAll('.option-row');
        if (rows.length <= 2) return; // keep at least 2 options
        btn.closest('.option-row').remove();
      };
    });
  }

  document.getElementById('qType').addEventListener('change', (e) => {
    document.getElementById('mcqOptions').style.display = e.target.value === 'mcq_single' ? 'block' : 'none';
  });

  document.getElementById('addOptionBtn').addEventListener('click', () => {
    const rows = document.getElementById('optionRows');
    const index = rows.children.length;
    rows.insertAdjacentHTML('beforeend', optionRowHtml(index));
    wireOptionRemovers();
  });

  resetOptionRows();

  async function loadTest() {
    const { test, questions } = await api(`/api/tests/${testId}`);
    currentTest = test;
    document.getElementById('testTitle').textContent = test.title;
    document.getElementById('testMeta').textContent =
      `${questions.length} question${questions.length === 1 ? '' : 's'} · ${test.total_marks} total marks`;

    const pubBtn = document.getElementById('publishBtn');
    pubBtn.textContent = test.is_published ? 'Unpublish' : 'Publish';
    pubBtn.className = 'btn ' + (test.is_published ? 'btn-danger' : 'btn-accent');
    pubBtn.onclick = async () => {
      try {
        await api(`/api/tests/${testId}/publish`, { method: 'PUT', body: { publish: !test.is_published } });
        loadTest();
      } catch (e) {
        alert(e.message);
      }
    };

    const listEl = document.getElementById('questionList');
    listEl.innerHTML = questions.length ? '' : '<p class="empty-state">No questions yet — add one below.</p>';
    questions.forEach((q, i) => {
      const div = document.createElement('div');
      div.className = 'question-card';
      div.innerHTML = `
        <div class="q-top">
          <div style="flex:1;">
            <strong>Q${i + 1}.</strong> ${escapeHtml(q.content)}
            ${q.type === 'mcq_single' ? `
              <ul style="margin:8px 0 0; padding-left:20px; font-size:14px;">
                ${q.options.map((o) => `<li>${escapeHtml(o)}${o === q.correctAnswer ? ' <strong>(correct)</strong>' : ''}</li>`).join('')}
              </ul>` : '<p style="font-size:13px; color:#8a8478; margin:6px 0 0;">Text answer — graded manually</p>'}
          </div>
          <div style="text-align:right;">
            <input type="number" class="q-marks" value="${q.marks}" min="0.5" step="0.5" data-qid="${q.id}">
            <div style="margin-top:8px;">
              <button class="btn btn-small btn-outline saveMarksBtn" data-qid="${q.id}">Save marks</button>
              <button class="btn btn-small btn-danger deleteQBtn" data-qid="${q.id}">Delete</button>
            </div>
          </div>
        </div>
      `;
      listEl.appendChild(div);
    });

    document.querySelectorAll('.saveMarksBtn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const qid = btn.dataset.qid;
        const input = document.querySelector(`.q-marks[data-qid="${qid}"]`);
        try {
          await api(`/api/tests/${testId}/questions/${qid}`, { method: 'PUT', body: { marks: parseFloat(input.value) } });
          loadTest();
        } catch (e) { alert(e.message); }
      });
    });

    document.querySelectorAll('.deleteQBtn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this question?')) return;
        try {
          await api(`/api/tests/${testId}/questions/${btn.dataset.qid}`, { method: 'DELETE' });
          loadTest();
        } catch (e) { alert(e.message); }
      });
    });
  }

  document.getElementById('bulkApply').addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('bulkMarks').value);
    const errEl = document.getElementById('bulkError');
    errEl.textContent = '';
    if (!val || val <= 0) { errEl.textContent = 'Enter a positive number.'; return; }
    try {
      await api(`/api/tests/${testId}/marks/bulk`, { method: 'PUT', body: { marks: val } });
      loadTest();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  document.getElementById('addQuestionBtn').addEventListener('click', async () => {
    const type = document.getElementById('qType').value;
    const content = document.getElementById('qContent').value.trim();
    const marks = parseFloat(document.getElementById('qMarks').value) || 1;
    const errEl = document.getElementById('addQuestionError');
    errEl.textContent = '';

    if (!content) { errEl.textContent = 'Question text is required.'; return; }

    const body = { type, content, marks };
    if (type === 'mcq_single') {
      const rows = [...document.querySelectorAll('.option-row')];
      const options = rows.map((r) => r.querySelector('input[type="text"]').value.trim()).filter(Boolean);
      const checkedIndex = rows.findIndex((r) => r.querySelector('input[type="radio"]').checked);
      if (options.length < 2) { errEl.textContent = 'Add at least 2 options.'; return; }
      body.options = options;
      body.correctAnswer = options[checkedIndex] ?? options[0];
    }

    try {
      await api(`/api/tests/${testId}/questions`, { method: 'POST', body });
      document.getElementById('qContent').value = '';
      document.getElementById('qMarks').value = '1';
      resetOptionRows();
      loadTest();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  loadTest();
})();
