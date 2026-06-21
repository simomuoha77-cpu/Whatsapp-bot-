const { register } = require('./registry');
const { setBlocked, getUser } = require('../db/users');

function parseTargetJid(args) {
  if (!args[0]) return null;
  const digits = args[0].replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

register('block', {
  description: 'Block a user from using the bot (admin only) — usage: !block <number>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const jid = parseTargetJid(args);
    if (!jid) {
      await reply('Usage: !block <phone number with country code, no +>');
      return;
    }
    await setBlocked(jid, true);
    await reply(`🚫 Blocked ${jid}`);
  },
});

register('unblock', {
  description: 'Unblock a user (admin only) — usage: !unblock <number>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const jid = parseTargetJid(args);
    if (!jid) {
      await reply('Usage: !unblock <phone number with country code, no +>');
      return;
    }
    await setBlocked(jid, false);
    await reply(`✅ Unblocked ${jid}`);
  },
});

register('reactmap', {
  description: 'Show the keyword to emoji map (admin only)',
  adminOnly: true,
  handler: async ({ reply }) => {
    const { KEYWORD_EMOJI_MAP, DEFAULT_EMOJI } = require('../utils/statusEmoji');
    let text = '*Status Auto-React Map*\n\n';
    for (const { keywords, emoji } of KEYWORD_EMOJI_MAP) {
      text += emoji + ' — ' + keywords.join(', ') + '\n';
    }
    text += '\nDefault: ' + DEFAULT_EMOJI;
    await reply(text);
  },
});

register('whois', {
  description: 'Look up a known user (admin only) — usage: !whois <number>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const jid = parseTargetJid(args);
    if (!jid) {
      await reply('Usage: !whois <phone number with country code, no +>');
      return;
    }
    const user = await getUser(jid);
    if (!user) {
      await reply('No record found for that number.');
      return;
    }
    await reply(
      `*User Lookup*\n\n` +
      `JID: ${user.jid}\n` +
      `Messages: ${user.message_count}\n` +
      `Blocked: ${user.is_blocked}\n` +
      `Admin: ${user.is_admin}\n` +
      `First seen: ${new Date(user.first_seen_at).toLocaleString()}`
    );
  },
});
