const { getDb, nextSequence } = require('./mongo');

async function createScheduledStatusPost({ botId, cronExpression, caption, mediaPath, mediaType }) {
  const db = await getDb();
  const id = await nextSequence('scheduled_status_posts');
  const doc = {
    id,
    bot_id: Number(botId),
    cron_expression: cronExpression,
    caption: caption || null,
    media_path: mediaPath || null,
    media_type: mediaType || null,
    is_active: true,
    last_run_at: null,
    created_at: new Date(),
  };
  await db.collection('scheduled_status_posts').insertOne(doc);
  return doc;
}

async function getActiveScheduledStatusPosts() {
  const db = await getDb();
  return db.collection('scheduled_status_posts').find({ is_active: true }).toArray();
}

async function getScheduledStatusPostsForBot(botId) {
  const db = await getDb();
  return db.collection('scheduled_status_posts')
    .find({ bot_id: Number(botId) })
    .sort({ created_at: -1 })
    .toArray();
}

async function deactivateScheduledStatusPost(id) {
  const db = await getDb();
  await db.collection('scheduled_status_posts').updateOne({ id: Number(id) }, { $set: { is_active: false } });
}

async function markScheduledStatusPostRun(id) {
  const db = await getDb();
  await db.collection('scheduled_status_posts').updateOne({ id: Number(id) }, { $set: { last_run_at: new Date() } });
}

module.exports = {
  createScheduledStatusPost,
  getActiveScheduledStatusPosts,
  getScheduledStatusPostsForBot,
  deactivateScheduledStatusPost,
  markScheduledStatusPostRun,
};
