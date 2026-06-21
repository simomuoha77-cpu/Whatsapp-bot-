# WhatsApp Bot (Baileys + Postgres + Render)

A complete, self-hosted WhatsApp bot. Connects to your real WhatsApp account
(no Meta Business approval needed), supports commands, menus, buttons, status
(story) viewing, broadcasts, multi-step flows, and persists everything to
Postgres.

## ⚠️ Read this before you deploy

1. **This uses an unofficial library (Baileys).** It automates WhatsApp by
   pretending to be a linked device (like WhatsApp Web). It is **not**
   endorsed by Meta/WhatsApp, and accounts that send a lot of automated
   messages — especially unsolicited broadcasts — can get **banned**.
   Use a spare number, not your primary one, especially while testing.
2. **Render's free plan spins your service down when idle** and does **not**
   include a persistent disk on the free tier. That matters because Baileys
   stores your login session in the `session/` folder — if that folder is
   wiped, you'll need to re-scan the QR code. Practical options:
   - Upgrade to a paid Render instance + add a persistent disk (configured in
     `render.yaml`), so the session folder survives restarts/deploys.
   - Or accept that on the free tier you may need to rescan the QR
     periodically (after deploys or spin-downs).
3. **Status viewing** marks stories as "seen" by your account — the people
   whose status you view will see you as a viewer, exactly like opening
   their story manually.

## Features included

- ✅ Real WhatsApp connection via QR login (web page at `/qr`, no terminal needed)
- ✅ Auto-reconnect on disconnects, session persistence
- ✅ Command system with prefix (`!menu`, `!ping`, `!info`, etc.)
- ✅ Admin-only commands (broadcast, block/unblock, whois, stats)
- ✅ Interactive buttons and list menus (`!options`, `!catalog`)
- ✅ Multi-step conversation flow example (`!order`)
- ✅ FAQ/keyword auto-replies (`!faq`)
- ✅ Status (story) auto-view + optional auto-download
- ✅ Incoming media auto-saved to `/downloads/incoming`
- ✅ Broadcast to all known users with rate-limiting (anti-ban delay)
- ✅ Full Postgres persistence: users, message history, command logs, status logs, broadcasts
- ✅ Health check endpoint for Render (`/health`)
- ✅ Structured logging (pino)

## Project structure

```
src/
  index.js                 - entry point, wires everything together
  whatsapp.js               - Baileys connection, QR, reconnect logic
  server.js                 - Express server (health check + QR web page)
  db/
    pool.js                 - Postgres connection pool
    schema.sql               - table definitions
    migrate.js               - runs schema.sql on startup
    users.js, messages.js, sessionState.js, broadcasts.js, logs.js
  handlers/
    messageHandler.js        - routes every incoming message
    statusHandler.js          - handles status/story updates
  commands/
    registry.js               - command registration system
    menu.js, info.js, interactive.js, broadcast.js,
    moderation.js, order.js, faq.js, media.js
  utils/
    logger.js, media.js
```

## Setup

### 1. Install dependencies locally (to test before deploying)

```bash
npm install
```

### 2. Create a Postgres database on Render

- Render dashboard → New → PostgreSQL → free plan is fine to start
- Copy the **Internal Database URL** (if bot and DB are both on Render) or
  **External Database URL** (if testing locally)

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

At minimum set `DATABASE_URL` and `ADMIN_NUMBERS` (your own number, digits
only, with country code, e.g. `15551234567`).

### 4. Run locally first (recommended)

```bash
npm start
```

Visit `http://localhost:3000/qr` in your browser, scan with WhatsApp
(Settings → Linked Devices → Link a Device). Once connected, the `session/`
folder will contain your auth credentials — keep this folder, it's how the
bot stays logged in.

### 5. Deploy to Render

- Push this code to a GitHub repo (the `.gitignore` already excludes
  `session/`, `.env`, and `downloads/` — **do not commit these**, they
  contain secrets/session keys)
- Render dashboard → New → Web Service → connect your repo
- Set environment variables in the Render dashboard (`DATABASE_URL`,
  `ADMIN_NUMBERS`, etc.) — `render.yaml` documents which ones are needed
- Deploy, then visit `https://<your-service>.onrender.com/qr` to scan and
  log in
- **For the session to survive restarts**, add a persistent disk (paid
  plans only) mounted at the `session/` path, as set up in `render.yaml`

### 6. Test it

Message your bot's number from another phone:
- `!menu` — see all commands
- `!ping` — check it's alive
- `!options` — try the interactive buttons
- `!order` — try the multi-step flow
- Post a WhatsApp Status from a contact and check your database's
  `status_log` table — the bot will have auto-viewed it

## Customizing

- Add new commands: create a file in `src/commands/`, call
  `register('name', { description, adminOnly, handler })`, then `require()`
  it in `src/commands/index.js`.
- Edit FAQ answers in `src/commands/faq.js`.
- Edit interactive menu options/categories in `src/commands/interactive.js`.
- Adjust broadcast delay via `BROADCAST_DELAY_MS` in `.env` (higher = safer
  against bans, slower to send).

## Known limitations / things to wire up further

- Sticker conversion (`!sticker`) is stubbed — to fully implement, add the
  `wa-sticker-formatter` (or `sharp`) package and convert the replied-to
  image to webp before sending.
- No AI/LLM-based free-text replies yet (you opted to skip this) — to add
  later, call the Anthropic API inside the fallback branch in
  `src/handlers/messageHandler.js`.
- Group-specific commands (e.g. admin-only group moderation) are not
  built out — `isGroup` is already passed into every command handler if
  you want to add this.
