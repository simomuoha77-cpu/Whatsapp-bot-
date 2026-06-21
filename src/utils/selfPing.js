const logger = require('./logger');

const PING_INTERVAL_MS = parseInt(process.env.SELF_PING_INTERVAL_MS || '600000', 10); // 10 min default

/**
 * Periodically pings the app's own /health endpoint to prevent Render's
 * free tier from spinning the service down due to inactivity.
 *
 * Only runs if SELF_PING_URL is set (your Render service's public URL),
 * so it's a no-op in local development.
 */
function startSelfPing() {
  const url = process.env.SELF_PING_URL;
  if (!url) {
    logger.info('SELF_PING_URL not set — self-ping disabled (fine for local dev).');
    return;
  }

  const target = `${url.replace(/\/+$/, '')}/health`;

  const ping = async () => {
    try {
      const res = await fetch(target);
      logger.debug({ status: res.status }, 'Self-ping sent');
    } catch (err) {
      logger.warn({ err: err.message }, 'Self-ping failed');
    }
  };

  logger.info(`Self-ping enabled: pinging ${target} every ${PING_INTERVAL_MS / 1000}s`);
  setInterval(ping, PING_INTERVAL_MS);
  ping(); // fire one immediately on startup too
}

module.exports = { startSelfPing };
