-- Run this once against your Render Postgres database before starting the bot.
-- You can do this via: psql "$DATABASE_URL" -f src/db/schema.sql
-- Or it is run automatically by src/db/migrate.js on bot startup.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  jid TEXT UNIQUE NOT NULL,            -- WhatsApp JID, e.g. 15551234567@s.whatsapp.net
  phone_number TEXT,
  display_name TEXT,
  is_admin BOOLEAN DEFAULT FALSE,
  is_blocked BOOLEAN DEFAULT FALSE,
  language TEXT DEFAULT 'en',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  jid TEXT NOT NULL REFERENCES users(jid) ON DELETE CASCADE,
  message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL DEFAULT 'text', -- text, image, video, audio, document, sticker, location, contact
  body TEXT,
  media_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE TABLE IF NOT EXISTS sessions_state (
  id SERIAL PRIMARY KEY,
  jid TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',   -- tracks multi-step command flows, e.g. 'awaiting_order_address'
  context JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id SERIAL PRIMARY KEY,
  created_by TEXT,
  body TEXT,
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, running, completed, failed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS status_log (
  id SERIAL PRIMARY KEY,
  contact_jid TEXT NOT NULL,
  status_id TEXT,
  media_type TEXT,
  media_path TEXT,
  caption TEXT,
  viewed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS command_logs (
  id SERIAL PRIMARY KEY,
  jid TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user feature toggles, set by admins for specific WhatsApp numbers.
CREATE TABLE IF NOT EXISTS user_features (
  id SERIAL PRIMARY KEY,
  jid TEXT UNIQUE NOT NULL,
  auto_view BOOLEAN DEFAULT TRUE,
  auto_react BOOLEAN DEFAULT FALSE,
  auto_reply BOOLEAN DEFAULT FALSE,
  auto_reply_message TEXT DEFAULT 'Thanks for your message! I''ll reply shortly.',
  auto_status_post BOOLEAN DEFAULT FALSE,
  auto_reminder BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled WhatsApp Status posts (bot's own account), e.g. "post this image at 7am daily".
CREATE TABLE IF NOT EXISTS scheduled_status_posts (
  id SERIAL PRIMARY KEY,
  created_by TEXT NOT NULL,
  cron_expression TEXT NOT NULL,   -- e.g. '0 7 * * *' for daily at 7:00 AM
  caption TEXT,
  media_path TEXT,                 -- optional local file path to an image/video to post
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled reminders sent to specific users at a given time (one-off or recurring).
CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  created_by TEXT NOT NULL,
  target_jid TEXT NOT NULL,        -- who receives the reminder message
  notify_admin BOOLEAN DEFAULT FALSE, -- if true, also pings the admin who created it
  message TEXT NOT NULL,
  cron_expression TEXT,            -- set for recurring reminders, e.g. '0 8 * * *'
  run_at TIMESTAMPTZ,              -- set for one-off reminders instead of cron_expression
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
