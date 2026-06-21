require('dotenv').config();
const logger = require('./utils/logger');
const { runMigrations } = require('./db/migrate');
const { startSock } = require('./whatsapp');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerStatusHandler } = require('./handlers/statusHandler');
const { createServer } = require('./server');

async function main() {
  logger.info('Starting WhatsApp bot...');

  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, 'Failed to run migrations. Check DATABASE_URL. Exiting.');
    process.exit(1);
  }

  const app = createServer();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Web server listening on port ${PORT}. Visit /qr to log in, /health to check status.`);
  });

  await startSock((sock) => {
    registerMessageHandler(sock);
    registerStatusHandler(sock);
    logger.info('Bot is fully online and listening for messages.');
  });
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully.');
  process.exit(0);
});

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
