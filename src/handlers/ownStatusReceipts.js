const logger = require('../utils/logger');
const { getStatusPostByMessageId, recordStatusView } = require('../db/ownStatusPosts');

function registerOwnStatusReceiptHandler(sock, botId) {
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const update of updates) {
      try {
        const key = update.key;
        if (!key || key.remoteJid !== 'status@broadcast') continue;
        if (!key.fromMe) continue;
        if (!key.id) continue;

        const receipt = update.receipt || {};
        const isRead = Boolean(receipt.readTimestamp || receipt.receiptTimestamp);
        if (!isRead) continue;

        const viewerJid = receipt.userJid || key.participant;
        if (!viewerJid) continue;

        const post = await getStatusPostByMessageId(botId, key.id);
        if (!post) continue;

        await recordStatusView(botId, post.id, viewerJid);
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to process status view receipt');
      }
    }
  });
}

module.exports = { registerOwnStatusReceiptHandler };
