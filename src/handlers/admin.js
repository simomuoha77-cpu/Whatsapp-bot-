const express = require('express');
const { verifyCredentials, requirePlatformAuth } = require('../utils/platformAuth');
const { createBot, getAllBots, getBotById, deleteBot, renameBot } = require('../db/bots');
const {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  STEALTH_READ_MODES,
  STEALTH_READ_MODE_LABELS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
  setStealthReadMode,
} = require('../db/botFeatures');
const { getContactsForBot } = require('../db/contacts');
const { getScheduledStatusPostsForBot, createScheduledStatusPost, deactivateScheduledStatusPost } = require('../db/scheduledStatusPosts');
const { getRemindersForBot, createReminder, deactivateReminder } = require('../db/reminders');
const { startBotSocket, getBotState, deleteBotSession } = require('../utils/botManager');
const { refreshScheduler } = require('./scheduler');

function layout(title, body) {
  return `
    <html>
      <head>
        <title>${title} — Admin</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 760px; margin: 20px auto; padding: 0 16px; background: #0f0f0f; color: #eee; }
          a { color: #4da6ff; }
          input, button, select { font-size: 16px; padding: 8px; margin: 4px 0; width: 100%; box-sizing: border-box; background: #1c1c1c; color: #eee; border: 1px solid #333; border-radius: 6px; }
          button { background: #2563eb; color: white; cursor: pointer; border: none; }
          button.danger { background: #dc2626; }
          .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
          .row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #2a2a2a; gap: 8px; flex-wrap: wrap; }
          .row:last-child { border-bottom: none; }
          nav { margin-bottom: 20px; }
          nav a { margin-right: 14px; }
          .pill { padding: 2px 8px; border-radius: 12px; font-size: 13px; white-space: nowrap; }
          .on, .connected { background: #14532d; color: #4ade80; }
          .off, .disconnected { background: #450a0a; color: #f87171; }
          .pending { background: #422006; color: #facc15; }
          code { background: #1c1c1c; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `;
}

function nav() {
  return `<nav><a href="/admin">Clients</a><a href="/admin/logout">Logout</a></nav>`;
}

function statusPill(status) {
  const map = { connected: 'connected', disconnected: 'disconnected' };
  const cls = map[status] || 'pending';
  return `<span class="pill ${cls}">${status}</span>`;
}

