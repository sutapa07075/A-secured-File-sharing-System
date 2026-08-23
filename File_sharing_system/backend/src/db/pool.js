const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected Postgres pool error', err);
});

/**
 * Runs `fn` inside a transaction with RLS session variables set,
 * so every query inside automatically respects the documents/permissions policies.
 * Never trust a userId/email passed from the client body — only from the verified JWT.
 */
async function withUserContext({ userId, email }, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId || '']);
    await client.query(`SELECT set_config('app.current_user_email', $1, true)`, [email || '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withUserContext };
