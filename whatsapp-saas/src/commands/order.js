const { setState, clearState } = require('../db/sessionState');

async function handleStatefulFlow({ botId, state, text, reply, sender }) {
  if (state.state === 'awaiting_order_item') {
    await setState(botId, sender, 'awaiting_order_address', { item: text });
    await reply(`Got it: *${text}*. Now, what's the delivery address?`);
    return true;
  }

  if (state.state === 'awaiting_order_address') {
    const item = state.context.item;
    await clearState(botId, sender);
    await reply(
      `✅ Order placed!\n\nItem: ${item}\nAddress: ${text}\n\n` +
      `An admin will confirm shortly. Type !menu for other commands.`
    );
    return true;
  }

  return false;
}

module.exports = { handleStatefulFlow };
