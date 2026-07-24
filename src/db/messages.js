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

// One row per contact, each carrying its most recent message — exactly
// what a real WhatsApp chat list shows (name, last message preview, when),
// sorted by that last message's time so the most recently active
// conversation is first. DISTINCT ON does this in a single query instead
// of one extra round-trip per contact.
async function getRecentChatsForBot(botId, limit = 100) {
  const res = await query(
    `SELECT DISTINCT ON (jid)
       jid, direction, message_type, body, created_at
     FROM messages
     WHERE bot_id = $1
     ORDER BY jid, created_at DESC`,
    [botId]
  );
  // DISTINCT ON gives one row per jid but in jid order, not recency order —
  // sort the (already-small, one-per-contact) result set by time here.
  return res.rows
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

module.exports = { logMessage, getThreadForContact, deleteThread, getRecentChatsForBot };
