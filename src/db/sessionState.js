const { query } = require('./pool');

async function getState(jid) {
  const res = await query('SELECT * FROM sessions_state WHERE jid = $1', [jid]);
  return res.rows[0] || { jid, state: 'idle', context: {} };
}

async function setState(jid, state, context = {}) {
  await query(
    `INSERT INTO sessions_state (jid, state, context, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (jid) DO UPDATE SET state = $2, context = $3, updated_at = NOW()`,
    [jid, state, JSON.stringify(context)]
  );
}

async function clearState(jid) {
  await setState(jid, 'idle', {});
}

module.exports = { getState, setState, clearState };
