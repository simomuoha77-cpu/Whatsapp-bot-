const { query } = require('./pool');

async function logViewOnceCapture({ botId, senderJid, senderName, senderNumber, chatJid, isGroup, groupName, mediaType, mediaPath, caption }) {
  const res = await query(
    `INSERT INTO view_once_captures
      (bot_id, sender_jid, sender_name, sender_number, chat_jid, is_group, group_name, media_type, media_path, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [botId, senderJid, senderName || null, senderNumber || null, chatJid, !!isGroup, groupName || null, mediaType, mediaPath || null, caption || null]
  );
  return res.rows[0];
}

async function getViewOnceCapturesForBot(botId, limit = 50) {
  const res = await query('SELECT * FROM view_once_captures WHERE bot_id = $1 ORDER BY captured_at DESC LIMIT $2', [botId, limit]);
  return res.rows;
}

module.exports = { logViewOnceCapture, getViewOnceCapturesForBot };
