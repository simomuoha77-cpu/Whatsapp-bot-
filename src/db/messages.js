const { query } = require('./pool');

async function logMessage({ botId, jid, messageId, direction, messageType, body, mediaPath }) {
  await query(
    `INSERT INTO messages (bot_id, jid, message_id, direction, message_type, body, media_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [botId, jid, messageId || null, direction, messageType || 'text', body || null, mediaPath || null]
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

// One row per contact, each carrying its most recent message — exactly
// what a real WhatsApp chat list shows (name, last message preview, when),
// sorted by that last message's time so the most recently active
// conversation is first.
async function getRecentChatsForBot(botId, limit = 100) {
  const res = await query(
    `SELECT DISTINCT ON (jid)
       jid, direction, message_type, body, created_at
     FROM messages
     WHERE bot_id = $1
     ORDER BY jid, created_at DESC`,
    [botId]
  );
  return res.rows
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

module.exports = { logMessage, getThreadForContact, deleteThread, getRecentChatsForBot };
