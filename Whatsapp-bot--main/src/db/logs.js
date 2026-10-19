const { getDb, nextSequence } = require('./mongo');

async function logStatusView({ botId, contactJid, statusId, mediaType, mediaPath, caption }) {
  const db = await getDb();
  const id = await nextSequence('status_log');
  await db.collection('status_log').insertOne({
    id,
    bot_id: Number(botId),
    contact_jid: contactJid,
    status_id: statusId || null,
    media_type: mediaType || null,
    media_path: mediaPath || null,
    caption: caption || null,
    viewed_at: new Date(),
  });
}

async function logCommand(botId, jid, command, args) {
  const db = await getDb();
  const id = await nextSequence('command_logs');
  await db.collection('command_logs').insertOne({
    id,
    bot_id: Number(botId),
    jid,
    command,
    args: args || null,
    executed_at: new Date(),
  });
}

module.exports = { logStatusView, logCommand };
