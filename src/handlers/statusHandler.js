const logger = require('../utils/logger');
const { saveMediaFromMessage } = require('../utils/media');
const { logStatusView } = require('../db/logs');
const { pickEmojiForCaption } = require('../utils/statusEmoji');

const STATUS_JID = 'status@broadcast';
const AUTO_VIEW = (process.env.AUTO_VIEW_STATUS || 'true').toLowerCase() === 'true';
const AUTO_DOWNLOAD = (process.env.AUTO_DOWNLOAD_STATUS || 'false').toLowerCase() === 'true';
const AUTO_REACT = (process.env.AUTO_REACT_STATUS || 'false').toLowerCase() === 'true';
const REACT_DELAY_MIN_MS = parseInt(process.env.STATUS_REACT_DELAY_MIN_MS || '1500', 10);
const REACT_DELAY_MAX_MS = parseInt(process.env.STATUS_REACT_DELAY_MAX_MS || '5000', 10);

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

function registerStatusHandler(sock) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key?.remoteJid !== STATUS_JID) continue;
      if (!msg.message) continue;

      const contactJid = msg.key.participant || msg.key.remoteJid;
      const messageType = getMessageType(msg);
      const caption = getCaption(msg);

      logger.info({ contactJid, messageType }, 'New status update received');

      if (AUTO_VIEW) {
        try {
          await sock.readMessages([msg.key]);
        } catch (err) {
          logger.warn({ err }, 'Failed to mark status as viewed');
        }
      }

      if (AUTO_REACT) {
        reactToStatus(sock, msg, caption)
          .then((emoji) => logger.info({ contactJid, emoji }, 'Reacted to status'))
          .catch((err) => logger.warn({ err, contactJid }, 'Failed to react to status'));
      }

      let mediaPath = null;
      if (AUTO_DOWNLOAD && ['imageMessage', 'videoMessage', 'audioMessage'].includes(messageType)) {
        mediaPath = await saveMediaFromMessage(msg, 'statuses');
      }

      try {
        await logStatusView({
          contactJid,
          statusId: msg.key.id,
          mediaType: messageType,
          mediaPath,
          caption,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to log status view to database');
      }
    }
  });
}

module.exports = { registerStatusHandler };
