const fs = require('fs');
const cron = require('node-cron');
const logger = require('../utils/logger');
const {
  getActiveRecurringStatusPosts,
  getDueOneOffStatusPosts,
  markScheduledStatusPostRun,
} = require('../db/scheduledStatusPosts');
const {
  getActiveRecurringGroupPosts,
  getDueOneOffGroupPosts,
  markScheduledGroupPostRun,
} = require('../db/scheduledGroupPosts');
const {
  getActiveRecurringReminders,
  getDueOneOffReminders,
  markReminderRun,
} = require('../db/reminders');
const { getBotState, getKnownContactJids } = require('../utils/botManager');
const { recordOwnStatusPost } = require('../db/ownStatusPosts');

const activeJobs = new Map();

/**
 * Builds a Baileys sendMessage payload from a scheduled post record.
 * Handles all three shapes: media+caption, media only, caption-only text.
 * Returns null if there's genuinely nothing to send (no media, no caption).
 */
function buildMessagePayload(post) {
  if (post.media_path) {
    if (!fs.existsSync(post.media_path)) {
      logger.warn({ postId: post.id, mediaPath: post.media_path }, 'Scheduled post media file is missing on disk, skipping');
      return null;
    }
    const buffer = fs.readFileSync(post.media_path);
    const caption = post.caption || undefined;
    if (post.media_type === 'video') {
      return { video: buffer, caption };
    }
    // Default to image for any non-video media type (including legacy rows
    // that predate media_type being recorded).
    return { image: buffer, caption };
  }
  if (post.caption) return { text: post.caption };
  return null;
}

async function postScheduledStatus(post) {
  const botState = getBotState(post.bot_id);
  if (!botState || !botState.sock || botState.status !== 'connected') {
    logger.warn({ postId: post.id, botId: post.bot_id }, 'Bot not connected, skipping scheduled status post');
    return;
  }
  try {
    const message = buildMessagePayload(post);
    if (!message) return;
    // Only pass statusJidList when we actually have contacts to put in it.
    // An EMPTY list is not "no preference" — it explicitly tells WhatsApp
    // "deliver to nobody," which text quietly tolerates (hence it always
    // showing 0 views) but which can make image/video status uploads fail
    // outright, since WhatsApp needs that list to know how to encrypt/
    // distribute the media at all. With no history sync, this bot's
    // contacts cache is often empty — so omit the option and let WhatsApp
    // fall back to its own default audience (the account's status privacy
    // list), same as plain sendMessage('status@broadcast', ...) does.
    const knownContacts = getKnownContactJids(post.bot_id);
    const sendOpts = knownContacts.length > 0 ? { statusJidList: knownContacts } : undefined;
    const sent = await botState.sock.sendMessage('status@broadcast', message, sendOpts);
    if (sent?.key?.id) {
      await recordOwnStatusPost(post.bot_id, sent.key.id, { source: 'scheduled', caption: post.caption });
    }
    await markScheduledStatusPostRun(post.id, { deactivate: !!post.run_at });
    logger.info({ postId: post.id, botId: post.bot_id }, 'Posted scheduled status');
  } catch (err) {
    logger.error({ err, postId: post.id }, 'Failed to post scheduled status');
  }
}

async function postScheduledGroupPost(post) {
  const botState = getBotState(post.bot_id);
  if (!botState || !botState.sock || botState.status !== 'connected') {
    logger.warn({ postId: post.id, botId: post.bot_id }, 'Bot not connected, skipping scheduled group post');
    return;
  }
  try {
    const message = buildMessagePayload(post);
    if (!message) return;
    await botState.sock.sendMessage(post.group_jid, message);
    await markScheduledGroupPostRun(post.id, { deactivate: !!post.run_at });
    logger.info({ postId: post.id, botId: post.bot_id, groupJid: post.group_jid }, 'Posted scheduled group post');
  } catch (err) {
    logger.error({ err, postId: post.id }, 'Failed to post scheduled group post');
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
 * Loads all active scheduled status posts, scheduled group posts, and
 * recurring reminders across ALL bots and registers cron jobs for them.
 * Each job looks up the live socket for its bot_id at run time, so it
 * always uses the current connection (even after reconnects).
 */
async function startScheduler() {
  for (const job of activeJobs.values()) job.stop();
  activeJobs.clear();

  const posts = await getActiveRecurringStatusPosts();
  for (const post of posts) {
    if (!cron.validate(post.cron_expression)) continue;
    const job = cron.schedule(post.cron_expression, () => postScheduledStatus(post), { timezone: post.timezone || 'UTC' });
    activeJobs.set(`status:${post.id}`, job);
  }

  const recurringGroupPosts = await getActiveRecurringGroupPosts();
  for (const post of recurringGroupPosts) {
    if (!cron.validate(post.cron_expression)) continue;
    const job = cron.schedule(post.cron_expression, () => postScheduledGroupPost(post), { timezone: post.timezone || 'UTC' });
    activeJobs.set(`group:${post.id}`, job);
  }

  const reminders = await getActiveRecurringReminders();
  for (const reminder of reminders) {
    if (!cron.validate(reminder.cron_expression)) continue;
    const job = cron.schedule(reminder.cron_expression, () => sendReminder(reminder));
    activeJobs.set(`reminder:${reminder.id}`, job);
  }

  // One-off, run-once-at-a-specific-date items — checked every minute,
  // same pattern as reminders' existing one-off check.
  cron.schedule('* * * * *', async () => {
    try {
      const due = await getDueOneOffReminders();
      for (const reminder of due) await sendReminder(reminder);
    } catch (err) {
      logger.error({ err }, 'Error checking due one-off reminders');
    }

    try {
      const dueGroupPosts = await getDueOneOffGroupPosts();
      for (const post of dueGroupPosts) await postScheduledGroupPost(post);
    } catch (err) {
      logger.error({ err }, 'Error checking due one-off group posts');
    }

    try {
      const dueStatusPosts = await getDueOneOffStatusPosts();
      for (const post of dueStatusPosts) await postScheduledStatus(post);
    } catch (err) {
      logger.error({ err }, 'Error checking due one-off status posts');
    }
  });

  logger.info(
    { statusPosts: posts.length, recurringGroupPosts: recurringGroupPosts.length, recurringReminders: reminders.length },
    'Scheduler started (covers all bots)'
  );
}

async function refreshScheduler() {
  await startScheduler();
}

module.exports = { startScheduler, refreshScheduler };
