/**
 * Run this on a schedule (cron, BullMQ repeatable job, etc).
 * Example cron: 0 3 * * *  node src/jobs/retention.js
 *
 * Two responsibilities:
 * 1. Hard-delete documents whose retention window has passed (GDPR/CCPA data-retention policy).
 * 2. Physically clean up B2 objects for documents already crypto-shredded (deleted_at set,
 *    wrapped_dek zeroed) so storage doesn't grow unbounded with unrecoverable ciphertext.
 */
require('dotenv').config();
const { pool } = require('../db/pool');
const storage = require('../services/storage');

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '365', 10);

async function run() {
  console.log(`Running retention job (RETENTION_DAYS=${RETENTION_DAYS})`);

  // 1. Crypto-shred anything past the retention window that hasn't been shredded yet
  const toShred = await pool.query(
    `SELECT id FROM documents
     WHERE deleted_at IS NULL AND created_at < now() - ($1 || ' days')::interval`,
    [RETENTION_DAYS]
  );
  for (const row of toShred.rows) {
    await pool.query(
      `UPDATE documents SET deleted_at = now(), wrapped_dek = '\\x00', file_auth_tag = '\\x00' WHERE id = $1`,
      [row.id]
    );
    console.log(`Crypto-shredded document ${row.id} (retention expired)`);
  }

  // 2. Physically remove B2 objects for documents shredded more than 7 days ago
  const toPurge = await pool.query(
    `SELECT id, b2_key FROM documents
     WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '7 days'`
  );
  for (const row of toPurge.rows) {
    try {
      await storage.deleteObject(row.b2_key);
      await pool.query(`DELETE FROM documents WHERE id = $1`, [row.id]);
      console.log(`Purged B2 object + row for document ${row.id}`);
    } catch (err) {
      console.error(`Failed to purge document ${row.id}:`, err.message);
    }
  }

  await pool.end();
}

run().catch((err) => {
  console.error('Retention job failed', err);
  process.exit(1);
});
