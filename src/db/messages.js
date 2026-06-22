const { query } = require('./pool');

async function logMessage({ botId, jid, messageId, direction, messageType, body, mediaPath }) {
  await query(
    `INSERT INTO messages (bot_id, jid, message_id, direction, message_type, body, media_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [botId, jid, messageId || null, direction, messageType || 'text', body || null, mediaPath || null]
  );
}

module.exports = { logMessage };
