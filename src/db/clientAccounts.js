const bcrypt = require('bcryptjs');
const { query } = require('./pool');

async function createClientAccount(botId, phoneNumber, plainPassword) {
  const hash = await bcrypt.hash(plainPassword, 10);
  const res = await query(
    `INSERT INTO client_accounts (bot_id, phone_number, password_hash) VALUES ($1, $2, $3) RETURNING *`,
    [botId, phoneNumber, hash]
  );
  return res.rows[0];
}

async function getClientAccountByPhone(phoneNumber) {
  const res = await query('SELECT * FROM client_accounts WHERE phone_number = $1', [phoneNumber]);
  return res.rows[0] || null;
}

async function getClientAccountByBotId(botId) {
  const res = await query('SELECT * FROM client_accounts WHERE bot_id = $1', [botId]);
  return res.rows[0] || null;
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
