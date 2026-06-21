const { register } = require('./registry');

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
