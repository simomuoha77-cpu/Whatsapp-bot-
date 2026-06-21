const { register } = require('./registry');
const {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
} = require('../db/userFeatures');

function parseTargetJid(numberStr) {
  if (!numberStr) return null;
  const digits = numberStr.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

register('setfeature', {
  description:
    'Toggle a feature for a specific user (admin only) — usage: !setfeature <number> <feature> on/off',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const [numberArg, featureArg, stateArg] = args;
    const jid = parseTargetJid(numberArg);

    if (!jid || !featureArg || !['on', 'off'].includes((stateArg || '').toLowerCase())) {
      await reply(
        `Usage: !setfeature <number> <feature> on/off\n\n` +
        `Available features: ${FEATURE_COLUMNS.join(', ')}\n\n` +
        `Example: !setfeature 254712345678 auto_react on`
      );
      return;
    }

    if (!FEATURE_COLUMNS.includes(featureArg)) {
      await reply(`Unknown feature "${featureArg}". Available: ${FEATURE_COLUMNS.join(', ')}`);
      return;
    }

    const enabled = stateArg.toLowerCase() === 'on';
    await setFeature(jid, featureArg, enabled);
    await reply(`✅ ${FEATURE_LABELS[featureArg]} is now ${enabled ? 'ON' : 'OFF'} for ${jid}`);
  },
});

register('myfeatures', {
  description: 'Show the current feature settings for a user (admin only) — usage: !myfeatures <number>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const jid = parseTargetJid(args[0]);
    if (!jid) {
      await reply('Usage: !myfeatures <number>');
      return;
    }
    const features = await getFeatures(jid);
    let text = `*Feature settings for ${jid}*\n\n`;
    for (const col of FEATURE_COLUMNS) {
      text += `${features[col] ? '✅' : '❌'} ${FEATURE_LABELS[col]}\n`;
    }
    text += `\nAuto-reply message: "${features.auto_reply_message}"`;
    await reply(text);
  },
});

register('setreply', {
  description:
    'Set the auto-reply (away message) text for a user (admin only) — usage: !setreply <number> <message>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const numberArg = args[0];
    const message = args.slice(1).join(' ').trim();
    const jid = parseTargetJid(numberArg);

    if (!jid || !message) {
      await reply('Usage: !setreply <number> <message text>');
      return;
    }

    await setAutoReplyMessage(jid, message);
    await reply(`✅ Auto-reply message for ${jid} set to: "${message}"`);
  },
});

module.exports = { parseTargetJid };
