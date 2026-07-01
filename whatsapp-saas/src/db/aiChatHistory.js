const { query } = require('./pool');

async function addChatMessage(botId, contactJid, role, content) {
  await query(
    `INSERT INTO ai_chat_history (bot_id, contact_jid, role, content) VALUES ($1, $2, $3, $4)`,
    [botId, contactJid, role, content]
  );
}

async function getRecentHistory(botId, contactJid, limit = 10) {
  const res = await query(
    `SELECT role, content FROM ai_chat_history
     WHERE bot_id = $1 AND contact_jid = $2
     ORDER BY created_at DESC LIMIT $3`,
    [botId, contactJid, limit]
  );
  return res.rows.reverse(); // oldest first, for sending to the AI in order
}

module.exports = { addChatMessage, getRecentHistory };
