const { Pool } = require('pg');
const logger = require('../utils/logger');

if (!process.env.DATABASE_URL) {
  logger.error('DATABASE_URL is not set. Set it in your .env or Render environment variables.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected Postgres pool error');
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug({ text, duration, rows: res.rowCount }, 'Executed query');
    return res;
  } catch (err) {
    logger.error({ err, text }, 'Query failed');
    throw err;
  }
}

module.exports = { pool, query };
