const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, nextSequence } = require('./mongo');

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex'); // short, e.g. "a1b2c3d4"
}

async function createClientAccount(botId, phoneNumber, plainPassword, referredByCode = null) {
  const db = await getDb();
  const hash = await bcrypt.hash(plainPassword, 10);
  const id = await nextSequence('client_accounts');

  let referralCode = generateReferralCode();
  // Extremely unlikely to collide at this scale, but guard anyway.
  while (await db.collection('client_accounts').findOne({ referral_code: referralCode })) {
    referralCode = generateReferralCode();
  }

  const doc = {
    id,
    bot_id: Number(botId),
    phone_number: phoneNumber,
    password_hash: hash,
    referral_code: referralCode,
    referred_by: referredByCode || null,
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

async function getClientAccountByReferralCode(code) {
  const db = await getDb();
  return db.collection('client_accounts').findOne({ referral_code: code });
}

async function countReferrals(referralCode) {
  const db = await getDb();
  return db.collection('client_accounts').countDocuments({ referred_by: referralCode });
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
  getClientAccountByReferralCode,
  countReferrals,
  verifyClientLogin,
};