function createAdminRoutes() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  router.get('/login', (req, res) => {
    if (req.session?.isPlatformAdmin) return res.redirect('/admin');
    const error = req.query.error ? '<p style="color:#f87171;">Invalid credentials.</p>' : '';
    res.send(layout('Login', `
      <h2>Platform Admin Login</h2>
      ${error}
      <form method="POST" action="/admin/login">
        <input name="username" placeholder="Username" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Log in</button>
      </form>
    `));
  });

  router.post('/login', async (req, res) => {
    const ok = await verifyCredentials(req.body.username, req.body.password);
    if (!ok) return res.redirect('/admin/login?error=1');
    req.session.isPlatformAdmin = true;
    req.session.platformUsername = req.body.username;
    res.redirect('/admin');
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  router.use(requirePlatformAuth);

  // --- Client list + create new ---
  router.get('/', async (req, res) => {
    const bots = await getAllBots();
    const rows = bots.map((b) => {
      const live = getBotState(b.id);
      const status = live?.status || b.status;
      return `
        <div class="row">
          <div>
            <strong>${b.client_name || '(unnamed client)'}</strong><br/>
            <small>${b.phone_number ? b.phone_number : 'not connected'} ${statusPill(status)}</small>
          </div>
          <a href="/admin/bot/${b.id}">Manage →</a>
        </div>
      `;
    }).join('');

    res.send(layout('Clients', `
      ${nav()}
      <h2>Your Clients</h2>
      <div class="card">
        <h3>Add a new client</h3>
        <form method="POST" action="/admin/bots">
          <input name="clientName" placeholder="Client name (e.g. Jane's Salon)" required />
          <button type="submit">Create Client Bot</button>
        </form>
      </div>
      <div class="card">${rows || '<p>No clients yet.</p>'}</div>
    `));
  });

  router.post('/bots', async (req, res) => {
    const bot = await createBot(req.body.clientName);
    await startBotSocket(bot.id, bot.slug, require('./botStartHook').onBotReady).catch(() => {});
    res.redirect(`/admin/bot/${bot.id}`);
  });

  // --- Manage a single client ---
  router.get('/bot/:id', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const bot = await getBotById(botId);
    if (!bot) return res.status(404).send(layout('Not found', '<h2>Client not found.</h2>'));

    const features = await getFeatures(botId);
    const live = getBotState(botId);
    const status = live?.status || bot.status;
    const contacts = await getContactsForBot(botId, 20);
    const posts = await getScheduledStatusPostsForBot(botId);
    const reminders = await getRemindersForBot(botId);

    const onboardingUrl = `${req.protocol}://${req.get('host')}/connect/${bot.slug}`;

    const featureRows = FEATURE_COLUMNS.map((col) => `
      <div class="row">
        <span>${FEATURE_LABELS[col]}</span>
        <form method="POST" action="/admin/bot/${botId}/toggle" style="width:auto;display:flex;gap:8px;align-items:center;">
          <input type="hidden" name="feature" value="${col}" />
          <span class="pill ${features[col] ? 'on' : 'off'}">${features[col] ? 'ON' : 'OFF'}</span>
          <button type="submit" style="width:auto;">Toggle</button>
        </form>
      </div>
    `).join('');

    const contactRows = contacts.map((c) => `
      <div class="row"><span>${c.display_name || c.phone_number}</span><small>${c.message_count} msgs</small></div>
    `).join('') || '<p>No contacts yet.</p>';

    const postRows = posts.map((p) => `
      <div class="row">
        <span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'ACTIVE' : 'OFF'}</span>
        <span>${p.cron_expression} — "${p.caption}"</span>
        ${p.is_active ? `<form method="POST" action="/admin/bot/${botId}/scheduled-posts/${p.id}/cancel" style="width:auto;"><button class="danger" style="width:auto;">Cancel</button></form>` : ''}
      </div>
    `).join('') || '<p>None scheduled.</p>';

    const reminderRows = reminders.map((r) => `
      <div class="row">
        <span>${r.cron_expression ? 'Daily ' + r.cron_expression : new Date(r.run_at).toLocaleString()} → ${r.target_jid} — "${r.message}"</span>
        <form method="POST" action="/admin/bot/${botId}/reminders/${r.id}/cancel" style="width:auto;"><button class="danger" style="width:auto;">Cancel</button></form>
      </div>
    `).join('') || '<p>None active.</p>';

    res.send(layout(bot.client_name || 'Client', `
      ${nav()}
      <h2>${bot.client_name || '(unnamed client)'}</h2>
      <p>${statusPill(status)} ${bot.phone_number ? `— ${bot.phone_number}` : ''}</p>

      <div class="card">
        <h3>Onboarding link</h3>
        <p>Send this link to your client so they can connect their own WhatsApp:</p>
        <code>${onboardingUrl}</code>
        <form method="POST" action="/admin/bot/${botId}/regenerate-link" style="margin-top:10px;">
          <button type="submit" style="width:auto;">Generate new link (invalidates old one)</button>
        </form>
      </div>

      <div class="card">
        <h3>Features for this client</h3>
        ${featureRows}
      </div>

      <div class="card">
        <h3>Stealth Read Mode</h3>
        <p>Controls whether incoming messages send a blue read receipt.</p>
        <form method="POST" action="/admin/bot/${botId}/stealth-mode">
          <select name="mode">
            ${STEALTH_READ_MODES.map((m) => `
              <option value="${m}" ${features.stealth_read_mode === m ? "selected" : ""}>
                ${STEALTH_READ_MODE_LABELS[m]}
              </option>
            `).join("")}
          </select>
          <button type="submit">Save</button>
        </form>
        <p><small>Current: <strong>${STEALTH_READ_MODE_LABELS[features.stealth_read_mode] || features.stealth_read_mode}</strong></small></p>
      </div>

      <div class="card">
        <h3>Auto-reply message</h3>
        <form method="POST" action="/admin/bot/${botId}/reply-message">
          <input name="message" value="${(features.auto_reply_message || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>Recent contacts</h3>
        ${contactRows}
      </div>

      <div class="card">
        <h3>Scheduled status posts</h3>
        ${postRows}
        <form method="POST" action="/admin/bot/${botId}/scheduled-posts">
          <input name="time" placeholder="HH:MM" required />
          <input name="caption" placeholder="Caption to post" required />
          <button type="submit">Schedule</button>
        </form>
      </div>

      <div class="card">
        <h3>Reminders</h3>
        ${reminderRows}
        <form method="POST" action="/admin/bot/${botId}/reminders">
          <input name="targetNumber" placeholder="Recipient number" required />
          <input name="time" placeholder="HH:MM (daily) or YYYY-MM-DDTHH:MM" required />
          <input name="message" placeholder="Reminder message" required />
          <button type="submit">Add Reminder</button>
        </form>
      </div>

      <div class="card">
        <h3>Danger zone</h3>
        <form method="POST" action="/admin/bot/${botId}/delete" onsubmit="return confirm('This permanently deletes the client and all their data. Continue?');">
          <button type="submit" class="danger">Delete this client</button>
        </form>
      </div>
    `));
  });

  router.post('/bot/:id/toggle', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const feature = req.body.feature;
    if (FEATURE_COLUMNS.includes(feature)) {
      const current = await getFeatures(botId);
      await setFeature(botId, feature, !current[feature]);
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/stealth-mode', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const mode = req.body.mode;
    if (STEALTH_READ_MODES.includes(mode)) {
      await setStealthReadMode(botId, mode);
      try {
        const live = getBotState(botId);
        if (live && live.sock && live.status === 'connected') {
          const receiptsValue = mode === 'normal' ? 'all' : 'none';
          await live.sock.updateReadReceiptsPrivacy(receiptsValue);
        }
      } catch (err) {}
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/reply-message', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    await setAutoReplyMessage(botId, req.body.message || '');
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/regenerate-link', async (req, res) => {
    // Regenerating means deleting the old session and creating a fresh slug,
    // so the client must reconnect — used if a link leaked or needs revoking.
    const botId = parseInt(req.params.id, 10);
    const bot = await getBotById(botId);
    await deleteBotSession(botId);
    const crypto = require('crypto');
    const { query } = require('../db/pool');
    const newSlug = crypto.randomBytes(6).toString('hex');
    await query('UPDATE bots SET slug = $1, status = $2 WHERE id = $3', [newSlug, 'pending', botId]);
    await startBotSocket(botId, newSlug, require('./botStartHook').onBotReady).catch(() => {});
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/scheduled-posts', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const match = /^(\d{1,2}):(\d{2})$/.exec(req.body.time || '');
    if (match) {
      const cronExpression = `${parseInt(match[2], 10)} ${parseInt(match[1], 10)} * * *`;
      await createScheduledStatusPost({ botId, cronExpression, caption: req.body.caption });
      await refreshScheduler();
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/scheduled-posts/:postId/cancel', async (req, res) => {
    await deactivateScheduledStatusPost(parseInt(req.params.postId, 10));
    await refreshScheduler();
    res.redirect(`/admin/bot/${req.params.id}`);
  });

  router.post('/bot/:id/reminders', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const digits = (req.body.targetNumber || '').replace(/[^0-9]/g, '');
    if (!digits) return res.redirect(`/admin/bot/${botId}`);
    const targetJid = `${digits}@s.whatsapp.net`;
    const dailyMatch = /^(\d{1,2}):(\d{2})$/.exec(req.body.time || '');

    if (dailyMatch) {
      const cronExpression = `${parseInt(dailyMatch[2], 10)} ${parseInt(dailyMatch[1], 10)} * * *`;
      await createReminder({ botId, targetJid, message: req.body.message, cronExpression });
    } else {
      const date = new Date(req.body.time);
      if (!isNaN(date.getTime())) {
        await createReminder({ botId, targetJid, message: req.body.message, runAt: date.toISOString() });
      }
    }
    await refreshScheduler();
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/reminders/:reminderId/cancel', async (req, res) => {
    await deactivateReminder(parseInt(req.params.reminderId, 10));
    await refreshScheduler();
    res.redirect(`/admin/bot/${req.params.id}`);
  });

  router.post('/bot/:id/delete', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const bot = await getBotById(botId);
    if (bot) await deleteBotSession(botId);
    await deleteBot(botId);
    res.redirect('/admin');
  });

  return router;
}

module.exports = { createAdminRoutes };
