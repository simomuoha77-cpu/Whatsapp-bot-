const { query } = require('./pool');

async function logMessage({ jid, messageId, direction, messageType, body, mediaPath }) {
  await query(
    `INSERT INTO messages (jid, message_id, direction, message_type, body, media_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jid, messageId || null, direction, messageType || 'text', body || null, mediaPath || null]
  );
}

async function getRecentHistory(jid, limit = 20) {
  const res = await query(
    `SELECT * FROM messages WHERE jid = $1 ORDER BY created_at DESC LIMIT $2`,
    [jid, limit]
  );
  return res.rows.reverse();
}

module.exports = { logMessage, getRecentHistory };
