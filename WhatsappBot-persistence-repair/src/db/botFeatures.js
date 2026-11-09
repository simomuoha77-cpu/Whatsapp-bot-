const { getDb } = require('./mongo');

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
  'group_welcome_enabled',
  'group_goodbye_enabled',
  'group_antilink_enabled',
  'group_tagall_enabled',
  'business_hours_enabled',
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
  group_welcome_enabled: 'Group Welcome Message',
  group_goodbye_enabled: 'Group Goodbye Message',
  group_antilink_enabled: 'Group Anti-Link (remove links from non-admins)',
  group_tagall_enabled: 'Group Tag-All (!tagall command for admins)',
  business_hours_enabled: 'Business Hours Auto-Reply (away message only outside set hours)',
};

const STEALTH_READ_MODES = ['normal', 'stealth', 'no_mark'];

const STEALTH_READ_MODE_LABELS = {
  normal: 'Normal (like a real phone — only marked read when you open the chat yourself)',
  stealth: 'Stealth (read & auto-reply, but never send read receipts)',
  no_mark: 'No-Mark (auto-reply works, actively forces the chat to stay unread)',
};

const AI_PROVIDERS = ['groq', 'gemini'];

// Mongo documents don't carry column defaults the way Postgres did — a
// field simply won't exist until explicitly set. These mirror exactly
// what schema.sql declared as DEFAULT, merged under whatever's actually
// stored so real values always win and only genuinely-unset fields fall
// back here (same effective behavior as Postgres columns added later via
// ALTER TABLE ADD COLUMN, which existing rows never had a chance to set).
const DEFAULTS = {
  auto_reply_message: "Thanks for your message! I'll reply shortly.",
  commands_enabled: true,
  stealth_read_mode: 'normal',
  welcome_message_text: 'Welcome! Thanks for messaging us.',
  away_message_text: "We're currently away and will respond soon.",
  ai_provider: 'groq',
  ai_system_prompt: 'You are a helpful assistant responding to WhatsApp messages. Keep replies concise.',
  anti_call_message: 'Sorry, calls are not accepted on this number. Please send a text message instead.',
  auto_bio_texts: 'Available|At work|Do not disturb',
  anti_ban_mode_enabled: true,
  group_welcome_text: 'Welcome to the group, {mention}! 👋',
  group_goodbye_text: 'Goodbye, {mention}. 👋',
  business_hours_start: '09:00',
  business_hours_end: '18:00',
  business_hours_timezone: 'Africa/Nairobi',
  business_hours_away_text: "We're currently outside business hours. We'll respond when we're back.",
  payment_method_type: 'none',
};

async function getFeatures(botId) {
  const db = await getDb();
  const id = Number(botId);
  let doc = await db.collection('bot_features').findOne({ bot_id: id });
  if (!doc) {
    doc = { bot_id: id, updated_at: new Date() };
    await db.collection('bot_features').insertOne(doc);
  }
  return { ...DEFAULTS, ...doc };
}

async function setFeature(botId, feature, enabled) {
  if (!FEATURE_COLUMNS.includes(feature)) {
    throw new Error(`Unknown feature "${feature}"`);
  }
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id); // ensure doc exists
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { [feature]: enabled, updated_at: new Date() } }
  );
}

async function setAutoReplyMessage(botId, message) {
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { auto_reply_message: message, updated_at: new Date() } }
  );
}

async function setWelcomeMessage(botId, message) {
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { welcome_message_text: message, updated_at: new Date() } }
  );
}

async function setAwayMessage(botId, message) {
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { away_message_text: message, updated_at: new Date() } }
  );
}

async function setAiProvider(botId, provider) {
  if (!AI_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown AI provider "${provider}". Valid: ${AI_PROVIDERS.join(', ')}`);
  }
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { ai_provider: provider, updated_at: new Date() } }
  );
}

async function setAiSystemPrompt(botId, prompt) {
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { ai_system_prompt: prompt, updated_at: new Date() } }
  );
}

async function setStealthReadMode(botId, mode) {
  if (!STEALTH_READ_MODES.includes(mode)) {
    throw new Error(`Unknown stealth read mode "${mode}". Valid: ${STEALTH_READ_MODES.join(', ')}`);
  }
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { stealth_read_mode: mode, updated_at: new Date() } }
  );
}

const TEXT_FIELDS = [
  'group_welcome_text',
  'group_goodbye_text',
  'business_hours_start',
  'business_hours_end',
  'business_hours_timezone',
  'business_hours_away_text',
  'payment_method_type',
  'payment_till_number',
  'payment_paybill_number',
  'payment_paybill_account',
  'payment_phone_number',
  'payment_notes',
];

async function setTextField(botId, field, value) {
  if (!TEXT_FIELDS.includes(field)) {
    throw new Error(`Unknown text field "${field}"`);
  }
  const db = await getDb();
  const id = Number(botId);
  await getFeatures(id);
  await db.collection('bot_features').updateOne(
    { bot_id: id },
    { $set: { [field]: value, updated_at: new Date() } }
  );
}

module.exports = {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  STEALTH_READ_MODES,
  STEALTH_READ_MODE_LABELS,
  AI_PROVIDERS,
  TEXT_FIELDS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
  setWelcomeMessage,
  setAwayMessage,
  setAiProvider,
  setAiSystemPrompt,
  setStealthReadMode,
  setTextField,
};
