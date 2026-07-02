const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { logStatusView } = require('../db/logs');
const { pickEmojiForCaption } = require('../utils/statusEmoji');
const { getFeatures } = require('../db/botFeatures');
const { saveStatusMedia } = require('../db/statusSaves');

const STATUS_MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'status-saves');
if (!fs.existsSync(STATUS_MEDIA_ROOT)) fs.mkdirSync(STATUS_MEDIA_ROOT, { recursive: true });

const STATUS_JID = 'status@broadcast';
const REACT_DELAY_MIN_MS = parseInt(process.env.STATUS_REACT_DELAY_MIN_MS || '1500', 10);
const REACT_DELAY_MAX_MS = parseInt(process.env.STATUS_REACT_DELAY_MAX_MS || '5000', 10);
const VIEW_DELAY_MIN_MS = parseInt(process.env.STATUS_VIEW_DELAY_MIN_MS || '800', 10);
const VIEW_DELAY_MAX_MS = parseInt(process.env.STATUS_VIEW_DELAY_MAX_MS || '3000', 10);

// Baileys can redeliver the same status update multiple times (retries,
// multi-device sync, etc.). Without deduplication, the bot would react to
// the same status over and over in a tight loop — which is both spammy
// and a strong signal to WhatsApp's anti-abuse systems. We track which
// status IDs we've already handled, per bot, and skip repeats.
const processedStatusIds = new Map(); // key: `${botId}:${statusId}` -> timestamp
const DEDUPE_TTL_MS = 10 * 60 * 1000; // forget after 10 minutes

function cleanupOldEntries() {
  const now = Date.now();
  for (const [key, ts] of processedStatusIds) {
    if (now - ts > DEDUPE_TTL_MS) processedStatusIds.delete(key);
  }
}
setInterval(cleanupOldEntries, 60 * 1000);

function alreadyProcessed(botId, statusId) {
  const key = `${botId}:${statusId}`;
  if (processedStatusIds.has(key)) return true;
  processedStatusIds.set(key, Date.now());
  return false;
}

/**
 * Per-bot reaction queue. THE CORE FIX: previously, reactToStatus() was
 * called without awaiting it, so when WhatsApp delivered several statuses
 * at once (a common occurrence — multiple contacts posting around the same
 * time, or a backlog after reconnecting), every reaction's random delay
 * started counting down in parallel. They all ended up firing within the
 * same 1-2 second window instead of being spaced apart — a burst pattern
 * that WhatsApp's servers appear to silently drop rather than reject
 * outright (the send call still resolves "successfully" client-side, but
 * the reaction never actually becomes visible to other viewers).
 *
 * This queue forces every reaction for a given bot to fully complete,
 * delay included, before the next one starts — so reactions are always
 * spaced out for real, never sent in a burst, regardless of how many
 * statuses arrive in the same batch from Baileys.
 */
const reactionQueues = new Map(); // botId -> { queue: [], processing: boolean }

function getQueue(botId) {
  if (!reactionQueues.has(botId)) {
    reactionQueues.set(botId, { queue: [], processing: false });
  }
  return reactionQueues.get(botId);
}

function enqueueReaction(botId, task) {
  const q = getQueue(botId);
  q.queue.push(task);
  processQueue(botId);
}

async function processQueue(botId) {
  const q = getQueue(botId);
  if (q.processing) return; // already draining, this call just added to the line
  q.processing = true;
  while (q.queue.length > 0) {
    const task = q.queue.shift();
    try {
      await task();
    } catch (err) {
      logger.warn({ err, botId }, 'Reaction queue task failed');
    }
  }
  q.processing = false;
}

function getMessageType(msg) {
  const keys = Object.keys(msg.message || {});
  return keys.find((k) =>
    ['imageMessage', 'videoMessage', 'audioMessage', 'extendedTextMessage', 'conversation'].includes(k)
  ) || keys[0] || 'unknown';
}

