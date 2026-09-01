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
const { getDb } = require('../db/mongo');
const { useMongoAuthState, clearMongoAuthState } = require('./mongoAuthState');

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
  const db = await getDb();
  await db.collection('bots').updateOne(
    { id: Number(botId) },
    { $set: { status, ...extra } }
  );
}

/**
 * Starts (or restarts) a Baileys connection for a single bot/client.
 * Auth credentials are stored in Postgres (not the filesystem), so
 * connected clients stay logged in across deploys/restarts on Render's
 * free tier, which wipes the filesystem but persists database data.
 */
async function startBotSocket(botId, slug, onReady) {
  const { state, saveCreds } = await useMongoAuthState(botId);
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

  // Anti-Call: auto-reject incoming voice/video calls before they ring
  // through, optionally replying with a text explaining why.
  // Group welcome/goodbye — separate listener, registered once per bot.
  const { registerGroupParticipantHandler } = require('../handlers/groupHandler');
  registerGroupParticipantHandler(sock, botId);

  sock.ev.on('call', async (calls) => {
    try {
      const { getFeatures } = require('../db/botFeatures');
      const features = await getFeatures(botId);
      if (!features.anti_call_enabled) return;
      for (const call of calls) {
        if (call.status !== 'offer') continue; // only reject incoming offers, not already-ended calls
        try {
          await sock.rejectCall(call.id, call.from);
          logger.info({ botId, from: call.from }, 'Anti-Call: rejected incoming call');
          if (features.anti_call_message) {
            await sock.sendMessage(call.from, { text: features.anti_call_message });
          }
        } catch (err) {
          logger.warn({ err, botId }, 'Anti-Call: failed to reject call');
        }
      }
    } catch (err) {
      logger.warn({ err, botId }, 'Anti-Call: error checking feature flag');
    }
  });

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
        disconnected_at: null,
        disconnect_reason: null,
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

      // Always Online: keep presence pinned to "available". WhatsApp's
      // presence state naturally lapses after a while with no activity, so
      // this needs a periodic refresh, not just a one-time call on connect.
      // Auto Bio: periodically rotate the "About" text from a pipe-separated
      // list the client configured, so it doesn't sit static forever.
      try {
        const { getFeatures } = require('../db/botFeatures');
        const features = await getFeatures(botId);

        if (features.always_online_enabled) {
          await sock.sendPresenceUpdate('available');
          entry.presenceIntervalId = setInterval(async () => {
            try {
              await sock.sendPresenceUpdate('available');
            } catch (err) {
              logger.warn({ err, botId }, 'Always Online: failed to refresh presence');
            }
          }, 4 * 60 * 1000); // refresh every 4 minutes
        }

        if (features.auto_bio_enabled && features.auto_bio_texts) {
          const bioOptions = features.auto_bio_texts.split('|').map((s) => s.trim()).filter(Boolean);
          if (bioOptions.length > 0) {
            const setRandomBio = async () => {
              try {
                const text = bioOptions[Math.floor(Math.random() * bioOptions.length)];
                await sock.updateProfileStatus(text);
              } catch (err) {
                logger.warn({ err, botId }, 'Auto Bio: failed to update About text');
              }
            };
            await setRandomBio();
            // Rotate every 30-60 min — frequent enough to look alive,
            // infrequent enough not to look automated.
            entry.bioIntervalId = setInterval(setRandomBio, (30 + Math.random() * 30) * 60 * 1000);
          }
        }
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to set up Always Online / Auto Bio');
      }

      if (onReady) onReady(sock, botId);
    }

    if (connection === 'close') {
      entry.status = 'disconnected';
      if (entry.presenceIntervalId) {
        clearInterval(entry.presenceIntervalId);
        entry.presenceIntervalId = null;
      }
      if (entry.bioIntervalId) {
        clearInterval(entry.bioIntervalId);
        entry.bioIntervalId = null;
      }
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      await updateBotStatusInDb(botId, 'disconnected', { disconnected_at: new Date().toISOString() });

      if (loggedOut) {
        logger.warn({ botId }, 'Bot logged out — needs a new QR/pairing code to reconnect.');
        activeBots.delete(botId);
        await clearMongoAuthState(botId);
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
          await updateBotStatusInDb(botId, 'disconnected', {
            disconnected_at: new Date().toISOString(),
            disconnect_reason: 'max_reconnect_attempts',
          });
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
        setTimeout(() => enqueueConnect(() => startBotSocket(botId, slug, onReady)), delayMs);
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
  const db = await getDb();
  const bots = await db.collection('bots').find({}).project({ id: 1, slug: 1, status: 1 }).toArray();
  // Startup uses the same global connect queue as reconnects — one
  // mechanism, one place governing the whole fleet's connection rate,
  // instead of a separate stagger system that could still overlap with
  // reconnect attempts and burst together.
  bots.forEach((bot) => {
    enqueueConnect(() => startBotSocket(bot.id, bot.slug, onReady)).catch((err) =>
      logger.error({ err, botId: bot.id }, 'Failed to start bot socket on startup')
    );
  });
  logger.info(
    { count: bots.length, gapMs: MIN_GAP_BETWEEN_CONNECTS_MS },
    'Queued startup for all existing bots through the global connect gate'
  );
}

/**
 * Global gate on new connection attempts across the ENTIRE fleet of bots.
 *
 * The per-bot exponential backoff above only controls how often ONE bot
 * retries — it does nothing to limit how many DIFFERENT bots might all be
 * attempting a connection in the same second. With many bots each
 * independently reconnecting on their own few-second timers, the combined
 * attempt rate across the whole fleet can be many connections/second
 * hitting WhatsApp from this one server's IP — a very plausible trigger
 * for WhatsApp's own abuse detection to start rejecting connections
 * outright (an immediate "connectionClosed"), which then triggers more
 * retries, compounding the problem indefinitely. This was confirmed to
 * fix exactly that pattern once already — re-adding it here after it was
 * inadvertently lost in a full codebase reset.
 *
 * This queue is the single choke point for every connection attempt,
 * whatever triggers it (initial boot, reconnect-after-close, or an
 * on-demand lazy start) — only one attempt goes out at a time, fleet-wide,
 * with a fixed minimum gap between them.
 */
const connectQueue = [];
let drainingConnectQueue = false;
const MIN_GAP_BETWEEN_CONNECTS_MS = parseInt(process.env.MIN_CONNECT_GAP_MS || '2000', 10);

function enqueueConnect(task) {
  return new Promise((resolve, reject) => {
    connectQueue.push({ task, resolve, reject });
    drainConnectQueue();
  });
}

async function drainConnectQueue() {
  if (drainingConnectQueue) return;
  drainingConnectQueue = true;
  while (connectQueue.length > 0) {
    const { task, resolve, reject } = connectQueue.shift();
    try {
      resolve(await task());
    } catch (err) {
      reject(err);
    }
    if (connectQueue.length > 0) {
      await new Promise((r) => setTimeout(r, MIN_GAP_BETWEEN_CONNECTS_MS));
    }
  }
  drainingConnectQueue = false;
}

async function deleteBotSession(botId) {
  activeBots.delete(botId);
  await clearMongoAuthState(botId);
}

module.exports = {
  startBotSocket,
  startAllBots,
  getBotState,
  getAllBotStates,
  requestPairingCodeForBot,
  deleteBotSession,
  enqueueConnect,
};
