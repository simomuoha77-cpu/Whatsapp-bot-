const pino = require('pino');

let logger;
try {
  if (process.env.NODE_ENV !== 'production') {
    require.resolve('pino-pretty');
    logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    });
  }
} catch (_) {
  // pino-pretty not installed, fall back to plain JSON logs
}

if (!logger) {
  logger = pino({ level: process.env.LOG_LEVEL || 'info' });
}

module.exports = logger;
