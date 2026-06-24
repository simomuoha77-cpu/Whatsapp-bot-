const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { getFeatures } = require('../db/botFeatures');
const { logViewOnceCapture } = require('../db/viewOnceCaptures');

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'view-once');
if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });

function extractViewOnceMedia(message) {
  if (!message) return null;
  const wrapper = message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension;
  const inner = wrapper ? wrapper.message : message;
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

async function handlePotentialViewOnce(sock, botId, msg) {
  const viewOnceData = extractViewOnceMedia(msg.message);
  if (!viewOnceData) return false;

  let features;
  try {
    features = await getFeatures(botId);
  } catch (err) {
    logger.warn({ err: err, botId: botId }, 'Failed to load features for anti-view-once check');
    return false;
  }
  if (!features.anti_view_once_enabled) return false;

  const mediaType = viewOnceData.mediaType;
  const caption = viewOnceData.caption;
  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = msg.key.participant || (isGroup ? null : chatJid) || chatJid;
  const senderName = msg.pushName || null;
  const senderNumber = senderJid ? senderJid.split('@')[0].split(':')[0] : null;

  let groupName = null;
  if (isGroup) {
    try {
      const meta = await sock.groupMetadata(chatJid);
      groupName = meta && meta.subject ? meta.subject : null;
    } catch (err) {
      logger.warn({ err: err, botId: botId, chatJid: chatJid }, 'Failed to fetch group metadata');
    }
  }

  let mediaPath = null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: logger });
    const ext = mediaType === 'video' ? 'mp4' : 'jpg';
    const filename = Date.now() + '_' + sanitizeFilenamePart(senderNumber) + '.' + ext;
    mediaPath = path.join(MEDIA_ROOT, filename);
    fs.writeFileSync(mediaPath, buffer);
  } catch (err) {
    logger.error({ err: err, botId: botId, senderJid: senderJid }, 'Failed to download view-once media before it expired');
    return false;
  }

  try {
    await logViewOnceCapture({
      botId: botId,
      senderJid: senderJid,
      senderName: senderName,
      senderNumber: senderNumber,
      chatJid: chatJid,
      isGroup: isGroup,
      groupName: groupName,
      mediaType: mediaType,
      mediaPath: mediaPath,
      caption: caption
    });
  } catch (err) {
    logger.error({ err: err, botId: botId }, 'Failed to log view-once capture');
  }

  logger.info({ botId: botId, senderJid: senderJid, senderName: senderName, mediaType: mediaType, isGroup: isGroup, groupName: groupName, chatJid: chatJid }, 'Captured view-once media (retrievable via .v in this chat)');
  return true;
}

module.exports = { handlePotentialViewOnce: handlePotentialViewOnce, extractViewOnceMedia: extractViewOnceMedia };
