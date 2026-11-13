const { getDb } = require('./mongo');
const { normalizePhoneNumber } = require('../utils/phoneNumber');

const MAX_PAGE = 200;

async function getCommunityContactForBot(botId) {
  const db = await getDb();
  return db.collection('community_contacts').findOne({ bot_id: Number(botId) }, { projection: { _id: 0, bot_id: 1, name: 1, phone_number: 1, opted_in: 1 } });
}

async function registerCommunityContact({ botId, name, phoneNumber }) {
  phoneNumber = normalizePhoneNumber(phoneNumber);
  if (!/^[0-9]{9,15}$/.test(phoneNumber)) throw new Error('Enter a valid WhatsApp number in international format.');
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

// One page of the shared directory for a participating member: opted-in only, never the
// caller's own bot or number, stable order (by number) so the cursor is the last number seen.
async function getCommunityContactsPage(excludeBotId, { after = '', limit = 100 } = {}) {
  const db = await getDb();
  const n = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 100));
  const own = await db.collection('community_contacts').findOne({ bot_id: Number(excludeBotId) }, { projection: { _id: 0, phone_number: 1 } });
  const phoneFilter = { $gt: String(after || '') };
  if (own && own.phone_number) phoneFilter.$ne = own.phone_number;
  const rows = await db.collection('community_contacts')
    .find({ opted_in: true, bot_id: { $ne: Number(excludeBotId) }, phone_number: phoneFilter }, { projection: { _id: 0, name: 1, phone_number: 1 } })
    .sort({ phone_number: 1 }).limit(n + 1).toArray();
  const hasMore = rows.length > n;
  const contacts = rows.slice(0, n);
  return { contacts, nextCursor: hasMore ? contacts[contacts.length - 1].phone_number : null };
}

async function getCommunityContacts(excludeBotId) {
  const all = []; let after = '';
  for (;;) {
    const page = await getCommunityContactsPage(excludeBotId, { after, limit: MAX_PAGE });
    all.push(...page.contacts);
    if (!page.nextCursor) return all;
    after = page.nextCursor;
  }
}

async function deleteCommunityContact(botId) {
  const db = await getDb();
  await db.collection('community_contacts').deleteOne({ bot_id: Number(botId) });
}

module.exports = { registerCommunityContact, getCommunityContactForBot, withdrawCommunityContact, getCommunityContacts, getCommunityContactsPage, deleteCommunityContact };
