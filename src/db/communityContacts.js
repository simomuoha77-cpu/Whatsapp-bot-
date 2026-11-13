const { getDb } = require('./mongo');

async function getCommunityContactForBot(botId) {
  const db = await getDb();
  return db.collection('community_contacts').findOne({ bot_id: Number(botId) }, { projection: { _id: 0, bot_id: 1, name: 1, phone_number: 1, opted_in: 1 } });
}

async function registerCommunityContact({ botId, name, phoneNumber }) {
  const db = await getDb();
  const now = new Date();
  // One active community identity per bot and one owner per phone number.
  const existing = await db.collection('community_contacts').findOne({ phone_number: phoneNumber, bot_id: { $ne: Number(botId) } });
  if (existing) throw new Error('That WhatsApp number is already used by another community member.');
  await db.collection('community_contacts').updateOne(
    { bot_id: Number(botId) },
    { $set: { bot_id: Number(botId), name, phone_number: phoneNumber, opted_in: true, updated_at: now }, $setOnInsert: { created_at: now } },
    { upsert: true }
  );
}

async function withdrawCommunityContact(botId) {
  const db = await getDb();
  await db.collection('community_contacts').updateOne({ bot_id: Number(botId) }, { $set: { opted_in: false, updated_at: new Date() } });
}

async function getCommunityContacts(excludeBotId) {
  const db = await getDb();
  return db.collection('community_contacts')
    .find({ opted_in: true, bot_id: { $ne: Number(excludeBotId) } }, { projection: { _id: 0, name: 1, phone_number: 1 } })
    .sort({ created_at: 1 })
    .toArray();
}

module.exports = { registerCommunityContact, getCommunityContactForBot, withdrawCommunityContact, getCommunityContacts };
