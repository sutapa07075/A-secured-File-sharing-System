const express = require('express');
const db = require('../db');
const cryptoUtil = require('../crypto');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- Student: start (or resume) a test attempt ----------
router.post('/tests/:id/start', requireRole('student'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const test = await db.get('SELECT * FROM tests WHERE id = ?', [testId]);
    if (!test || !test.is_published) return res.status(404).json({ error: 'Test not available.' });

    const enrollment = await db.get(
      'SELECT id FROM class_enrollments WHERE class_id = ? AND student_id = ?',
      [test.class_id, req.user.id]
    );
    if (!enrollment) return res.status(403).json({ error: 'You are not enrolled in this class.' });

    const now = new Date();
    if (test.scheduled_start && now < new Date(test.scheduled_start)) {
      return res.status(403).json({ error: 'This test has not opened yet.' });
    }
    if (test.scheduled_end && now > new Date(test.scheduled_end)) {
      return res.status(403).json({ error: 'This test has closed.' });
    }

    let submission = await db.get(
      'SELECT * FROM submissions WHERE test_id = ? AND student_id = ?',
      [testId, req.user.id]
    );
    if (submission && submission.status === 'submitted') {
      return res.status(409).json({ error: 'You have already submitted this test.' });
    }
    if (!submission) {
      const info = await db.run(
        'INSERT INTO submissions (test_id, student_id, status) VALUES (?, ?, ?)',
        [testId, req.user.id, 'in_progress']
      );
      submission = await db.get('SELECT * FROM submissions WHERE id = ?', [info.lastID]);
    }

    res.status(201).json({ submission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start test.' });
  }
});

// ---------- Student: save one answer (auto-save as they go) ----------
router.put('/:submissionId/answers/:questionId', requireRole('student'), async (req, res) => {
  try {
    const submissionId = parseInt(req.params.submissionId, 10);
    const questionId = parseInt(req.params.questionId, 10);
    const { answer } = req.body || {};

    const submission = await db.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!submission || submission.student_id !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    if (submission.status === 'submitted') {
      return res.status(409).json({ error: 'This test has already been submitted.' });
    }

    const question = await db.get('SELECT * FROM questions WHERE id = ? AND test_id = ?', [questionId, submission.test_id]);
    if (!question) return res.status(404).json({ error: 'Question not found.' });

    const encryptedAnswer = answer !== undefined && answer !== null ? cryptoUtil.encrypt(String(answer)) : null;

    const existing = await db.get(
      'SELECT id FROM answers WHERE submission_id = ? AND question_id = ?',
      [submissionId, questionId]
    );
    if (existing) {
      await db.run('UPDATE answers SET answer_encrypted = ? WHERE id = ?', [encryptedAnswer, existing.id]);
    } else {
      await db.run(
        'INSERT INTO answers (submission_id, question_id, answer_encrypted) VALUES (?, ?, ?)',
        [submissionId, questionId, encryptedAnswer]
      );
    }
    res.json({ message: 'Answer saved.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save answer.' });
  }
});

// ---------- Student: submit the whole test (final) ----------
// Auto-grades mcq_single questions immediately; text questions wait for manual grading.
router.post('/:submissionId/submit', requireRole('student'), async (req, res) => {
  try {
    const submissionId = parseInt(req.params.submissionId, 10);
    const submission = await db.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!submission || submission.student_id !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    if (submission.status === 'submitted') {
      return res.status(409).json({ error: 'This test has already been submitted.' });
    }

    const questions = await db.all('SELECT * FROM questions WHERE test_id = ?', [submission.test_id]);
    const answers = await db.all('SELECT * FROM answers WHERE submission_id = ?', [submissionId]);
    const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

    let autoScore = 0;
    let hasUngraded = false;

    for (const q of questions) {
      const ans = answerByQuestion.get(q.id);
      if (q.type === 'mcq_single') {
        const correct = cryptoUtil.decrypt(q.correct_answer_encrypted);
        const given = ans && ans.answer_encrypted ? cryptoUtil.decrypt(ans.answer_encrypted) : null;
        const isCorrect = given !== null && given === correct;
        const awarded = isCorrect ? q.marks : 0;
        autoScore += awarded;
        if (ans) {
          await db.run('UPDATE answers SET awarded_marks = ?, is_correct = ? WHERE id = ?', [awarded, isCorrect ? 1 : 0, ans.id]);
        } else {
          await db.run(
            'INSERT INTO answers (submission_id, question_id, answer_encrypted, awarded_marks, is_correct) VALUES (?, ?, NULL, ?, 0)',
            [submissionId, q.id, 0]
          );
        }
      } else {
        // text questions need a human to award marks later
        hasUngraded = true;
      }
    }

    await db.run(
      `UPDATE submissions SET status = ?, score = ?, submitted_at = datetime('now') WHERE id = ?`,
      [hasUngraded ? 'submitted_pending_review' : 'graded', autoScore, submissionId]
    );

    res.json({ message: 'Test submitted.', autoScore, pendingManualGrading: hasUngraded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit test.' });
  }
});

// ---------- Teacher: view all results for a test ----------
router.get('/tests/:id/results', requireRole('teacher'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const test = await db.get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [testId, req.user.id]);
    if (!test) return res.status(403).json({ error: 'You do not own this test.' });

    const submissions = await db.all(
      `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM submissions s JOIN users u ON u.id = s.student_id
       WHERE s.test_id = ? ORDER BY s.submitted_at DESC`,
      [testId]
    );
    res.json({ test, submissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load results.' });
  }
});

// ---------- Teacher: view one submission in full (to manually grade text answers) ----------
router.get('/:submissionId', requireRole('teacher'), async (req, res) => {
  try {
    const submissionId = parseInt(req.params.submissionId, 10);
    const submission = await db.get('SELECT * FROM submissions WHERE id = ?', [submissionId]);
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });

    const test = await db.get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [submission.test_id, req.user.id]);
    if (!test) return res.status(403).json({ error: 'You do not own this test.' });

    const questions = await db.all('SELECT * FROM questions WHERE test_id = ? ORDER BY order_index ASC, id ASC', [submission.test_id]);
    const answers = await db.all('SELECT * FROM answers WHERE submission_id = ?', [submissionId]);
    const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

    const items = questions.map((q) => {
      const ans = answerByQuestion.get(q.id);
      return {
        questionId: q.id,
        type: q.type,
        content: cryptoUtil.decrypt(q.content_encrypted),
        marks: q.marks,
        studentAnswer: ans && ans.answer_encrypted ? cryptoUtil.decrypt(ans.answer_encrypted) : null,
        awardedMarks: ans ? ans.awarded_marks : null,
        isCorrect: ans ? !!ans.is_correct : null,
        answerId: ans ? ans.id : null,
      };
    });

    res.json({ submission, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load submission.' });
  }
});

// ---------- Teacher: award marks for a text (manually graded) answer ----------
router.put('/answers/:answerId/grade', requireRole('teacher'), async (req, res) => {
  try {
    const answerId = parseInt(req.params.answerId, 10);
    const { awardedMarks } = req.body || {};
    if (typeof awardedMarks !== 'number' || awardedMarks < 0) {
      return res.status(400).json({ error: 'awardedMarks must be a non-negative number.' });
    }

    const answer = await db.get('SELECT * FROM answers WHERE id = ?', [answerId]);
    if (!answer) return res.status(404).json({ error: 'Answer not found.' });

    const submission = await db.get('SELECT * FROM submissions WHERE id = ?', [answer.submission_id]);
    const test = await db.get('SELECT * FROM tests WHERE id = ? AND teacher_id = ?', [submission.test_id, req.user.id]);
    if (!test) return res.status(403).json({ error: 'You do not own this test.' });

    await db.run('UPDATE answers SET awarded_marks = ? WHERE id = ?', [awardedMarks, answerId]);

    // Recompute the submission's total score and flip to fully "graded" once
    // every answer has a mark assigned.
    const allAnswers = await db.all('SELECT * FROM answers WHERE submission_id = ?', [submission.id]);
    const total = allAnswers.reduce((sum, a) => sum + (a.awarded_marks || 0), 0);
    const allGraded = allAnswers.every((a) => a.awarded_marks !== null);
    await db.run('UPDATE submissions SET score = ?, status = ? WHERE id = ?', [total, allGraded ? 'graded' : 'submitted_pending_review', submission.id]);

    res.json({ message: 'Marks awarded.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not award marks.' });
  }
});

// ---------- Student: view my own result once graded ----------
router.get('/tests/:id/my-result', requireRole('student'), async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const submission = await db.get('SELECT * FROM submissions WHERE test_id = ? AND student_id = ?', [testId, req.user.id]);
    if (!submission) return res.status(404).json({ error: 'You have not taken this test.' });
    res.json({ submission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load result.' });
  }
});

module.exports = router;
