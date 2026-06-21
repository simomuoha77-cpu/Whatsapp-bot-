const { query } = require('./pool');

async function logStatusView({ contactJid, statusId, mediaType, mediaPath, caption }) {
  await query(
    `INSERT INTO status_log (contact_jid, status_id, media_type, media_path, caption)
     VALUES ($1, $2, $3, $4, $5)`,
    [contactJid, statusId || null, mediaType || null, mediaPath || null, caption || null]
  );
}

async function logCommand(jid, command, args) {
  await query(
    `INSERT INTO command_logs (jid, command, args) VALUES ($1, $2, $3)`,
    [jid, command, args || null]
  );
}

module.exports = { logStatusView, logCommand };
