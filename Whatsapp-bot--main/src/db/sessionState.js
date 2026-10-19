const { getDb } = require('./mongo');

async function getState(botId, jid) {
  const db = await getDb();
  const doc = await db.collection('sessions_state').findOne({ bot_id: Number(botId), jid });
  return doc || { bot_id: Number(botId), jid, state: 'idle', context: {} };
}

async function setState(botId, jid, state, context = {}) {
  const db = await getDb();
  await db.collection('sessions_state').updateOne(
    { bot_id: Number(botId), jid },
    { $set: { state, context, updated_at: new Date() } },
    { upsert: true }
  );
}

async function clearState(botId, jid) {
  await setState(botId, jid, 'idle', {});
}

module.exports = { getState, setState, clearState };
