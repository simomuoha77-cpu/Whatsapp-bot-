const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { getFeatures } = require('../db/botFeatures');
const { cacheMessageForAntiDelete } = require('../db/deletedCaptures');

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'anti-delete');
if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });

// In-memory cache of recent messages, keyed by message id, so that when a
// REVOKE protocol message references that id, we can look up what it was
// and forward a copy. Capped and periodically cleared to avoid unbounded
// memory growth — anti-delete only needs to bridge a short window between
// a message arriving and it (possibly) being deleted shortly after.
const recentMessages = new Map(); // messageId -> { botId, msg, cachedAt }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cleanupOldEntries() {
  const now = Date.now();
  for (const [id, entry] of recentMessages) {
    if (now - entry.cachedAt > CACHE_TTL_MS) recentMessages.delete(id);
  }
}
setInterval(cleanupOldEntries, 5 * 60 * 1000);

function sanitizeFilenamePart(s) {
  return (s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function getMessageTypeAndBody(message) {
  if (!message) return { type: 'unknown', body: null };
  if (message.conversation) return { type: 'text', body: message.conversation };
  if (message.extendedTextMessage) return { type: 'text', body: message.extendedTextMessage.text };
  if (message.imageMessage) return { type: 'image', body: message.imageMessage.caption || null };
  if (message.videoMessage) return { type: 'video', body: message.videoMessage.caption || null };
  if (message.audioMessage) return { type: 'audio', body: null };
  if (message.documentMessage) return { type: 'document', body: message.documentMessage.fileName || null };
  if (message.stickerMessage) return { type: 'sticker', body: null };
  return { type: 'unknown', body: null };
}

/**
 * Caches an incoming message in memory (for quick lookup if it's deleted
 * shortly after) — called for every message regardless of whether
 * anti_delete is enabled, since we don't know in advance which messages
 * will get deleted. The actual feature check happens at delete-detection
 * time, not at cache time, so toggling the feature on/off doesn't require
 * pre-emptively knowing what to cache.
 */
function cacheIncomingMessage(botId, msg) {
  if (!msg.key?.id) return;
  recentMessages.set(msg.key.id, { botId, msg, cachedAt: Date.now() });
}

/**
 * Checks if an incoming message is a REVOKE protocol message (a delete
 * notification). If so, and anti_delete is enabled for this bot, looks up
 * the cached original message, downloads its media if needed, logs it,
 * and forwards a copy to the bot's own "Message Yourself" chat.
 *
 * Returns true if this message was a delete notification (handled or not),
 * so the caller can skip further normal processing for it.
 */
async function handlePotentialDelete(sock, botId, msg) {
  const protocolMsg = msg.message?.protocolMessage;
  if (!protocolMsg) return false;

  // Baileys/WAProto may represent the REVOKE type as the number 0 or the
  // string 'REVOKE' depending on version. Explicitly exclude other known
  // protocol message types (message edits, history sync notifications,
  // etc.) so we don't misfire on those.
  const typeVal = protocolMsg.type;
  const knownNonDeleteTypes = ['MESSAGE_EDIT', 14, 'HISTORY_SYNC_NOTIFICATION', 1, 'PEER_DATA_OPERATION_REQUEST_MESSAGE'];
  if (knownNonDeleteTypes.includes(typeVal)) return false;

  const isRevoke = typeVal === 0 || typeVal === 'REVOKE';
  if (!isRevoke) return false;

  const originalKey = protocolMsg.key;
  if (!originalKey?.id) return true; // it's a revoke, but nothing to look up

  let features;
  try {
    features = await getFeatures(botId);
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to load features for anti-delete check');
    return true;
  }
  if (!features.anti_delete_enabled) return true;

  const cached = recentMessages.get(originalKey.id);
  if (!cached) {
    logger.info({ botId, messageId: originalKey.id }, 'Delete detected but original message not in cache (too old or never seen)');
    return true;
  }

  const originalMsg = cached.msg;
  const { type: messageType, body } = getMessageTypeAndBody(originalMsg.message);
  const chatJid = originalMsg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = originalMsg.key.participant || (isGroup ? null : chatJid) || chatJid;
  const senderName = originalMsg.pushName || null;
  const senderNumber = senderJid ? senderJid.split('@')[0].split(':')[0] : null;

  let groupName = null;
  if (isGroup) {
    try {
      const meta = await sock.groupMetadata(chatJid);
      groupName = meta?.subject || null;
    } catch (err) {
      // non-fatal
    }
  }

  let mediaPath = null;
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(messageType)) {
    try {
      const buffer = await downloadMediaMessage(originalMsg, 'buffer', {}, { logger });
      const extMap = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', sticker: 'webp' };
      const filename = `${Date.now()}_${sanitizeFilenamePart(senderNumber)}.${extMap[messageType] || 'bin'}`;
      mediaPath = path.join(MEDIA_ROOT, filename);
      fs.writeFileSync(mediaPath, buffer);
    } catch (err) {
      logger.warn({ err, botId }, 'Failed to download media for deleted message capture');
    }
  }

  try {
    await cacheMessageForAntiDelete({
      botId,
      sourceType: 'message',
      senderJid,
      senderName,
      senderNumber,
      chatJid,
      isGroup,
      groupName,
      messageType,
      body,
      mediaPath,
      originalSentAt: originalMsg.messageTimestamp
        ? new Date(originalMsg.messageTimestamp * 1000).toISOString()
        : null,
    });
  } catch (err) {
    logger.error({ err, botId }, 'Failed to log anti-delete capture');
  }

  // Forward a notice (and media, if any) to the bot's own self-chat.
  try {
    const ownJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
    if (ownJid) {
      const where = isGroup ? `group "${groupName || chatJid}"` : 'a direct chat';
      const header =
        `🗑️ *Deleted Message Recovered*\n\n` +
        `From: ${senderName || 'Unknown'} (${senderNumber || 'unknown number'})\n` +
        `In: ${where}\n` +
        `Date: ${new Date().toLocaleString()}`;

      if (mediaPath) {
        const buffer = fs.readFileSync(mediaPath);
        const caption = `${header}${body ? `\n\nCaption: ${body}` : ''}`;
        const payload =
          messageType === 'video'
            ? { video: buffer, caption }
            : messageType === 'audio'
              ? { audio: buffer, caption, ptt: false }
              : messageType === 'document'
                ? { document: buffer, caption, fileName: body || 'document' }
                : { image: buffer, caption };
        await sock.sendMessage(ownJid, payload);
      } else {
        await sock.sendMessage(ownJid, { text: `${header}\n\nMessage: ${body || '(no text content)'}` });
      }
    }
  } catch (err) {
    logger.error({ err, botId }, 'Failed to forward deleted message to self-chat');
  }

  logger.info({ botId, senderJid, messageType, isGroup }, 'Recovered deleted message');
  recentMessages.delete(originalKey.id);
  return true;
}

module.exports = { cacheIncomingMessage, handlePotentialDelete };
