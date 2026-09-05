const { getDb, nextSequence } = require('./mongo');

// Same recurring-vs-one-off split as reminders.js: exactly one of
// cronExpression ("repeat daily at this time") or runAt ("once, at this
// exact date/time") should be set per post.
async function createScheduledGroupPost({
  botId,
  groupJid,
  groupName,
  caption,
  mediaPath,
  mediaType,
  cronExpression,
  runAt,
  timezone,
}) {
  const db = await getDb();
  const id = await nextSequence('scheduled_group_posts');
  const doc = {
    id,
    bot_id: Number(botId),
    group_jid: groupJid,
    group_name: groupName || null,
    caption: caption || null,
    media_path: mediaPath || null,
    media_type: mediaType || null,
    cron_expression: cronExpression || null,
    run_at: runAt || null,
    timezone: timezone || 'UTC',
    is_active: true,
    last_run_at: null,
    created_at: new Date(),
  };
  await db.collection('scheduled_group_posts').insertOne(doc);
  return doc;
}

async function getActiveRecurringGroupPosts() {
  const db = await getDb();
  return db.collection('scheduled_group_posts')
    .find({ is_active: true, cron_expression: { $ne: null } })
    .toArray();
}

async function getDueOneOffGroupPosts() {
  const db = await getDb();
  return db.collection('scheduled_group_posts')
    .find({
      is_active: true,
      run_at: { $ne: null, $lte: new Date() },
      last_run_at: null,
    })
    .toArray();
}

async function getScheduledGroupPostsForBot(botId) {
  const db = await getDb();
  return db.collection('scheduled_group_posts')
    .find({ bot_id: Number(botId) })
    .sort({ created_at: -1 })
    .toArray();
}

async function deactivateScheduledGroupPost(id) {
  const db = await getDb();
  await db.collection('scheduled_group_posts').updateOne({ id: Number(id) }, { $set: { is_active: false } });
}

async function deleteScheduledGroupPost(id) {
  const db = await getDb();
  await db.collection('scheduled_group_posts').deleteOne({ id: Number(id) });
}

async function updateScheduledGroupPostCaption(id, caption) {
  const db = await getDb();
  await db.collection('scheduled_group_posts').updateOne({ id: Number(id) }, { $set: { caption: caption || null } });
}

async function markScheduledGroupPostRun(id, { deactivate } = {}) {
  const db = await getDb();
  const update = { last_run_at: new Date() };
  if (deactivate) update.is_active = false;
  await db.collection('scheduled_group_posts').updateOne({ id: Number(id) }, { $set: update });
}

module.exports = {
  createScheduledGroupPost,
  getActiveRecurringGroupPosts,
  getDueOneOffGroupPosts,
  getScheduledGroupPostsForBot,
  deactivateScheduledGroupPost,
  deleteScheduledGroupPost,
  updateScheduledGroupPostCaption,
  markScheduledGroupPostRun,
};
