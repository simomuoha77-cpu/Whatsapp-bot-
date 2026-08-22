const { getDb, nextSequence } = require('./mongo');

async function createOrder({ botId, customerJid, productId, productName, price, address, phone }) {
  const db = await getDb();
  const id = await nextSequence('orders');
  const doc = {
    id,
    bot_id: Number(botId),
    customer_jid: customerJid,
    product_id: productId || null,
    product_name: productName,
    price: price || null,
    address,
    phone,
    status: 'pending',
    created_at: new Date(),
  };
  await db.collection('orders').insertOne(doc);
  return doc;
}

async function getOrdersForBot(botId, limit = 50) {
  const db = await getDb();
  return db.collection('orders')
    .find({ bot_id: Number(botId) })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

async function setOrderStatus(botId, orderId, status) {
  const db = await getDb();
  await db.collection('orders').updateOne(
    { bot_id: Number(botId), id: Number(orderId) },
    { $set: { status } }
  );
}

module.exports = { createOrder, getOrdersForBot, setOrderStatus };
