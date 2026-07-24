const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { query } = require('../db/pool');
const logger = require('./logger');

/**
 * Database-backed replacement for Baileys' useMultiFileAuthState.
 *
 * Why this exists: Render's free tier wipes the filesystem on every
 * deploy/restart (no persistent disk on free instances), but Postgres data
 * survives. Without this, every code push would force every connected
 * client to rescan their QR/pairing code. Storing credentials in the
 * database that's already deployed alongside the app means sessions
 * persist across deploys with zero extra infrastructure.
 *
 * Modeled on Baileys' own useMultiFileAuthState and the documented pattern
 * for SQL-backed auth states (creds stored as one row, signal keys stored
 * as individual rows keyed by category + id), using Baileys' BufferJSON
 * helper to correctly serialize/deserialize binary key material.
 */
async function usePostgresAuthState(botId) {
  const readValue = async (keyType, keyId = '') => {
    const res = await query(
      'SELECT value FROM bot_auth_state WHERE bot_id = $1 AND key_type = $2 AND key_id = $3',
      [botId, keyType, keyId]
    );
    if (!res.rows[0] || res.rows[0].value === null) return null;
    try {
      return JSON.parse(res.rows[0].value, BufferJSON.reviver);
    } catch (err) {
      logger.error({ err, botId, keyType, keyId }, 'Failed to parse stored auth value');
      return null;
    }
  };

  // Batched read for multiple key ids of the same type in one round-trip —
  // a handshake can ask for dozens of signal keys at once, and doing one
  // query per key sequentially (the original approach) adds up to real,
  // meaningful delay, especially against any hosted Postgres with per-query
  // network latency. This is the single most-called path during connect.
  const readValues = async (keyType, keyIds) => {
    if (keyIds.length === 0) return {};
    const res = await query(
      'SELECT key_id, value FROM bot_auth_state WHERE bot_id = $1 AND key_type = $2 AND key_id = ANY($3::text[])',
      [botId, keyType, keyIds]
    );
    const out = {};
    for (const row of res.rows) {
      if (row.value === null) continue;
      try {
        out[row.key_id] = JSON.parse(row.value, BufferJSON.reviver);
      } catch (err) {
        logger.error({ err, botId, keyType, keyId: row.key_id }, 'Failed to parse stored auth value');
      }
    }
    return out;
  };

  const writeValue = async (keyType, keyId, value) => {
    const serialized = value === null ? null : JSON.stringify(value, BufferJSON.replacer);
    await query(
      `INSERT INTO bot_auth_state (bot_id, key_type, key_id, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (bot_id, key_type, key_id) DO UPDATE SET value = $4, updated_at = NOW()`,
      [botId, keyType, keyId || '', serialized]
    );
  };

  // Batched upsert for writing several keys (possibly across categories)
  // in one round-trip via UNNEST, instead of one INSERT per key — same
  // reasoning as readValues above.
  const writeValues = async (entries) => {
    if (entries.length === 0) return;
    const keyTypes = entries.map((e) => e.keyType);
    const keyIds = entries.map((e) => e.keyId || '');
    const values = entries.map((e) => (e.value === null ? null : JSON.stringify(e.value, BufferJSON.replacer)));
    await query(
      `INSERT INTO bot_auth_state (bot_id, key_type, key_id, value, updated_at)
       SELECT $1, t.key_type, t.key_id, t.value, NOW()
       FROM UNNEST($2::text[], $3::text[], $4::text[]) AS t(key_type, key_id, value)
       ON CONFLICT (bot_id, key_type, key_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [botId, keyTypes, keyIds, values]
    );
  };

  const deleteValue = async (keyType, keyId) => {
    await query(
      'DELETE FROM bot_auth_state WHERE bot_id = $1 AND key_type = $2 AND key_id = $3',
      [botId, keyType, keyId || '']
    );
  };

  // Batched delete for multiple ids of one type in one round-trip.
  const deleteValues = async (keyType, keyIds) => {
    if (keyIds.length === 0) return;
    await query(
      'DELETE FROM bot_auth_state WHERE bot_id = $1 AND key_type = $2 AND key_id = ANY($3::text[])',
      [botId, keyType, keyIds]
    );
  };

  const existingCreds = await readValue('creds');
  const creds = existingCreds || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const raw = await readValues(type, ids);
        const result = {};
        for (const id of ids) {
          let value = raw[id];
          if (value === undefined) continue;
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        const toWrite = [];
        const toDeleteByType = {};
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            if (value) {
              toWrite.push({ keyType: category, keyId: id, value });
            } else {
              (toDeleteByType[category] ||= []).push(id);
            }
          }
        }
        // Fire the write batch and all delete batches together rather than
        // sequentially — different categories don't depend on each other.
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
async function clearPostgresAuthState(botId) {
  await query('DELETE FROM bot_auth_state WHERE bot_id = $1', [botId]);
}

module.exports = { usePostgresAuthState, clearPostgresAuthState };
