const { query } = require('./pool');

async function createScheduledStatusPost({ botId, cronExpression, caption, mediaPath }) {
  const res = await query(
    `INSERT INTO scheduled_status_posts (bot_id, cron_expression, caption, media_path)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [botId, cronExpression, caption || null, mediaPath || null]
  );
  return res.rows[0];
}

async function getActiveScheduledStatusPosts() {
  const res = await query('SELECT * FROM scheduled_status_posts WHERE is_active = TRUE');
  return res.rows;
}

async function getScheduledStatusPostsForBot(botId) {
  const res = await query(
    'SELECT * FROM scheduled_status_posts WHERE bot_id = $1 ORDER BY created_at DESC',
    [botId]
  );
  return res.rows;
}

async function deactivateScheduledStatusPost(id) {
  await query('UPDATE scheduled_status_posts SET is_active = FALSE WHERE id = $1', [id]);
}

async function markScheduledStatusPostRun(id) {
  await query('UPDATE scheduled_status_posts SET last_run_at = NOW() WHERE id = $1', [id]);
}

module.exports = {
  createScheduledStatusPost,
  getActiveScheduledStatusPosts,
  getScheduledStatusPostsForBot,
  deactivateScheduledStatusPost,
  markScheduledStatusPostRun,
};
