const { getDb, nextSequence } = require('./mongo');

async function cacheMessageForAntiDelete({
  botId,
  sourceType,
  senderJid,
  senderName,
  senderNumber,
  chatJid,
  isGroup,
  groupName,
  messageType,
  body,
  mediaPath,
  originalSentAt,
}) {
  const db = await getDb();
  const id = await nextSequence('deleted_message_captures');
  const doc = {
    id,
    bot_id: Number(botId),
    source_type: sourceType,
    sender_jid: senderJid,
    sender_name: senderName || null,
    sender_number: senderNumber || null,
    chat_jid: chatJid,
    is_group: !!isGroup,
    group_name: groupName || null,
    message_type: messageType,
    body: body || null,
    media_path: mediaPath || null,
    deleted_at: new Date(),
    original_sent_at: originalSentAt || new Date().toISOString(),
  };
  await db.collection('deleted_message_captures').insertOne(doc);
  return doc;
}

async function getRecentCapturesForBot(botId, limit = 50) {
  const db = await getDb();
  return db.collection('deleted_message_captures')
    .find({ bot_id: Number(botId) })
    .sort({ deleted_at: -1 })
    .limit(limit)
    .toArray();
}

module.exports = { cacheMessageForAntiDelete, getRecentCapturesForBot };
