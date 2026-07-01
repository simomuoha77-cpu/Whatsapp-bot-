const { query } = require('./pool');

async function recordOwnStatusPost(botId, messageId, { source = 'manual', caption = null } = {}) {
  const res = await query(
    `INSERT INTO own_status_posts (bot_id, message_id, source, caption)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bot_id, message_id) DO NOTHING
     RETURNING *`,
    [botId, messageId, source, caption]
  );
  if (res.rows[0]) return res.rows[0];
  const existing = await query(
    'SELECT * FROM own_status_posts WHERE bot_id = $1 AND message_id = $2',
    [botId, messageId]
  );
  return existing.rows[0] || null;
}

async function getStatusPostByMessageId(botId, messageId) {
  const res = await query(
    'SELECT * FROM own_status_posts WHERE bot_id = $1 AND message_id = $2',
    [botId, messageId]
  );
  return res.rows[0] || null;
}

async function recordStatusView(botId, statusPostId, viewerJid, viewerName = null) {
  await query(
    `INSERT INTO own_status_views (bot_id, status_post_id, viewer_jid, viewer_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (status_post_id, viewer_jid) DO NOTHING`,
    [botId, statusPostId, viewerJid, viewerName]
  );
}

async function getRecentPostsWithViewers(botId, limit = 10) {
  const posts = await query(
    `SELECT * FROM own_status_posts WHERE bot_id = $1 ORDER BY posted_at DESC LIMIT $2`,
    [botId, limit]
  );
  const results = [];
  for (const post of posts.rows) {
    const viewers = await query(
      `SELECT viewer_jid, viewer_name, viewed_at FROM own_status_views
       WHERE status_post_id = $1 ORDER BY viewed_at ASC`,
      [post.id]
    );
    results.push({ ...post, viewers: viewers.rows, viewCount: viewers.rows.length });
  }
  return results;
}

module.exports = {
  recordOwnStatusPost,
  getStatusPostByMessageId,
  recordStatusView,
  getRecentPostsWithViewers,
};
