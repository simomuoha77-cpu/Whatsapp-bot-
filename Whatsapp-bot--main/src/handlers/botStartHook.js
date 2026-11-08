const { registerMessageHandler } = require('./messageHandler');
const { registerStatusHandler, resetQueue } = require('./statusHandler');
const { registerPresenceHandler } = require('./presenceHandler');
const { registerDeleteListener } = require('./antiDelete');
const { registerOwnStatusReceiptHandler } = require('./ownStatusReceipts');
const logger = require('../utils/logger');

/**
 * Called every time any bot's socket reaches the "connected" state —
 * whether on initial server startup (loading existing bots) or right
 * after a brand-new client finishes onboarding. Attaches the same
 * message/status handling logic, scoped to that bot's id.
 */
function onBotReady(sock, botId) {
  // A fresh connection should never inherit a stuck reaction/view queue
  // from a previous, possibly-broken connection (e.g. one that died
  // mid-reconnect-storm earlier). Always start clean.
  resetQueue(botId);
  registerMessageHandler(sock, botId);
  registerStatusHandler(sock, botId);
  registerPresenceHandler(sock, botId);
  registerDeleteListener(sock, botId);
  registerOwnStatusReceiptHandler(sock, botId);
  logger.info({ botId }, 'Handlers attached for bot');
}

module.exports = { onBotReady };
