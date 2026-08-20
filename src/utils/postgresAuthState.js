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

  const writeValue = async (keyType, keyId, value) => {
    const serialized = value === null ? null : JSON.stringify(value, BufferJSON.replacer);
    await query(
      `INSERT INTO bot_auth_state (bot_id, key_type, key_id, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (bot_id, key_type, key_id) DO UPDATE SET value = $4, updated_at = NOW()`,
      [botId, keyType, keyId || '', serialized]
    );
  };

  const deleteValue = async (keyType, keyId) => {
    await query(
      'DELETE FROM bot_auth_state WHERE bot_id = $1 AND key_type = $2 AND key_id = $3',
      [botId, keyType, keyId || '']
    );
  };

  const existingCreds = await readValue('creds');
  const creds = existingCreds || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          let value = await readValue(type, id);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value) result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            if (value) {
              await writeValue(category, id, value);
            } else {
              await deleteValue(category, id);
            }
          }
        }
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
