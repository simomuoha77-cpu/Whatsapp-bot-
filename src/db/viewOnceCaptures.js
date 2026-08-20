const { getDb, nextSequence } = require('./mongo');

async function logViewOnceCapture({
  botId,
  senderJid,
  senderName,
  senderNumber,
  chatJid,
  isGroup,
  groupName,
  mediaType,
  mediaPath,
  caption,
}) {
  const db = await getDb();
  const id = await nextSequence('view_once_captures');
  const doc = {
    id,
    bot_id: Number(botId),
    sender_jid: senderJid,
    sender_name: senderName || null,
    sender_number: senderNumber || null,
    chat_jid: chatJid,
    is_group: !!isGroup,
    group_name: groupName || null,
    media_type: mediaType,
    media_path: mediaPath || null,
    caption: caption || null,
    captured_at: new Date(),
  };
  await db.collection('view_once_captures').insertOne(doc);
  return doc;
}

async function getViewOnceCapturesForBot(botId, limit = 50) {
  const db = await getDb();
  return db.collection('view_once_captures')
    .find({ bot_id: Number(botId) })
    .sort({ captured_at: -1 })
    .limit(limit)
    .toArray();
}

async function getLatestCaptureForChat(botId, chatJid) {
  const db = await getDb();
  return db.collection('view_once_captures')
    .find({ bot_id: Number(botId), chat_jid: chatJid })
    .sort({ captured_at: -1 })
    .limit(1)
    .next();
}

async function getCapturesForChat(botId, chatJid, limit = 10) {
  const db = await getDb();
  return db.collection('view_once_captures')
    .find({ bot_id: Number(botId), chat_jid: chatJid })
    .sort({ captured_at: -1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  logViewOnceCapture,
  getViewOnceCapturesForBot,
  getLatestCaptureForChat,
  getCapturesForChat,
};
