const logger = require('../utils/logger');
const { saveMediaFromMessage } = require('../utils/media');
const { logStatusView } = require('../db/logs');

const STATUS_JID = 'status@broadcast';
const AUTO_VIEW = (process.env.AUTO_VIEW_STATUS || 'true').toLowerCase() === 'true';
const AUTO_DOWNLOAD = (process.env.AUTO_DOWNLOAD_STATUS || 'false').toLowerCase() === 'true';

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

/**
 * Registers listeners on the socket for incoming Status updates.
 * Baileys delivers status updates as regular messages where remoteJid === 'status@broadcast'.
 */
function registerStatusHandler(sock) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key?.remoteJid !== STATUS_JID) continue;
      if (!msg.message) continue;

      const contactJid = msg.key.participant || msg.key.remoteJid;
      const messageType = getMessageType(msg);
      const caption = getCaption(msg);

      logger.info({ contactJid, messageType }, 'New status update received');

      // Mark the status as viewed (shows up as "seen" to the contact, like opening their story)
      if (AUTO_VIEW) {
        try {
          await sock.readMessages([msg.key]);
        } catch (err) {
          logger.warn({ err }, 'Failed to mark status as viewed');
        }
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
