const cron = require('node-cron');
const logger = require('../utils/logger');
const {
  getActiveScheduledStatusPosts,
  markScheduledStatusPostRun,
} = require('../db/scheduledStatusPosts');
const {
  getActiveRecurringReminders,
  getDueOneOffReminders,
  markReminderRun,
} = require('../db/reminders');
const { getBotState } = require('../utils/botManager');

const activeJobs = new Map();

async function postScheduledStatus(post) {
  const botState = getBotState(post.bot_id);
  if (!botState || !botState.sock || botState.status !== 'connected') {
    logger.warn({ postId: post.id, botId: post.bot_id }, 'Bot not connected, skipping scheduled status post');
    return;
  }
  try {
    const message = post.caption ? { text: post.caption } : null;
    if (!message) return;
    await botState.sock.sendMessage('status@broadcast', message);
    await markScheduledStatusPostRun(post.id);
    logger.info({ postId: post.id, botId: post.bot_id }, 'Posted scheduled status');
  } catch (err) {
    logger.error({ err, postId: post.id }, 'Failed to post scheduled status');
  }
}

async function sendReminder(reminder) {
  const botState = getBotState(reminder.bot_id);
  if (!botState || !botState.sock || botState.status !== 'connected') {
    logger.warn({ reminderId: reminder.id, botId: reminder.bot_id }, 'Bot not connected, skipping reminder');
    return;
  }
  try {
    await botState.sock.sendMessage(reminder.target_jid, { text: reminder.message });
    await markReminderRun(reminder.id);
    logger.info({ reminderId: reminder.id, botId: reminder.bot_id }, 'Sent reminder');
  } catch (err) {
    logger.error({ err, reminderId: reminder.id }, 'Failed to send reminder');
  }
}

/**
 * Loads all active scheduled status posts and recurring reminders across
 * ALL bots and registers cron jobs for them. Each job looks up the live
 * socket for its bot_id at run time, so it always uses the current
 * connection (even after reconnects).
 */
async function startScheduler() {
  for (const job of activeJobs.values()) job.stop();
  activeJobs.clear();

  const posts = await getActiveScheduledStatusPosts();
  for (const post of posts) {
    if (!cron.validate(post.cron_expression)) continue;
    const job = cron.schedule(post.cron_expression, () => postScheduledStatus(post));
    activeJobs.set(`status:${post.id}`, job);
  }

  const reminders = await getActiveRecurringReminders();
  for (const reminder of reminders) {
    if (!cron.validate(reminder.cron_expression)) continue;
    const job = cron.schedule(reminder.cron_expression, () => sendReminder(reminder));
    activeJobs.set(`reminder:${reminder.id}`, job);
  }

  cron.schedule('* * * * *', async () => {
    try {
      const due = await getDueOneOffReminders();
      for (const reminder of due) await sendReminder(reminder);
    } catch (err) {
      logger.error({ err }, 'Error checking due one-off reminders');
    }
  });

  logger.info(
    { statusPosts: posts.length, recurringReminders: reminders.length },
    'Scheduler started (covers all bots)'
  );
}

async function refreshScheduler() {
  await startScheduler();
}

module.exports = { startScheduler, refreshScheduler };
