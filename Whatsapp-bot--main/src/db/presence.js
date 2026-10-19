const { getDb } = require('./mongo');

async function updatePresence(botId, contactJid, presenceStatus, lastSeenAt) {
  const db = await getDb();
  const id = Number(botId);
  const existing = await db.collection('presence_log').findOne({ bot_id: id, contact_jid: contactJid });
  await db.collection('presence_log').updateOne(
    { bot_id: id, contact_jid: contactJid },
    { $set: {
        presence_status: presenceStatus,
        last_seen_at: lastSeenAt || (existing ? existing.last_seen_at : null),
        recorded_at: new Date(),
    } },
    { upsert: true }
  );
}

async function getPresence(botId, contactJid) {
  const db = await getDb();
  return db.collection('presence_log').findOne({ bot_id: Number(botId), contact_jid: contactJid });
}

async function getAllPresenceForBot(botId) {
  const db = await getDb();
  return db.collection('presence_log')
    .find({ bot_id: Number(botId) })
    .sort({ recorded_at: -1 })
    .toArray();
}

module.exports = { updatePresence, getPresence, getAllPresenceForBot };
