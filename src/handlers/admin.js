const express = require('express');
const logger = require('../utils/logger');
const { verifyCredentials, requirePlatformAuth } = require('../utils/platformAuth');
const { createBot, getAllBots, getBotById, deleteBot, renameBot } = require('../db/bots');
const {
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
} = require('../db/botFeatures');
const { getContactsForBot, manuallyAddContact } = require('../db/contacts');
const { getThreadForContact, deleteThread, getRecentChatsForBot } = require('../db/messages');
const { getViewOnceCapturesForBot } = require('../db/viewOnceCaptures');
const { getScheduledStatusPostsForBot, createScheduledStatusPost, deactivateScheduledStatusPost } = require('../db/scheduledStatusPosts');
const {
  getScheduledGroupPostsForBot,
  createScheduledGroupPost,
  deactivateScheduledGroupPost,
} = require('../db/scheduledGroupPosts');
const { getRemindersForBot, createReminder, deactivateReminder } = require('../db/reminders');
const { handleScheduledMediaUpload, mediaTypeForFile } = require('../utils/mediaUpload');
const { resolveSchedule } = require('../utils/scheduleTime');
const { getAllKeywordResponses, addKeywordResponse, deleteKeywordResponse } = require('../db/keywordResponses');
const { getRecentCapturesForBot } = require('../db/deletedCaptures');
const { getStatusSavesForBot } = require('../db/statusSaves');
const { recordOwnStatusPost, getRecentPostsWithViewers } = require('../db/ownStatusPosts');
const { getPricingSettings, updatePricingSettings } = require('../db/pricingSettings');
const { getSubscription, isSubscriptionActive, extendSubscriptionByYMD, setSubscriptionExpiry } = require('../db/subscriptions');
const { getPaymentsForBot } = require('../db/payments');
const { startBotSocket, getBotState, deleteBotSession, enqueueConnect, getKnownContactJids } = require('../utils/botManager');
const { refreshScheduler } = require('./scheduler');

