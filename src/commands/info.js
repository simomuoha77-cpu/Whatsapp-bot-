const { register } = require('./registry');
const { getUser } = require('../db/users');
const { countUsers } = require('../db/users');

register('ping', {
  description: 'Check if the bot is online',
  adminOnly: false,
  handler: async ({ reply }) => {
    const start = Date.now();
    await reply('🏓 Pong!');
    const latency = Date.now() - start;
    await reply(`_Response time: ${latency}ms_`);
  },
});

register('info', {
  description: 'Show your account info as the bot sees it',
  adminOnly: false,
  handler: async ({ reply, sender }) => {
    const user = await getUser(sender);
    if (!user) {
      await reply('No record found yet — send a few more messages!');
      return;
    }
    const text =
      `*Your Info*\n\n` +
      `Phone: ${user.phone_number}\n` +
      `First seen: ${new Date(user.first_seen_at).toLocaleString()}\n` +
      `Messages sent: ${user.message_count}\n` +
      `Admin: ${user.is_admin ? 'Yes' : 'No'}`;
    await reply(text);
  },
});

register('stats', {
  description: 'Show bot-wide statistics (admin only)',
  adminOnly: true,
  handler: async ({ reply }) => {
    const total = await countUsers();
    await reply(`*Bot Stats*\n\nTotal known users: ${total}`);
  },
});
