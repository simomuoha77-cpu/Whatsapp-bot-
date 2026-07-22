-- Multi-tenant schema: each row in `bots` represents one client's WhatsApp
-- connection. Every other table that used to be global is now scoped to a
-- bot_id, so client A's contacts/settings never mix with client B's.

CREATE TABLE IF NOT EXISTS bots (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,            -- short random id used in onboarding URL, e.g. /connect/abc123
  client_name TEXT,                     -- label for your own reference, e.g. "Jane's Salon"
  status TEXT DEFAULT 'pending',        -- pending | qr_pending | pairing_code_pending | connected | disconnected
  phone_number TEXT,                    -- filled in once connected
  created_at TIMESTAMPTZ DEFAULT NOW(),
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);

-- Per-bot feature toggles. One row per bot (not per contact) — this is
-- exactly what you control from the master dashboard: "this client's bot
-- only does auto-status-viewing" etc.
CREATE TABLE IF NOT EXISTS bot_features (
  bot_id INTEGER PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  auto_view_status BOOLEAN DEFAULT FALSE,
  auto_react_status BOOLEAN DEFAULT FALSE,
  auto_reply BOOLEAN DEFAULT FALSE,
  auto_reply_message TEXT DEFAULT 'Thanks for your message! I''ll reply shortly.',
  auto_status_post BOOLEAN DEFAULT FALSE,
  auto_reminder BOOLEAN DEFAULT FALSE,
  commands_enabled BOOLEAN DEFAULT TRUE,  -- whether !menu/!ping/etc respond at all
  broadcast_enabled BOOLEAN DEFAULT FALSE,
  -- Stealth Read Mode controls whether incoming chat messages get marked
  -- as read (triggering blue ticks) on the sender's side.
  --   'normal'  - read messages normally, sends read receipts as usual
  --   'stealth' - bot reads/processes messages and can still auto-reply,
  --               but never sends a read receipt, so the sender only ever
  --               sees grey ticks (sent/delivered), never blue (read)
  --   'no_mark' - same as stealth; messages are simply never marked read
  stealth_read_mode TEXT NOT NULL DEFAULT 'normal',
  -- Anti View Once: automatically captures view-once photos/videos before
  -- they expire, saving a copy and forwarding it to the bot's own
  -- "Message Yourself" chat. Off by default given the privacy implications.
  anti_view_once_enabled BOOLEAN DEFAULT FALSE,
  -- New feature toggles
  anti_delete_enabled BOOLEAN DEFAULT FALSE,         -- capture messages/status before deletion
  welcome_message_enabled BOOLEAN DEFAULT FALSE,
  welcome_message_text TEXT DEFAULT 'Welcome! Thanks for messaging us.',
  away_message_enabled BOOLEAN DEFAULT FALSE,
  away_message_text TEXT DEFAULT 'We''re currently away and will respond soon.',
  keyword_responses_enabled BOOLEAN DEFAULT FALSE,
  auto_status_save_enabled BOOLEAN DEFAULT FALSE,    -- download status media (separate from viewing/reacting)
  ai_chat_enabled BOOLEAN DEFAULT FALSE,
  ai_provider TEXT DEFAULT 'groq',                   -- 'groq' or 'gemini'
  ai_system_prompt TEXT DEFAULT 'You are a helpful assistant responding to WhatsApp messages. Keep replies concise.',
  presence_tracking_enabled BOOLEAN DEFAULT FALSE,   -- online/offline + last-seen logging
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts are now scoped per bot — Client A's contacts are invisible to Client B.
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  phone_number TEXT,
  display_name TEXT,
  is_blocked BOOLEAN DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INTEGER DEFAULT 0,
  UNIQUE (bot_id, jid)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  media_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_bot_jid ON messages(bot_id, jid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_msgid ON messages(bot_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions_state (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  context JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (bot_id, jid)
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  body TEXT,
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS status_log (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  contact_jid TEXT NOT NULL,
  status_id TEXT,
  media_type TEXT,
  media_path TEXT,
  caption TEXT,
  viewed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS command_logs (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_status_posts (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  cron_expression TEXT NOT NULL,
  caption TEXT,
  media_path TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  target_jid TEXT NOT NULL,
  notify_admin BOOLEAN DEFAULT FALSE,
  message TEXT NOT NULL,
  cron_expression TEXT,
  run_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tracks statuses the bot itself has posted (both scheduled auto-posts and
-- manual posts), so we can show "who viewed my status" in the dashboard.
-- One row per posted status, keyed by its own WhatsApp message id.
CREATE TABLE IF NOT EXISTS own_status_posts (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,       -- the status's own WAMessageKey.id
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'scheduled'
  caption TEXT,
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (bot_id, message_id)
);

-- One row per contact who has viewed one of the bot's own posted statuses,
-- populated from Baileys' message-receipt.update event (read receipts).
CREATE TABLE IF NOT EXISTS own_status_views (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status_post_id INTEGER NOT NULL REFERENCES own_status_posts(id) ON DELETE CASCADE,
  viewer_jid TEXT NOT NULL,
  viewer_name TEXT,
  viewed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (status_post_id, viewer_jid)
);

-- Stores each bot's WhatsApp login credentials (the Baileys "auth state"),
-- so sessions survive deploys/restarts on Render's free tier, which wipes
-- the filesystem on every deploy but persists Postgres data.
CREATE TABLE IF NOT EXISTS bot_auth_state (
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL,   -- 'creds' for the single creds object, or a Baileys key category name
  key_id TEXT NOT NULL DEFAULT '',  -- empty for 'creds', otherwise the specific key id
  value TEXT,               -- JSON-serialized via Baileys' BufferJSON, or NULL to mean "deleted"
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (bot_id, key_type, key_id)
);

-- Log of every view-once photo/video the bot has captured, per client bot.
CREATE TABLE IF NOT EXISTS view_once_captures (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  sender_jid TEXT NOT NULL,
  sender_name TEXT,
  sender_number TEXT,
  chat_jid TEXT NOT NULL,        -- where it was sent: a direct chat or a group
  is_group BOOLEAN DEFAULT FALSE,
  group_name TEXT,                -- populated only when is_group is true
  media_type TEXT NOT NULL,       -- 'image' or 'video'
  media_path TEXT,                -- saved file location on disk
  caption TEXT,
  captured_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_view_once_bot ON view_once_captures(bot_id);

-- Keyword -> response pairs, per bot. Admin-configurable via dashboard.
CREATE TABLE IF NOT EXISTS keyword_responses (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,        -- matched as case-insensitive substring
  response TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_keyword_responses_bot ON keyword_responses(bot_id);

-- Captures messages and statuses just before/when WhatsApp signals they
-- were deleted, so the content isn't lost. Works the same way Anti View
-- One does: we cache content when it first arrives, and only display "it
-- was deleted" notices alongside the cached copy when a delete event fires.
CREATE TABLE IF NOT EXISTS deleted_message_captures (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,     -- 'message' or 'status'
  sender_jid TEXT NOT NULL,
  sender_name TEXT,
  sender_number TEXT,
  chat_jid TEXT NOT NULL,
  is_group BOOLEAN DEFAULT FALSE,
  group_name TEXT,
  message_type TEXT NOT NULL,    -- text, image, video, audio, document, sticker
  body TEXT,
  media_path TEXT,
  deleted_at TIMESTAMPTZ DEFAULT NOW(),
  original_sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deleted_captures_bot ON deleted_message_captures(bot_id);

-- Downloaded copies of contacts' status media, separate from the
-- view+react log (status_log) — this is specifically for keeping the
-- actual files, gated by auto_status_save_enabled.
CREATE TABLE IF NOT EXISTS status_saves (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  contact_jid TEXT NOT NULL,
  contact_name TEXT,
  media_type TEXT NOT NULL,
  media_path TEXT,
  caption TEXT,
  saved_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_status_saves_bot ON status_saves(bot_id);

-- Presence (online/offline) and last-seen tracking, per contact. Only
-- populated for contacts whose own privacy settings allow it to be seen.
CREATE TABLE IF NOT EXISTS presence_log (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  contact_jid TEXT NOT NULL,
  presence_status TEXT NOT NULL,  -- 'available', 'composing', 'unavailable', etc.
  last_seen_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (bot_id, contact_jid)
);

-- AI chat conversation history, per bot+contact, so the assistant has
-- short-term context across messages in the same conversation.
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  contact_jid TEXT NOT NULL,
  role TEXT NOT NULL,            -- 'user' or 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_history_bot_contact ON ai_chat_history(bot_id, contact_jid);

-- IMPORTANT: CREATE TABLE IF NOT EXISTS does nothing if the table already
-- exists — it does NOT add new columns to it. Since bot_features was
-- created in an earlier deploy before these columns existed, they must be
-- added explicitly here, every time, so existing databases catch up.
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS anti_delete_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS welcome_message_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS welcome_message_text TEXT DEFAULT 'Welcome! Thanks for messaging us.';
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS away_message_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS away_message_text TEXT DEFAULT 'We''re currently away and will respond soon.';
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS keyword_responses_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS auto_status_save_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS ai_chat_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS ai_provider TEXT DEFAULT 'groq';
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS ai_system_prompt TEXT DEFAULT 'You are a helpful assistant responding to WhatsApp messages. Keep replies concise.';
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS presence_tracking_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS ai_only_silent_mode BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS anti_call_enabled BOOLEAN DEFAULT FALSE;   -- auto-reject incoming calls
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS anti_call_message TEXT DEFAULT 'Sorry, calls are not accepted on this number. Please send a text message instead.';
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS auto_bio_enabled BOOLEAN DEFAULT FALSE;     -- periodically rotate the "About" text
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS auto_bio_texts TEXT DEFAULT 'Available|At work|Do not disturb';  -- pipe-separated rotation list
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS always_online_enabled BOOLEAN DEFAULT FALSE; -- keep presence as "available" continuously
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS fake_typing_enabled BOOLEAN DEFAULT FALSE;   -- show "typing..." before every reply
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS fake_recording_enabled BOOLEAN DEFAULT FALSE; -- show "recording audio..." instead of typing
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS auto_react_messages_enabled BOOLEAN DEFAULT FALSE; -- react to incoming chat messages (not status)
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS auto_save_contacts_enabled BOOLEAN DEFAULT FALSE;  -- upsert every new sender into the contacts table
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS media_download_enabled BOOLEAN DEFAULT FALSE; -- .song / .video download commands
ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS anti_ban_mode_enabled BOOLEAN DEFAULT TRUE; -- human-paced delays + occasional skipped status reactions

-- Client-facing login accounts (separate from your own platform admin
-- login). One account per phone number, linked to the bot they registered
-- with that number. Login is phone number + password only.
CREATE TABLE IF NOT EXISTS client_accounts (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  phone_number TEXT UNIQUE NOT NULL,   -- the number they registered with; trial is tied to this permanently
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One subscription record per bot. Tracks trial window and paid-until
-- date. A bot is "active" if NOW() is before trial_ends_at OR before
-- paid_until, whichever is later.
CREATE TABLE IF NOT EXISTS subscriptions (
  bot_id INTEGER PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  trial_started_at TIMESTAMPTZ DEFAULT NOW(),
  trial_ends_at TIMESTAMPTZ NOT NULL,
  paid_until TIMESTAMPTZ,              -- NULL until they've ever paid
  plan TEXT DEFAULT 'monthly',          -- 'monthly' or 'yearly'
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Records of every STK Push payment attempt, successful or not. Looked up
-- by checkout_request_id when Safaricom's callback arrives.
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  checkout_request_id TEXT UNIQUE NOT NULL,
  merchant_request_id TEXT,
  phone_number TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  plan TEXT NOT NULL,                  -- 'monthly' or 'yearly'
  status TEXT DEFAULT 'pending',        -- pending, success, failed, cancelled
  mpesa_receipt_number TEXT,
  result_desc TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_bot ON payments(bot_id);

-- Global pricing, set by you (the platform admin) from /admin. Single row.
CREATE TABLE IF NOT EXISTS pricing_settings (
  id SERIAL PRIMARY KEY,
  monthly_price NUMERIC NOT NULL DEFAULT 500,
  yearly_price NUMERIC NOT NULL DEFAULT 5000,
  trial_days INTEGER NOT NULL DEFAULT 5,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Platform admin (you) login for the master dashboard. Single row in practice,
-- but modeled as a table in case you ever want more than one admin login.
CREATE TABLE IF NOT EXISTS platform_admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
