const { query } = require('./pool');
const { getPricingSettings } = require('./pricingSettings');

/**
 * Creates the trial subscription record for a brand-new bot, using the
 * current global trial_days setting. Called once, when a bot is first
 * registered (linked to a client_account).
 */
async function startTrial(botId) {
  const pricing = await getPricingSettings();
  const res = await query(
    `INSERT INTO subscriptions (bot_id, trial_started_at, trial_ends_at)
     VALUES ($1, NOW(), NOW() + ($2 || ' days')::interval)
     ON CONFLICT (bot_id) DO NOTHING
     RETURNING *`,
    [botId, pricing.trial_days]
  );
  if (res.rows[0]) return res.rows[0];
  const existing = await query('SELECT * FROM subscriptions WHERE bot_id = $1', [botId]);
  return existing.rows[0] || null;
}

async function getSubscription(botId) {
  const res = await query('SELECT * FROM subscriptions WHERE bot_id = $1', [botId]);
  return res.rows[0] || null;
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
  const intervalSql = plan === 'yearly' ? "1 year" : "1 month";
  await query(
    `UPDATE subscriptions
     SET paid_until = GREATEST(COALESCE(paid_until, NOW()), NOW()) + $2::interval,
         plan = $3,
         updated_at = NOW()
     WHERE bot_id = $1`,
    [botId, intervalSql, plan]
  );
}

module.exports = {
  startTrial,
  getSubscription,
  isSubscriptionActive,
  extendSubscription,
};
