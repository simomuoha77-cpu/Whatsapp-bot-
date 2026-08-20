const { getDb, nextSequence } = require('./mongo');

async function logMessage({ botId, jid, messageId, direction, messageType, body, mediaPath }) {
  const db = await getDb();
  const id = await nextSequence('messages');
  await db.collection('messages').insertOne({
    id,
    bot_id: Number(botId),
    jid,
    message_id: messageId || null,
    direction,
    message_type: messageType || 'text',
    body: body || null,
    media_path: mediaPath || null,
    created_at: new Date(),
  });
}

async function getThreadForContact(botId, jid, limit = 200) {
  const db = await getDb();
  return db.collection('messages')
    .find({ bot_id: Number(botId), jid })
    .sort({ created_at: 1 })
    .limit(limit)
    .toArray();
}

async function deleteThread(botId, jid) {
  const db = await getDb();
  await db.collection('messages').deleteMany({ bot_id: Number(botId), jid });
}

// One row per contact, each carrying its most recent message — exactly
// what a real WhatsApp chat list shows (name, last message preview, when),
// sorted by that last message's time so the most recently active
// conversation is first.
async function getRecentChatsForBot(botId, limit = 100) {
  const db = await getDb();
  return db.collection('messages').aggregate([
    { $match: { bot_id: Number(botId) } },
    { $sort: { created_at: -1 } },
    { $group: {
        _id: '$jid',
        jid: { $first: '$jid' },
        direction: { $first: '$direction' },
        message_type: { $first: '$message_type' },
        body: { $first: '$body' },
        created_at: { $first: '$created_at' },
    } },
    { $sort: { created_at: -1 } },
    { $limit: limit },
  ]).toArray();
}

module.exports = { logMessage, getThreadForContact, deleteThread, getRecentChatsForBot };
