require('dotenv').config();
const logger = require('./utils/logger');
const { runMigrations } = require('./db/migrate');
const { createServer } = require('./server');
const { startAllBots, closeAllBotSockets } = require('./utils/botManager');
const { onBotReady } = require('./handlers/botStartHook');
const { startScheduler } = require('./handlers/scheduler');
const http = require('http');
const https = require('https');

async function main() {
  logger.info('Starting WhatsApp bot platform...');

  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, 'Failed to run migrations. Check MONGODB_URI. Exiting.');
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

  // Render's free tier spins the whole server down after ~15 minutes with
  // no incoming HTTP traffic — and a sleeping process can't fire a
  // scheduled status/group post at its set time, or keep a WhatsApp socket
  // connected, no matter how correct the scheduling code is. This isn't a
  // workaround for a bug; it's the standard fix for free-tier hosting:
  // periodically hit our own public URL so Render always sees recent
  // traffic and never considers the service idle. RENDER_EXTERNAL_URL is
  // set automatically by Render on every web service — no config needed.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (selfUrl) {
    const client = selfUrl.startsWith('https') ? https : http;
    const PING_INTERVAL_MS = 10 * 60 * 1000; // well under Render's ~15min idle window
    setInterval(() => {
      client.get(selfUrl, (res) => {
        res.resume(); // drain response, don't care about the body
        logger.info({ selfUrl, statusCode: res.statusCode }, 'Self-ping keepalive');
      }).on('error', (err) => {
        logger.warn({ err, selfUrl }, 'Self-ping keepalive failed');
      });
    }, PING_INTERVAL_MS);
    logger.info({ selfUrl, intervalMinutes: PING_INTERVAL_MS / 60000 }, 'Self-ping keepalive started');
  } else {
    logger.warn('RENDER_EXTERNAL_URL not set — self-ping keepalive disabled. On Render free tier, the server will spin down when idle and scheduled posts/reminders will silently miss their fire time.');
  }
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, closing WhatsApp sockets before shutdown.');
  try {
    await closeAllBotSockets();
  } catch (err) {
    logger.error({ err }, 'Error while closing sockets on shutdown');
  }
  process.exit(0);
});

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
