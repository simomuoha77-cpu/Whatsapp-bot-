const { query } = require('./pool');

async function createReminder({ createdBy, targetJid, message, cronExpression, runAt, notifyAdmin }) {
  const res = await query(
    `INSERT INTO reminders (created_by, target_jid, message, cron_expression, run_at, notify_admin)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [createdBy, targetJid, message, cronExpression || null, runAt || null, !!notifyAdmin]
  );
  return res.rows[0];
}

async function getActiveRecurringReminders() {
  const res = await query(
    `SELECT * FROM reminders WHERE is_active = TRUE AND cron_expression IS NOT NULL`
  );
  return res.rows;
}

async function getDueOneOffReminders() {
  const res = await query(
    `SELECT * FROM reminders
     WHERE is_active = TRUE AND run_at IS NOT NULL AND run_at <= NOW() AND last_run_at IS NULL`
  );
  return res.rows;
}

async function getRemindersForUser(targetJid) {
  const res = await query(
    'SELECT * FROM reminders WHERE target_jid = $1 AND is_active = TRUE ORDER BY created_at DESC',
    [targetJid]
  );
  return res.rows;
}

async function markReminderRun(id) {
  await query('UPDATE reminders SET last_run_at = NOW() WHERE id = $1', [id]);
}

async function deactivateReminder(id) {
  await query('UPDATE reminders SET is_active = FALSE WHERE id = $1', [id]);
}

module.exports = {
  createReminder,
  getActiveRecurringReminders,
  getDueOneOffReminders,
  getRemindersForUser,
  markReminderRun,
  deactivateReminder,
};
