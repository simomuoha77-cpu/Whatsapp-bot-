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

/**
 * Manually extends (or creates) a bot's paid access by a given number of
 * days — for admin use (comps, manual top-ups, support gestures), separate
 * from the M-Pesa payment flow. Adds on top of whatever time is already
 * remaining (paid_until or trial_ends_at, whichever is later and still in
 * the future), rather than resetting the clock. Works even for
 * admin-created bots that never had a subscription record at all.
 */
async function extendSubscriptionByDays(botId, days) {
  const db = await getDb();
  const id = Number(botId);
  const sub = await getSubscription(id);
  const now = new Date();

  const candidates = [now];
  if (sub?.paid_until) candidates.push(new Date(sub.paid_until));
  if (sub?.trial_ends_at) candidates.push(new Date(sub.trial_ends_at));
  const base = candidates.reduce((latest, d) => (d > latest ? d : latest), now);

  const extended = new Date(base.getTime() + Number(days) * 24 * 60 * 60 * 1000);

  await db.collection('subscriptions').updateOne(
    { bot_id: id },
    { $set: { paid_until: extended, updated_at: now },
      $setOnInsert: { bot_id: id, trial_started_at: now, trial_ends_at: now, plan: sub?.plan || 'monthly' } },
    { upsert: true }
  );
  return extended;
}

/**
 * Same idea as extendSubscriptionByDays, but takes years/months/days
 * together and applies them with real calendar arithmetic (so "1 month"
 * from Jan 31 correctly lands on Feb 28, not a raw 30-day guess). This is
 * the one the admin UI's Years/Months/Days form uses.
 */
async function extendSubscriptionByYMD(botId, { years = 0, months = 0, days = 0 }) {
  const db = await getDb();
  const id = Number(botId);
  const sub = await getSubscription(id);
  const now = new Date();

  const candidates = [now];
  if (sub?.paid_until) candidates.push(new Date(sub.paid_until));
  if (sub?.trial_ends_at) candidates.push(new Date(sub.trial_ends_at));
  const base = candidates.reduce((latest, d) => (d > latest ? d : latest), now);

  const extended = new Date(base);
  extended.setFullYear(extended.getFullYear() + Number(years || 0));
  extended.setMonth(extended.getMonth() + Number(months || 0));
  extended.setDate(extended.getDate() + Number(days || 0));

  await db.collection('subscriptions').updateOne(
    { bot_id: id },
    { $set: { paid_until: extended, updated_at: now },
      $setOnInsert: { bot_id: id, trial_started_at: now, trial_ends_at: now, plan: sub?.plan || 'monthly' } },
    { upsert: true }
  );
  return extended;
}

/**
 * Sets paid_until to an exact date, instead of extending relative to
 * whatever's already there — for correcting a mistake or setting a precise
 * "access until" date directly rather than doing the math yourself.
 */
async function setSubscriptionExpiry(botId, dateInput) {
  const db = await getDb();
  const id = Number(botId);
  const expiry = new Date(dateInput);
  const now = new Date();
  const sub = await getSubscription(id);

  await db.collection('subscriptions').updateOne(
    { bot_id: id },
    { $set: { paid_until: expiry, updated_at: now },
      $setOnInsert: { bot_id: id, trial_started_at: now, trial_ends_at: now, plan: sub?.plan || 'monthly' } },
    { upsert: true }
  );
  return expiry;
}

module.exports = {
  startTrial,
  getSubscription,
  isSubscriptionActive,
  extendSubscription,
  extendSubscriptionByDays,
  extendSubscriptionByYMD,
  setSubscriptionExpiry,
};
