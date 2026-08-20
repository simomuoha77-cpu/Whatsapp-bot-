const bcrypt = require('bcryptjs');
const { getDb, nextSequence } = require('./mongo');

async function createClientAccount(botId, phoneNumber, plainPassword) {
  const db = await getDb();
  const hash = await bcrypt.hash(plainPassword, 10);
  const id = await nextSequence('client_accounts');
  const doc = {
    id,
    bot_id: Number(botId),
    phone_number: phoneNumber,
    password_hash: hash,
    created_at: new Date(),
  };
  await db.collection('client_accounts').insertOne(doc);
  return doc;
}

async function getClientAccountByPhone(phoneNumber) {
  const db = await getDb();
  return db.collection('client_accounts').findOne({ phone_number: phoneNumber });
}

async function getClientAccountByBotId(botId) {
  const db = await getDb();
  return db.collection('client_accounts').findOne({ bot_id: Number(botId) });
}

async function verifyClientLogin(phoneNumber, plainPassword) {
  const account = await getClientAccountByPhone(phoneNumber);
  if (!account) return null;
  const ok = await bcrypt.compare(plainPassword, account.password_hash);
  return ok ? account : null;
}

module.exports = {
  createClientAccount,
  getClientAccountByPhone,
  getClientAccountByBotId,
  verifyClientLogin,
};
