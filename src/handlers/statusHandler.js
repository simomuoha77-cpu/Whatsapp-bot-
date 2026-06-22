const logger = require('../utils/logger');
const { logStatusView } = require('../db/logs');
const { pickEmojiForCaption } = require('../utils/statusEmoji');
const { getFeatures } = require('../db/botFeatures');

const STATUS_JID = 'status@broadcast';
const REACT_DELAY_MIN_MS = parseInt(process.env.STATUS_REACT_DELAY_MIN_MS || '1500', 10);
const REACT_DELAY_MAX_MS = parseInt(process.env.STATUS_REACT_DELAY_MAX_MS || '5000', 10);

// Baileys can redeliver the same status update multiple times (retries,
// multi-device sync, etc.). Without deduplication, the bot would react to
// the same status over and over in a tight loop — which is both spammy
// and a strong signal to WhatsApp's anti-abuse systems. We track which
// status IDs we've already handled, per bot, and skip repeats.
// Capped and periodically cleared so this doesn't grow forever.
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

async function reactToStatus(sock, msg, caption) {
  const emoji = pickEmojiForCaption(caption);
  await randomDelay(REACT_DELAY_MIN_MS, REACT_DELAY_MAX_MS);
  await sock.sendMessage(STATUS_JID, { react: { text: emoji, key: msg.key } });
  return emoji;
}

/**
 * Registers status (story) handling for one specific bot's socket.
 * Whether it views/reacts at all is controlled entirely by that bot's
 * own feature row — this is exactly the "client only wants auto-status-
 * viewing" control surface.
 */
function registerStatusHandler(sock, botId) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
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
        try {
          await sock.readMessages([msg.key]);
        } catch (err) {
          logger.warn({ err, botId }, 'Failed to mark status as viewed');
        }
      }

      if (features.auto_react_status) {
        reactToStatus(sock, msg, caption)
          .then((emoji) => logger.info({ botId, contactJid, statusId: msg.key.id, emoji }, 'Reacted to status'))
          .catch((err) => logger.warn({ err, botId, contactJid, statusId: msg.key.id }, 'Failed to react to status'));
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
