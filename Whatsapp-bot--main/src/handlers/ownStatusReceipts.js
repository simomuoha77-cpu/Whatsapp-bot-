const logger = require('../utils/logger');
const { getStatusPostByMessageId, recordStatusView } = require('../db/ownStatusPosts');

/**
 * Listens for message-receipt.update events and, when the receipt is a
 * "read" receipt for a status message this bot itself posted (tracked in
 * own_status_posts), records who viewed it. This is how "who viewed my
 * status" gets populated — WhatsApp only tells us about a viewer once
 * they've actually opened the status while this bot is connected.
 *
 * Baileys' MessageUserReceiptUpdate shape: { key: WAMessageKey, receipt: {
 *   userJid, readTimestamp, ... } }. We only care about the read receipt
 *   (receiptTimestamp/readTimestamp present) for status@broadcast keys.
 */
function registerOwnStatusReceiptHandler(sock, botId) {
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const update of updates) {
      try {
        const key = update.key;
        if (!key || key.remoteJid !== 'status@broadcast') continue;
        if (!key.fromMe) continue; // only our own posted statuses matter here
        if (!key.id) continue;

        const receipt = update.receipt || {};
        // A status counts as "viewed" once WhatsApp reports it as read.
        const isRead = Boolean(receipt.readTimestamp || receipt.receiptTimestamp);
        if (!isRead) continue;

        const viewerJid = receipt.userJid || key.participant;
        if (!viewerJid) continue;

        const post = await getStatusPostByMessageId(botId, key.id);
        if (!post) continue; // not one of the statuses we're tracking

        await recordStatusView(botId, post.id, viewerJid);
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to process status view receipt');
      }
    }
  });
}

module.exports = { registerOwnStatusReceiptHandler };