const { annotateGroupPermissions, jidNumber } = require('../utils/groupPermissions');

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
      <body>${body}
        <script>
          document.querySelectorAll('.tz-input').forEach((el) => {
            try { el.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
          });
        </script>
      </body>
    </html>
  `;
}

function nav() {
  return `<nav><a href="/admin">Clients</a><a href="/admin/logout">Logout</a></nav>`;
}

// A separate layout from the generic admin one above — full-bleed, dark
// theme matching real WhatsApp Web's actual colors and proportions, used
// only for the chat list and chat thread pages so they genuinely look and
// feel like a linked WhatsApp Web session instead of a plain admin list.
function whatsappLayout(title, body) {
  return `
    <html>
      <head>
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; background: #111b21; color: #e9edef; height: 100vh; overflow: hidden; }
          .wa-header { background: #202c33; padding: 10px 16px; display: flex; align-items: center; gap: 12px; }
          .wa-header a { color: #aebac1; text-decoration: none; font-size: 20px; }
          .wa-header .title { font-size: 16px; font-weight: 500; }
          .wa-avatar { width: 40px; height: 40px; border-radius: 50%; background: #6a7175; display: flex; align-items: center; justify-content: center; font-weight: 600; color: #111b21; flex-shrink: 0; }
          .wa-list { overflow-y: auto; height: calc(100vh - 60px); }
          .wa-row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; text-decoration: none; color: inherit; border-bottom: 1px solid #202c33; }
          .wa-row:active, .wa-row:hover { background: #202c33; }
          .wa-row .meta { flex: 1; min-width: 0; }
          .wa-row .name { font-size: 16px; color: #e9edef; }
          .wa-row .preview { font-size: 14px; color: #8696a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
          .wa-row .time { font-size: 12px; color: #8696a0; flex-shrink: 0; }
          .wa-chat-bg { background: #0b141a; height: calc(100vh - 60px); overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 2px; }
          .wa-bubble-wrap { display: flex; }
          .wa-bubble-wrap.out { justify-content: flex-end; }
          .wa-bubble-wrap.in { justify-content: flex-start; }
          .wa-bubble { max-width: 75%; padding: 6px 9px 8px 9px; border-radius: 8px; font-size: 14.5px; line-height: 1.35; position: relative; }
          .wa-bubble.out { background: #005c4b; color: #e9edef; border-top-right-radius: 0; }
          .wa-bubble.in { background: #202c33; color: #e9edef; border-top-left-radius: 0; }
          .wa-bubble .time { display: block; text-align: right; font-size: 11px; color: #ffffff99; margin-top: 3px; }
          .wa-bubble.in .time { color: #8696a0; }
          .wa-empty { color: #8696a0; text-align: center; margin-top: 40px; font-size: 14px; }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `;
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
    const pricing = await getPricingSettings();
    const rows = await Promise.all(bots.map(async (b) => {
      const live = getBotState(b.id);
      const status = live?.status || b.status;
      const subActive = await isSubscriptionActive(b.id);
      return `
        <div class="row">
          <div>
            <strong>${b.client_name || '(unnamed client)'}</strong><br/>
            <small>${b.phone_number ? b.phone_number : 'not connected'} ${statusPill(status)} <span class="pill ${subActive ? 'on' : 'off'}">${subActive ? 'SUBSCRIBED' : 'EXPIRED'}</span></small>
          </div>
          <a href="/admin/bot/${b.id}">Manage →</a>
        </div>
      `;
    }));

    res.send(layout('Clients', `
      ${nav()}
      <h2>Your Clients</h2>
      <div class="card">
        <h3>Pricing</h3>
        <form method="POST" action="/admin/pricing">
          <label>Monthly price (KES)</label>
          <input name="monthlyPrice" type="number" value="${pricing.monthly_price}" required />
          <label>Yearly price (KES)</label>
          <input name="yearlyPrice" type="number" value="${pricing.yearly_price}" required />
          <label>Free trial length (days)</label>
          <input name="trialDays" type="number" value="${pricing.trial_days}" required />
          <button type="submit">Save Pricing</button>
        </form>
        <p><small>Changes apply to new registrations and renewals going forward — doesn't retroactively change anyone's current trial/subscription end date.</small></p>
      </div>
      <div class="card">
        <h3>Add a new client</h3>
        <form method="POST" action="/admin/bots">
          <input name="clientName" placeholder="Client name (e.g. Jane's Salon)" required />
          <button type="submit">Create Client Bot</button>
        </form>
        <p><small>Note: clients can also self-register with their own trial at <code>/client/register</code> — this admin-created path doesn't include a client login/payment account.</small></p>
      </div>
      <div class="card">${rows.join('') || '<p>No clients yet.</p>'}</div>
    `));
  });

  router.post('/pricing', async (req, res) => {
    await updatePricingSettings({
      monthlyPrice: parseFloat(req.body.monthlyPrice),
      yearlyPrice: parseFloat(req.body.yearlyPrice),
      trialDays: parseInt(req.body.trialDays, 10),
    });
    res.redirect('/admin');
  });

  router.post('/bots', async (req, res) => {
    const bot = await createBot(req.body.clientName);
    await enqueueConnect(() => startBotSocket(bot.id, bot.slug, require('./botStartHook').onBotReady)).catch((err) =>
      logger.error({ err, botId: bot.id }, 'Failed to start bot socket on admin bot creation')
    );
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
    const joinGroupMessage = req.query.joinGroupError
      ? `<div class="row" style="border:1px solid #5c2323;background:#3a1414;border-radius:8px;padding:10px;color:#fca5a5;">${req.query.joinGroupError}</div>`
      : req.query.joinGroupSuccess
      ? `<div class="row" style="border:1px solid #1a5c3a;background:#0d2f22;border-radius:8px;padding:10px;color:#4ade80;">${req.query.joinGroupSuccess}</div>`
      : '';

    const addMemberMessage = req.query.addMemberError
      ? `<div class="row" style="border:1px solid #5c2323;background:#3a1414;border-radius:8px;padding:10px;color:#fca5a5;">${req.query.addMemberError}</div>`
      : req.query.addMemberSuccess
      ? `<div class="row" style="border:1px solid #1a5c3a;background:#0d2f22;border-radius:8px;padding:10px;color:#4ade80;">${req.query.addMemberSuccess}</div>`
      : '';

    // Live-fetched, not stored — the bot's actual current group list from
    // WhatsApp itself, so the dropdown can never show a stale/left group.
    let botGroups = [];
    if (live && live.sock && live.status === 'connected') {
      try {
        const groupsObj = await live.sock.groupFetchAllParticipating();
        botGroups = annotateGroupPermissions(groupsObj, live.sock.user?.id);
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to fetch participating groups');
      }
    }
    const contacts = await getContactsForBot(botId, 200);
    const recentChats = await getRecentChatsForBot(botId, 50);
    const posts = await getScheduledStatusPostsForBot(botId);
    const groupPosts = await getScheduledGroupPostsForBot(botId);
    const reminders = await getRemindersForBot(botId);
    const viewOnceCaptures = await getViewOnceCapturesForBot(botId, 20);
    const subscription = await getSubscription(botId);
    const subActive = await isSubscriptionActive(botId);
    const payments = await getPaymentsForBot(botId, 10);
    const keywordResponses = await getAllKeywordResponses(botId);
    const deletedCaptures = await getRecentCapturesForBot(botId, 20);
    const statusSaves = await getStatusSavesForBot(botId, 20);
    const statusPosts = await getRecentPostsWithViewers(botId, 10);

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

    const nameByJid = {};
    for (const c of contacts) {
      nameByJid[c.jid] = c.display_name || c.phone_number;
    }

    const formatChatTime = (iso) => {
      const d = new Date(iso);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      if (isToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const daysAgo = Math.floor((now - d) / (1000 * 60 * 60 * 24));
      if (daysAgo < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
    };

    const previewText = (m) => {
      if (m.body) return m.body.length > 45 ? m.body.slice(0, 45) + '…' : m.body;
      const icons = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Document' };
      return icons[m.message_type] || '[message]';
    };

    const contactRows = recentChats.map((m) => {
      const name = nameByJid[m.jid] || m.jid.split('@')[0];
      const initial = (name[0] || '?').toUpperCase();
      const prefix = m.direction === 'outgoing' ? '<span style="opacity:0.7;">You: </span>' : '';
      return `
        <a href="/admin/bot/${botId}/chat/${encodeURIComponent(m.jid)}" style="text-decoration:none;color:inherit;">
          <div class="row" style="align-items:center;gap:12px;">
            <div style="width:44px;height:44px;border-radius:50%;background:#2a2a2a;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:600;">${initial}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;">${name}</div>
              <div style="opacity:0.7;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${prefix}${previewText(m)}</div>
            </div>
            <small style="flex-shrink:0;opacity:0.6;">${formatChatTime(m.created_at)}</small>
          </div>
        </a>
      `;
    }).join('') || '<p>No chats yet.</p>';

    const addContactForm = `
      <form method="POST" action="/admin/bot/${botId}/contacts/add" style="display:flex;gap:8px;margin-bottom:12px;">
        <input name="phone" placeholder="Phone number, e.g. 254712345678" required style="flex:2;" />
        <input name="name" placeholder="Name (optional)" style="flex:1;" />
        <button type="submit" style="width:auto;">Add</button>
      </form>
      <p><small>Creates a CRM entry only — the bot can then message this number, and any future messages either way show up in the chat viewer. It does NOT give access to any existing chats on that number.</small></p>
    `;

    const viewOnceRows = viewOnceCaptures.map((v) => `
      <div class="row">
        <span>
          ${v.media_type === 'video' ? '🎥' : '📷'}
          <strong>${v.sender_name || 'Unknown'}</strong> (${v.sender_number || '?'})
          ${v.is_group ? ` in group "${v.group_name || v.chat_jid}"` : ''}
        </span>
        <small>${new Date(v.captured_at).toLocaleString()}</small>
      </div>
    `).join('') || '<p>No view-once media captured yet.</p>';

    const keywordRows = keywordResponses.map((k) => `
      <div class="row">
        <span><strong>"${k.keyword}"</strong> → ${k.response.slice(0, 60)}${k.response.length > 60 ? '...' : ''}</span>
        <form method="POST" action="/admin/bot/${botId}/keywords/${k.id}/delete" style="width:auto;">
          <button type="submit" class="danger" style="width:auto;">Delete</button>
        </form>
      </div>
    `).join('') || '<p>No keyword responses set up yet.</p>';

    const deletedCaptureRows = deletedCaptures.map((d) => `
      <div class="row">
        <span>
          ${d.message_type === 'text' ? '💬' : '📎'}
          <strong>${d.sender_name || 'Unknown'}</strong> (${d.sender_number || '?'})
          ${d.is_group ? ` in group "${d.group_name || d.chat_jid}"` : ''}
          ${d.body ? `— "${d.body.slice(0, 50)}"` : ''}
        </span>
        <small>${new Date(d.deleted_at).toLocaleString()}</small>
      </div>
    `).join('') || '<p>No deleted messages recovered yet.</p>';

    const statusSaveRows = statusSaves.map((s) => `
      <div class="row">
        <span>${s.media_type === 'video' ? '🎥' : '📷'} ${s.contact_name || s.contact_jid}</span>
        <small>${new Date(s.saved_at).toLocaleString()}</small>
      </div>
    `).join('') || '<p>No status media saved yet.</p>';

    const postRows = posts.map((p) => `
      <div class="row">
        <span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'ACTIVE' : 'OFF'}</span>
        <span>${p.cron_expression}${p.media_path ? ` ${p.media_type === 'video' ? '🎥' : '📷'}` : ''} — "${p.caption || ''}"</span>
        ${p.is_active ? `<form method="POST" action="/admin/bot/${botId}/scheduled-posts/${p.id}/cancel" style="width:auto;"><button class="danger" style="width:auto;">Cancel</button></form>` : ''}
      </div>
    `).join('') || '<p>None scheduled.</p>';

    const groupPostRows = groupPosts.map((p) => `
      <div class="row">
        <span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'ACTIVE' : 'OFF'}</span>
        <span>${p.cron_expression ? 'Daily ' + p.cron_expression : new Date(p.run_at).toLocaleString()}${p.media_path ? ` ${p.media_type === 'video' ? '🎥' : '📷'}` : ''} → ${p.group_name || p.group_jid} — "${p.caption || ''}"</span>
        ${p.is_active ? `<form method="POST" action="/admin/bot/${botId}/group-posts/${p.id}/cancel" style="width:auto;"><button class="danger" style="width:auto;">Cancel</button></form>` : ''}
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
        <h3>💳 Subscription</h3>
        <p><span class="pill ${subActive ? 'on' : 'off'}">${subActive ? 'ACTIVE' : 'EXPIRED'}</span></p>
        ${subscription ? `
          <p><small>Trial ends: ${new Date(subscription.trial_ends_at).toLocaleString()}</small></p>
          ${subscription.paid_until ? `<p><small>Paid until: <strong>${new Date(subscription.paid_until).toLocaleString()}</strong> (${subscription.plan})</small></p>` : '<p><small>No payments yet.</small></p>'}
        ` : '<p><small>No subscription record (admin-created bot, not self-registered).</small></p>'}
        <p><small>Recent payments:</small></p>
        ${payments.map((p) => `<div class="row"><span>${p.plan} — KES ${p.amount}</span><span class="pill ${p.status === 'success' ? 'on' : 'off'}">${p.status}</span></div>`).join('') || '<p>None</p>'}

        <div style="margin-top:16px;padding-top:16px;border-top:1px solid #333;">
          <p><strong>Extend access</strong></p>
          <p><small>Adds this much time on top of whatever's already remaining — never resets or shortens the current expiry.</small></p>
          <form method="POST" action="/admin/bot/${botId}/extend-days" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;">
            <label style="flex:1;min-width:70px;"><small>Years</small><input type="number" name="years" min="0" value="0" /></label>
            <label style="flex:1;min-width:70px;"><small>Months</small><input type="number" name="months" min="0" value="0" /></label>
            <label style="flex:1;min-width:70px;"><small>Days</small><input type="number" name="days" min="0" value="0" /></label>
            <button type="submit" style="width:auto;">Extend</button>
          </form>
        </div>

        <div style="margin-top:16px;padding-top:16px;border-top:1px solid #333;">
          <p><strong>Or set an exact expiry date</strong></p>
          <p><small>Sets "paid until" directly to this date, instead of extending — use this to correct a mistake or set a precise date.</small></p>
          <form method="POST" action="/admin/bot/${botId}/set-expiry" style="display:flex;gap:8px;">
            <input type="date" name="expiry" required style="flex:1;" />
            <button type="submit" style="width:auto;">Set</button>
          </form>
        </div>
      </div>

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
        <p>Controls whether incoming messages get marked as "read" (blue ticks) on the sender's side.</p>
        <form method="POST" action="/admin/bot/${botId}/stealth-mode">
          <select name="mode">
            ${STEALTH_READ_MODES.map((m) => `
              <option value="${m}" ${features.stealth_read_mode === m ? 'selected' : ''}>
                ${STEALTH_READ_MODE_LABELS[m]}
              </option>
            `).join('')}
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
        <h3>Welcome message</h3>
        <p><small>Sent once, the first time a contact messages this bot.</small></p>
        <form method="POST" action="/admin/bot/${botId}/welcome-message">
          <input name="message" value="${(features.welcome_message_text || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>Away message</h3>
        <form method="POST" action="/admin/bot/${botId}/away-message">
          <input name="message" value="${(features.away_message_text || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>🤖 AI Chat Assistant</h3>
        <p><small>Set provider and personality. Needs GROQ_API_KEY or GEMINI_API_KEY configured on the server.</small></p>
        <form method="POST" action="/admin/bot/${botId}/ai-provider">
          <select name="provider">
            ${AI_PROVIDERS.map((p) => `<option value="${p}" ${features.ai_provider === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <button type="submit">Save Provider</button>
        </form>
        <form method="POST" action="/admin/bot/${botId}/ai-prompt" style="margin-top:10px;">
          <input name="prompt" value="${(features.ai_system_prompt || '').replace(/"/g, '&quot;')}" placeholder="System prompt / personality" />
          <button type="submit">Save Prompt</button>
        </form>
      </div>

      <div class="card">
        <h3>Keyword Responses</h3>
        ${keywordRows}
        <form method="POST" action="/admin/bot/${botId}/keywords">
          <input name="keyword" placeholder="Keyword (e.g. 'price')" required />
          <input name="response" placeholder="Response to send" required />
          <button type="submit">Add Keyword Response</button>
        </form>
      </div>

      <div class="card">
        <h3>Chats</h3>
        <p><a href="/admin/bot/${botId}/whatsapp" style="display:inline-block;background:#00a884;color:white;text-decoration:none;padding:8px 14px;border-radius:6px;margin-bottom:12px;">💬 Open full WhatsApp-style view</a></p>
        ${addContactForm}
        ${contactRows}
      </div>

      <div class="card">
        <h3>➕ Join Group</h3>
        <p><small>Paste a WhatsApp group invite link (chat.whatsapp.com/...) and this bot's number will join it. Bot must be connected.</small></p>
        ${joinGroupMessage}
        <form method="POST" action="/admin/bot/${botId}/join-group">
          <input name="link" placeholder="https://chat.whatsapp.com/XXXXXXXX" required />
          <button type="submit">Join</button>
        </form>
      </div>

      <div class="card">
        <h3>👤 Add Member to Group</h3>
        <p><small>Adds someone (e.g. re-adding a removed member) to a group this bot is admin of. The bot must be a group admin, and if WhatsApp's privacy rules don't allow a direct add, that person gets sent an invite link automatically instead — this is normal WhatsApp behavior, not something this bypasses.</small></p>
        ${addMemberMessage}
        ${botGroups.length > 0 ? `
          <form method="POST" action="/admin/bot/${botId}/add-to-group">
            <select name="groupId" required>
              ${botGroups.map((g) => `<option value="${g.id}">${g.subject}</option>`).join('')}
            </select>
            <input name="phone" placeholder="Phone number, e.g. 254712345678" required />
            <button type="submit">Add</button>
          </form>
        ` : '<p>Bot must be connected and in at least one group.</p>'}
      </div>

      <div class="card">
        <h3>👁️ View-Once Captures</h3>
        <p><small>Captured media is also forwarded to this bot's own "Message Yourself" chat.</small></p>
        ${viewOnceRows}
      </div>

      <div class="card">
        <h3>🗑️ Deleted Message Recovery</h3>
        <p><small>Recovered content is also forwarded to this bot's own "Message Yourself" chat.</small></p>
        ${deletedCaptureRows}
      </div>

      <div class="card">
        <h3>📸 Saved Status Media</h3>
        ${statusSaveRows}
      </div>

      <div class="card">
        <h3>👀 Status Views</h3>
        <p><small>Post a status now, or check viewers on scheduled posts — either way, viewers show up here once they open it.</small></p>
        <form method="POST" action="/admin/bot/${botId}/post-status">
          <input name="caption" placeholder="What's on your mind?" required />
          <button type="submit">Post to Status Now</button>
        </form>
        ${statusPosts.length ? statusPosts.map((p) => `
          <div class="row" style="flex-direction:column;align-items:flex-start;gap:6px;">
            <div style="display:flex;justify-content:space-between;width:100%;">
              <span>${p.source === 'scheduled' ? '⏰' : '✍️'} "${(p.caption || '').slice(0, 60)}${(p.caption || '').length > 60 ? '...' : ''}"</span>
              <span class="pill on">${p.viewCount} view${p.viewCount === 1 ? '' : 's'}</span>
            </div>
            <small>${new Date(p.posted_at).toLocaleString()}</small>
            ${p.viewers.length ? `
              <div style="width:100%;padding-left:8px;">
                ${p.viewers.map((v) => `<div><small>${v.viewer_name || v.viewer_jid.split('@')[0]} — ${new Date(v.viewed_at).toLocaleString()}</small></div>`).join('')}
              </div>
            ` : ''}
          </div>
        `).join('') : '<p>No status posts tracked yet.</p>'}
      </div>

      <div class="card">
        <h3>Scheduled status posts</h3>
        <p><small>Pick a time. Leave date blank to repeat daily, or set a date to post once. Attach an image/video, add a caption, or both.</small></p>
        ${req.query.postError ? `<p style="color:#f87171;">${req.query.postError}</p>` : ''}
        ${postRows}
        <form method="POST" action="/admin/bot/${botId}/scheduled-posts" enctype="multipart/form-data">
          <label><small>Time</small><input type="time" name="time" required /></label>
          <label><small>Date (optional — leave blank to repeat every day)</small><input type="date" name="date" /></label>
          <input type="hidden" name="timezone" class="tz-input" />
          <label><small>Caption</small><input name="caption" placeholder="Optional if attaching media" /></label>
          <label><small>Media (optional)</small><input type="file" name="media" accept="image/jpeg,image/png,image/webp,video/mp4" /></label>
          <button type="submit">Schedule</button>
        </form>
      </div>

      <div class="card">
        <h3>Group auto-posts</h3>
        <p><small>Post to a group the bot is in. Leave date blank to repeat daily, or set a date to post once. Attach an image/video, add a caption, or both.</small></p>
        ${req.query.groupPostError ? `<p style="color:#f87171;">${req.query.groupPostError}</p>` : ''}
        ${groupPostRows}
        ${botGroups.length > 0 ? `
          <form method="POST" action="/admin/bot/${botId}/group-posts" enctype="multipart/form-data">
            <label><small>Group(s) — tap to select, tap again to add more. 🔒 = admins-only group; the bot must be a group admin there to post.</small>
              <select name="groupId" multiple required size="${Math.min(botGroups.length, 6)}">
                ${botGroups.map((g) => `<option value="${g.id}" ${g.canPost ? '' : 'disabled'}>${g.subject}${g.announce ? (g.isBotAdmin ? ' 🔒✅' : ' 🔒 (bot not admin — can\'t post)') : ''}</option>`).join('')}
              </select>
            </label>
            <label><small>Time</small><input type="time" name="time" required /></label>
            <label><small>Date (optional — leave blank to repeat every day)</small><input type="date" name="date" /></label>
          <input type="hidden" name="timezone" class="tz-input" />
            <label><small>Caption</small><input name="caption" placeholder="Optional if attaching media" /></label>
            <label><small>Media (optional)</small><input type="file" name="media" accept="image/jpeg,image/png,image/webp,video/mp4" /></label>
            <button type="submit">Schedule</button>
          </form>
        ` : '<p>Bot must be connected and in at least one group.</p>'}
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

  // Full WhatsApp-Web-styled chat list for this bot — separate from the
  // dense admin dashboard page, so it actually looks like a linked
  // WhatsApp Web session instead of a plain list inside the admin shell.
  router.get('/bot/:id/whatsapp', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const bot = await getBotById(botId);
    if (!bot) return res.status(404).send(layout('Not found', '<h2>Client not found.</h2>'));

    const contacts = await getContactsForBot(botId, 200);
    const recentChats = await getRecentChatsForBot(botId, 100);
    const nameByJid = {};
    for (const c of contacts) nameByJid[c.jid] = c.display_name || c.phone_number;

    const formatChatTime = (iso) => {
      const d = new Date(iso);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const daysAgo = Math.floor((now - d) / (1000 * 60 * 60 * 24));
      if (daysAgo < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
    };
    const previewText = (m) => {
      if (m.body) return m.body.length > 45 ? m.body.slice(0, 45) + '…' : m.body;
      const icons = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Document' };
      return icons[m.message_type] || '[message]';
    };

    const rows = recentChats.map((m) => {
      const name = nameByJid[m.jid] || m.jid.split('@')[0];
      const initial = (name[0] || '?').toUpperCase();
      const prefix = m.direction === 'outgoing' ? 'You: ' : '';
      return `
        <a class="wa-row" href="/admin/bot/${botId}/chat/${encodeURIComponent(m.jid)}">
          <div class="wa-avatar">${initial}</div>
          <div class="meta">
            <div class="name">${name}</div>
            <div class="preview">${prefix}${previewText(m).replace(/</g, '&lt;')}</div>
          </div>
          <div class="time">${formatChatTime(m.created_at)}</div>
        </a>
      `;
    }).join('') || '<p class="wa-empty">No chats yet.</p>';

    res.send(whatsappLayout(bot.slug, `
      <div class="wa-header">
        <a href="/admin/bot/${botId}" title="Back to admin">&larr;</a>
        <div class="wa-avatar">${(bot.slug[0] || '?').toUpperCase()}</div>
        <div class="title">${bot.slug}</div>
      </div>
      <div class="wa-list">${rows}</div>
    `));
  });

  // Admin-only chat viewer — lets the platform admin see a contact's full
  // message thread with a given bot, for support/moderation. Intentionally
  // NOT exposed on the client dashboard (client.js) — a bot owner already
  // sees their own chats in their own WhatsApp; this is only for the
  // platform admin to look in when helping a client.
  router.get('/bot/:id/chat/:jid', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const jid = req.params.jid;
    const bot = await getBotById(botId);
    if (!bot) return res.status(404).send(layout('Not found', '<h2>Client not found.</h2>'));

    const thread = await getThreadForContact(botId, jid, 200);
    const contact = (await getContactsForBot(botId, 200)).find((c) => c.jid === jid);
    const name = contact?.display_name || contact?.phone_number || jid.split('@')[0];
    const initial = (name[0] || '?').toUpperCase();

    const bubbleTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const bubbleContent = (m) => {
      if (m.body) return String(m.body).replace(/</g, '&lt;');
      const icons = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Document' };
      return icons[m.message_type] || `[${m.message_type}]`;
    };

    const messageRows = thread.map((m) => `
      <div class="wa-bubble-wrap ${m.direction === 'outgoing' ? 'out' : 'in'}">
        <div class="wa-bubble ${m.direction === 'outgoing' ? 'out' : 'in'}">
          <div>${bubbleContent(m)}</div>
          <span class="time">${bubbleTime(m.created_at)}</span>
        </div>
      </div>
    `).join('') || '<p class="wa-empty">No messages in this thread yet.</p>';

    res.send(whatsappLayout(`Chat — ${name}`, `
      <div class="wa-header">
        <a href="/admin/bot/${botId}/whatsapp" title="Back to chats">&larr;</a>
        <div class="wa-avatar">${initial}</div>
        <div class="title">${name}</div>
        <div style="flex:1;"></div>
        <form method="POST" action="/admin/bot/${botId}/chat/${encodeURIComponent(jid)}/disappearing" style="margin:0;display:flex;align-items:center;gap:4px;">
          <select name="duration" title="Disappearing messages (applies to future messages only)" style="width:auto;background:#2a3942;color:#e9edef;border:none;border-radius:4px;padding:4px;font-size:12px;">
            <option value="0">⏱️ Off</option>
            <option value="86400">⏱️ 24h</option>
            <option value="604800">⏱️ 7d</option>
            <option value="7776000">⏱️ 90d</option>
          </select>
          <button type="submit" title="Apply" style="background:none;border:none;color:#aebac1;font-size:14px;cursor:pointer;width:auto;padding:4px;">✓</button>
        </form>
        <form method="POST" action="/admin/bot/${botId}/chat/${encodeURIComponent(jid)}/delete"
              onsubmit="return confirm('Delete this whole conversation? This wipes it from the admin view and attempts to delete-for-everyone the bot\\'s own sent messages on WhatsApp. The other person\\'s own messages can only be removed here, not from their phone.');"
              style="margin:0;">
          <button type="submit" title="Delete conversation" style="background:none;border:none;color:#aebac1;font-size:18px;cursor:pointer;width:auto;padding:4px;">🗑️</button>
        </form>
      </div>
      <div class="wa-chat-bg">${messageRows}</div>
    `));
  });

  router.post('/bot/:id/chat/:jid/disappearing', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const jid = req.params.jid;
    const duration = parseInt(req.body.duration, 10) || 0;

    try {
      const live = getBotState(botId);
      if (live && live.sock && live.status === 'connected') {
        await live.sock.sendMessage(jid, {
          disappearingMessagesInChat: duration > 0 ? duration : false,
        });
        logger.info({ botId, jid, duration }, 'Set disappearing messages for chat');
      } else {
        logger.warn({ botId, jid }, 'Cannot set disappearing messages — bot not connected');
      }
    } catch (err) {
      logger.warn({ err, botId, jid }, 'Failed to set disappearing messages');
    }

    res.redirect(`/admin/bot/${botId}/chat/${encodeURIComponent(jid)}`);
  });

  router.post('/bot/:id/chat/:jid/delete', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const jid = req.params.jid;

    // Best-effort real WhatsApp "delete for everyone" — only possible for
    // messages this bot itself sent (fromMe), and only within whatever
    // window WhatsApp still allows for that account. Failures here are
    // expected for old messages and are non-fatal; the local wipe below
    // always succeeds regardless.
    try {
      const live = getBotState(botId);
      if (live && live.sock && live.status === 'connected') {
        const thread = await getThreadForContact(botId, jid, 200);
        for (const m of thread) {
          if (m.direction === 'outgoing' && m.message_id) {
            try {
              await live.sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: true, id: m.message_id },
              });
            } catch (err) {
              // Expected for messages outside WhatsApp's delete window —
              // keep going, don't let one failure stop the rest.
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err, botId, jid }, 'Failed attempting delete-for-everyone during conversation delete');
    }

    await deleteThread(botId, jid);
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/add-to-group', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const groupId = req.body.groupId;
    const digits = (req.body.phone || '').replace(/[^0-9]/g, '');

    const live = getBotState(botId);
    if (!live || !live.sock || live.status !== 'connected') {
      return res.redirect(`/admin/bot/${botId}?addMemberError=` + encodeURIComponent('Bot is not connected right now.'));
    }
    if (!digits || !groupId) {
      return res.redirect(`/admin/bot/${botId}?addMemberError=` + encodeURIComponent('Group and phone number are required.'));
    }

    const targetJid = `${digits}@s.whatsapp.net`;
    try {
      const result = await live.sock.groupParticipantsUpdate(groupId, [targetJid], 'add');
      const entry = result?.[0];
      // WhatsApp's own status codes for this action: 200 = added directly,
      // 403 = their privacy settings blocked a direct add (WhatsApp itself
      // then auto-sends them an invite link instead — normal behavior),
      // 408 = request timed out, 404 = not a WhatsApp number.
      if (entry?.status === '200') {
        res.redirect(`/admin/bot/${botId}?addMemberSuccess=` + encodeURIComponent(`Added ${digits} to the group.`));
      } else if (entry?.status === '403') {
        res.redirect(`/admin/bot/${botId}?addMemberSuccess=` + encodeURIComponent(`${digits} couldn't be added directly (their privacy settings) — WhatsApp sent them an invite link instead.`));
      } else if (entry?.status === '404') {
        res.redirect(`/admin/bot/${botId}?addMemberError=` + encodeURIComponent(`${digits} is not a valid WhatsApp number.`));
      } else {
        res.redirect(`/admin/bot/${botId}?addMemberError=` + encodeURIComponent(`Could not add ${digits} (status ${entry?.status || 'unknown'}). The bot may not be a group admin.`));
      }
    } catch (err) {
      logger.warn({ err, botId, groupId, targetJid }, 'Failed to add member to group');
      res.redirect(`/admin/bot/${botId}?addMemberError=` + encodeURIComponent('Failed to add member. The bot may not be a group admin.'));
    }
  });

  router.post('/bot/:id/join-group', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const link = (req.body.link || '').trim();

    const live = getBotState(botId);
    if (!live || !live.sock || live.status !== 'connected') {
      return res.redirect(`/admin/bot/${botId}?joinGroupError=` + encodeURIComponent('Bot is not connected right now.'));
    }

    // Accepts either the full link or just the bare invite code.
    const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
    const inviteCode = match ? match[1] : link.replace(/[^A-Za-z0-9]/g, '');
    if (!inviteCode) {
      return res.redirect(`/admin/bot/${botId}?joinGroupError=` + encodeURIComponent('That doesn\'t look like a valid group invite link.'));
    }

    try {
      const groupId = await live.sock.groupAcceptInvite(inviteCode);
      const metadata = await live.sock.groupMetadata(groupId).catch(() => null);
      const groupName = metadata?.subject || groupId;
      logger.info({ botId, groupId, groupName }, 'Bot joined group via invite link');
      res.redirect(`/admin/bot/${botId}?joinGroupSuccess=` + encodeURIComponent(`Joined "${groupName}" successfully.`));
    } catch (err) {
      logger.warn({ err, botId, link }, 'Failed to join group via invite link');
      const message = err?.message?.includes('not-authorized') || err?.data === 401
        ? 'This invite link is invalid, expired, or the bot was removed from this group before.'
        : 'Failed to join the group. Check the link and try again.';
      res.redirect(`/admin/bot/${botId}?joinGroupError=` + encodeURIComponent(message));
    }
  });

  router.post('/bot/:id/contacts/add', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const phone = (req.body.phone || '').trim();
    const name = (req.body.name || '').trim();
    if (phone) {
      await manuallyAddContact(botId, phone, name || null);
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/extend-days', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const years = parseInt(req.body.years, 10) || 0;
    const months = parseInt(req.body.months, 10) || 0;
    const days = parseInt(req.body.days, 10) || 0;
    if (years > 0 || months > 0 || days > 0) {
      await extendSubscriptionByYMD(botId, { years, months, days });
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/set-expiry', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const expiry = req.body.expiry;
    if (expiry) {
      await setSubscriptionExpiry(botId, expiry);
    }
    res.redirect(`/admin/bot/${botId}`);
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
      // Apply the new resting state immediately rather than waiting for the
      // next reconnect. 'normal' rests at 'all' (receipts + status views
      // both on). 'stealth'/'no_mark' rest at 'none' (blue tick guaranteed
      // off) — status views still work via the brief per-action toggle in
      // statusHandler.js.
      try {
        const live = getBotState(botId);
        if (live && live.sock && live.status === 'connected') {
          await live.sock.updateReadReceiptsPrivacy(mode === 'normal' ? 'all' : 'none');
        }
      } catch (err) {
        // Non-fatal — will still apply on next reconnect via botManager.js
      }
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/reply-message', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    await setAutoReplyMessage(botId, req.body.message || '');
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/welcome-message', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    await setWelcomeMessage(botId, req.body.message || '');
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/away-message', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    await setAwayMessage(botId, req.body.message || '');
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/ai-provider', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    if (AI_PROVIDERS.includes(req.body.provider)) {
      await setAiProvider(botId, req.body.provider);
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/ai-prompt', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    await setAiSystemPrompt(botId, req.body.prompt || '');
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/keywords', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const { keyword, response } = req.body;
    if (keyword && response) {
      await addKeywordResponse(botId, keyword, response);
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/keywords/:keywordId/delete', async (req, res) => {
    await deleteKeywordResponse(parseInt(req.params.keywordId, 10));
    res.redirect(`/admin/bot/${req.params.id}`);
  });

  router.post('/bot/:id/regenerate-link', async (req, res) => {
    // Regenerating means deleting the old session and creating a fresh slug,
    // so the client must reconnect — used if a link leaked or needs revoking.
    const botId = parseInt(req.params.id, 10);
    const bot = await getBotById(botId);
    await deleteBotSession(botId);
    const crypto = require('crypto');
    const { getDb } = require('../db/mongo');
    const newSlug = crypto.randomBytes(6).toString('hex');
    const db = await getDb();
    await db.collection('bots').updateOne({ id: Number(botId) }, { $set: { slug: newSlug, status: 'pending' } });
    await startBotSocket(botId, newSlug, require('./botStartHook').onBotReady).catch(() => {});
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/post-status', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    const caption = (req.body.caption || '').trim();
    if (!caption) return res.redirect(`/admin/bot/${botId}`);

    const live = getBotState(botId);
    if (!live || !live.sock || live.status !== 'connected') {
      return res.send(layout('Not connected', `<p>This client's bot isn't connected right now, so it can't post a status.</p><a href="/admin/bot/${botId}">Back</a>`));
    }

    try {
      // See scheduler.js for why an empty statusJidList is worse than omitting it.
      const knownContacts = getKnownContactJids(botId);
      const sendOpts = knownContacts.length > 0 ? { statusJidList: knownContacts } : undefined;
      const sent = await live.sock.sendMessage('status@broadcast', { text: caption }, sendOpts);
      if (sent?.key?.id) {
        await recordOwnStatusPost(botId, sent.key.id, { source: 'manual', caption });
      }
    } catch (err) {
      logger.error({ err, botId }, 'Failed to post manual status from admin panel');
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/scheduled-posts', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    try {
      await handleScheduledMediaUpload(req, res);
    } catch (err) {
      logger.warn({ err, botId }, 'Scheduled status post media upload rejected');
      return res.redirect(`/admin/bot/${botId}?postError=${encodeURIComponent(err.message || 'Media upload failed.')}`);
    }

    try {
      const caption = (req.body.caption || '').trim();
      if (!caption && !req.file) {
        return res.redirect(`/admin/bot/${botId}?postError=${encodeURIComponent('Add a caption or attach media.')}`);
      }
      const { cronExpression, runAt, timezone, error } = resolveSchedule(req.body.time, req.body.date, req.body.timezone);
      if (error) {
        return res.redirect(`/admin/bot/${botId}?postError=${encodeURIComponent(error)}`);
      }
      await createScheduledStatusPost({
        botId,
        cronExpression,
        runAt,
        timezone,
        caption: caption || null,
        mediaPath: req.file ? req.file.path : null,
        mediaType: mediaTypeForFile(req.file),
      });
      await refreshScheduler();
    } catch (err) {
      logger.error({ err, botId }, 'Failed to create scheduled status post');
      return res.redirect(`/admin/bot/${botId}?postError=${encodeURIComponent('Something went wrong saving that — check server logs.')}`);
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/scheduled-posts/:postId/cancel', async (req, res) => {
    await deactivateScheduledStatusPost(parseInt(req.params.postId, 10));
    await refreshScheduler();
    res.redirect(`/admin/bot/${req.params.id}`);
  });

  router.post('/bot/:id/group-posts', async (req, res) => {
    const botId = parseInt(req.params.id, 10);
    try {
      await handleScheduledMediaUpload(req, res);
    } catch (err) {
      logger.warn({ err, botId }, 'Group post media upload rejected');
      return res.redirect(`/admin/bot/${botId}?groupPostError=${encodeURIComponent(err.message || 'Media upload failed.')}`);
    }

    try {
      const groupJids = [].concat(req.body.groupId || []).map((g) => g.trim()).filter(Boolean);
      const caption = (req.body.caption || '').trim();
      if (groupJids.length === 0) {
        return res.redirect(`/admin/bot/${botId}?groupPostError=${encodeURIComponent('Pick at least one group.')}`);
      }
      if (!caption && !req.file) {
        return res.redirect(`/admin/bot/${botId}?groupPostError=${encodeURIComponent('Add a caption or attach media.')}`);
      }
      const { cronExpression, runAt, timezone, error } = resolveSchedule(req.body.time, req.body.date, req.body.timezone);
      if (error) {
        return res.redirect(`/admin/bot/${botId}?groupPostError=${encodeURIComponent(error)}`);
      }

      const live = getBotState(botId);
      // One post per selected group — same time/caption/media, but each is
      // independently cancelable afterward. Re-check admin status fresh
      // here too (not just trusting the disabled dropdown option) since
      // group admin status can change between page load and submit.
      const skipped = [];
      let created = 0;
      for (const groupJid of groupJids) {
        let groupName = null;
        let canPost = true;
        if (live && live.sock && live.status === 'connected') {
          const metadata = await live.sock.groupMetadata(groupJid).catch(() => null);
          groupName = metadata?.subject || groupJid;
          if (metadata?.announce) {
            const botNumber = jidNumber(live.sock.user?.id);
            const isBotAdmin = (metadata.participants || []).some(
              (p) => jidNumber(p.id) === botNumber && (p.admin === 'admin' || p.admin === 'superadmin')
            );
            canPost = isBotAdmin;
          }
        }
        if (!canPost) {
          skipped.push(groupName);
          continue;
        }
        await createScheduledGroupPost({
          botId,
          groupJid,
          groupName,
          cronExpression,
          runAt,
          timezone,
          caption: caption || null,
          mediaPath: req.file ? req.file.path : null,
          mediaType: mediaTypeForFile(req.file),
        });
        created++;
      }
      if (skipped.length > 0) {
        const msg = `Skipped ${skipped.join(', ')} — bot isn't admin there, so WhatsApp won't let it post (that group only allows admins to send).${created > 0 ? ` Scheduled the other ${created}.` : ''}`;
        return res.redirect(`/admin/bot/${botId}?groupPostError=${encodeURIComponent(msg)}`);
      }
      await refreshScheduler();
    } catch (err) {
      logger.error({ err, botId }, 'Failed to create scheduled group post');
      return res.redirect(`/admin/bot/${botId}?groupPostError=${encodeURIComponent('Something went wrong saving that — check server logs.')}`);
    }
    res.redirect(`/admin/bot/${botId}`);
  });

  router.post('/bot/:id/group-posts/:postId/cancel', async (req, res) => {
    await deactivateScheduledGroupPost(parseInt(req.params.postId, 10));
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
