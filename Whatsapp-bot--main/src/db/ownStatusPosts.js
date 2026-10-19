const { getDb, nextSequence } = require('./mongo');

/**
 * Call this right after sock.sendMessage('status@broadcast', ...) succeeds,
 * using the message key it returns, so we know which status to watch for
 * incoming view receipts against.
 */
async function recordOwnStatusPost(botId, messageId, { source = 'manual', caption = null } = {}) {
  const db = await getDb();
  const id = Number(botId);
  const existing = await db.collection('own_status_posts').findOne({ bot_id: id, message_id: messageId });
  if (existing) return existing;
  const postId = await nextSequence('own_status_posts');
  const doc = {
    id: postId,
    bot_id: id,
    message_id: messageId,
    source,
    caption,
    posted_at: new Date(),
  };
  await db.collection('own_status_posts').insertOne(doc);
  return doc;
}

async function getStatusPostByMessageId(botId, messageId) {
  const db = await getDb();
  return db.collection('own_status_posts').findOne({ bot_id: Number(botId), message_id: messageId });
}

async function recordStatusView(botId, statusPostId, viewerJid, viewerName = null) {
  const db = await getDb();
  const existing = await db.collection('own_status_views').findOne({
    status_post_id: Number(statusPostId),
    viewer_jid: viewerJid,
  });
  if (existing) return;
  const id = await nextSequence('own_status_views');
  await db.collection('own_status_views').insertOne({
    id,
    bot_id: Number(botId),
    status_post_id: Number(statusPostId),
    viewer_jid: viewerJid,
    viewer_name: viewerName,
    viewed_at: new Date(),
  });
}

/**
 * Returns recent posts for a bot, each with its viewer count and the list
 * of viewers (name/jid + when), most recent post first.
 */
async function getRecentPostsWithViewers(botId, limit = 10) {
  const db = await getDb();
  const posts = await db.collection('own_status_posts')
    .find({ bot_id: Number(botId) })
    .sort({ posted_at: -1 })
    .limit(limit)
    .toArray();

  const results = [];
  for (const post of posts) {
    const viewers = await db.collection('own_status_views')
      .find({ status_post_id: post.id })
      .sort({ viewed_at: 1 })
      .project({ viewer_jid: 1, viewer_name: 1, viewed_at: 1, _id: 0 })
      .toArray();
    results.push({ ...post, viewers, viewCount: viewers.length });
  }
  return results;
}

module.exports = {
  recordOwnStatusPost,
  getStatusPostByMessageId,
  recordStatusView,
  getRecentPostsWithViewers,
};
