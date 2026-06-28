const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { getFeatures } = require('../db/botFeatures');
const { cacheMessageForAntiDelete } = require('../db/deletedCaptures');

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'anti-delete');
if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });

const recentMessages = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

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

function cacheIncomingMessage(botId, msg) {
  if (!msg.key || !msg.key.id) return;
  recentMessages.set(msg.key.id, { botId: botId, msg: msg, cachedAt: Date.now() });
}

async function processDeletedMessageId(sock, botId, messageId) {
  let features;
  try {
    features = await getFeatures(botId);
  } catch (err) {
    logger.warn({ err: err, botId: botId }, 'Failed to load features for anti-delete check');
    return;
  }
  if (!features.anti_delete_enabled) return;

  const cached = recentMessages.get(messageId);
  if (!cached) {
    logger.info({ botId: botId, messageId: messageId }, 'Delete detected but original message not in cache');
    return;
  }

  const originalMsg = cached.msg;
  const typeAndBody = getMessageTypeAndBody(originalMsg.message);
  const messageType = typeAndBody.type;
  const body = typeAndBody.body;
  const chatJid = originalMsg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = originalMsg.key.participant || (isGroup ? null : chatJid) || chatJid;
  const senderName = originalMsg.pushName || null;
  const senderNumber = senderJid ? senderJid.split('@')[0].split(':')[0] : null;

  let groupName = null;
  if (isGroup) {
    try {
      const meta = await sock.groupMetadata(chatJid);
      groupName = meta && meta.subject ? meta.subject : null;
    } catch (err) {}
  }

  let mediaPath = null;
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(messageType)) {
    try {
      const buffer = await downloadMediaMessage(originalMsg, 'buffer', {}, { logger: logger });
      const extMap = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', sticker: 'webp' };
      const filename = Date.now() + '_' + sanitizeFilenamePart(senderNumber) + '.' + (extMap[messageType] || 'bin');
      mediaPath = path.join(MEDIA_ROOT, filename);
      fs.writeFileSync(mediaPath, buffer);
    } catch (err) {
      logger.warn({ err: err, botId: botId }, 'Failed to download media for deleted message capture');
    }
  }

  try {
    await cacheMessageForAntiDelete({
      botId: botId,
      sourceType: 'message',
      senderJid: senderJid,
      senderName: senderName,
      senderNumber: senderNumber,
      chatJid: chatJid,
      isGroup: isGroup,
      groupName: groupName,
      messageType: messageType,
      body: body,
      mediaPath: mediaPath,
      originalSentAt: originalMsg.messageTimestamp ? new Date(originalMsg.messageTimestamp * 1000).toISOString() : null
    });
  } catch (err) {
    logger.error({ err: err, botId: botId }, 'Failed to log anti-delete capture');
  }

  try {
    const header = '🗑️ *This message was deleted, but here\'s what it said:*';
    if (mediaPath) {
      const buffer = fs.readFileSync(mediaPath);
      const caption = header + (body ? '\n\n' + body : '');
      const payload = messageType === 'video' ? { video: buffer, caption: caption }
        : messageType === 'audio' ? { audio: buffer, caption: caption, ptt: false }
        : messageType === 'document' ? { document: buffer, caption: caption, fileName: body || 'document' }
        : { image: buffer, caption: caption };
      await sock.sendMessage(chatJid, payload);
    } else {
      await sock.sendMessage(chatJid, { text: header + '\n\n' + (body || '(no text content)') });
    }
  } catch (err) {
    logger.error({ err: err, botId: botId, chatJid: chatJid }, 'Failed to resend deleted message into the original chat');
  }

  logger.info({ botId: botId, senderJid: senderJid, messageType: messageType, isGroup: isGroup }, 'Recovered deleted message');
  recentMessages.delete(messageId);
}

async function handlePotentialDelete(sock, botId, msg) {
  const protocolMsg = msg.message && msg.message.protocolMessage;
  if (!protocolMsg) return false;

  try {
    const dbg = require('../db/pool');
    await dbg.query(
      "CREATE TABLE IF NOT EXISTS debug_log (id SERIAL PRIMARY KEY, bot_id INTEGER, has_message BOOLEAN, message_keys TEXT, from_me BOOLEAN, remote_jid TEXT, created_at TIMESTAMPTZ DEFAULT NOW())"
    );
    await dbg.query(
      "INSERT INTO debug_log (bot_id, has_message, message_keys, from_me, remote_jid) VALUES ($1, $2, $3, $4, $5)",
      [botId, true, 'PROTOCOL_MSG type=' + JSON.stringify(protocolMsg.type) + ' keys=' + JSON.stringify(Object.keys(protocolMsg)), (msg.key && msg.key.fromMe) || false, (msg.key && msg.key.remoteJid) || null]
    );
  } catch (debugErr) {}

  const typeVal = protocolMsg.type;
  const knownNonDeleteTypes = ['MESSAGE_EDIT', 14, 'HISTORY_SYNC_NOTIFICATION', 1, 'PEER_DATA_OPERATION_REQUEST_MESSAGE'];
  if (knownNonDeleteTypes.includes(typeVal)) return false;

  const isRevoke = typeVal === 0 || typeVal === 'REVOKE';
  if (!isRevoke) return false;

  const originalKey = protocolMsg.key;
  if (!originalKey || !originalKey.id) return true;

  await processDeletedMessageId(sock, botId, originalKey.id);
  return true;
}

function registerDeleteListener(sock, botId) {
  sock.ev.on('messages.delete', async (item) => {
    try {
      try {
        const dbg = require('../db/pool');
        await dbg.query(
          "INSERT INTO debug_log (bot_id, has_message, message_keys, from_me, remote_jid) VALUES ($1, $2, $3, $4, $5)",
          [botId, true, 'MESSAGES_DELETE_EVENT ' + JSON.stringify(item).slice(0, 300), false, 'MESSAGES_DELETE']
        );
      } catch (debugErr) {}

      if (item.keys) {
        for (const key of item.keys) {
          if (key && key.id) await processDeletedMessageId(sock, botId, key.id);
        }
      }
    } catch (err) {
      logger.error({ err: err, botId: botId }, 'Error in messages.delete handler');
    }
  });
}

module.exports = { cacheIncomingMessage: cacheIncomingMessage, handlePotentialDelete: handlePotentialDelete, registerDeleteListener: registerDeleteListener };
