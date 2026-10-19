const { getDb, nextSequence } = require('./mongo');

async function createReminder({ botId, targetJid, message, cronExpression, runAt, notifyAdmin }) {
  const db = await getDb();
  const id = await nextSequence('reminders');
  const doc = {
    id,
    bot_id: Number(botId),
    target_jid: targetJid,
    message,
    cron_expression: cronExpression || null,
    run_at: runAt || null,
    notify_admin: !!notifyAdmin,
    is_active: true,
    last_run_at: null,
    created_at: new Date(),
  };
  await db.collection('reminders').insertOne(doc);
  return doc;
}

async function getActiveRecurringReminders() {
  const db = await getDb();
  return db.collection('reminders')
    .find({ is_active: true, cron_expression: { $ne: null } })
    .toArray();
}

async function getDueOneOffReminders() {
  const db = await getDb();
  return db.collection('reminders')
    .find({
      is_active: true,
      run_at: { $ne: null, $lte: new Date() },
      last_run_at: null,
    })
    .toArray();
}

async function getRemindersForBot(botId) {
  const db = await getDb();
  return db.collection('reminders')
    .find({ bot_id: Number(botId), is_active: true })
    .sort({ created_at: -1 })
    .toArray();
}

async function markReminderRun(id) {
  const db = await getDb();
  await db.collection('reminders').updateOne({ id: Number(id) }, { $set: { last_run_at: new Date() } });
}

async function deactivateReminder(id) {
  const db = await getDb();
  await db.collection('reminders').updateOne({ id: Number(id) }, { $set: { is_active: false } });
}

module.exports = {
  createReminder,
  getActiveRecurringReminders,
  getDueOneOffReminders,
  getRemindersForBot,
  markReminderRun,
  deactivateReminder,
};
