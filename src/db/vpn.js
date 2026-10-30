const { getDb, nextSequence } = require('./mongo');

async function getVpnPackages() {
  const db = await getDb();
  return db.collection('vpn_packages').find({}).sort({ day: 1 }).toArray();
}

async function getVpnPackage(day) {
  const db = await getDb();
  return db.collection('vpn_packages').findOne({ day: Number(day) });
}

async function saveVpnPackage({ day, title, amount, uri, active = true }) {
  const db = await getDb();
  const n = Number(day);
  const doc = { day: n, title: String(title || '').trim(), amount: Number(amount), uri: String(uri || '').trim(), active: Boolean(active), updated_at: new Date() };
  await db.collection('vpn_packages').updateOne({ day: n }, { $set: doc, $setOnInsert: { created_at: new Date() } }, { upsert: true });
  return doc;
}

async function getVpnPurchasesForBot(botId) {
  const db = await getDb();
  return db.collection('vpn_purchases').find({ bot_id: Number(botId) }).sort({ purchased_at: -1 }).toArray();
}

async function createVpnPurchase({ botId, day, title, amount, uri, checkoutRequestId, mpesaReceiptNumber }) {
  const db = await getDb();
  const existing = await db.collection('vpn_purchases').findOne({ checkout_request_id: checkoutRequestId });
  if (existing) return existing;
  const doc = { id: await nextSequence('vpn_purchases'), bot_id: Number(botId), day: Number(day), title, amount: Number(amount), uri, checkout_request_id: checkoutRequestId, mpesa_receipt_number: mpesaReceiptNumber || null, purchased_at: new Date() };
  await db.collection('vpn_purchases').insertOne(doc);
  return doc;
}

module.exports = { getVpnPackages, getVpnPackage, saveVpnPackage, getVpnPurchasesForBot, createVpnPurchase };
