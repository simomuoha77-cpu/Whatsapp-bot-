require('dotenv').config();
const logger = require('./utils/logger');
const { runMigrations } = require('./db/migrate');
const { createServer } = require('./server');
const { startAllBots } = require('./utils/botManager');
const { onBotReady } = require('./handlers/botStartHook');
const { startScheduler } = require('./handlers/scheduler');

async function main() {
  logger.info('Starting WhatsApp bot platform...');

  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, 'Failed to run migrations. Check DATABASE_URL. Exiting.');
    process.exit(1);
  }

  const app = createServer();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}. Visit /admin to manage clients.`);
  });

  // Reconnect every existing client bot on startup.
  await startAllBots(onBotReady);

  // Start the cron-based scheduler covering all bots' scheduled posts/reminders.
  await startScheduler();
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
