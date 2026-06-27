const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const NodeCache = require('node-cache');
const logger = require('./logger');
const { query } = require('../db/pool');
const { usePostgresAuthState, clearPostgresAuthState } = require('./postgresAuthState');

const baileysLogger = pino({ level: 'silent' });

/**
 * In-memory registry of all live bot connections, keyed by bot_id.
 * Each entry: { sock, status, qr, pairingCode, slug, pendingPairingNumber }
 */
const activeBots = new Map();

function getBotState(botId) {
  return activeBots.get(botId) || null;
}

function getAllBotStates() {
  return activeBots;
}

async function updateBotStatusInDb(botId, status, extra = {}) {
  const fields = ['status = $2'];
  const values = [botId, status];
  let i = 3;
  for (const [key, val] of Object.entries(extra)) {
    fields.push(`${key} = $${i}`);
    values.push(val);
    i++;
  }
  await query(`UPDATE bots SET ${fields.join(', ')} WHERE id = $1`, values);
}

/**
 * Starts (or restarts) a Baileys connection for a single bot/client.
 * Auth credentials are stored in Postgres (not the filesystem), so
 * connected clients stay logged in across deploys/restarts on Render's
 * free tier, which wipes the filesystem but persists database data.
 */
async function startBotSocket(botId, slug, onReady) {
  const { state, saveCreds } = await usePostgresAuthState(botId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    msgRetryCounterCache: new NodeCache(),
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const entry = {
    sock,
    status: 'connecting',
    qr: null,
    pairingCode: null,
    pendingPairingNumber: null,
    slug,
  };
  activeBots.set(botId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (
      connection === 'connecting' &&
      entry.pendingPairingNumber &&
      !sock.authState.creds.registered
    ) {
      try {
        const code = await sock.requestPairingCode(entry.pendingPairingNumber);
        entry.pairingCode = code;
        entry.status = 'pairing_code_pending';
        await updateBotStatusInDb(botId, 'pairing_code_pending');
        logger.info({ botId, code }, 'Pairing code generated');
      } catch (err) {
        logger.error({ err, botId }, 'Failed to generate pairing code');
      } finally {
        entry.pendingPairingNumber = null;
      }
    }

    if (qr && !entry.pendingPairingNumber) {
      entry.qr = qr;
      entry.status = 'qr_pending';
      await updateBotStatusInDb(botId, 'qr_pending');
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.pairingCode = null;
      const ownNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      await updateBotStatusInDb(botId, 'connected', {
        phone_number: ownNumber,
        connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
      logger.info({ botId, ownNumber }, 'Bot connected to WhatsApp');

      // Apply the account-wide read receipts privacy setting based on this
      // bot's Stealth Read Mode. This is the real, WhatsApp-enforced switch
      // (the same one under Settings > Privacy > Read Receipts) — far more
      // reliable than only skipping our own readMessages() call, since it's
      // honored by WhatsApp's servers directly rather than depending on us
      // catching every code path that could trigger a receipt.
      try {
        const { getFeatures } = require('../db/botFeatures');
        const features = await getFeatures(botId);
        const stealthMode = features.stealth_read_mode || 'normal';
        const receiptsValue = stealthMode === 'normal' ? 'all' : 'none';
        await sock.updateReadReceiptsPrivacy(receiptsValue);
        logger.info({ botId, stealthMode, receiptsValue }, 'Applied read receipts privacy setting');
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to apply read receipts privacy setting');
      }

      if (onReady) onReady(sock, botId);
    }

    if (connection === 'close') {
      entry.status = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      await updateBotStatusInDb(botId, 'disconnected');

      if (loggedOut) {
        logger.warn({ botId }, 'Bot logged out — needs a new QR/pairing code to reconnect.');
        activeBots.delete(botId);
        await clearPostgresAuthState(botId);
      } else {
        logger.warn({ botId, statusCode }, 'Bot disconnected, reconnecting in 3s...');
        setTimeout(() => startBotSocket(botId, slug, onReady), 3000);
      }
    }
  });

  return sock;
}

function requestPairingCodeForBot(botId, phoneNumber) {
  const entry = activeBots.get(botId);
  if (!entry) return false;
  entry.pendingPairingNumber = phoneNumber;
  if (entry.sock && !entry.sock.authState?.creds?.registered) {
    entry.sock.requestPairingCode(phoneNumber).then((code) => {
      entry.pairingCode = code;
      entry.status = 'pairing_code_pending';
      entry.pendingPairingNumber = null;
    }).catch((err) => logger.error({ err, botId }, 'Immediate pairing code request failed'));
  }
  return true;
}

/**
 * Loads every non-deleted bot from the database and starts a socket for each.
 * Called once on server startup. onReady is invoked per-bot once it connects.
 * Because credentials live in Postgres, already-connected clients reconnect
 * automatically without needing to rescan anything.
 */
async function startAllBots(onReady) {
  const result = await query('SELECT id, slug, status FROM bots');
  for (const bot of result.rows) {
    startBotSocket(bot.id, bot.slug, onReady).catch((err) =>
      logger.error({ err, botId: bot.id }, 'Failed to start bot socket on startup')
    );
  }
  logger.info({ count: result.rows.length }, 'Started sockets for all existing bots');
}

async function deleteBotSession(botId) {
  activeBots.delete(botId);
  await clearPostgresAuthState(botId);
}

module.exports = {
  startBotSocket,
  startAllBots,
  getBotState,
  getAllBotStates,
  requestPairingCodeForBot,
  deleteBotSession,
};
