const { MongoClient } = require('mongodb');
const logger = require('../utils/logger');

if (!process.env.MONGODB_URI) {
  logger.error('MONGODB_URI is not set.');
} else {
  try {
    const u = new URL(process.env.MONGODB_URI);
    logger.info({ dbHost: u.hostname }, 'Connecting to MongoDB');
  } catch (err) {
    logger.warn('MONGODB_URI is set but could not be parsed as a valid URL');
  }
}

const client = new MongoClient(process.env.MONGODB_URI || '', {
  maxPoolSize: 10,
  connectTimeoutMS: 10000,
  serverSelectionTimeoutMS: 10000,
});

let dbInstance = null;
let connectPromise = null;

// The database name comes from the URI path if present (e.g.
// mongodb+srv://.../mydb), otherwise falls back to this default — Atlas
// connection strings often omit the db name and expect the driver/app to
// pick one.
const DEFAULT_DB_NAME = process.env.MONGODB_DB_NAME || 'whatsapp_saas';

async function getDb() {
  if (dbInstance) return dbInstance;
  if (!connectPromise) {
    connectPromise = client.connect().then(() => {
      let dbName = DEFAULT_DB_NAME;
      try {
        const u = new URL(process.env.MONGODB_URI);
        const pathName = u.pathname.replace('/', '');
        if (pathName) dbName = pathName;
      } catch (err) {
        // fall back to DEFAULT_DB_NAME
      }
      dbInstance = client.db(dbName);
      logger.info({ dbName }, 'Connected to MongoDB');
      return dbInstance;
    });
  }
  return connectPromise;
}

module.exports = { getDb, client, nextSequence };

// Classic Mongo auto-increment emulation — keeps every id in this app a
// plain integer (bot.id, contact.id, etc.), exactly like Postgres SERIAL
// did, so none of the ~20 files that pass these ids around (URL params,
// comparisons, foreign-key-style references) need to change at all.
async function nextSequence(name) {
  const db = await getDb();
  const res = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return res.value ? res.value.seq : res.seq;
}
