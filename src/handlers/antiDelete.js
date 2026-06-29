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
 * Core logic: given a deleted message's id, looks up the cached original,
 * downloads media if needed, logs it, and forwards a copy to the bot's
 * own self-chat. Shared between both possible delivery paths — a
 * protocolMessage seen in messages.upsert, and the dedicated
 * messages.delete event — since different Baileys/WhatsApp versions
 * appear to use one or the other.
 */
async function processDeletedMessageId(sock, botId, messageId) {
  let features;
  try {
    features = await getFeatures(botId);
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to load features for anti-delete check');
    return;
  }
  if (!features.anti_delete_enabled) return;

  const cached = recentMessages.get(messageId);
  if (!cached) {
    logger.info({ botId, messageId }, 'Delete detected but original message not in cache (too old or never seen)');
    return;
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

  // Send the recovered content back into the SAME chat it was deleted
  // from. Note: this means the other participant in the conversation will
  // also see their own deleted message reappear, sent by the bot — the
  // user has explicitly confirmed this is the desired behavior.
  try {
    const header = `🗑️ *This message was deleted, but here's what it said:*`;

    if (mediaPath) {
      const buffer = fs.readFileSync(mediaPath);
      const caption = `${header}${body ? `\n\n${body}` : ''}`;
      const payload =
        messageType === 'video'
          ? { video: buffer, caption }
          : messageType === 'audio'
            ? { audio: buffer, caption, ptt: false }
            : messageType === 'document'
              ? { document: buffer, caption, fileName: body || 'document' }
              : { image: buffer, caption };
      await sock.sendMessage(chatJid, payload);
    } else {
      await sock.sendMessage(chatJid, { text: `${header}\n\n${body || '(no text content)'}` });
    }
  } catch (err) {
    logger.error({ err, botId, chatJid }, 'Failed to resend deleted message into the original chat');
  }

  logger.info({ botId, senderJid, messageType, isGroup }, 'Recovered deleted message');
  recentMessages.delete(messageId);
}

/**
 * Checks if an incoming message (from messages.upsert) is a REVOKE
 * protocol message, and if so processes it via the shared logic above.
 * Returns true if this message was a delete notification (handled or
 * not), so the caller can skip further normal processing for it.
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

  await processDeletedMessageId(sock, botId, originalKey.id);
  return true;
}

/**
 * Registers the dedicated 'messages.delete' event listener for one bot's
 * socket. This is the officially documented event for delete detection
 * in Baileys (separate from messages.upsert's protocolMessage path) —
 * registering both means we catch deletes regardless of which path a
 * given Baileys/WhatsApp version actually uses.
 */
function registerDeleteListener(sock, botId) {
  sock.ev.on('messages.delete', async (item) => {
    try {
      if (item.keys) {
        for (const key of item.keys) {
          if (key?.id) await processDeletedMessageId(sock, botId, key.id);
        }
      }
      // { jid, all: true } form means the whole chat was cleared — nothing
      // specific to recover per-message in that case.
    } catch (err) {
      logger.error({ err, botId }, 'Error in messages.delete handler');
    }
  });
}

module.exports = { cacheIncomingMessage, handlePotentialDelete, registerDeleteListener };
