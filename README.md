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
4. **Session persistence**: each client's WhatsApp login lives in
   `sessions/<slug>/`. On Render's free tier (no persistent disk), this
   folder can be wiped on restart/redeploy, meaning clients would need to
   reconnect. For a real paying client base, add a persistent disk (paid
   Render plan) or migrate session storage to the database.

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

## Known limitations

- No payment/subscription system — this manages bot access, not billing.
  You'd add that separately (e.g. manually toggling features based on
  whether a client paid, or integrating a payment provider).
- No per-client custom command sets yet — all clients currently share the
  same command definitions (`!menu`, `!ping`, `!order`, etc.); only whether
  commands work at all is toggleable, not which specific commands.
- Session storage is filesystem-based — fine for one server, but won't
  survive Render free-tier restarts without a persistent disk.
