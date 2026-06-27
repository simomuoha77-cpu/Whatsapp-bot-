const { query } = require('./pool');

async function cacheMessageForAntiDelete({
  botId,
  sourceType,
  senderJid,
  senderName,
  senderNumber,
  chatJid,
  isGroup,
  groupName,
  messageType,
  body,
  mediaPath,
  originalSentAt,
}) {
  const res = await query(
    `INSERT INTO deleted_message_captures
      (bot_id, source_type, sender_jid, sender_name, sender_number, chat_jid, is_group, group_name, message_type, body, media_path, original_sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      botId,
      sourceType,
      senderJid,
      senderName || null,
      senderNumber || null,
      chatJid,
      !!isGroup,
      groupName || null,
      messageType,
      body || null,
      mediaPath || null,
      originalSentAt || new Date().toISOString(),
    ]
  );
  return res.rows[0];
}

async function getRecentCapturesForBot(botId, limit = 50) {
  const res = await query(
    'SELECT * FROM deleted_message_captures WHERE bot_id = $1 ORDER BY deleted_at DESC LIMIT $2',
    [botId, limit]
  );
  return res.rows;
}

module.exports = { cacheMessageForAntiDelete, getRecentCapturesForBot };
