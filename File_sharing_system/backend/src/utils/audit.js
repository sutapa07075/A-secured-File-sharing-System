const { pool } = require('../db/pool');

/**
 * Append-only audit log. Never update or delete rows from this table at the app layer —
 * only a scheduled retention job (with its own justification) should ever prune it.
 */
async function logAction({ actorId, actorEmail, action, documentId, ip, userAgent, metadata }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, document_id, ip_address, user_agent, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actorId || null, actorEmail || null, action, documentId || null, ip || null, userAgent || null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    // Audit logging must never crash the request — log to stderr and move on.
    // eslint-disable-next-line no-console
    console.error('Failed to write audit log', err.message);
  }
}

module.exports = { logAction };
