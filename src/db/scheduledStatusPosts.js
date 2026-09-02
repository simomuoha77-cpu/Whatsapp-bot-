const { getDb, nextSequence } = require('./mongo');

// Same recurring-vs-one-off split used by scheduledGroupPosts.js /
// reminders.js: exactly one of cronExpression ("repeat daily at this time")
// or runAt ("once, at this exact date/time") should be set per post.
async function createScheduledStatusPost({ botId, cronExpression, runAt, timezone, caption, mediaPath, mediaType }) {
  const db = await getDb();
  const id = await nextSequence('scheduled_status_posts');
  const doc = {
    id,
    bot_id: Number(botId),
    cron_expression: cronExpression || null,
    run_at: runAt || null,
    timezone: timezone || 'UTC',
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

async function getActiveRecurringStatusPosts() {
  const db = await getDb();
  return db.collection('scheduled_status_posts')
    .find({ is_active: true, cron_expression: { $ne: null } })
    .toArray();
}

async function getDueOneOffStatusPosts() {
  const db = await getDb();
  return db.collection('scheduled_status_posts')
    .find({
      is_active: true,
      run_at: { $ne: null, $lte: new Date() },
      last_run_at: null,
    })
    .toArray();
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
  getActiveRecurringStatusPosts,
  getDueOneOffStatusPosts,
  getScheduledStatusPostsForBot,
  deactivateScheduledStatusPost,
  markScheduledStatusPostRun,
};
