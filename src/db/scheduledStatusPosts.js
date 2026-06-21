const { query } = require('./pool');

async function createScheduledStatusPost({ createdBy, cronExpression, caption, mediaPath }) {
  const res = await query(
    `INSERT INTO scheduled_status_posts (created_by, cron_expression, caption, media_path)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [createdBy, cronExpression, caption || null, mediaPath || null]
  );
  return res.rows[0];
}

async function getActiveScheduledStatusPosts() {
  const res = await query('SELECT * FROM scheduled_status_posts WHERE is_active = TRUE');
  return res.rows;
}

async function getAllScheduledStatusPosts() {
  const res = await query('SELECT * FROM scheduled_status_posts ORDER BY created_at DESC');
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
  getAllScheduledStatusPosts,
  deactivateScheduledStatusPost,
  markScheduledStatusPostRun,
};
