const { register } = require('./registry');
const { setState, clearState } = require('../db/sessionState');

register('order', {
  description: 'Start a simple order flow (example of multi-step conversation)',
  adminOnly: false,
  handler: async ({ reply, sender }) => {
    await setState(sender, 'awaiting_order_item', {});
    await reply('🛒 What would you like to order? (type the item name)');
  },
});

register('cancel', {
  description: 'Cancel any in-progress flow (like an order)',
  adminOnly: false,
  handler: async ({ reply, sender }) => {
    await clearState(sender);
    await reply('Cancelled. Back to normal — type !menu to see commands.');
  },
});

/**
 * Handles free-text replies when the user is mid-flow (state != idle).
 * Called from the main message router before falling through to command parsing.
 * Returns true if it handled the message, false to let normal processing continue.
 */
async function handleStatefulFlow({ state, text, reply, sender }) {
  if (state.state === 'awaiting_order_item') {
    await setState(sender, 'awaiting_order_address', { item: text });
    await reply(`Got it: *${text}*. Now, what's the delivery address?`);
    return true;
  }

  if (state.state === 'awaiting_order_address') {
    const item = state.context.item;
    await clearState(sender);
    await reply(
      `✅ Order placed!\n\nItem: ${item}\nAddress: ${text}\n\n` +
      `An admin will confirm shortly. Type !menu for other commands.`
    );
    return true;
  }

  return false;
}

module.exports = { handleStatefulFlow };
