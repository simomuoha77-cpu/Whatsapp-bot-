const { register, getAll } = require('./registry');

register('menu', {
  description: 'Show this menu of available commands',
  handler: async ({ reply }) => {
    const prefix = process.env.COMMAND_PREFIX || '!';
    const all = getAll();
    let text = `*${process.env.BOT_NAME || 'Bot'} - Command Menu*\n\n`;
    for (const [name, def] of all) {
      text += `${prefix}${name} - ${def.description}\n`;
    }
    await reply(text);
  },
});

register('help', {
  description: 'Alias for !menu',
  handler: async (ctx) => {
    await require('./registry').get('menu').handler(ctx);
  },
});

register('ping', {
  description: 'Check if the bot is online',
  handler: async ({ reply }) => {
    await reply('🏓 Pong!');
  },
});

register('order', {
  description: 'Start a simple order flow (example)',
  handler: async ({ reply, botId, sender }) => {
    const { setState } = require('../db/sessionState');
    await setState(botId, sender, 'awaiting_order_item', {});
    await reply('🛒 What would you like to order? (type the item name)');
  },
});

register('cancel', {
  description: 'Cancel any in-progress flow',
  handler: async ({ reply, botId, sender }) => {
    const { clearState } = require('../db/sessionState');
    await clearState(botId, sender);
    await reply('Cancelled. Back to normal — type !menu to see commands.');
  },
});
