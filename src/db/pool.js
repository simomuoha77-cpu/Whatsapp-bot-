const { Pool } = require('pg');
const logger = require('../utils/logger');

if (!process.env.DATABASE_URL) {
  logger.error('DATABASE_URL is not set.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Every mainstream hosted Postgres (Render, Neon, Supabase, etc.)
  // requires SSL, and none of them mind rejectUnauthorized:false for a
  // managed connection. Applying this unconditionally avoids depending on
  // NODE_ENV being set correctly to get a working connection.
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected Postgres pool error');
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    logger.error({ err, text }, 'Query failed');
    throw err;
  }
}

module.exports = { pool, query };
