const { getDb } = require('./mongo');
const logger = require('../utils/logger');

/**
 * MongoDB has no CREATE TABLE step — collections are created implicitly on
 * first insert. What this replaces from the old Postgres schema.sql is the
 * UNIQUE constraints and query-performance indexes that used to be
 * declared there. createIndex() is idempotent (safe to call every startup,
 * same spirit as Postgres's CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS pattern) — it's a no-op if the index already exists with the same
 * definition.
 */
async function runMigrations() {
  const db = await getDb();
  logger.info('Ensuring MongoDB indexes...');

  await Promise.all([
    db.collection('bots').createIndex({ slug: 1 }, { unique: true }),
    db.collection('bots').createIndex({ id: 1 }, { unique: true }),

    db.collection('bot_features').createIndex({ bot_id: 1 }, { unique: true }),

    db.collection('contacts').createIndex({ bot_id: 1, jid: 1 }, { unique: true }),
    db.collection('contacts').createIndex({ id: 1 }, { unique: true }),

    db.collection('messages').createIndex({ bot_id: 1, jid: 1 }),
    db.collection('messages').createIndex({ id: 1 }, { unique: true }),

    db.collection('sessions_state').createIndex({ bot_id: 1, jid: 1 }, { unique: true }),

    db.collection('own_status_posts').createIndex({ bot_id: 1, message_id: 1 }, { unique: true }),
    db.collection('own_status_posts').createIndex({ id: 1 }, { unique: true }),
    db.collection('own_status_views').createIndex({ status_post_id: 1, viewer_jid: 1 }, { unique: true }),

    db.collection('bot_auth_state').createIndex({ bot_id: 1, key_type: 1, key_id: 1 }, { unique: true }),

    db.collection('view_once_captures').createIndex({ bot_id: 1 }),
    db.collection('view_once_captures').createIndex({ id: 1 }, { unique: true }),

    db.collection('keyword_responses').createIndex({ bot_id: 1 }),
    db.collection('keyword_responses').createIndex({ id: 1 }, { unique: true }),

    db.collection('deleted_message_captures').createIndex({ bot_id: 1 }),
    db.collection('deleted_message_captures').createIndex({ id: 1 }, { unique: true }),

    db.collection('status_saves').createIndex({ bot_id: 1 }),
    db.collection('status_saves').createIndex({ id: 1 }, { unique: true }),

    db.collection('presence_log').createIndex({ bot_id: 1, contact_jid: 1 }, { unique: true }),

    db.collection('ai_chat_history').createIndex({ bot_id: 1, contact_jid: 1 }),
    db.collection('ai_chat_history').createIndex({ id: 1 }, { unique: true }),

    db.collection('client_accounts').createIndex({ phone_number: 1 }, { unique: true }),
    db.collection('client_accounts').createIndex({ id: 1 }, { unique: true }),

    db.collection('subscriptions').createIndex({ bot_id: 1 }, { unique: true }),

    db.collection('payments').createIndex({ checkout_request_id: 1 }, { unique: true }),
    db.collection('payments').createIndex({ bot_id: 1 }),
    db.collection('payments').createIndex({ id: 1 }, { unique: true }),

    db.collection('broadcasts').createIndex({ id: 1 }, { unique: true }),
    db.collection('status_log').createIndex({ id: 1 }, { unique: true }),
    db.collection('command_logs').createIndex({ id: 1 }, { unique: true }),
    db.collection('scheduled_status_posts').createIndex({ id: 1 }, { unique: true }),
    db.collection('reminders').createIndex({ id: 1 }, { unique: true }),
  ]);

  logger.info('MongoDB indexes ensured.');
}

module.exports = { runMigrations };
