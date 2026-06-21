const cron = require('node-cron');
const fs = require('fs');
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

const activeJobs = new Map(); // key: `status:${id}` or `reminder:${id}` -> cron task

async function postScheduledStatus(sock, post) {
  try {
    const message = {};
    if (post.media_path && fs.existsSync(post.media_path)) {
      const buffer = fs.readFileSync(post.media_path);
      const isVideo = /\.(mp4|mov|mkv)$/i.test(post.media_path);
      if (isVideo) {
        message.video = buffer;
      } else {
        message.image = buffer;
      }
      if (post.caption) message.caption = post.caption;
    } else if (post.caption) {
      message.text = post.caption;
    } else {
      logger.warn({ postId: post.id }, 'Scheduled status post has no caption or media, skipping');
      return;
    }

    await sock.sendMessage('status@broadcast', message);
    await markScheduledStatusPostRun(post.id);
    logger.info({ postId: post.id }, 'Posted scheduled status');
  } catch (err) {
    logger.error({ err, postId: post.id }, 'Failed to post scheduled status');
  }
}

async function sendReminder(sock, reminder) {
  try {
    await sock.sendMessage(reminder.target_jid, { text: reminder.message });
    if (reminder.notify_admin && reminder.created_by !== reminder.target_jid) {
      await sock.sendMessage(reminder.created_by, {
        text: `🔔 Reminder sent to ${reminder.target_jid}: "${reminder.message}"`,
      });
    }
    await markReminderRun(reminder.id);
    logger.info({ reminderId: reminder.id }, 'Sent reminder');
  } catch (err) {
    logger.error({ err, reminderId: reminder.id }, 'Failed to send reminder');
  }
}

/**
 * Loads all active scheduled status posts and recurring reminders from the
 * database and registers cron jobs for them. Also starts a 1-minute poller
 * for one-off reminders (run_at based, not cron-based).
 */
async function startScheduler(sock) {
  // Clear any existing jobs before reloading (used on refresh)
  for (const job of activeJobs.values()) job.stop();
  activeJobs.clear();

  const posts = await getActiveScheduledStatusPosts();
  for (const post of posts) {
    if (!cron.validate(post.cron_expression)) {
      logger.warn({ postId: post.id, cron: post.cron_expression }, 'Invalid cron expression, skipping');
      continue;
    }
    const job = cron.schedule(post.cron_expression, () => postScheduledStatus(sock, post));
    activeJobs.set(`status:${post.id}`, job);
  }

  const reminders = await getActiveRecurringReminders();
  for (const reminder of reminders) {
    if (!cron.validate(reminder.cron_expression)) {
      logger.warn({ reminderId: reminder.id }, 'Invalid cron expression, skipping');
      continue;
    }
    const job = cron.schedule(reminder.cron_expression, () => sendReminder(sock, reminder));
    activeJobs.set(`reminder:${reminder.id}`, job);
  }

  // One-off reminders (specific date/time, not recurring) — checked every minute.
  cron.schedule('* * * * *', async () => {
    try {
      const due = await getDueOneOffReminders();
      for (const reminder of due) {
        await sendReminder(sock, reminder);
      }
    } catch (err) {
      logger.error({ err }, 'Error checking due one-off reminders');
    }
  });

  logger.info(
    { statusPosts: posts.length, recurringReminders: reminders.length },
    'Scheduler started'
  );
}

/**
 * Call this after creating/removing a scheduled post or reminder via a
 * command, so the new cron job picks up immediately without a restart.
 */
async function refreshScheduler(sock) {
  await startScheduler(sock);
}

module.exports = { startScheduler, refreshScheduler };
