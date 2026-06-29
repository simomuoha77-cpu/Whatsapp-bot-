# WhatsApp Bot Platform (Multi-Tenant)

A platform for running and selling WhatsApp bots to multiple clients from
one deployment. You manage everything from a single admin dashboard; each
client connects their own WhatsApp number and never sees your admin panel.

## ⚠️ Read this before you deploy

1. **Unofficial library (Baileys).** Each client bot automates a real
   WhatsApp account. Accounts that send heavy automated traffic can be
   banned by WhatsApp/Meta — make sure clients understand this risk before
   connecting their main number.
2. **Memory matters.** Each connected client bot is a live WebSocket
   connection held in memory. Render's free tier (512MB RAM) can likely
   handle a handful of clients before you need to upgrade to a paid
   instance. Watch your memory usage as you onboard more clients.
3. **Render's free Postgres expires after 30 days** and has a 1GB cap —
   fine to start, but plan to upgrade for real client data.
4. **Sessions persist across deploys.** Unlike the filesystem (which
   Render's free tier wipes on every deploy/restart), each client's
   WhatsApp login credentials are stored in the `bot_auth_state` table in
   Postgres. This means pushing new code does **not** force clients to
   rescan/reconnect — sessions survive deploys automatically.

## How it works

- **You** log into `/admin` with your own platform credentials.
- From there, click **"Create Client Bot"** — this generates a new bot
  record and a unique onboarding link like `yourapp.onrender.com/connect/abc123`.
- **Send that link to your client.** They open it on their phone, scan a QR
  code (or use a pairing code), and their WhatsApp account connects to
  their own bot instance — they never see or need your admin login.
- Back in `/admin`, click into that client's bot to:
  - Toggle exactly which features are active (auto status viewing, auto
    react, auto reply, scheduled status posts, reminders, commands,
    broadcast) — if a client only paid for "auto status viewing," turn
    everything else off.
  - See their recent contacts.
  - Set up scheduled status posts or reminders on their behalf.
  - Regenerate their onboarding link (revokes the old one) or delete the
    client entirely.

## Project structure

```
src/
  index.js                  - entry point: migrations, server, loads all bots, starts scheduler
  server.js                 - Express app wiring sessions + route mounting
  db/
    pool.js, migrate.js, schema.sql
    bots.js                 - core tenant table (one row per client)
    botFeatures.js          - per-client feature toggles
    contacts.js             - contacts, scoped per bot_id
    messages.js, sessionState.js, logs.js, broadcasts.js
    scheduledStatusPosts.js, reminders.js
  utils/
    botManager.js            - holds every live Baileys socket in memory, keyed by bot_id
    platformAuth.js           - YOUR login (not client-facing)
    statusEmoji.js, logger.js
  handlers/
    admin.js                  - YOUR dashboard: create/manage all clients
    onboarding.js              - client-facing QR/pairing connect page
    botStartHook.js             - attaches message/status handlers to any newly connected bot
    messageHandler.js, statusHandler.js  - per-bot, read that bot's own feature flags
    scheduler.js                - cron jobs across all bots' scheduled posts/reminders
  commands/
    registry.js, basic.js, interactive.js, broadcast.js, order.js
```

## Setup

1. `cp .env.example .env` and fill in `DATABASE_URL`, `PLATFORM_ADMIN_USERNAME`,
   `PLATFORM_ADMIN_PASSWORD`, `SESSION_SECRET`.
2. `npm install`
3. `npm start`
4. Visit `http://localhost:3000/admin`, log in, create your first client bot.
5. Open the onboarding link it gives you (as if you were the client) and
   scan/pair to confirm the whole flow works end to end.

## Deploying to Render

Same as a normal Node web service:
- Build command: `npm install`
- Start command: `npm start`
- Set the env vars above in Render's dashboard
- Once live, `/admin` is your control panel; share `/connect/<slug>` links
  with clients as you create them

## Feature toggles, explained

Each client bot has these independent on/off switches:
- **Auto Status Viewing** — marks contacts' WhatsApp Status as seen automatically
- **Auto Status Reacting** — reacts to statuses with an emoji based on caption keywords
- **Auto Reply** — sends an away-message-style reply to first-time/returning contacts (with a cooldown)
- **Auto Status Posting** — the bot posts its own scheduled WhatsApp Status updates
- **Auto Reminders** — scheduled messages sent to specific contacts
- **Commands** — whether typed commands like `!menu`, `!ping` work at all
- **Broadcast** — whether `!broadcast` is usable for this client

Turning everything off except "Auto Status Viewing" gives you exactly the
"client only wants status viewing" bot you described — commands won't
respond, no reactions, nothing else happens, just silent status viewing.

## Stealth Read Mode

Each client's bot also has a **Stealth Read Mode** setting, controlling
whether incoming messages get marked as "read" (the blue double-tick) on
the sender's side:

- **Normal** — behaves like a regular WhatsApp client; messages are marked
  read as usual, sender sees blue ticks.
- **Stealth** — the bot still fully reads and processes every message
  (auto-reply, commands, everything works normally), but never sends the
  read receipt back to WhatsApp. The sender only ever sees grey ticks
  (sent/delivered), never blue.
- **No-Mark** — functionally the same as Stealth (auto-reply works,
  messages are simply never marked read).

Set this per client from `/admin` → click into the bot → **Stealth Read
Mode** dropdown.

## Anti View Once

When enabled per-client, the bot automatically detects view-once photos
and videos (in both direct chats and groups) and silently downloads/saves
them before they expire — no notification is sent to the sender. Files
are saved to `downloads/view-once/` on the server; every capture is
logged with sender name/number, chat, and timestamp.

**Retrieval is on-demand, from inside the same chat where it was received:**
- `.v` — sends back the most recently captured view-once media **from
  that specific chat** as a normal (non-view-once) photo/video, so it can
  be viewed repeatedly, downloaded, saved, or forwarded freely.
- `.vlist` — shows a numbered history of recent captures in that chat.

These two commands work independently of the bot's `!`-prefixed command
system and the `commands_enabled` toggle — they're gated solely by
`anti_view_once_enabled`, since they're core to this specific feature.
Only the bot owner (messaging their own connected number) can trigger
them, and `.v` only ever returns captures from the exact chat it's typed
in — it can't pull a capture from a different conversation.

The full capture log (across all chats) is also viewable from `/admin` →
the bot's page → **View-Once Captures**.

**⚠️ Important to understand before enabling this for a client:** View
Once exists specifically because the sender chose that mode, expecting
the recipient to see it exactly once. Capturing it without the sender's
knowledge is exactly the kind of behavior WhatsApp's anti-abuse systems
watch for, and in some places may carry real privacy/legal implications —
similar in spirit to recording someone without consent. This is off by
default (`anti_view_once_enabled` defaults to `false`); enabling it for a
client is a deliberate choice you and they should make with that in mind.

## New features (messaging, privacy, AI)

All toggleable per-client from `/admin` → the bot's page → **Features for
this client**, same as everything else.

- **Welcome Message** — sent once, automatically, the first time a contact
  ever messages the bot. Independent of Auto Reply, which can fire
  repeatedly on a cooldown.
- **Away Message** — a dedicated message/toggle separate from Auto Reply,
  for a clearer "currently away" framing if you want both configured
  differently.
- **Keyword Responses** — admin-defined keyword → response pairs (e.g.
  "price" → your pricing info). Matched as a case-insensitive substring of
  the incoming message. Manage them from the bot's dashboard page.
- **Anti Delete** — works like Anti View Once: every message is cached in
  memory briefly when it arrives, and if WhatsApp signals it was deleted
  shortly after, the cached copy (text or downloaded media) is logged and
  forwarded to the bot's own "Message Yourself" chat. Only catches deletes
  that happen while the bot process is running and within a ~30 minute
  window of the original message.
- **Auto Status Saving** — downloads a copy of contacts' status
  photos/videos to disk, separate from (and in addition to) the existing
  status viewing/reacting features. Viewable from the bot's dashboard page.
- **AI Chat Assistant** — when enabled, the bot replies to plain-text
  messages (anything not starting with the command prefix, and not
  matching a keyword response) using an AI provider. Supports **Groq** or
  **Gemini** — set `GROQ_API_KEY` and/or `GEMINI_API_KEY` in your
  environment, then pick the provider and customize the system
  prompt/personality per bot from the dashboard. Keeps short conversation
  history per contact for context. If the AI call fails (missing key, API
  down), the bot falls through to its normal fallback response rather than
  going silent.
- **Online/Offline + Last Seen Tracking** — subscribes to presence updates
  for contacts who message the bot, logging status changes (online,
  offline, typing, last-seen timestamp) to the database. Important
  caveat: this only works for contacts whose own WhatsApp privacy settings
  allow their presence to be visible at all — if someone has "Last Seen &
  Online" set to nobody/contacts-only (and the bot isn't in that list),
  WhatsApp simply never sends presence updates for them, regardless of
  anything this code does.

## Client billing (trials, subscriptions, M-Pesa STK Push)

Clients can self-register at `/client/register` with a phone number and
password — separate from your own `/admin` login. Registering creates
their bot, starts a free trial (length set by you), and takes them
straight to the WhatsApp connection page.

- **Trial**: tied permanently to the phone number used at registration —
  that number can't register again for a second trial.
- **Client dashboard** (`/client/dashboard`, after logging in): shows
  subscription status (trial days left / paid until / expired) and lets
  them trigger an M-Pesa STK Push to subscribe or renew.
- **Expiry enforcement**: when a bot's trial and any paid period have both
  lapsed, the bot stops responding entirely — no commands, no auto-reply,
  no AI, nothing — checked on every incoming message and status update.
- **Pricing**: set globally from `/admin` (monthly price, yearly price,
  trial length in days). Changes apply going forward, not retroactively.
- **Payments**: each STK Push attempt is logged in the `payments` table;
  Safaricom's callback (`/client/payment-callback`) confirms success/failure
  and extends the subscription automatically on success.

**Setup required before this works for real:**
1. Set `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_SHORTCODE`,
   `DARAJA_PASSKEY` in your environment (from your Safaricom Daraja app).
2. Set `DARAJA_ENV=production` once you're ready for real transactions
   (defaults to `sandbox` for testing).
3. Daraja's callback requires a public HTTPS URL — your Render URL already
   satisfies this; no extra setup needed there.
4. Test with Safaricom's sandbox test number (`254708374149`, any 4-digit
   PIN) before switching to production.

**Honest limitation**: this billing logic has been verified against
Safaricom's documented API format and tested with mocked HTTP responses,
but has not been tested against a real M-Pesa transaction. Test thoroughly
in sandbox mode first.

## Known limitations

- No automatic dunning/retry on failed renewal payments — a client whose
  card/M-Pesa payment fails simply sees "expired" and must manually retry
  from their dashboard.
  You'd add that separately (e.g. manually toggling features based on
  whether a client paid, or integrating a payment provider).
- No per-client custom command sets yet — all clients currently share the
  same command definitions (`!menu`, `!ping`, `!order`, etc.); only whether
  commands work at all is toggleable, not which specific commands.
- Session storage is filesystem-based — fine for one server, but won't
  survive Render free-tier restarts without a persistent disk.
