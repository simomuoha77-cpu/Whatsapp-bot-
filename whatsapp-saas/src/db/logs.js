const { query } = require('./pool');

async function logStatusView({ botId, contactJid, statusId, mediaType, mediaPath, caption }) {
  await query(
    `INSERT INTO status_log (bot_id, contact_jid, status_id, media_type, media_path, caption)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [botId, contactJid, statusId || null, mediaType || null, mediaPath || null, caption || null]
  );
}

async function logCommand(botId, jid, command, args) {
  await query(
    `INSERT INTO command_logs (bot_id, jid, command, args) VALUES ($1, $2, $3, $4)`,
    [botId, jid, command, args || null]
  );
}

module.exports = { logStatusView, logCommand };
