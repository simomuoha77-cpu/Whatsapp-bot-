const { register } = require('./registry');
const { getAllContactJids } = require('../db/contacts');
const { createBroadcast, updateBroadcastProgress, completeBroadcast } = require('../db/broadcasts');
const logger = require('../utils/logger');

const DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '2000', 10);

register('broadcast', {
  description: 'Send a message to all contacts of this bot — usage: !broadcast <message>',
  requiresBroadcast: true,
  handler: async ({ sock, botId, reply, args }) => {
    const text = args.join(' ').trim();
    if (!text) {
      await reply('Usage: !broadcast <message to send to everyone>');
      return;
    }

    const recipients = await getAllContactJids(botId);
    if (recipients.length === 0) {
      await reply('No recipients found yet.');
      return;
    }

    const record = await createBroadcast(botId, text, recipients.length);
    await reply(`📢 Starting broadcast to ${recipients.length} contact(s)...`);

    let sent = 0, failed = 0;
    for (const jid of recipients) {
      try {
        await sock.sendMessage(jid, { text });
        sent++;
      } catch (err) {
        failed++;
        logger.warn({ err, jid, botId }, 'Broadcast send failed');
      }
      await updateBroadcastProgress(record.id, sent, failed);
      await new Promise((res) => setTimeout(res, DELAY_MS));
    }

    await completeBroadcast(record.id);
    await reply(`✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}`);
  },
});
