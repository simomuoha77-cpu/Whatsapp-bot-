const { register } = require('./registry');

register('options', {
  description: 'Show an interactive button menu',
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

async function handleInteractiveReply({ sock, botId, sender, selectedId, reply }) {
  switch (selectedId) {
    case 'btn_about':
      await reply(`This is ${process.env.BOT_NAME || 'a bot'}.`);
      break;
    case 'btn_support':
      await reply('Type *!support* or just describe your issue.');
      break;
    case 'btn_menu':
      await require('./registry').get('menu').handler({ reply, sock, botId, sender });
      break;
    default:
      await reply('Option received.');
  }
}

module.exports = { handleInteractiveReply };
