const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'app.db');
const rawDb = new sqlite3.Database(dbPath);

rawDb.run('PRAGMA journal_mode = WAL');
rawDb.run('PRAGMA foreign_keys = ON');

// Promise wrappers so the rest of the app can use async/await instead of callbacks.
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.run(sql, params, function (err) {
      if (err) return reject(err);
      // `this` inside the callback carries lastID / changes for INSERT/UPDATE/DELETE.
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

// Users table.
// password_hash is NULL for accounts created purely via OAuth (Google/GitHub).
const schemaReady = exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT,
    provider TEXT NOT NULL DEFAULT 'local',   -- 'local' | 'google' | 'github'
    provider_id TEXT,
    avatar_url TEXT,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    lock_until INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`).then(() => exec(`
  CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider, provider_id);
`));

module.exports = { run, get, all, exec, schemaReady };
