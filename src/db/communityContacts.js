const { getDb } = require('./mongo');

async function registerCommunityContact({ botId, name, phoneNumber }) {
  const db = await getDb();
  const now = new Date();
  await db.collection('community_contacts').updateOne(
    { phone_number: phoneNumber },
    { $set: { bot_id: Number(botId), name, phone_number: phoneNumber, opted_in: true, updated_at: now }, $setOnInsert: { created_at: now } },
    { upsert: true }
  );
}

async function getCommunityContacts(excludeBotId) {
  const db = await getDb();
  return db.collection('community_contacts')
    .find({ opted_in: true, bot_id: { $ne: Number(excludeBotId) } }, { projection: { _id: 0, name: 1, phone_number: 1 } })
    .sort({ created_at: 1 })
    .toArray();
}

module.exports = { registerCommunityContact, getCommunityContacts };
