const { query } = require('./pool');

const FEATURE_COLUMNS = [
  'auto_view',
  'auto_react',
  'auto_reply',
  'auto_status_post',
  'auto_reminder',
];

const FEATURE_LABELS = {
  auto_view: 'Auto Status Viewing',
  auto_react: 'Auto Status Reacting',
  auto_reply: 'Auto Reply (away message)',
  auto_status_post: 'Auto Status Posting (bot account)',
  auto_reminder: 'Auto Reminders',
};

async function getFeatures(jid) {
  const res = await query('SELECT * FROM user_features WHERE jid = $1', [jid]);
  if (res.rows[0]) return res.rows[0];

  // Create a default row on first access so toggles always have something to update.
  const insert = await query(
    `INSERT INTO user_features (jid) VALUES ($1)
     ON CONFLICT (jid) DO NOTHING
     RETURNING *`,
    [jid]
  );
  if (insert.rows[0]) return insert.rows[0];

  const retry = await query('SELECT * FROM user_features WHERE jid = $1', [jid]);
  return retry.rows[0];
}

async function setFeature(jid, feature, enabled) {
  if (!FEATURE_COLUMNS.includes(feature)) {
    throw new Error(`Unknown feature "${feature}". Valid: ${FEATURE_COLUMNS.join(', ')}`);
  }
  await getFeatures(jid); // ensure row exists first
  await query(
    `UPDATE user_features SET ${feature} = $1, updated_at = NOW() WHERE jid = $2`,
    [enabled, jid]
  );
}

async function setAutoReplyMessage(jid, message) {
  await getFeatures(jid);
  await query(
    `UPDATE user_features SET auto_reply_message = $1, updated_at = NOW() WHERE jid = $2`,
    [message, jid]
  );
}

async function isFeatureEnabled(jid, feature) {
  const row = await getFeatures(jid);
  return !!(row && row[feature]);
}

module.exports = {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
  isFeatureEnabled,
};
