const { query } = require('./pool');

async function createBroadcast(createdBy, body, totalRecipients) {
  const res = await query(
    `INSERT INTO broadcasts (created_by, body, total_recipients, status)
     VALUES ($1, $2, $3, 'running') RETURNING *`,
    [createdBy, body, totalRecipients]
  );
  return res.rows[0];
}

async function updateBroadcastProgress(id, sentCount, failedCount) {
  await query(
    `UPDATE broadcasts SET sent_count = $2, failed_count = $3 WHERE id = $1`,
    [id, sentCount, failedCount]
  );
}

async function completeBroadcast(id) {
  await query(
    `UPDATE broadcasts SET status = 'completed', completed_at = NOW() WHERE id = $1`,
    [id]
  );
}

module.exports = { createBroadcast, updateBroadcastProgress, completeBroadcast };
