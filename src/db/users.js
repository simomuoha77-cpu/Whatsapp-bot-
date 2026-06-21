const { query } = require('./pool');

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

function phoneFromJid(jid) {
  return jid.split('@')[0].split(':')[0];
}

async function upsertUser(jid, displayName) {
  const phone = phoneFromJid(jid);
  const isAdmin = ADMIN_NUMBERS.includes(phone);
  const res = await query(
    `INSERT INTO users (jid, phone_number, display_name, is_admin, last_seen_at, message_count)
     VALUES ($1, $2, $3, $4, NOW(), 1)
     ON CONFLICT (jid) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       last_seen_at = NOW(),
       message_count = users.message_count + 1,
       is_admin = $4
     RETURNING *`,
    [jid, phone, displayName || null, isAdmin]
  );
  return res.rows[0];
}

async function getUser(jid) {
  const res = await query('SELECT * FROM users WHERE jid = $1', [jid]);
  return res.rows[0] || null;
}

async function isAdmin(jid) {
  const phone = phoneFromJid(jid);
  if (ADMIN_NUMBERS.includes(phone)) return true;
  const user = await getUser(jid);
  return !!(user && user.is_admin);
}

async function setBlocked(jid, blocked) {
  await query('UPDATE users SET is_blocked = $1 WHERE jid = $2', [blocked, jid]);
}

async function isBlocked(jid) {
  const user = await getUser(jid);
  return !!(user && user.is_blocked);
}

async function getAllActiveUsers() {
  const res = await query('SELECT jid FROM users WHERE is_blocked = FALSE');
  return res.rows.map((r) => r.jid);
}

async function countUsers() {
  const res = await query('SELECT COUNT(*) FROM users');
  return parseInt(res.rows[0].count, 10);
}

module.exports = {
  upsertUser,
  getUser,
  isAdmin,
  setBlocked,
  isBlocked,
  getAllActiveUsers,
  countUsers,
  phoneFromJid,
};
