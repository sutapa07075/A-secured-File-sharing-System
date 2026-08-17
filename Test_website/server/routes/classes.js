const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function generateClassCode() {
  // 6 uppercase alphanumeric chars, e.g. "K3F9QZ" — easy for students to type.
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

// ---------- Teacher: create a class ----------
router.post('/', requireRole('teacher'), async (req, res) => {
  try {
    const { name, subject } = req.body || {};
    if (!name || !subject) {
      return res.status(400).json({ error: 'Class name and subject are required.' });
    }

    let code;
    let attempts = 0;
    do {
      code = generateClassCode();
      attempts += 1;
      const existing = await db.get('SELECT id FROM classes WHERE class_code = ?', [code]);
      if (!existing) break;
    } while (attempts < 10);

    const info = await db.run(
      'INSERT INTO classes (name, subject, teacher_id, class_code) VALUES (?, ?, ?, ?)',
      [name.trim(), subject.trim(), req.user.id, code]
    );
    const created = await db.get('SELECT * FROM classes WHERE id = ?', [info.lastID]);
    res.status(201).json({ class: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create class.' });
  }
});

// ---------- Teacher: list classes I teach ----------
router.get('/mine', requireRole('teacher'), async (req, res) => {
  try {
    const classes = await db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM class_enrollments e WHERE e.class_id = c.id) AS student_count
       FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ classes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load classes.' });
  }
});

// ---------- Student: list classes I'm enrolled in ----------
router.get('/enrolled', requireRole('student'), async (req, res) => {
  try {
    const classes = await db.all(
      `SELECT c.*, u.name AS teacher_name
       FROM classes c
       JOIN class_enrollments e ON e.class_id = c.id
       JOIN users u ON u.id = c.teacher_id
       WHERE e.student_id = ?
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ classes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load classes.' });
  }
});

// ---------- Student: join a class by code ----------
router.post('/join', requireRole('student'), async (req, res) => {
  try {
    const { classCode } = req.body || {};
    if (!classCode) return res.status(400).json({ error: 'Class code is required.' });

    const klass = await db.get('SELECT * FROM classes WHERE class_code = ?', [classCode.trim().toUpperCase()]);
    if (!klass) return res.status(404).json({ error: 'No class found with that code.' });

    const already = await db.get(
      'SELECT id FROM class_enrollments WHERE class_id = ? AND student_id = ?',
      [klass.id, req.user.id]
    );
    if (already) return res.status(409).json({ error: 'You are already enrolled in this class.' });

    await db.run('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)', [klass.id, req.user.id]);
    res.status(201).json({ class: klass });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not join class.' });
  }
});

// ---------- Class detail (Google Classroom-style test list) ----------
// Accessible to: the owning teacher, enrolled students, or admin (metadata only).
router.get('/:id', async (req, res) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Please log in to continue.' });
    }
    const classId = parseInt(req.params.id, 10);
    const klass = await db.get('SELECT * FROM classes WHERE id = ?', [classId]);
    if (!klass) return res.status(404).json({ error: 'Class not found.' });

    const isOwner = req.user.role === 'teacher' && klass.teacher_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    let isEnrolled = false;
    if (req.user.role === 'student') {
      const enrollment = await db.get(
        'SELECT id FROM class_enrollments WHERE class_id = ? AND student_id = ?',
        [classId, req.user.id]
      );
      isEnrolled = !!enrollment;
    }

    if (!isOwner && !isAdmin && !isEnrolled) {
      return res.status(403).json({ error: 'You do not have access to this class.' });
    }

    // Students only ever see published tests; teachers/admin see everything.
    const testsQuery = isOwner || isAdmin
      ? 'SELECT id, title, description, scheduled_start, scheduled_end, duration_minutes, total_marks, is_published, created_at FROM tests WHERE class_id = ? ORDER BY created_at DESC'
      : 'SELECT id, title, description, scheduled_start, scheduled_end, duration_minutes, total_marks, is_published, created_at FROM tests WHERE class_id = ? AND is_published = 1 ORDER BY created_at DESC';
    const tests = await db.all(testsQuery, [classId]);

    res.json({ class: klass, tests, role: isOwner ? 'teacher' : isAdmin ? 'admin' : 'student' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load class.' });
  }
});

module.exports = router;
