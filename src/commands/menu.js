const { register, getAll } = require('./registry');

register('menu', {
  description: 'Show this menu of available commands',
  adminOnly: false,
  handler: async ({ reply }) => {
    const prefix = process.env.COMMAND_PREFIX || '!';
    const all = getAll();
    let text = `*${process.env.BOT_NAME || 'Bot'} - Command Menu*\n\n`;
    for (const [name, def] of all) {
      if (def.adminOnly) continue;
      text += `${prefix}${name} - ${def.description}\n`;
    }
    text += `\n_Admin commands available to bot admins only._`;
    await reply(text);
  },
});

register('help', {
  description: 'Alias for !menu',
  adminOnly: false,
  handler: async ({ reply, sock, msg }) => {
    const menuCmd = require('./registry').get('menu');
    await menuCmd.handler({ reply, sock, msg });
  },
});
