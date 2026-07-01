const { query } = require('./pool');

async function getState(botId, jid) {
  const res = await query('SELECT * FROM sessions_state WHERE bot_id = $1 AND jid = $2', [botId, jid]);
  return res.rows[0] || { bot_id: botId, jid, state: 'idle', context: {} };
}

async function setState(botId, jid, state, context = {}) {
  await query(
    `INSERT INTO sessions_state (bot_id, jid, state, context, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (bot_id, jid) DO UPDATE SET state = $3, context = $4, updated_at = NOW()`,
    [botId, jid, state, JSON.stringify(context)]
  );
}

async function clearState(botId, jid) {
  await setState(botId, jid, 'idle', {});
}

module.exports = { getState, setState, clearState };
