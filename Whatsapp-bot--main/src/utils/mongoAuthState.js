const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { getDb } = require('../db/mongo');
const logger = require('./logger');

/**
 * MongoDB-backed replacement for Baileys' useMultiFileAuthState (previously
 * Postgres-backed via postgresAuthState.js — same role, same reasoning:
 * Render's free tier wipes the filesystem on every deploy/restart, so
 * credentials need to live in the database to survive deploys).
 *
 * Modeled the same way the Postgres version was: creds stored as one
 * document, signal keys stored as individual documents keyed by
 * (bot_id, key_type, key_id), using Baileys' BufferJSON helper to
 * correctly serialize/deserialize binary key material.
 */
async function useMongoAuthState(botId) {
  const db = await getDb();
  const coll = db.collection('bot_auth_state');
  const id = Number(botId);

  const readValue = async (keyType, keyId = '') => {
    const doc = await coll.findOne({ bot_id: id, key_type: keyType, key_id: keyId });
    if (!doc || doc.value === null || doc.value === undefined) return null;
    try {
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch (err) {
      logger.error({ err, botId: id, keyType, keyId }, 'Failed to parse stored auth value');
      return null;
    }
  };

  // Batched read for multiple key ids of the same type in one round-trip —
  // a handshake can ask for dozens of signal keys at once.
  const readValues = async (keyType, keyIds) => {
    if (keyIds.length === 0) return {};
    const docs = await coll.find({ bot_id: id, key_type: keyType, key_id: { $in: keyIds } }).toArray();
    const out = {};
    for (const doc of docs) {
      if (doc.value === null || doc.value === undefined) continue;
      try {
        out[doc.key_id] = JSON.parse(doc.value, BufferJSON.reviver);
      } catch (err) {
        logger.error({ err, botId: id, keyType, keyId: doc.key_id }, 'Failed to parse stored auth value');
      }
    }
    return out;
  };

  const writeValue = async (keyType, keyId, value) => {
    const serialized = value === null ? null : JSON.stringify(value, BufferJSON.replacer);
    await coll.updateOne(
      { bot_id: id, key_type: keyType, key_id: keyId || '' },
      { $set: { value: serialized, updated_at: new Date() } },
      { upsert: true }
    );
  };

  // Batched upsert for writing several keys at once via bulkWrite, instead
  // of one round-trip per key.
  const writeValues = async (entries) => {
    if (entries.length === 0) return;
    const ops = entries.map((e) => ({
      updateOne: {
        filter: { bot_id: id, key_type: e.keyType, key_id: e.keyId || '' },
        update: { $set: {
          value: e.value === null ? null : JSON.stringify(e.value, BufferJSON.replacer),
          updated_at: new Date(),
        } },
        upsert: true,
      },
    }));
    await coll.bulkWrite(ops);
  };

  const deleteValue = async (keyType, keyId) => {
    await coll.deleteOne({ bot_id: id, key_type: keyType, key_id: keyId || '' });
  };

  const deleteValues = async (keyType, keyIds) => {
    if (keyIds.length === 0) return;
    await coll.deleteMany({ bot_id: id, key_type: keyType, key_id: { $in: keyIds } });
  };

  const existingCreds = await readValue('creds');
  const creds = existingCreds || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const raw = await readValues(type, ids);
        const result = {};
        for (const keyId of ids) {
          let value = raw[keyId];
          if (value === undefined) continue;
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          result[keyId] = value;
        }
        return result;
      },
      set: async (data) => {
        const toWrite = [];
        const toDeleteByType = {};
        for (const category in data) {
          for (const keyId in data[category]) {
            const value = data[category][keyId];
            if (value) {
              toWrite.push({ keyType: category, keyId, value });
            } else {
              (toDeleteByType[category] ||= []).push(keyId);
            }
          }
        }
        const tasks = [writeValues(toWrite)];
        for (const category in toDeleteByType) {
          tasks.push(deleteValues(category, toDeleteByType[category]));
        }
        await Promise.all(tasks);
      },
    },
  };

  const saveCreds = async () => {
    await writeValue('creds', '', state.creds);
  };

  return { state, saveCreds };
}

/**
 * Removes all stored auth data for a bot — used when regenerating a
 * client's onboarding link/session, or deleting a client entirely.
 */
async function clearMongoAuthState(botId) {
  const db = await getDb();
  await db.collection('bot_auth_state').deleteMany({ bot_id: Number(botId) });
}

module.exports = { useMongoAuthState, clearMongoAuthState };
