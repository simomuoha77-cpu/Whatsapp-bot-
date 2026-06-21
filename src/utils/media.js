const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('./logger');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'downloads');
const STATUS_DIR = path.join(MEDIA_DIR, 'statuses');

function ensureDirs() {
  for (const dir of [MEDIA_DIR, STATUS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

function extensionForType(messageType) {
  const map = {
    imageMessage: 'jpg',
    videoMessage: 'mp4',
    audioMessage: 'ogg',
    documentMessage: 'bin',
    stickerMessage: 'webp',
  };
  return map[messageType] || 'bin';
}

/**
 * Downloads media from a message and saves it to disk.
 * @param {object} msg - the full message object from Baileys
 * @param {string} subDir - subdirectory under /downloads to save into ('statuses', 'incoming', etc.)
 * @returns {Promise<string|null>} path to saved file, or null if no media
 */
async function saveMediaFromMessage(msg, subDir = 'incoming') {
  const messageType = Object.keys(msg.message || {}).find((k) =>
    ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(k)
  );
  if (!messageType) return null;

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }) }
    );
    const targetDir = path.join(MEDIA_DIR, subDir);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const filename = `${Date.now()}_${msg.key.id || 'file'}.${extensionForType(messageType)}`;
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    logger.error({ err }, 'Failed to download media');
    return null;
  }
}

module.exports = { saveMediaFromMessage, MEDIA_DIR, STATUS_DIR };
