const { registerMessageHandler } = require('./messageHandler');
const { registerStatusHandler } = require('./statusHandler');
const logger = require('../utils/logger');

/**
 * Called every time any bot's socket reaches the "connected" state —
 * whether on initial server startup (loading existing bots) or right
 * after a brand-new client finishes onboarding. Attaches the same
 * message/status handling logic, scoped to that bot's id.
 */
function onBotReady(sock, botId) {
  registerMessageHandler(sock, botId);
  registerStatusHandler(sock, botId);
  logger.info({ botId }, 'Handlers attached for bot');
}

module.exports = { onBotReady };
