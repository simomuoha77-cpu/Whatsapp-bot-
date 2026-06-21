const express = require('express');
const { verifyCredentials, requireDashboardAuth, getAdminUsername } = require('../utils/dashboardAuth');
const { query } = require('../db/pool');
const {
  FEATURE_COLUMNS,
  FEATURE_LABELS,
  getFeatures,
  setFeature,
  setAutoReplyMessage,
} = require('../db/userFeatures');
const {
  createScheduledStatusPost,
  getAllScheduledStatusPosts,
  deactivateScheduledStatusPost,
} = require('../db/scheduledStatusPosts');
const {
  createReminder,
  getRemindersForUser,
  deactivateReminder,
} = require('../db/reminders');

function layout(title, body) {
  return `
    <html>
      <head>
        <title>${title} — Bot Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 20px auto; padding: 0 16px; background: #0f0f0f; color: #eee; }
          a { color: #4da6ff; }
          input, button, select { font-size: 16px; padding: 8px; margin: 4px 0; width: 100%; box-sizing: border-box; background: #1c1c1c; color: #eee; border: 1px solid #333; border-radius: 6px; }
          button { background: #2563eb; color: white; cursor: pointer; border: none; }
          button.danger { background: #dc2626; }
          .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
          .row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #2a2a2a; }
          .row:last-child { border-bottom: none; }
          nav { margin-bottom: 20px; }
          nav a { margin-right: 14px; }
          .pill { padding: 2px 8px; border-radius: 12px; font-size: 13px; }
          .on { background: #14532d; color: #4ade80; }
          .off { background: #450a0a; color: #f87171; }
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>
  `;
}

function nav() {
  return `
    <nav>
      <a href="/dashboard">Users</a>
      <a href="/dashboard/scheduled-posts">Scheduled Posts</a>
      <a href="/dashboard/logout">Logout</a>
    </nav>
  `;
}

