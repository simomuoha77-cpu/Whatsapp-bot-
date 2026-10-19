const { register } = require('./registry');
const { getAllContactJids } = require('../db/contacts');
const { createBroadcast, updateBroadcastProgress, completeBroadcast } = require('../db/broadcasts');
const logger = require('../utils/logger');

const DELAY_MIN_MS = parseInt(process.env.BROADCAST_DELAY_MIN_MS || '2000', 10);
const DELAY_MAX_MS = parseInt(process.env.BROADCAST_DELAY_MAX_MS || '6000', 10);
// Sending to very large contact lists in one run looks like bulk/spam
// traffic to WhatsApp regardless of per-message delay. Past this size,
// require the broadcast to be split into multiple smaller runs instead.
const MAX_RECIPIENTS_PER_RUN = parseInt(process.env.BROADCAST_MAX_RECIPIENTS || '200', 10);

function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((res) => setTimeout(res, ms));
}

register('broadcast', {
  description: 'Send a message to all contacts of this bot — usage: !broadcast <message>',
  requiresBroadcast: true,
  handler: async ({ sock, botId, reply, args }) => {
    const text = args.join(' ').trim();
    if (!text) {
      await reply('Usage: !broadcast <message to send to everyone>');
      return;
    }

    const allRecipients = await getAllContactJids(botId);
    if (allRecipients.length === 0) {
      await reply('No recipients found yet.');
      return;
    }

    if (allRecipients.length > MAX_RECIPIENTS_PER_RUN) {
      await reply(
        `⚠️ You have ${allRecipients.length} contacts, which is more than the safe limit of ${MAX_RECIPIENTS_PER_RUN} per broadcast. ` +
        `Sending to that many at once is a strong spam signal to WhatsApp and risks your number getting restricted or banned. ` +
        `Please narrow your contact list or split this into smaller batches over separate days.`
      );
      return;
    }

    const recipients = allRecipients;
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
      // Randomized spacing, not a fixed interval — perfectly uniform timing
      // between messages is itself a pattern WhatsApp's detection watches
      // for, on top of overall volume.
      await randomDelay(DELAY_MIN_MS, DELAY_MAX_MS);
    }

    await completeBroadcast(record.id);
    await reply(`✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}`);
  },
});
