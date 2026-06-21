const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('./utils/logger');
const NodeCache = require('node-cache');

const SESSION_DIR = path.join(__dirname, '..', 'session');

const baileysLogger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();

let sock = null;
let latestQr = null;
let latestPairingCode = null;
let connectionStatus = 'disconnected';
let pendingPairingNumber = null;

async function startSock(onReady) {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting' && pendingPairingNumber && !sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(pendingPairingNumber);
        latestPairingCode = code;
        connectionStatus = 'pairing_code_pending';
        logger.info(`Pairing code: ${code}`);
      } catch (err) {
        logger.error({ err }, 'Failed to generate pairing code');
      } finally {
        pendingPairingNumber = null;
      }
    }

    if (qr && !pendingPairingNumber) {
      latestQr = qr;
      connectionStatus = 'qr_pending';
      logger.info('Scan this QR code with WhatsApp (Linked Devices):');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      latestQr = null;
      latestPairingCode = null;
      logger.info('WhatsApp connection established.');
      if (onReady) onReady(sock);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error('Session logged out. Delete the /session folder and log in again.');
      } else {
        logger.warn({ statusCode }, 'Connection closed, reconnecting in 3s...');
        setTimeout(() => startSock(onReady), 3000);
      }
    }
  });

  return sock;
}

function requestPairingCode(phoneNumber) {
  pendingPairingNumber = phoneNumber;
  if (sock && !sock.authState?.creds?.registered) {
    sock.requestPairingCode(phoneNumber).then((code) => {
      latestPairingCode = code;
      connectionStatus = 'pairing_code_pending';
      pendingPairingNumber = null;
    }).catch((err) => logger.error({ err }, 'Failed to generate pairing code (immediate attempt)'));
  }
}

function getSock() {
  return sock;
}

function getStatus() {
  return { status: connectionStatus, qr: latestQr, pairingCode: latestPairingCode };
}

module.exports = { startSock, getSock, getStatus, requestPairingCode };