function createDashboardRoutes() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  // --- Login ---
  router.get('/login', (req, res) => {
    if (req.session && req.session.isDashboardAdmin) return res.redirect('/dashboard');
    const error = req.query.error ? '<p style="color:#f87171;">Invalid username or password.</p>' : '';
    res.send(layout('Login', `
      <h2>Bot Dashboard Login</h2>
      ${error}
      <form method="POST" action="/dashboard/login">
        <input name="username" placeholder="Username" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Log in</button>
      </form>
    `));
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const ok = await verifyCredentials(username, password);
    if (!ok) return res.redirect('/dashboard/login?error=1');
    req.session.isDashboardAdmin = true;
    req.session.dashboardUsername = username;
    res.redirect('/dashboard');
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/dashboard/login'));
  });

  // --- Everything below requires login ---
  router.use(requireDashboardAuth);

  // --- Users list + search ---
  router.get('/', async (req, res) => {
    const result = await query(
      `SELECT jid, phone_number, display_name, message_count, is_blocked FROM users WHERE jid NOT LIKE '%@g.us' ORDER BY last_seen_at DESC LIMIT 100`
    );
    const rows = result.rows
      .map(
        (u) => `
        <div class="row">
          <div>
            <strong>${u.display_name || u.phone_number}</strong><br/>
            <small>${u.phone_number}${u.is_blocked ? ' — 🚫 blocked' : ''}</small>
          </div>
          <a href="/dashboard/user/${encodeURIComponent(u.jid)}">Manage →</a>
        </div>
      `
      )
      .join('');

    res.send(layout('Users', `
      ${nav()}
      <h2>Users (most recent 100)</h2>
      <div class="card">
        <form method="GET" action="/dashboard/user-lookup">
          <input name="number" placeholder="Enter phone number to manage directly" required />
          <button type="submit">Go</button>
        </form>
      </div>
      <div class="card">${rows || '<p>No users yet.</p>'}</div>
    `));
  });

  router.get('/user-lookup', (req, res) => {
    const digits = (req.query.number || '').replace(/[^0-9]/g, '');
    if (!digits) return res.redirect('/dashboard');
    res.redirect(`/dashboard/user/${digits}@s.whatsapp.net`);
  });

  // --- Per-user feature management ---
  router.get('/user/:jid', async (req, res) => {
    const jid = req.params.jid;
    const features = await getFeatures(jid);
    const reminders = await getRemindersForUser(jid);

    const featureRows = FEATURE_COLUMNS.map(
      (col) => `
      <div class="row">
        <span>${FEATURE_LABELS[col]}</span>
        <form method="POST" action="/dashboard/user/${encodeURIComponent(jid)}/toggle" style="width:auto;display:flex;gap:8px;align-items:center;">
          <input type="hidden" name="feature" value="${col}" />
          <span class="pill ${features[col] ? 'on' : 'off'}">${features[col] ? 'ON' : 'OFF'}</span>
          <button type="submit" style="width:auto;">Toggle</button>
        </form>
      </div>
    `
    ).join('');

    const reminderRows = reminders
      .map(
        (r) => `
        <div class="row">
          <span>${r.cron_expression ? 'Daily ' + r.cron_expression : new Date(r.run_at).toLocaleString()} — "${r.message}"</span>
          <form method="POST" action="/dashboard/reminder/${r.id}/cancel" style="width:auto;">
            <button type="submit" class="danger" style="width:auto;">Cancel</button>
          </form>
        </div>
      `
      )
      .join('');

    res.send(layout('Manage User', `
      ${nav()}
      <h2>${jid}</h2>

      <div class="card">
        <h3>Features</h3>
        ${featureRows}
      </div>

      <div class="card">
        <h3>Auto-reply message</h3>
        <form method="POST" action="/dashboard/user/${encodeURIComponent(jid)}/reply-message">
          <input name="message" value="${(features.auto_reply_message || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>Reminders</h3>
        ${reminderRows || '<p>No active reminders for this user.</p>'}
        <form method="POST" action="/dashboard/user/${encodeURIComponent(jid)}/remind">
          <input name="time" placeholder="HH:MM (daily) or YYYY-MM-DDTHH:MM (one-time)" required />
          <input name="message" placeholder="Reminder message" required />
          <label style="display:flex;align-items:center;gap:8px;font-size:14px;width:auto;">
            <input type="checkbox" name="notifyAdmin" value="1" style="width:auto;" /> Notify me when sent
          </label>
          <button type="submit">Add Reminder</button>
        </form>
      </div>
    `));
  });

  router.post('/user/:jid/toggle', async (req, res) => {
    const jid = req.params.jid;
    const feature = req.body.feature;
    if (FEATURE_COLUMNS.includes(feature)) {
      const current = await getFeatures(jid);
      await setFeature(jid, feature, !current[feature]);
    }
    res.redirect(`/dashboard/user/${encodeURIComponent(jid)}`);
  });

  router.post('/user/:jid/reply-message', async (req, res) => {
    const jid = req.params.jid;
    await setAutoReplyMessage(jid, req.body.message || '');
    res.redirect(`/dashboard/user/${encodeURIComponent(jid)}`);
  });

  router.post('/user/:jid/remind', async (req, res) => {
    const jid = req.params.jid;
    const { time, message, notifyAdmin } = req.body;
    const dailyMatch = /^(\d{1,2}):(\d{2})$/.exec(time || '');

    if (dailyMatch) {
      const cronExpression = `${parseInt(dailyMatch[2], 10)} ${parseInt(dailyMatch[1], 10)} * * *`;
      await createReminder({
        createdBy: req.session.dashboardUsername,
        targetJid: jid,
        message,
        cronExpression,
        notifyAdmin: !!notifyAdmin,
      });
    } else {
      const date = new Date(time);
      if (!isNaN(date.getTime())) {
        await createReminder({
          createdBy: req.session.dashboardUsername,
          targetJid: jid,
          message,
          runAt: date.toISOString(),
          notifyAdmin: !!notifyAdmin,
        });
      }
    }
    res.redirect(`/dashboard/user/${encodeURIComponent(jid)}`);
  });

  router.post('/reminder/:id/cancel', async (req, res) => {
    await deactivateReminder(parseInt(req.params.id, 10));
    res.redirect(req.get('Referer') || '/dashboard');
  });

  // --- Scheduled status posts ---
  router.get('/scheduled-posts', async (req, res) => {
    const posts = await getAllScheduledStatusPosts();
    const rows = posts
      .map(
        (p) => `
        <div class="row">
          <span>
            <span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'ACTIVE' : 'INACTIVE'}</span>
            ${p.cron_expression} — "${p.caption || '(no caption)'}"
          </span>
          ${p.is_active ? `
            <form method="POST" action="/dashboard/scheduled-posts/${p.id}/cancel" style="width:auto;">
              <button type="submit" class="danger" style="width:auto;">Cancel</button>
            </form>` : ''}
        </div>
      `
      )
      .join('');

    res.send(layout('Scheduled Posts', `
      ${nav()}
      <h2>Scheduled Status Posts</h2>
      <div class="card">${rows || '<p>None scheduled yet.</p>'}</div>
      <div class="card">
        <h3>Schedule a new daily post</h3>
        <form method="POST" action="/dashboard/scheduled-posts">
          <input name="time" placeholder="HH:MM (e.g. 07:00)" required />
          <input name="caption" placeholder="Caption / text to post" required />
          <button type="submit">Schedule</button>
        </form>
        <p><small>Note: takes effect after the next restart/deploy.</small></p>
      </div>
    `));
  });

  router.post('/scheduled-posts', async (req, res) => {
    const { time, caption } = req.body;
    const match = /^(\d{1,2}):(\d{2})$/.exec(time || '');
    if (match) {
      const cronExpression = `${parseInt(match[2], 10)} ${parseInt(match[1], 10)} * * *`;
      await createScheduledStatusPost({
        createdBy: req.session.dashboardUsername,
        cronExpression,
        caption,
      });
    }
    res.redirect('/dashboard/scheduled-posts');
  });

  router.post('/scheduled-posts/:id/cancel', async (req, res) => {
    await deactivateScheduledStatusPost(parseInt(req.params.id, 10));
    res.redirect('/dashboard/scheduled-posts');
  });

  return router;
}

module.exports = { createDashboardRoutes };
