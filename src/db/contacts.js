const { query } = require('./pool');

function phoneFromJid(jid) {
  return jid.split('@')[0].split(':')[0];
}

async function upsertContact(botId, jid, displayName) {
  const phone = phoneFromJid(jid);
  const res = await query(
    `INSERT INTO contacts (bot_id, jid, phone_number, display_name, last_seen_at, message_count)
     VALUES ($1, $2, $3, $4, NOW(), 1)
     ON CONFLICT (bot_id, jid) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
       last_seen_at = NOW(),
       message_count = contacts.message_count + 1
     RETURNING *`,
    [botId, jid, phone, displayName || null]
  );
  return res.rows[0];
}

async function getContact(botId, jid) {
  const res = await query('SELECT * FROM contacts WHERE bot_id = $1 AND jid = $2', [botId, jid]);
  return res.rows[0] || null;
}

async function getContactsForBot(botId, limit = 100) {
  const res = await query(
    'SELECT * FROM contacts WHERE bot_id = $1 ORDER BY last_seen_at DESC LIMIT $2',
    [botId, limit]
  );
  return res.rows;
}

async function setBlocked(botId, jid, blocked) {
  await query('UPDATE contacts SET is_blocked = $1 WHERE bot_id = $2 AND jid = $3', [blocked, botId, jid]);
}

async function isBlocked(botId, jid) {
  const c = await getContact(botId, jid);
  return !!(c && c.is_blocked);
}

async function getAllContactJids(botId) {
  const res = await query(
    'SELECT jid FROM contacts WHERE bot_id = $1 AND is_blocked = FALSE',
    [botId]
  );
  return res.rows.map((r) => r.jid);
}

module.exports = {
  upsertContact,
  getContact,
  getContactsForBot,
  setBlocked,
  isBlocked,
  getAllContactJids,
  phoneFromJid,
};
