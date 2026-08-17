const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Every route below is admin-only. None of them ever import crypto.js or
// touch content_encrypted / options_encrypted / correct_answer_encrypted /
// answer_encrypted columns — that's what keeps question and answer content
// out of reach for the admin role, even though the admin can see everything else.
router.use(requireRole('admin'));

router.get('/users', async (req, res) => {
  try {
    const users = await db.all(
      'SELECT id, email, name, provider, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load users.' });
  }
});

router.put('/users/:id/role', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { role } = req.body || {};
    if (!['student', 'teacher', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Role must be student, teacher, or admin.' });
    }
    await db.run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    res.json({ message: 'Role updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update role.' });
  }
});

router.get('/classes', async (req, res) => {
  try {
    const classes = await db.all(
      `SELECT c.*, u.name AS teacher_name, u.email AS teacher_email,
              (SELECT COUNT(*) FROM class_enrollments e WHERE e.class_id = c.id) AS student_count
       FROM classes c JOIN users u ON u.id = c.teacher_id
       ORDER BY c.created_at DESC`
    );
    res.json({ classes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load classes.' });
  }
});

// Metadata only: title, schedule, marks total, published state, question COUNT.
// Never the questions themselves.
router.get('/tests', async (req, res) => {
  try {
    const tests = await db.all(
      `SELECT t.id, t.title, t.description, t.scheduled_start, t.scheduled_end,
              t.duration_minutes, t.total_marks, t.is_published, t.created_at,
              c.name AS class_name, c.subject, u.name AS teacher_name,
              (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id) AS question_count,
              (SELECT COUNT(*) FROM submissions s WHERE s.test_id = t.id) AS submission_count
       FROM tests t
       JOIN classes c ON c.id = t.class_id
       JOIN users u ON u.id = t.teacher_id
       ORDER BY t.created_at DESC`
    );
    res.json({ tests, note: 'Question and answer content is end-to-end encrypted and not visible to admin accounts.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load tests.' });
  }
});

module.exports = router;
