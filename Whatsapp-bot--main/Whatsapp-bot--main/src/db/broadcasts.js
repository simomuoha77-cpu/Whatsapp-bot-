const { getDb, nextSequence } = require('./mongo');

async function createBroadcast(botId, body, totalRecipients) {
  const db = await getDb();
  const id = await nextSequence('broadcasts');
  const doc = {
    id,
    bot_id: Number(botId),
    body,
    total_recipients: totalRecipients,
    sent_count: 0,
    failed_count: 0,
    status: 'running',
    created_at: new Date(),
    completed_at: null,
  };
  await db.collection('broadcasts').insertOne(doc);
  return doc;
}

async function updateBroadcastProgress(id, sentCount, failedCount) {
  const db = await getDb();
  await db.collection('broadcasts').updateOne(
    { id: Number(id) },
    { $set: { sent_count: sentCount, failed_count: failedCount } }
  );
}

async function completeBroadcast(id) {
  const db = await getDb();
  await db.collection('broadcasts').updateOne(
    { id: Number(id) },
    { $set: { status: 'completed', completed_at: new Date() } }
  );
}

module.exports = { createBroadcast, updateBroadcastProgress, completeBroadcast };
