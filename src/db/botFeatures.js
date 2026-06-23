const { query } = require('./pool');

const FEATURE_COLUMNS = [
  'auto_view_status',
  'auto_react_status',
  'auto_reply',
  'auto_status_post',
  'auto_reminder',
  'commands_enabled',
  'broadcast_enabled',
  'anti_view_once_enabled',
];

const FEATURE_LABELS = {
  auto_view_status: 'Auto Status Viewing',
  auto_react_status: 'Auto Status Reacting',
  auto_reply: 'Auto Reply (away message)',
  auto_status_post: 'Auto Status Posting',
  auto_reminder: 'Auto Reminders',
  commands_enabled: 'Commands (!menu, !ping, etc.)',
  broadcast_enabled: 'Broadcast capability',
  anti_view_once_enabled: 'Anti View Once (capture & save view-once media)',
};

async function getFeatures(botId) {
  const res = await query('SELECT * FROM bot_features WHERE bot_id = $1', [botId]);
  if (res.rows[0]) return res.rows[0];
  const insert = await query(
    `INSERT INTO bot_features (bot_id) VALUES ($1) ON CONFLICT (bot_id) DO NOTHING RETURNING *`,
    [botId]
  );
  if (insert.rows[0]) return insert.rows[0];
  const retry = await query('SELECT * FROM bot_features WHERE bot_id = $1', [botId]);
  return retry.rows[0];
}

async function setFeature(botId, feature, enabled) {
  if (!FEATURE_COLUMNS.includes(feature)) {
    throw new Error(`Unknown feature "${feature}"`);
  }
  await getFeatures(botId); // ensure row exists
  await query(
    `UPDATE bot_features SET ${feature} = $1, updated_at = NOW() WHERE bot_id = $2`,
    [enabled, botId]
  );
}

async function setAutoReplyMessage(botId, message) {
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET auto_reply_message = $1, updated_at = NOW() WHERE bot_id = $2`,
    [message, botId]
  );
}


const STEALTH_READ_MODES = ["normal", "stealth", "no_mark"];
const STEALTH_READ_MODE_LABELS = {
  normal: "Normal (sends read receipts)",
  stealth: "Stealth (no read receipts, auto-reply works)",
  no_mark: "No-Mark (auto-reply works, never marked read)",
};

async function setStealthReadMode(botId, mode) {
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET stealth_read_mode = $1, updated_at = NOW() WHERE bot_id = $2`,
    [mode, botId]
  );
}

module.exports = {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
  setStealthReadMode,
  STEALTH_READ_MODES,
  STEALTH_READ_MODE_LABELS,
};
