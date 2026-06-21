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

register('features', {
  description:
    'Open an interactive menu to toggle features for a user (admin only) — usage: !features <number>',
  adminOnly: true,
  handler: async ({ sock, sender, reply, args }) => {
    const jid = parseTargetJid(args[0]);
    if (!jid) {
      await reply('Usage: !features <number>\n\nExample: !features 254712345678');
      return;
    }

    const features = await getFeatures(jid);
    const rows = FEATURE_COLUMNS.map((col) => ({
      title: `${features[col] ? '✅ ON' : '❌ OFF'} — ${FEATURE_LABELS[col]}`,
      rowId: `feature_toggle:${jid}:${col}`,
      description: `Tap to turn ${features[col] ? 'OFF' : 'ON'}`,
    }));

    await sock.sendMessage(sender, {
      text: `Feature settings for ${jid}\nTap any feature below to toggle it:`,
      footer: process.env.BOT_NAME || 'Bot',
      title: 'Feature Menu',
      buttonText: 'Open Menu',
      sections: [{ title: 'Features', rows }],
    });
  },
});

register('options', {
  description: 'Show an interactive button menu',
  adminOnly: false,
  handler: async ({ sock, sender }) => {
    await sock.sendMessage(sender, {
      text: 'Choose an option below:',
      footer: process.env.BOT_NAME || 'Bot',
      buttons: [
        { buttonId: 'btn_about', buttonText: { displayText: 'About' }, type: 1 },
        { buttonId: 'btn_support', buttonText: { displayText: 'Support' }, type: 1 },
        { buttonId: 'btn_menu', buttonText: { displayText: 'Full Menu' }, type: 1 },
      ],
      headerType: 1,
    });
  },
});

register('catalog', {
  description: 'Show an interactive list menu (example for product/service listing)',
  adminOnly: false,
  handler: async ({ sock, sender }) => {
    await sock.sendMessage(sender, {
      text: 'Browse our categories:',
      footer: process.env.BOT_NAME || 'Bot',
      title: 'Catalog',
      buttonText: 'View Categories',
      sections: [
        {
          title: 'Categories',
          rows: [
            { title: 'Electronics', rowId: 'cat_electronics', description: 'Phones, laptops, accessories' },
            { title: 'Clothing', rowId: 'cat_clothing', description: 'Shirts, shoes, accessories' },
            { title: 'Support', rowId: 'cat_support', description: 'Talk to a human' },
          ],
        },
      ],
    });
  },
});

/**
 * Handles button/list reply clicks. Called from the main message handler
 * when a message contains a buttonsResponseMessage or listResponseMessage.
 */
async function handleInteractiveReply({ sock, sender, selectedId, reply }) {
  if (selectedId && selectedId.startsWith('feature_toggle:')) {
    const rest = selectedId.slice('feature_toggle:'.length);
    const lastColon = rest.lastIndexOf(':');
    const jid = rest.slice(0, lastColon);
    const feature = rest.slice(lastColon + 1);
    const { isAdmin } = require('../db/users');

    if (!(await isAdmin(sender))) {
      await reply('🚫 Only admins can change feature settings.');
      return;
    }

    const current = await getFeatures(jid);
    const newValue = !current[feature];
    await setFeature(jid, feature, newValue);
    await reply(`✅ ${FEATURE_LABELS[feature]} is now ${newValue ? 'ON' : 'OFF'} for ${jid}`);

    // Re-show the menu with updated states so the admin can keep toggling
    await require('./registry').get('features').handler({ sock, sender, reply, args: [jid.split('@')[0]] });
    return;
  }

  switch (selectedId) {
    case 'btn_about':
      await reply(`This is ${process.env.BOT_NAME || 'a bot'} — built to handle messages, menus, and more.`);
      break;
    case 'btn_support':
      await reply('Type *!support* or just describe your issue and an admin will be notified.');
      break;
    case 'btn_menu':
      await require('./registry').get('menu').handler({ reply, sock, sender });
      break;
    case 'cat_electronics':
      await reply('📱 Electronics: (connect this to your real product list / database)');
      break;
    case 'cat_clothing':
      await reply('👕 Clothing: (connect this to your real product list / database)');
      break;
    case 'cat_support':
      await reply('A human will be with you shortly. In the meantime, describe your issue here.');
      break;
    default:
      await reply('Option received.');
  }
}

module.exports = { handleInteractiveReply };
