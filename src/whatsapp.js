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
const logger = require('../utils/logger');
const NodeCache = require('node-cache');

const SESSION_DIR = path.join(__dirname, '..', '..', 'session');

const baileysLogger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();

let sock = null;
let latestQr = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | qr_pending | connected

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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      connectionStatus = 'qr_pending';
      logger.info('Scan this QR code with WhatsApp (Linked Devices):');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      latestQr = null;
      logger.info('WhatsApp connection established.');
      if (onReady) onReady(sock);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error('Session logged out. Delete the /session folder and re-scan the QR code to log in again.');
      } else {
        logger.warn({ statusCode }, 'Connection closed, reconnecting in 3s...');
        setTimeout(() => startSock(onReady), 3000);
      }
    }
  });

  return sock;
}

function getSock() {
  return sock;
}

function getStatus() {
  return { status: connectionStatus, qr: latestQr };
}

module.exports = { startSock, getSock, getStatus };
