const { getDb, nextSequence } = require('./mongo');

async function addChatMessage(botId, contactJid, role, content) {
  const db = await getDb();
  const id = await nextSequence('ai_chat_history');
  await db.collection('ai_chat_history').insertOne({
    id,
    bot_id: Number(botId),
    contact_jid: contactJid,
    role,
    content,
    created_at: new Date(),
  });
}

async function getRecentHistory(botId, contactJid, limit = 10) {
  const db = await getDb();
  const rows = await db.collection('ai_chat_history')
    .find({ bot_id: Number(botId), contact_jid: contactJid })
    .sort({ created_at: -1 })
    .limit(limit)
    .project({ role: 1, content: 1, _id: 0 })
    .toArray();
  return rows.reverse(); // oldest first, for sending to the AI in order
}

async function countAiReplies(botId, sinceDate) {
  const db = await getDb();
  return db.collection('ai_chat_history').countDocuments({
    bot_id: Number(botId),
    role: 'assistant',
    created_at: { $gte: sinceDate },
  });
}

module.exports = { addChatMessage, getRecentHistory, countAiReplies };
