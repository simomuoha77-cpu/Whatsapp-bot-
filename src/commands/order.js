const { setState, clearState } = require('../db/sessionState');
const { getProductsForBot, getProductById } = require('../db/products');
const { createOrder } = require('../db/orders');
const logger = require('../utils/logger');

async function notifyOwnerOfOrder(sock, order) {
  try {
    const ownJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
    if (!ownJid) return;
    const text =
      `🛒 *New order*\n\n` +
      `Item: ${order.product_name}${order.price ? ` (KES ${order.price})` : ''}\n` +
      `From: ${order.customer_jid.split('@')[0]}\n` +
      `Phone: ${order.phone}\n` +
      `Address: ${order.address}`;
    await sock.sendMessage(ownJid, { text });
  } catch (err) {
    logger.warn({ err }, 'Failed to notify bot owner of new order');
  }
}

async function handleStatefulFlow({ botId, state, text, reply, sender, sock }) {
  if (state.state === 'awaiting_order_item_freeform') {
    await setState(botId, sender, 'awaiting_order_address', { product: { name: text, price: null } });
    await reply(`Got it: *${text}*. What's the delivery address?`);
    return true;
  }

  if (state.state === 'awaiting_order_choice') {
    const products = state.context.products || [];
    const index = parseInt(text.trim(), 10) - 1;
    const product = products[index];
    if (!product) {
      await reply('Please reply with a valid item number from the list, or type !cancel.');
      return true;
    }
    await setState(botId, sender, 'awaiting_order_address', { product });
    await reply(`Got it: *${product.name}*. What's the delivery address?`);
    return true;
  }

  if (state.state === 'awaiting_order_address') {
    await setState(botId, sender, 'awaiting_order_phone', { ...state.context, address: text });
    await reply(`Thanks. What's the best phone number to reach you on for this order?`);
    return true;
  }

  if (state.state === 'awaiting_order_phone') {
    const { product, address } = state.context;
    const phone = text.trim();
    await clearState(botId, sender);

    const order = await createOrder({
      botId,
      customerJid: sender,
      productId: product.id,
      productName: product.name,
      price: product.price,
      address,
      phone,
    });

    await reply(
      `✅ Order placed!\n\n` +
      `Item: ${product.name}${product.price ? ` (KES ${product.price})` : ''}\n` +
      `Address: ${address}\n` +
      `Phone: ${phone}\n\n` +
      `We'll be in touch shortly to confirm. Type !menu for other commands.`
    );

    if (sock) await notifyOwnerOfOrder(sock, order);
    return true;
  }

  return false;
}

/**
 * Starts the order flow: shows the bot's product catalog and asks the
 * customer to pick one by number. If no products have been set up yet,
 * falls back to the old freeform "type what you want" flow so !order
 * still works for bots that haven't added a catalog.
 */
async function startOrderFlow({ botId, sender, reply }) {
  const products = await getProductsForBot(botId);
  if (products.length === 0) {
    await setState(botId, sender, 'awaiting_order_item_freeform', {});
    await reply('🛒 What would you like to order? (type the item name)');
    return;
  }
  const list = products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — KES ${p.price}` : ''}`).join('\n');
  await setState(botId, sender, 'awaiting_order_choice', { products });
  await reply(`🛒 *Our menu:*\n\n${list}\n\nReply with the item number you'd like to order.`);
}

module.exports = { handleStatefulFlow, startOrderFlow };
