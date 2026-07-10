const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { getFeatures } = require('../db/botFeatures');
const { logViewOnceCapture } = require('../db/viewOnceCaptures');

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'view-once');
if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });

/**
 * Unwraps a message to find view-once media, regardless of which of the
 * several WhatsApp wrapper formats it arrived in. Modern clients sometimes
 * send a direct imageMessage/videoMessage with viewOnce: true set on the
 * media object itself, rather than wrapping it — both forms are checked.
 *
 * Returns { mediaType: 'image'|'video', mediaMessage, caption } or null
 * if this message isn't a view-once.
 */
function extractViewOnceMedia(message) {
  if (!message) return null;

  // If this chat has disappearing messages on (common, sometimes default
  // for new chats), WhatsApp wraps EVERY incoming message — including
  // view-once photos — in an extra ephemeralMessage layer first. Without
  // unwrapping that, the viewOnceMessage wrapper underneath is invisible
  // to the checks below and the capture silently misses it every time.
  const unwrapped = message.ephemeralMessage ? message.ephemeralMessage.message : message;
  if (!unwrapped) return null;

  // Wrapped forms: viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension
  const wrapper =
    unwrapped.viewOnceMessage ||
    unwrapped.viewOnceMessageV2 ||
    unwrapped.viewOnceMessageV2Extension;

  const inner = wrapper ? wrapper.message : unwrapped;
  if (!inner) return null;

  if (inner.imageMessage && (wrapper || inner.imageMessage.viewOnce)) {
    return { mediaType: 'image', mediaMessage: inner.imageMessage, caption: inner.imageMessage.caption || null };
  }
  if (inner.videoMessage && (wrapper || inner.videoMessage.viewOnce)) {
    return { mediaType: 'video', mediaMessage: inner.videoMessage, caption: inner.videoMessage.caption || null };
  }

  return null;
}

function sanitizeFilenamePart(s) {
  return (s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

/**
 * Checks an incoming message for view-once media. If found and the bot's
 * anti_view_once_enabled feature is on, downloads and saves it silently
 * before it expires, logging sender/chat details. Retrieval happens later,
 * on demand, via the .v command — not by forwarding immediately.
 *
 * Returns true if this message was a view-once and was captured, false
 * otherwise. The caller can use this to skip further normal processing
 * for genuine view-once messages.
 */
async function handlePotentialViewOnce(sock, botId, msg) {
  const viewOnceData = extractViewOnceMedia(msg.message);
  if (!viewOnceData) return false;

  let features;
  try {
    features = await getFeatures(botId);
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to load features for anti-view-once check');
    return false;
  }

  if (!features.anti_view_once_enabled) return false;

  const { mediaType, caption } = viewOnceData;
  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = msg.key.participant || (isGroup ? null : chatJid) || chatJid;
  const senderName = msg.pushName || null;
  const senderNumber = senderJid ? senderJid.split('@')[0].split(':')[0] : null;

  let groupName = null;
  if (isGroup) {
    try {
      const meta = await sock.groupMetadata(chatJid);
      groupName = meta?.subject || null;
    } catch (err) {
      logger.warn({ err, botId, chatJid }, 'Failed to fetch group metadata for view-once log');
    }
  }

  let mediaPath = null;
  try {
    // Download before WhatsApp expires/removes the underlying media.
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    const ext = mediaType === 'video' ? 'mp4' : 'jpg';
    const filename = `${Date.now()}_${sanitizeFilenamePart(senderNumber)}.${ext}`;
    mediaPath = path.join(MEDIA_ROOT, filename);
    fs.writeFileSync(mediaPath, buffer);
  } catch (err) {
    logger.error({ err, botId, senderJid }, 'Failed to download view-once media before it expired');
    return false; // nothing useful to log if we couldn't even save the file
  }

  try {
    await logViewOnceCapture({
      botId,
      senderJid,
      senderName,
      senderNumber,
      chatJid,
      isGroup,
      groupName,
      mediaType,
      mediaPath,
      caption,
    });
  } catch (err) {
    logger.error({ err, botId }, 'Failed to log view-once capture to database');
  }

  logger.info(
    { botId, senderJid, senderName, mediaType, isGroup, groupName, chatJid },
    'Captured view-once media (retrievable via .v in this chat)'
  );

  return true;
}

module.exports = { handlePotentialViewOnce, extractViewOnceMedia };
