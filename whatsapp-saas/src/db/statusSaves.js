const { query } = require('./pool');

async function saveStatusMedia({ botId, contactJid, contactName, mediaType, mediaPath, caption }) {
  const res = await query(
    `INSERT INTO status_saves (bot_id, contact_jid, contact_name, media_type, media_path, caption)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [botId, contactJid, contactName || null, mediaType, mediaPath || null, caption || null]
  );
  return res.rows[0];
}

async function getStatusSavesForBot(botId, limit = 50) {
  const res = await query(
    'SELECT * FROM status_saves WHERE bot_id = $1 ORDER BY saved_at DESC LIMIT $2',
    [botId, limit]
  );
  return res.rows;
}

module.exports = { saveStatusMedia, getStatusSavesForBot };
