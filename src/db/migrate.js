const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const logger = require('../utils/logger');

async function runMigrations() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    logger.info('Running database migrations...');
    await client.query(sql);
    logger.info('Migrations applied successfully.');
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
