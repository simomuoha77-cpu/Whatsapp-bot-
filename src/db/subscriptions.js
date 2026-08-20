const { getDb } = require('./mongo');
const { getPricingSettings } = require('./pricingSettings');

/**
 * Creates the trial subscription record for a brand-new bot, using the
 * current global trial_days setting. Called once, when a bot is first
 * registered (linked to a client_account).
 */
async function startTrial(botId) {
  const db = await getDb();
  const id = Number(botId);
  const existing = await db.collection('subscriptions').findOne({ bot_id: id });
  if (existing) return existing;

  const pricing = await getPricingSettings();
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + pricing.trial_days * 24 * 60 * 60 * 1000);
  const doc = {
    bot_id: id,
    trial_started_at: now,
    trial_ends_at: trialEndsAt,
    paid_until: null,
    plan: 'monthly',
    updated_at: now,
  };
  await db.collection('subscriptions').insertOne(doc);
  return doc;
}

async function getSubscription(botId) {
  const db = await getDb();
  return db.collection('subscriptions').findOne({ bot_id: Number(botId) });
}

/**
 * The core gate check: is this bot currently allowed to operate?
 * Active if NOW() is before trial_ends_at, OR before paid_until
 * (whichever gives a later/more-permissive date).
 */
async function isSubscriptionActive(botId) {
  const sub = await getSubscription(botId);
  if (!sub) return false; // no subscription record at all = not active
  const now = new Date();
  const trialActive = !!(sub.trial_ends_at && now < new Date(sub.trial_ends_at));
  const paidActive = !!(sub.paid_until && now < new Date(sub.paid_until));
  return trialActive || paidActive;
}

/**
 * Extends paid_until by one billing period from whichever is later:
 * the current paid_until, or now. This means renewing early simply adds
 * on top of remaining time, rather than resetting the clock.
 */
async function extendSubscription(botId, plan) {
  const db = await getDb();
  const id = Number(botId);
  const sub = await getSubscription(id);
  const now = new Date();
  const base = sub && sub.paid_until && new Date(sub.paid_until) > now ? new Date(sub.paid_until) : now;
  const extended = new Date(base);
  if (plan === 'yearly') {
    extended.setFullYear(extended.getFullYear() + 1);
  } else {
    extended.setMonth(extended.getMonth() + 1);
  }
  await db.collection('subscriptions').updateOne(
    { bot_id: id },
    { $set: { paid_until: extended, plan, updated_at: now } }
  );
}

module.exports = {
  startTrial,
  getSubscription,
  isSubscriptionActive,
  extendSubscription,
};
