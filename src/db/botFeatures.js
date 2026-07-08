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
  'anti_delete_enabled',
  'welcome_message_enabled',
  'away_message_enabled',
  'keyword_responses_enabled',
  'auto_status_save_enabled',
  'ai_chat_enabled',
  'presence_tracking_enabled',
  'ai_only_silent_mode',
  'anti_call_enabled',
  'auto_bio_enabled',
  'always_online_enabled',
  'fake_typing_enabled',
  'fake_recording_enabled',
  'auto_react_messages_enabled',
  'auto_save_contacts_enabled',
  'media_download_enabled',
  'anti_ban_mode_enabled',
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
  anti_delete_enabled: 'Anti Delete (capture messages/status before deletion)',
  welcome_message_enabled: 'Welcome Message (first-time contacts)',
  away_message_enabled: 'Away Message',
  keyword_responses_enabled: 'Keyword Responses',
  auto_status_save_enabled: 'Auto Status Saving (download status media)',
  ai_chat_enabled: 'AI Chat Assistant',
  presence_tracking_enabled: 'Online/Offline + Last Seen Tracking',
  ai_only_silent_mode: 'AI-Only Silent Mode (auto-archive & mute every AI conversation)',
  anti_call_enabled: 'Anti-Call (auto-reject voice/video calls)',
  auto_bio_enabled: 'Auto Bio (rotate About text automatically)',
  always_online_enabled: 'Always Online',
  fake_typing_enabled: 'Fake Typing (show "typing..." before replies)',
  fake_recording_enabled: 'Fake Recording (show "recording audio..." before replies)',
  auto_react_messages_enabled: 'Auto React to Messages',
  auto_save_contacts_enabled: 'Auto Save Contacts',
  media_download_enabled: 'Media Download (.song / .video commands)',
  anti_ban_mode_enabled: 'Anti-Ban Mode (human-paced delays, occasional skipped status reactions — reduces risk, does not guarantee against bans)',
};

const STEALTH_READ_MODES = ['normal', 'stealth', 'no_mark'];

const STEALTH_READ_MODE_LABELS = {
  normal: 'Normal (read messages normally, sends read receipts)',
  stealth: 'Stealth (read & auto-reply, but never send read receipts)',
  no_mark: 'No-Mark (auto-reply works, messages never marked as read)',
};

const AI_PROVIDERS = ['groq', 'gemini'];

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

async function setWelcomeMessage(botId, message) {
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET welcome_message_text = $1, updated_at = NOW() WHERE bot_id = $2`,
    [message, botId]
  );
}

async function setAwayMessage(botId, message) {
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET away_message_text = $1, updated_at = NOW() WHERE bot_id = $2`,
    [message, botId]
  );
}

async function setAiProvider(botId, provider) {
  if (!AI_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown AI provider "${provider}". Valid: ${AI_PROVIDERS.join(', ')}`);
  }
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET ai_provider = $1, updated_at = NOW() WHERE bot_id = $2`,
    [provider, botId]
  );
}

async function setAiSystemPrompt(botId, prompt) {
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET ai_system_prompt = $1, updated_at = NOW() WHERE bot_id = $2`,
    [prompt, botId]
  );
}

async function setStealthReadMode(botId, mode) {
  if (!STEALTH_READ_MODES.includes(mode)) {
    throw new Error(`Unknown stealth read mode "${mode}". Valid: ${STEALTH_READ_MODES.join(', ')}`);
  }
  await getFeatures(botId);
  await query(
    `UPDATE bot_features SET stealth_read_mode = $1, updated_at = NOW() WHERE bot_id = $2`,
    [mode, botId]
  );
}

module.exports = {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  STEALTH_READ_MODES,
  STEALTH_READ_MODE_LABELS,
  AI_PROVIDERS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
  setWelcomeMessage,
  setAwayMessage,
  setAiProvider,
  setAiSystemPrompt,
  setStealthReadMode,
};
