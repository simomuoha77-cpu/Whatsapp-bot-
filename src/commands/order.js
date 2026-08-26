const { setState, clearState } = require('../db/sessionState');
const { getProductsForBot, getProductById } = require('../db/products');
const { createOrder } = require('../db/orders');
const { getFeatures } = require('../db/botFeatures');
const { generateAiReply } = require('../utils/aiProvider');
const logger = require('../utils/logger');

/**
 * Tries to figure out which product the customer meant, in order of
 * cheapest/most-certain to most-expensive/least-certain:
 *   1. A plain number matching the menu position (the expected path).
 *   2. A substring/word match against product names — catches "I want the
 *      bag" or just "bag" instead of "1", with zero cost or latency.
 *   3. If neither works and this bot has AI Chat enabled, ask the AI to
 *      pick the closest product from the exact list — catches typos,
 *      descriptions, or indirect phrasing ("the blue one", "school bag").
 * Returns the matched product, or null if nothing reasonably matches —
 * callers should fall back to asking again rather than guessing further.
 */
async function matchProduct(botId, products, text) {
  const trimmed = text.trim();

  const index = parseInt(trimmed, 10) - 1;
  if (products[index]) return { product: products[index], aiUsed: false };

  const lower = trimmed.toLowerCase();
  const substringMatches = products.filter(
    (p) => lower.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(lower)
  );
  if (substringMatches.length === 1) return { product: substringMatches[0], aiUsed: false };

  const features = await getFeatures(botId);
  if (!features.ai_chat_enabled) return { product: null, aiUsed: false };

  try {
    const productList = products.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const aiReply = await generateAiReply({
      provider: features.ai_provider,
      systemPrompt:
        `You are matching a customer's message to a product from this exact list:\n${productList}\n\n` +
        `Reply with ONLY the number of the best-matching product, or the word NONE if nothing in the list ` +
        `reasonably matches what they said. Do not explain, just the number or NONE.`,
      history: [],
      userMessage: trimmed,
      botId,
    });
    if (!aiReply) return { product: null, aiUsed: true };
    const aiIndex = parseInt(aiReply.trim(), 10) - 1;
    return { product: products[aiIndex] || null, aiUsed: true };
  } catch (err) {
    logger.warn({ err, botId }, 'AI product matching failed');
    return { product: null, aiUsed: true };
  }
}

/**
 * When AI genuinely looked at the message and still couldn't match a
 * product, generate a natural, contextual clarifying reply instead of
 * showing the exact same canned string every time — this is what makes
 * "AI is helping" actually visible, rather than an invisible NONE that
 * falls back to identical static text whether AI ran or not.
 */
async function generateClarification(botId, products, text, features) {
  try {
    const productList = products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` (KES ${p.price})` : ''}`).join('\n');
    const aiReply = await generateAiReply({
      provider: features.ai_provider,
      systemPrompt:
        `You are a friendly shop assistant on WhatsApp. The customer is picking an item from this menu:\n${productList}\n\n` +
        `Their message didn't clearly match any item. Write a short, warm reply (1-2 sentences) that ` +
        `acknowledges what they said and asks them to reply with the item number. Keep it natural, not robotic.`,
      history: [],
      userMessage: text,
      botId,
    });
    return aiReply || null;
  } catch (err) {
    logger.warn({ err, botId }, 'AI clarification generation failed');
    return null;
  }
}

/**
 * Builds a human-readable payment instructions block from whatever the
 * bot owner configured on their dashboard. Returns '' if they haven't set
 * up a payment method — in that case the order flow just skips this
 * section entirely rather than showing empty/broken instructions.
 */
function buildPaymentInstructions(features) {
  const type = features.payment_method_type;
  const lines = [];
  if (type === 'till' && features.payment_till_number) {
    lines.push(`💳 *Pay via M-Pesa Till*\nTill Number: *${features.payment_till_number}*`);
  } else if (type === 'paybill' && features.payment_paybill_number) {
    lines.push(
      `💳 *Pay via M-Pesa Paybill*\nPaybill: *${features.payment_paybill_number}*` +
      (features.payment_paybill_account ? `\nAccount: *${features.payment_paybill_account}*` : '')
    );
  } else if (type === 'phone' && features.payment_phone_number) {
    lines.push(`💳 *Pay via M-Pesa Send Money*\nPhone: *${features.payment_phone_number}*`);
  }
  if (lines.length === 0) return '';
  if (features.payment_notes) lines.push(features.payment_notes);
  return lines.join('\n');
}

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
    const { product, aiUsed } = await matchProduct(botId, products, text);
    if (!product) {
      if (aiUsed) {
        const features = await getFeatures(botId);
        const clarification = await generateClarification(botId, products, text, features);
        if (clarification) {
          await reply(clarification);
          return true;
        }
      }
      await reply("Sorry, I couldn't tell which item you meant. Please reply with the item *number* from the list above, or type !menu to see everything I can help with.");
      return true;
    }
    await setState(botId, sender, 'awaiting_order_address', { product });
    await reply(`Got it: *${product.name}*. What's the delivery address?`);
    return true;
  }

  if (state.state === 'awaiting_order_address') {
    const address = text.trim();
    // Not trying to verify it's a *real* address (impossible without a
    // maps API) — just catching obviously-not-an-address input like a
    // single stray word, so it doesn't get treated as valid.
    if (address.length < 5) {
      await reply("That doesn't look like a full address — please include enough detail for delivery (e.g. area, street, landmark).");
      return true;
    }
    await setState(botId, sender, 'awaiting_order_phone', { ...state.context, address });
    await reply(`Thanks. What's the best phone number to reach you on for this order?`);
    return true;
  }

  if (state.state === 'awaiting_order_phone') {
    const digitsOnly = text.replace(/[^0-9]/g, '');
    // A real phone number, safaricom-style or otherwise, is going to be at
    // least 9 digits once you strip spaces/dashes/+. Anything shorter is
    // clearly not a phone number, not a judgment call.
    if (digitsOnly.length < 9) {
      await reply("That doesn't look like a valid phone number. Please send just the digits, e.g. 0712345678.");
      return true;
    }
    const { product, address } = state.context;
    const phone = digitsOnly;
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

    const features = await getFeatures(botId);
    const paymentBlock = buildPaymentInstructions(features);

    await reply(
      `✅ Order placed!\n\n` +
      `Item: ${product.name}${product.price ? ` (KES ${product.price})` : ''}\n` +
      `Address: ${address}\n` +
      `Phone: ${phone}\n\n` +
      (paymentBlock ? `${paymentBlock}\n\n` : '') +
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
