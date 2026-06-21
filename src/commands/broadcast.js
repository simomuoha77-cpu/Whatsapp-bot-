const { register } = require('./registry');
const { getAllActiveUsers } = require('../db/users');
const { createBroadcast, updateBroadcastProgress, completeBroadcast } = require('../db/broadcasts');
const logger = require('../utils/logger');

const DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '2000', 10);

register('broadcast', {
  description: 'Send a message to all known users (admin only) — usage: !broadcast <message>',
  adminOnly: true,
  handler: async ({ sock, sender, reply, args }) => {
    const text = args.join(' ').trim();
    if (!text) {
      await reply('Usage: !broadcast <message to send to everyone>');
      return;
    }

    const recipients = await getAllActiveUsers();
    if (recipients.length === 0) {
      await reply('No recipients found yet.');
      return;
    }

    const record = await createBroadcast(sender, text, recipients.length);
    await reply(
      `📢 Starting broadcast to ${recipients.length} user(s). ` +
      `Sending with a ${DELAY_MS}ms delay between messages to avoid rate limits. This may take a while.`
    );

    let sent = 0;
    let failed = 0;

    for (const jid of recipients) {
      try {
        await sock.sendMessage(jid, { text });
        sent++;
      } catch (err) {
        failed++;
        logger.warn({ err, jid }, 'Broadcast send failed for recipient');
      }
      await updateBroadcastProgress(record.id, sent, failed);
      await new Promise((res) => setTimeout(res, DELAY_MS));
    }

    await completeBroadcast(record.id);
    await reply(`✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}`);
  },
});
