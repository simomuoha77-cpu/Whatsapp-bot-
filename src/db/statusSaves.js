const { getDb, nextSequence } = require('./mongo');

async function saveStatusMedia({ botId, contactJid, contactName, mediaType, mediaPath, caption }) {
  const db = await getDb();
  const id = await nextSequence('status_saves');
  const doc = {
    id,
    bot_id: Number(botId),
    contact_jid: contactJid,
    contact_name: contactName || null,
    media_type: mediaType,
    media_path: mediaPath || null,
    caption: caption || null,
    saved_at: new Date(),
  };
  await db.collection('status_saves').insertOne(doc);
  return doc;
}

async function getStatusSavesForBot(botId, limit = 50) {
  const db = await getDb();
  return db.collection('status_saves')
    .find({ bot_id: Number(botId) })
    .sort({ saved_at: -1 })
    .limit(limit)
    .toArray();
}

module.exports = { saveStatusMedia, getStatusSavesForBot };
