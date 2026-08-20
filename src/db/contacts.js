const { getDb, nextSequence } = require('./mongo');

function phoneFromJid(jid) {
  return jid.split('@')[0].split(':')[0];
}

async function upsertContact(botId, jid, displayName) {
  const db = await getDb();
  const id = Number(botId);
  const phone = phoneFromJid(jid);
  const existing = await db.collection('contacts').findOne({ bot_id: id, jid });
  if (existing) {
    const update = {
      $set: { last_seen_at: new Date() },
      $inc: { message_count: 1 },
    };
    if (displayName) update.$set.display_name = displayName;
    await db.collection('contacts').updateOne({ bot_id: id, jid }, update);
    return db.collection('contacts').findOne({ bot_id: id, jid });
  }
  const contactId = await nextSequence('contacts');
  const contact = {
    id: contactId,
    bot_id: id,
    jid,
    phone_number: phone,
    display_name: displayName || null,
    is_blocked: false,
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    message_count: 1,
  };
  await db.collection('contacts').insertOne(contact);
  return contact;
}

async function getContact(botId, jid) {
  const db = await getDb();
  return db.collection('contacts').findOne({ bot_id: Number(botId), jid });
}

async function getContactsForBot(botId, limit = 100) {
  const db = await getDb();
  return db.collection('contacts')
    .find({ bot_id: Number(botId) })
    .sort({ last_seen_at: -1 })
    .limit(limit)
    .toArray();
}

async function setBlocked(botId, jid, blocked) {
  const db = await getDb();
  await db.collection('contacts').updateOne(
    { bot_id: Number(botId), jid },
    { $set: { is_blocked: blocked } }
  );
}

async function isBlocked(botId, jid) {
  const c = await getContact(botId, jid);
  return !!(c && c.is_blocked);
}

async function getAllContactJids(botId) {
  const db = await getDb();
  const rows = await db.collection('contacts')
    .find({ bot_id: Number(botId), is_blocked: { $ne: true } })
    .project({ jid: 1 })
    .toArray();
  return rows.map((r) => r.jid);
}

async function manuallyAddContact(botId, phoneNumber, displayName) {
  const db = await getDb();
  const id = Number(botId);
  // Normalize to a bare digit string, then build the JID the same way
  // real incoming messages would key it (E.164-ish digits + @s.whatsapp.net).
  const digits = String(phoneNumber).replace(/[^0-9]/g, '');
  const jid = `${digits}@s.whatsapp.net`;
  const existing = await db.collection('contacts').findOne({ bot_id: id, jid });
  if (existing) {
    if (displayName) {
      await db.collection('contacts').updateOne({ bot_id: id, jid }, { $set: { display_name: displayName } });
    }
    return db.collection('contacts').findOne({ bot_id: id, jid });
  }
  const contactId = await nextSequence('contacts');
  const contact = {
    id: contactId,
    bot_id: id,
    jid,
    phone_number: digits,
    display_name: displayName || null,
    is_blocked: false,
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    message_count: 0,
  };
  await db.collection('contacts').insertOne(contact);
  return contact;
}

module.exports = {
  upsertContact,
  manuallyAddContact,
  getContact,
  getContactsForBot,
  setBlocked,
  isBlocked,
  getAllContactJids,
  phoneFromJid,
};
