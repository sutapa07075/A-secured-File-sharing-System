const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'app.db');
const rawDb = new sqlite3.Database(dbPath);

rawDb.run('PRAGMA journal_mode = WAL');
rawDb.run('PRAGMA foreign_keys = ON');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    rawDb.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function columnExists(table, column) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

async function buildSchema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      provider TEXT NOT NULL DEFAULT 'local',
      provider_id TEXT,
      avatar_url TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      lock_until INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await exec(`CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider, provider_id);`);

  // 'role' didn't exist in the original auth-only schema, so add it if missing
  // rather than requiring people to delete their database.
  if (!(await columnExists('users', 'role'))) {
    await exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student';`);
  }

  // Classes are owned by one teacher. Students join via a short class_code.
  await exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS class_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(class_id, student_id)
    );
  `);

  // total_marks is a cached sum of question marks, refreshed whenever questions change.
  await exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      scheduled_start TEXT,
      scheduled_end TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      total_marks REAL NOT NULL DEFAULT 0,
      is_published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // content_encrypted / options_encrypted / correct_answer_encrypted are AES-256-GCM
  // packed strings (see crypto.js). Nothing in this table is ever plaintext.
  // type: 'text' | 'mcq_single'
  await exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content_encrypted TEXT NOT NULL,
      options_encrypted TEXT,
      correct_answer_encrypted TEXT,
      marks REAL NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'in_progress',
      score REAL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT,
      UNIQUE(test_id, student_id)
    );
  `);

  // answer_encrypted stores the student's raw answer, encrypted, so even an
  // admin with DB access can't read what a student wrote.
  await exec(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer_encrypted TEXT,
      awarded_marks REAL,
      is_correct INTEGER,
      UNIQUE(submission_id, question_id)
    );
  `);
}

const schemaReady = buildSchema();

module.exports = { run, get, all, exec, schemaReady };
