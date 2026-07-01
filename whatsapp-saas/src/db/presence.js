const { query } = require('./pool');

async function updatePresence(botId, contactJid, presenceStatus, lastSeenAt) {
  await query(
    `INSERT INTO presence_log (bot_id, contact_jid, presence_status, last_seen_at, recorded_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (bot_id, contact_jid) DO UPDATE SET
       presence_status = $3,
       last_seen_at = COALESCE($4, presence_log.last_seen_at),
       recorded_at = NOW()`,
    [botId, contactJid, presenceStatus, lastSeenAt || null]
  );
}

async function getPresence(botId, contactJid) {
  const res = await query(
    'SELECT * FROM presence_log WHERE bot_id = $1 AND contact_jid = $2',
    [botId, contactJid]
  );
  return res.rows[0] || null;
}

async function getAllPresenceForBot(botId) {
  const res = await query(
    'SELECT * FROM presence_log WHERE bot_id = $1 ORDER BY recorded_at DESC',
    [botId]
  );
  return res.rows;
}

module.exports = { updatePresence, getPresence, getAllPresenceForBot };