function getCaption(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

function randomDelay(min, max) {
  return new Promise((resolve) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(resolve, ms);
  });
}

function sanitizeFilenamePart(s) {
  return (s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

async function reactToStatus(sock, msg, caption) {
  const emoji = pickEmojiForCaption(caption);
  await randomDelay(REACT_DELAY_MIN_MS, REACT_DELAY_MAX_MS);
  await sock.sendMessage(STATUS_JID, { react: { text: emoji, key: msg.key } });
  return emoji;
}

async function saveStatusIfMedia(botId, msg, messageType, caption, contactJid) {
  if (!['imageMessage', 'videoMessage'].includes(messageType)) return;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    const ext = messageType === 'videoMessage' ? 'mp4' : 'jpg';
    const filename = `${Date.now()}_${sanitizeFilenamePart(contactJid.split('@')[0])}.${ext}`;
    const mediaPath = path.join(STATUS_MEDIA_ROOT, filename);
    fs.writeFileSync(mediaPath, buffer);
    await saveStatusMedia({
      botId,
      contactJid,
      mediaType: messageType === 'videoMessage' ? 'video' : 'image',
      mediaPath,
      caption,
    });
  } catch (err) {
    logger.warn({ err, botId, contactJid }, 'Failed to save status media');
  }
}

/**
 * Registers status (story) handling for one specific bot's socket.
 * Whether it views/reacts at all is controlled entirely by that bot's
 * own feature row — this is exactly the "client only wants auto-status-
 * viewing" control surface.
 */
function registerStatusHandler(sock, botId) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    // Subscription gate — same as messageHandler.js, checked once per batch.
    try {
      const { isSubscriptionActive } = require('../db/subscriptions');
      const active = await isSubscriptionActive(botId);
      if (!active) return;
    } catch (err) {
      logger.error({ err, botId }, 'Failed to check subscription status for status handler, allowing through');
    }

    for (const msg of messages) {
      if (msg.key?.remoteJid !== STATUS_JID) continue;
      if (!msg.message) continue;
      if (!msg.key.id) continue;

      // Skip if we've already handled this exact status update for this bot.
      if (alreadyProcessed(botId, msg.key.id)) continue;

      const contactJid = msg.key.participant || msg.key.remoteJid;
      const messageType = getMessageType(msg);
      const caption = getCaption(msg);

      let features;
      try {
        features = await getFeatures(botId);
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to load bot features for status handling');
        continue;
      }

      if (features.auto_view_status) {
        // Queued and delayed, same as reactions — marking many statuses as
        // viewed in the same instant is a bot-like pattern WhatsApp's spam
        // detection watches for. Spacing them out mimics a real person
        // scrolling through their status feed instead.
        enqueueReaction(botId, async () => {
          await randomDelay(VIEW_DELAY_MIN_MS, VIEW_DELAY_MAX_MS);
          try {
            await sock.readMessages([msg.key]);
          } catch (err) {
            logger.warn({ err, botId }, 'Failed to mark status as viewed');
          }
        });
      }

      if (features.auto_react_status) {
        // Queued, not fired immediately — guarantees true one-at-a-time
        // spacing even when many statuses arrive in the same batch.
        enqueueReaction(botId, async () => {
          const emoji = await reactToStatus(sock, msg, caption);
          logger.info({ botId, contactJid, statusId: msg.key.id, emoji }, 'Reacted to status');
        });
      }

      if (features.auto_status_save_enabled) {
        saveStatusIfMedia(botId, msg, messageType, caption, contactJid).catch((err) =>
          logger.warn({ err, botId }, 'Status save task failed')
        );
      }

      try {
        await logStatusView({
          botId,
          contactJid,
          statusId: msg.key.id,
          mediaType: messageType,
          caption,
        });
      } catch (err) {
        logger.error({ err, botId }, 'Failed to log status view to database');
      }
    }
  });
}

module.exports = { registerStatusHandler };
