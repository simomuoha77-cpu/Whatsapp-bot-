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

-- Platform admin (you) login for the master dashboard. Single row in practice,
-- but modeled as a table in case you ever want more than one admin login.
CREATE TABLE IF NOT EXISTS platform_admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS stealth_read_mode TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE bot_features ADD COLUMN IF NOT EXISTS anti_view_once_enabled BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS view_once_captures (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  sender_jid TEXT NOT NULL,
  sender_name TEXT,
  sender_number TEXT,
  chat_jid TEXT NOT NULL,
  is_group BOOLEAN DEFAULT FALSE,
  group_name TEXT,
  media_type TEXT NOT NULL,
  media_path TEXT,
  caption TEXT,
  captured_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_view_once_bot ON view_once_captures(bot_id);
