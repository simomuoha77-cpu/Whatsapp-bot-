const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { logStatusView } = require('../db/logs');
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
 * Two independent per-bot queues — one for views, one for reactions.
 *
 * THE CORE FIX (kept): previously, reactToStatus() was called without
 * awaiting it, so when WhatsApp delivered several statuses at once (multiple
 * contacts posting around the same time, or a backlog after reconnecting),
 * every reaction's random delay started counting down in parallel and they
 * all fired within the same 1-2 second window — a burst pattern WhatsApp's
 * servers appear to silently drop rather than reject outright. Each queue
 * still forces its own tasks to fully complete, delay included, one at a
 * time, so reactions stay spaced out for real.
 *
 * WHY TWO QUEUES: views and reactions used to share one queue, chained
 * view-then-react per status. That meant a reaction's 1.5-5s spacing delay
 * blocked the *next* status's view from even starting — so during a busy
 * period (several contacts posting close together), views could lag well
 * behind when statuses were actually posted. Splitting them means viewing
 * stays fast and immediate regardless of how backed up reactions are.
 */
const viewQueues = new Map(); // botId -> { queue: [], processing: boolean }
const reactionQueues = new Map(); // botId -> { queue: [], processing: boolean }

function getQueue(map, botId) {
  if (!map.has(botId)) {
    map.set(botId, { queue: [], processing: false });
  }
  return map.get(botId);
}

function enqueueView(botId, task) {
  const q = getQueue(viewQueues, botId);
  q.queue.push(task);
  processQueue(viewQueues, botId);
}

function enqueueReaction(botId, task) {
  const q = getQueue(reactionQueues, botId);
  q.queue.push(task);
  processQueue(reactionQueues, botId);
}

const TASK_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Task timed out')), ms)),
  ]);
}

async function processQueue(map, botId) {
  const q = getQueue(map, botId);
  if (q.processing) return; // already draining, this call just added to the line
  q.processing = true;
  while (q.queue.length > 0) {
    const task = q.queue.shift();
    try {
      // A hung task (e.g. sendMessage that never resolves because the
      // socket died mid-call during a disconnect) would otherwise leave
      // q.processing stuck true forever — silently blocking every future
      // view/reaction for this bot with no error and no recovery. The
      // timeout guarantees the queue always keeps moving.
      await withTimeout(task(), TASK_TIMEOUT_MS);
    } catch (err) {
      logger.warn({ err, botId }, 'View/reaction queue task failed or timed out');
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

async function reactToStatus(sock, msg) {
  // WhatsApp's status viewer sheet only ever renders the native heart badge
  // for a status reaction, no matter what emoji is actually sent underneath.
  // Sending a rotating/keyword emoji just wastes effort on something that
  // will always display as ❤️ anyway — so send the heart directly.
  const emoji = '❤️';
  await randomDelay(REACT_DELAY_MIN_MS, REACT_DELAY_MAX_MS);

  const participant = msg.key.participant;
  const opts = participant
    ? { statusJidList: [...new Set([participant, sock.user?.id].filter(Boolean))] }
    : undefined;

  await sock.sendMessage(STATUS_JID, { react: { text: emoji, key: msg.key } }, opts);
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
        // Fast, near-immediate queue — separate from reactions, so a
        // backlog of reactions (each spaced 1.5-5s apart) never delays
        // viewing the next status that comes in.
        enqueueView(botId, async () => {
          await randomDelay(VIEW_DELAY_MIN_MS, VIEW_DELAY_MAX_MS);
          try {
            await sock.readMessages([msg.key]);
          } catch (err) {
            logger.warn({ err, botId }, 'Failed to mark status as viewed');
          }

          if (features.auto_react_status) {
            // Anti-Ban Mode: reacting to literally every single status,
            // every time, with zero misses is itself an unnatural pattern —
            // a real person doesn't like every friend's status without
            // exception. Skipping a random ~15% keeps it looking human.
            const shouldSkip = features.anti_ban_mode_enabled !== false && Math.random() < 0.15;
            if (!shouldSkip) {
              enqueueReaction(botId, async () => {
                const emoji = await reactToStatus(sock, msg);
                logger.info({ botId, contactJid, statusId: msg.key.id, emoji }, 'Reacted to status');
              });
            }
          }
        });
      } else if (features.auto_react_status) {
        // Viewing is off but reacting is on — still react on its own.
        const shouldSkip = features.anti_ban_mode_enabled !== false && Math.random() < 0.15;
        if (!shouldSkip) {
          enqueueReaction(botId, async () => {
            const emoji = await reactToStatus(sock, msg);
            logger.info({ botId, contactJid, statusId: msg.key.id, emoji }, 'Reacted to status');
          });
        }
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

function resetQueue(botId) {
  reactionQueues.delete(botId);
}

module.exports = { registerStatusHandler, resetQueue };
