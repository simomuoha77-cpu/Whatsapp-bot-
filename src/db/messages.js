const { query } = require('./pool');

async function logMessage({ botId, jid, messageId, direction, messageType, body, mediaPath, createdAt }) {
  await query(
    `INSERT INTO messages (bot_id, jid, message_id, direction, message_type, body, media_path, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
     ON CONFLICT (bot_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
    [botId, jid, messageId || null, direction, messageType || 'text', body || null, mediaPath || null, createdAt || null]
  );
}

async function getThreadForContact(botId, jid, limit = 200) {
  const res = await query(
    `SELECT * FROM messages WHERE bot_id = $1 AND jid = $2 ORDER BY created_at ASC LIMIT $3`,
    [botId, jid, limit]
  );
  return res.rows;
}

async function deleteThread(botId, jid) {
  await query(`DELETE FROM messages WHERE bot_id = $1 AND jid = $2`, [botId, jid]);
}

module.exports = { logMessage, getThreadForContact, deleteThread };
