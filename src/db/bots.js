const crypto = require('crypto');
const { getDb, nextSequence } = require('./mongo');

function generateSlug() {
  return crypto.randomBytes(6).toString('hex'); // e.g. "a1b2c3d4e5f6"
}

async function createBot(clientName) {
  const db = await getDb();
  let slug = generateSlug();
  let attempts = 0;
  while (attempts < 5) {
    const existing = await db.collection('bots').findOne({ slug });
    if (existing) {
      slug = generateSlug();
      attempts++;
      continue;
    }
    const id = await nextSequence('bots');
    const bot = {
      id,
      slug,
      client_name: clientName || null,
      status: 'pending',
      phone_number: null,
      created_at: new Date(),
      connected_at: null,
      last_seen_at: null,
    };
    await db.collection('bots').insertOne(bot);
    // Create a default feature doc immediately so toggles always have something to update.
    await db.collection('bot_features').insertOne({ bot_id: id, updated_at: new Date() });
    return bot;
  }
  throw new Error('Failed to generate a unique bot slug after several attempts.');
}

async function getBotBySlug(slug) {
  const db = await getDb();
  return db.collection('bots').findOne({ slug });
}

async function getBotById(id) {
  const db = await getDb();
  return db.collection('bots').findOne({ id: Number(id) });
}

async function getAllBots() {
  const db = await getDb();
  return db.collection('bots').find({}).sort({ created_at: -1 }).toArray();
}

// Postgres used ON DELETE CASCADE to automatically wipe every related row
// across ~15 tables when a bot was deleted. Mongo has no equivalent — this
// has to be done explicitly, collection by collection, or deleted bots
// would leave orphaned data behind forever.
async function deleteBot(id) {
  const db = await getDb();
  const botId = Number(id);

  const ownStatusPosts = await db.collection('own_status_posts').find({ bot_id: botId }).project({ id: 1 }).toArray();
  const ownStatusPostIds = ownStatusPosts.map((p) => p.id);

  await Promise.all([
    db.collection('bots').deleteOne({ id: botId }),
    db.collection('bot_features').deleteMany({ bot_id: botId }),
    db.collection('contacts').deleteMany({ bot_id: botId }),
    db.collection('messages').deleteMany({ bot_id: botId }),
    db.collection('sessions_state').deleteMany({ bot_id: botId }),
    db.collection('broadcasts').deleteMany({ bot_id: botId }),
    db.collection('status_log').deleteMany({ bot_id: botId }),
    db.collection('command_logs').deleteMany({ bot_id: botId }),
    db.collection('scheduled_status_posts').deleteMany({ bot_id: botId }),
    db.collection('reminders').deleteMany({ bot_id: botId }),
    db.collection('own_status_posts').deleteMany({ bot_id: botId }),
    ownStatusPostIds.length
      ? db.collection('own_status_views').deleteMany({ status_post_id: { $in: ownStatusPostIds } })
      : Promise.resolve(),
    db.collection('bot_auth_state').deleteMany({ bot_id: botId }),
    db.collection('view_once_captures').deleteMany({ bot_id: botId }),
    db.collection('keyword_responses').deleteMany({ bot_id: botId }),
    db.collection('deleted_message_captures').deleteMany({ bot_id: botId }),
    db.collection('status_saves').deleteMany({ bot_id: botId }),
    db.collection('presence_log').deleteMany({ bot_id: botId }),
    db.collection('ai_chat_history').deleteMany({ bot_id: botId }),
    db.collection('client_accounts').deleteMany({ bot_id: botId }),
    db.collection('subscriptions').deleteMany({ bot_id: botId }),
    db.collection('payments').deleteMany({ bot_id: botId }),
  ]);
}

async function renameBot(id, clientName) {
  const db = await getDb();
  await db.collection('bots').updateOne({ id: Number(id) }, { $set: { client_name: clientName } });
}

module.exports = {
  createBot,
  getBotBySlug,
  getBotById,
  getAllBots,
  deleteBot,
  renameBot,
};
