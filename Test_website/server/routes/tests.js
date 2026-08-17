const express = require('express');
const db = require('../db');
const cryptoUtil = require('../crypto');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

async function assertOwnsTest(testId, teacherId) {
  const test = await db.get('SELECT * FROM tests WHERE id = ?', [testId]);
  if (!test) return { error: 404, message: 'Test not found.' };
  if (test.teacher_id !== teacherId) return { error: 403, message: 'You do not own this test.' };
  return { test };
}

async function refreshTotalMarks(testId) {
  const row = await db.get('SELECT COALESCE(SUM(marks), 0) AS total FROM questions WHERE test_id = ?', [testId]);
  await db.run('UPDATE tests SET total_marks = ? WHERE id = ?', [row.total, testId]);
}

// ---------- Teacher: create a test (draft, unpublished) ----------
router.post('/', requireRole('teacher'), async (req, res) => {
  try {
    const { classId, title, description, scheduledStart, scheduledEnd, durationMinutes } = req.body || {};
    if (!classId || !title) return res.status(400).json({ error: 'Class and title are required.' });

    const klass = await db.get('SELECT * FROM classes WHERE id = ? AND teacher_id = ?', [classId, req.user.id]);
    if (!klass) return res.status(403).json({ error: 'You do not own that class.' });

    const info = await db.run(
      `INSERT INTO tests (class_id, teacher_id, title, description, scheduled_start, scheduled_end, duration_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [classId, req.user.id, title.trim(), description || null, scheduledStart || null, scheduledEnd || null, durationMinutes || 30]
    );
    const test = await db.get('SELECT * FROM tests WHERE id = ?', [info.lastID]);
    res.status(201).json({ test });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create test.' });
  }
});

// ---------- Get test detail ----------
// Teacher (owner): full detail including decrypted questions and correct answers.
// Student: decrypted question content only, WITHOUT correct answers, and only if published + enrolled.
// Admin: metadata only — never decrypts question content (see crypto.js for why).
router.get('/:id', async (req, res) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Please log in to continue.' });
    }
    const testId = parseInt(req.params.id, 10);
    const test = await db.get('SELECT * FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: 'Test not found.' });

    if (req.user.role === 'admin') {
      const questionCount = await db.get('SELECT COUNT(*) AS c FROM questions WHERE test_id = ?', [testId]);
      return res.json({ test, questionCount: questionCount.c, questions: null, note: 'Question content is encrypted and not accessible to admin accounts.' });
    }

    if (req.user.role === 'teacher') {
      if (test.teacher_id !== req.user.id) return res.status(403).json({ error: 'You do not own this test.' });
      const rows = await db.all('SELECT * FROM questions WHERE test_id = ? ORDER BY order_index ASC, id ASC', [testId]);
      const questions = rows.map((q) => ({
        id: q.id,
        type: q.type,
        content: cryptoUtil.decrypt(q.content_encrypted),
        options: q.options_encrypted ? cryptoUtil.decryptJSON(q.options_encrypted) : null,
        correctAnswer: q.correct_answer_encrypted ? cryptoUtil.decrypt(q.correct_answer_encrypted) : null,
        marks: q.marks,
        orderIndex: q.order_index,
      }));
      return res.json({ test, questions });
    }

    // student
    const enrollment = await db.get(
      'SELECT id FROM class_enrollments WHERE class_id = ? AND student_id = ?',
      [test.class_id, req.user.id]
    );
    if (!enrollment) return res.status(403).json({ error: 'You are not enrolled in this class.' });
    if (!test.is_published) return res.status(403).json({ error: 'This test is not yet available.' });

    const rows = await db.all('SELECT * FROM questions WHERE test_id = ? ORDER BY order_index ASC, id ASC', [testId]);
    const questions = rows.map((q) => ({
      id: q.id,
      type: q.type,
      content: cryptoUtil.decrypt(q.content_encrypted),
      options: q.options_encrypted ? cryptoUtil.decryptJSON(q.options_encrypted) : null,
      marks: q.marks,
    }));
    res.json({ test, questions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load test.' });
  }
});

// ---------- Teacher: add a question ----------
// type: 'text' | 'mcq_single'
// For mcq_single: options = string[], correctAnswer = one of the option strings.
router.post('/:id/questions', requireRole('teacher'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const ownership = await assertOwnsTest(testId, req.user.id);
    if (ownership.error) return res.status(ownership.error).json({ error: ownership.message });

    const { type, content, options, correctAnswer, marks, orderIndex } = req.body || {};
    if (!type || !['text', 'mcq_single'].includes(type)) {
      return res.status(400).json({ error: "Question type must be 'text' or 'mcq_single'." });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Question content is required.' });
    }
    if (type === 'mcq_single') {
      if (!Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: 'Multiple choice questions need at least 2 options.' });
      }
      if (!correctAnswer || !options.includes(correctAnswer)) {
        return res.status(400).json({ error: 'correctAnswer must be one of the provided options.' });
      }
    }

    const info = await db.run(
      `INSERT INTO questions (test_id, type, content_encrypted, options_encrypted, correct_answer_encrypted, marks, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        testId,
        type,
        cryptoUtil.encrypt(content.trim()),
        type === 'mcq_single' ? cryptoUtil.encrypt(options) : null,
        type === 'mcq_single' ? cryptoUtil.encrypt(correctAnswer) : null,
        typeof marks === 'number' ? marks : 1,
        typeof orderIndex === 'number' ? orderIndex : 0,
      ]
    );
    await refreshTotalMarks(testId);
    res.status(201).json({ questionId: info.lastID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add question.' });
  }
});

// ---------- Teacher: edit a single question (content, options, correct answer, marks) ----------
router.put('/:id/questions/:qid', requireRole('teacher'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const questionId = parseInt(req.params.qid, 10);
    const ownership = await assertOwnsTest(testId, req.user.id);
    if (ownership.error) return res.status(ownership.error).json({ error: ownership.message });

    const question = await db.get('SELECT * FROM questions WHERE id = ? AND test_id = ?', [questionId, testId]);
    if (!question) return res.status(404).json({ error: 'Question not found.' });

    const { content, options, correctAnswer, marks } = req.body || {};
    const updates = [];
    const params = [];

    if (content !== undefined) {
      updates.push('content_encrypted = ?');
      params.push(cryptoUtil.encrypt(content));
    }
    if (options !== undefined) {
      updates.push('options_encrypted = ?');
      params.push(cryptoUtil.encrypt(options));
    }
    if (correctAnswer !== undefined) {
      updates.push('correct_answer_encrypted = ?');
      params.push(cryptoUtil.encrypt(correctAnswer));
    }
    if (marks !== undefined) {
      updates.push('marks = ?');
      params.push(marks);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(questionId);
    await db.run(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`, params);
    await refreshTotalMarks(testId);
    res.json({ message: 'Question updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update question.' });
  }
});

// ---------- Teacher: bulk-set marks for every question in the test ----------
router.put('/:id/marks/bulk', requireRole('teacher'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const ownership = await assertOwnsTest(testId, req.user.id);
    if (ownership.error) return res.status(ownership.error).json({ error: ownership.message });

    const { marks } = req.body || {};
    if (typeof marks !== 'number' || marks <= 0) {
      return res.status(400).json({ error: 'marks must be a positive number.' });
    }

    await db.run('UPDATE questions SET marks = ? WHERE test_id = ?', [marks, testId]);
    await refreshTotalMarks(testId);
    res.json({ message: 'All question marks updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update marks.' });
  }
});

// ---------- Teacher: delete a question ----------
router.delete('/:id/questions/:qid', requireRole('teacher'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const questionId = parseInt(req.params.qid, 10);
    const ownership = await assertOwnsTest(testId, req.user.id);
    if (ownership.error) return res.status(ownership.error).json({ error: ownership.message });

    await db.run('DELETE FROM questions WHERE id = ? AND test_id = ?', [questionId, testId]);
    await refreshTotalMarks(testId);
    res.json({ message: 'Question deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete question.' });
  }
});

// ---------- Teacher: publish / unpublish ----------
router.put('/:id/publish', requireRole('teacher'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const ownership = await assertOwnsTest(testId, req.user.id);
    if (ownership.error) return res.status(ownership.error).json({ error: ownership.message });

    const { publish } = req.body || {};
    const questionCount = await db.get('SELECT COUNT(*) AS c FROM questions WHERE test_id = ?', [testId]);
    if (publish && questionCount.c === 0) {
      return res.status(400).json({ error: 'Add at least one question before publishing.' });
    }

    await db.run('UPDATE tests SET is_published = ? WHERE id = ?', [publish ? 1 : 0, testId]);
    res.json({ message: publish ? 'Test published.' : 'Test unpublished.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update test.' });
  }
});

module.exports = router;
