const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
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
    // Baileys' unlabeled default linked-device name is itself a signal —
    // every real WhatsApp Web/Desktop session identifies as a real browser.
    // This just matches that instead of leaving it blank/generic.
    browser: Browsers.macOS('Safari'),
  });

  const entry = {
    sock,
    status: 'connecting',
    qr: null,
    pairingCode: null,
    pendingPairingNumber: null,
    slug,
    reconnectAttempts: 0,
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
      entry.reconnectAttempts = 0;
      const ownNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      await updateBotStatusInDb(botId, 'connected', {
        phone_number: ownNumber,
        connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
      logger.info({ botId, ownNumber }, 'Bot connected to WhatsApp');

      // This account-wide "Read Receipts" toggle is the ONLY thing that
      // guarantees no blue tick — skipping our own readMessages() call
      // alone isn't reliable enough in practice. But it also controls status
      // view visibility, with no way to separate the two as a static
      // setting. So: for 'normal' mode we leave it 'all' (receipts + status
      // views both on, as expected). For 'stealth'/'no_mark', the resting
      // state is 'none' (blue tick guaranteed off) — and statusHandler.js
      // briefly flips it to 'all' only for the moment it's actually viewing
      // or reacting to a status, then back to 'none' right after, so status
      // views still show without permanently exposing message read receipts.
      try {
        const { getFeatures } = require('../db/botFeatures');
        const features = await getFeatures(botId);
        const stealthMode = features.stealth_read_mode || 'normal';
        await sock.updateReadReceiptsPrivacy(stealthMode === 'normal' ? 'all' : 'none');
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to set read receipts privacy setting');
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
        entry.reconnectAttempts = (entry.reconnectAttempts || 0) + 1;

        // Cap retries — repeatedly reconnecting in a tight loop is exactly
        // the kind of "automated" traffic pattern WhatsApp's spam detection
        // flags. After too many failed attempts in a row, back off and
        // require a manual reconnect (via regenerate-link) instead of
        // hammering their servers indefinitely.
        const MAX_RECONNECT_ATTEMPTS = 8;
        if (entry.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          logger.error(
            { botId, attempts: entry.reconnectAttempts },
            'Too many reconnect failures in a row — stopping automatic retries to avoid triggering WhatsApp spam detection. Client must regenerate their connection link to reconnect.'
          );
          activeBots.delete(botId);
          await updateBotStatusInDb(botId, 'disconnected');
          return;
        }

        // Exponential backoff: 3s, 6s, 12s, 24s... capped at 2 minutes.
        // A stable connection recovers quickly; an unstable one spaces its
        // retries out instead of retrying every few seconds forever.
        // Jitter is critical here: with many bots on one server, a shared
        // disruption (deploy, restart, network blip) disconnects all of
        // them at once. Without jitter, they'd all retry at the exact same
        // moment every time — a synchronized reconnect storm that overloads
        // the server and causes the very timeouts that trigger more
        // reconnects. Randomizing +/-30% spreads retries out over time.
        const baseDelay = Math.min(3000 * 2 ** (entry.reconnectAttempts - 1), 120000);
        const jitter = baseDelay * (0.7 + Math.random() * 0.6); // 70%-130% of base
        const delayMs = Math.round(jitter);
        logger.warn(
          { botId, statusCode, attempt: entry.reconnectAttempts, delayMs },
          'Bot disconnected, reconnecting with backoff...'
        );
        setTimeout(() => startBotSocket(botId, slug, onReady), delayMs);
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
  // Starting every bot's WebSocket at the exact same instant is what was
  // causing the mass "statusCode 408" disconnect storms — the server
  // can't establish/sync that many sessions simultaneously, so they time
  // out, retry, and pile up again. Staggering startup by a few hundred ms
  // per bot spreads the load out so each connection actually has a chance
  // to establish before the next one starts.
  const STAGGER_MS = parseInt(process.env.BOT_STARTUP_STAGGER_MS || '3500', 10);
  result.rows.forEach((bot, index) => {
    setTimeout(() => {
      startBotSocket(bot.id, bot.slug, onReady).catch((err) =>
        logger.error({ err, botId: bot.id }, 'Failed to start bot socket on startup')
      );
    }, index * STAGGER_MS);
  });
  logger.info({ count: result.rows.length, staggerMs: STAGGER_MS }, 'Scheduled staggered startup for all existing bots');
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
