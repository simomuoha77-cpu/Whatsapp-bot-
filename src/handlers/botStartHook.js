const { registerMessageHandler } = require('./messageHandler');
const { registerStatusHandler } = require('./statusHandler');
const { registerPresenceHandler } = require('./presenceHandler');
const { registerDeleteListener } = require('./antiDelete');
const logger = require('../utils/logger');

function onBotReady(sock, botId) {
  registerMessageHandler(sock, botId);
  registerStatusHandler(sock, botId);
  registerPresenceHandler(sock, botId);
  registerDeleteListener(sock, botId);
  logger.info({ botId: botId }, 'Handlers attached for bot');
}

module.exports = { onBotReady: onBotReady };
