const { getDb, nextSequence } = require('./mongo');

async function addProduct(botId, name, price) {
  const db = await getDb();
  const id = await nextSequence('products');
  const doc = {
    id,
    bot_id: Number(botId),
    name,
    price: Number(price),
    is_active: true,
    created_at: new Date(),
  };
  await db.collection('products').insertOne(doc);
  return doc;
}

async function getProductsForBot(botId) {
  const db = await getDb();
  return db.collection('products')
    .find({ bot_id: Number(botId), is_active: true })
    .sort({ created_at: 1 })
    .toArray();
}

async function getAllProductsForBot(botId) {
  const db = await getDb();
  return db.collection('products')
    .find({ bot_id: Number(botId) })
    .sort({ created_at: -1 })
    .toArray();
}

async function getProductById(botId, productId) {
  const db = await getDb();
  return db.collection('products').findOne({ bot_id: Number(botId), id: Number(productId) });
}

async function deleteProduct(botId, productId) {
  const db = await getDb();
  await db.collection('products').deleteOne({ bot_id: Number(botId), id: Number(productId) });
}

module.exports = { addProduct, getProductsForBot, getAllProductsForBot, getProductById, deleteProduct };
