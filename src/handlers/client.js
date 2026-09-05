const express = require('express');
const crypto = require('crypto');
const { requireClientAuth } = require('../utils/clientAuth');
const { createBot, getBotById, setBotDisplayName } = require('../db/bots');
const { createClientAccount, verifyClientLogin, getClientAccountByPhone, getClientAccountByBotId, getClientAccountByReferralCode, countReferrals } = require('../db/clientAccounts');
const { startTrial, getSubscription, isSubscriptionActive, extendSubscription, extendSubscriptionByYMD } = require('../db/subscriptions');
const { getPricingSettings } = require('../db/pricingSettings');
const { createPaymentRecord, getPaymentByCheckoutId, markPaymentResult, getPaymentsForBot } = require('../db/payments');
const { initiateStkPush, parseStkCallback } = require('../utils/daraja');
const { startBotSocket, getBotState, deleteBotSession, enqueueConnect, getKnownContactJids } = require('../utils/botManager');
const { getDb } = require('../db/mongo');
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
  setTextField,
} = require('../db/botFeatures');
const { getAllKeywordResponses, addKeywordResponse, deleteKeywordResponse } = require('../db/keywordResponses');
const { getRecentPostsWithViewers, recordOwnStatusPost } = require('../db/ownStatusPosts');
const { getScheduledStatusPostsForBot, createScheduledStatusPost, deactivateScheduledStatusPost, deleteScheduledStatusPost, updateScheduledStatusPostCaption } = require('../db/scheduledStatusPosts');
const {
  getScheduledGroupPostsForBot,
  createScheduledGroupPost,
  deactivateScheduledGroupPost,
  deleteScheduledGroupPost,
  updateScheduledGroupPostCaption,
} = require('../db/scheduledGroupPosts');
const { handleScheduledMediaUpload, mediaTypeForFile } = require('../utils/mediaUpload');
const { resolveSchedule } = require('../utils/scheduleTime');
const { refreshScheduler } = require('./scheduler');
const { getProductsForBot, addProduct, deleteProduct } = require('../db/products');
const { getOrdersForBot, getOrderById, setOrderStatus } = require('../db/orders');
const { getMessageStatsForBot } = require('../db/messages');
const { countAiReplies } = require('../db/aiChatHistory');
const { countActiveContacts } = require('../db/contacts');
const logger = require('../utils/logger');

const REFERRAL_BONUS_DAYS = parseInt(process.env.REFERRAL_BONUS_DAYS || '7', 10);

function layout(title, body, extraHead = '') {
  return `
    <html>
      <head>
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${extraHead}
        <style>
          :root {
            --accent: #00a884;
            --accent-dark: #008a6e;
            --bg: #0b0f14;
            --card: #151b23;
            --card-border: #232b36;
            --text: #e9edef;
            --text-dim: #8696a0;
            --danger: #f87171;
            --danger-bg: #3a1414;
            --success-bg: #0d2f22;
          }
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            max-width: 520px; margin: 0 auto; padding: 0 16px 40px;
            background: var(--bg); color: var(--text); line-height: 1.5;
            -webkit-font-smoothing: antialiased;
          }
          a { color: var(--accent); text-decoration: none; }
          a:hover { text-decoration: underline; }
          h1, h2, h3 { font-weight: 600; letter-spacing: -0.01em; }
          h1 { font-size: 1.5rem; margin: 24px 0 4px; }
          h2 { font-size: 1.25rem; margin: 20px 0 10px; }
          h3 { font-size: 1.02rem; margin: 0 0 12px; color: var(--text); display: flex; align-items: center; gap: 6px; }
          p { color: var(--text-dim); }
          small { color: var(--text-dim); }

          .topbar {
            display: flex; align-items: center; justify-content: space-between;
            padding: 18px 0; margin-bottom: 8px; border-bottom: 1px solid var(--card-border);
          }
          .topbar .brand { font-weight: 700; font-size: 1.1rem; color: var(--text); display: flex; align-items: center; gap: 8px; }
          .topbar .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
          .topbar a { color: var(--text-dim); font-size: 0.9rem; }

          input, select, textarea {
            font-size: 15px; padding: 11px 12px; margin: 6px 0; width: 100%;
            background: #0f151c; color: var(--text); border: 1px solid var(--card-border);
            border-radius: 10px; transition: border-color 0.15s;
          }
          input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
          input::placeholder { color: #55606b; }
          label { display: block; }
          label small { display: block; margin-bottom: 2px; font-size: 0.78rem; }

          button {
            font-size: 15px; padding: 11px 16px; margin: 6px 0; width: 100%;
            background: var(--accent); color: #04211a; font-weight: 600;
            cursor: pointer; border: none; border-radius: 10px;
            transition: background 0.15s, transform 0.1s;
          }
          button:hover { background: var(--accent-dark); }
          button:active { transform: scale(0.98); }
          button.danger, .danger { background: var(--danger-bg); color: var(--danger); border: 1px solid #5c2323; }
          button.danger:hover { background: #4a1a1a; }
          button.secondary { background: #1c2530; color: var(--text); border: 1px solid var(--card-border); }
          button.secondary:hover { background: #232d3a; }

          .card {
            background: var(--card); border: 1px solid var(--card-border); border-radius: 14px;
            padding: 18px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          }

          .group-checklist { max-height: 260px; overflow-y: auto; border: 1px solid var(--card-border); border-radius: 8px; margin-bottom: 10px; }
          .group-check-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--card-border); cursor: pointer; }
          .group-check-row:last-child { border-bottom: none; }
          .group-check-row input[type="checkbox"] { width: 18px; height: 18px; flex-shrink: 0; }
          .group-check-row.disabled { opacity: 0.5; cursor: not-allowed; }

          .pill {
            padding: 3px 11px; border-radius: 20px; font-size: 12px; font-weight: 600;
            letter-spacing: 0.02em; display: inline-block;
          }
          .on { background: var(--success-bg); color: #4ade80; }
          .off { background: var(--danger-bg); color: #f87171; }

          .row {
            display: flex; justify-content: space-between; align-items: center;
            padding: 11px 0; border-bottom: 1px solid var(--card-border); gap: 10px;
          }
          .row:last-child { border-bottom: none; }
          .row > span:first-child { font-size: 0.93rem; }

          /* Real switch control, replacing the old pill+Toggle-button combo */
          .switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
          .switch input { opacity: 0; width: 0; height: 0; }
          .switch .slider {
            position: absolute; cursor: pointer; inset: 0; background: #2a333e;
            border-radius: 24px; transition: background 0.2s;
          }
          .switch .slider::before {
            content: ""; position: absolute; height: 18px; width: 18px; left: 3px; bottom: 3px;
            background: white; border-radius: 50%; transition: transform 0.2s;
          }
          .switch input:checked + .slider { background: var(--accent); }
          .switch input:checked + .slider::before { transform: translateX(20px); }

          .error-box {
            background: var(--danger-bg); border: 1px solid #5c2323; color: #fca5a5;
            padding: 10px 14px; border-radius: 10px; font-size: 0.9rem; margin-bottom: 12px;
          }
        </style>
      </head>
      <body>
        <div class="topbar">
          <div class="brand"><span class="dot"></span>WhatsApp Bot</div>
          ${title !== 'Register' && title !== 'Login' ? '<a href="/client/logout">Logout</a>' : ''}
        </div>
        ${body}
        <script>
          document.querySelectorAll('.tz-input').forEach((el) => {
            try { el.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
          });
          // Every button click that submits a form (Delete, Cancel, Save,
          // Schedule, etc.) shows immediate loading feedback — Render's
          // free tier can take a while to respond, especially right after
          // being idle, so without this a click can look like it did
          // nothing when it's actually still working.
          document.addEventListener('submit', (e) => {
            const form = e.target;
            const btn = form.querySelector('button[type="submit"], button:not([type])');
            if (btn && !btn.disabled) {
              btn.dataset.originalText = btn.textContent;
              btn.textContent = 'Loading...';
              btn.disabled = true;
              btn.style.opacity = '0.7';
            }
          });
        </script>
      </body>
    </html>
  `;
}

// Small inline script that auto-submits a toggle switch's form the instant
// it's flipped — no separate "Toggle" button needed, feels like a real
// settings screen instead of a form you have to remember to submit.
const TOGGLE_AUTOSUBMIT_JS = `<script>
  document.querySelectorAll('.switch input').forEach(function(el) {
    el.addEventListener('change', function() { el.closest('form').submit(); });
  });
</script>`;

function createClientRoutes() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  router.get('/register', (req, res) => {
    const error = req.query.error ? `<div class="error-box">${req.query.error}</div>` : '';
    const refCode = (req.query.ref || '').trim();
    res.send(layout('Register', `
      <h2>Create Your Account</h2>
      ${error}
      <p>Register once with the WhatsApp number you'll connect your bot to. This number gets a free trial — it can't be reused for another trial later.</p>
      ${refCode ? `<p><small>🎁 Referred by a friend — you'll both get ${REFERRAL_BONUS_DAYS} bonus days once you register.</small></p>` : ''}
      <form method="POST" action="/client/register">
        <input name="phoneNumber" placeholder="Phone number (e.g. 254712345678)" required />
        <input name="password" type="password" placeholder="Choose a password" required minlength="6" />
        <input type="hidden" name="ref" value="${refCode.replace(/"/g, '')}" />
        <button type="submit">Register</button>
      </form>
      <p>Already registered? <a href="/client/login">Log in</a></p>
    `));
  });

  router.post('/register', async (req, res) => {
    const digits = (req.body.phoneNumber || '').replace(/[^0-9]/g, '');
    const password = req.body.password || '';
    const refCode = (req.body.ref || '').trim();

    if (!digits || password.length < 6) {
      return res.redirect('/client/register?error=' + encodeURIComponent('Enter a valid number and a password of at least 6 characters.'));
    }

    const existing = await getClientAccountByPhone(digits);
    if (existing) {
      return res.redirect('/client/register?error=' + encodeURIComponent('This number is already registered. Please log in instead.'));
    }

    const bot = await createBot(digits);
    await startTrial(bot.id);

    let referrer = null;
    if (refCode) {
      referrer = await getClientAccountByReferralCode(refCode);
    }
    const account = await createClientAccount(bot.id, digits, password, referrer ? refCode : null);

    // Reward both sides once the referral actually converts into a real
    // signup — not just for clicking the link.
    if (referrer) {
      await extendSubscriptionByYMD(referrer.bot_id, { days: REFERRAL_BONUS_DAYS });
      await extendSubscriptionByYMD(bot.id, { days: REFERRAL_BONUS_DAYS });
      logger.info({ referrerBotId: referrer.bot_id, newBotId: bot.id }, 'Referral bonus applied to both accounts');
    }

    const { onBotReady } = require('./botStartHook');
    enqueueConnect(() => startBotSocket(bot.id, bot.slug, onBotReady)).catch((err) =>
      logger.error({ err, botId: bot.id }, 'Failed to start bot socket on client registration')
    );

    req.session.clientBotId = bot.id;
    req.session.clientPhoneNumber = digits;
    res.redirect(`/connect/${bot.slug}`);
  });

  router.get('/login', (req, res) => {
    if (req.session && req.session.clientBotId) return res.redirect('/client/dashboard');
    const error = req.query.error ? '<div class="error-box">Invalid phone number or password.</div>' : '';
    res.send(layout('Login', `
      <h2>Client Login</h2>
      ${error}
      <form method="POST" action="/client/login">
        <input name="phoneNumber" placeholder="Phone number" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Log in</button>
      </form>
      <p>New here? <a href="/client/register">Register</a></p>
    `));
  });

  router.post('/login', async (req, res) => {
    const digits = (req.body.phoneNumber || '').replace(/[^0-9]/g, '');
    const account = await verifyClientLogin(digits, req.body.password || '');
    if (!account) return res.redirect('/client/login?error=1');
    req.session.clientBotId = account.bot_id;
    req.session.clientPhoneNumber = account.phone_number;
    res.redirect('/client/dashboard');
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/client/login'));
  });

  router.use(requireClientAuth);

  router.get('/dashboard', async (req, res) => {
    const botId = req.session.clientBotId;
    const bot = await getBotById(botId);
    const live = getBotState(botId);
    const connectionStatus = live?.status || bot?.status || 'pending';
    const onboardingUrl = bot ? `${req.protocol}://${req.get('host')}/connect/${bot.slug}` : null;
    const sub = await getSubscription(botId);
    const active = await isSubscriptionActive(botId);
    const pricing = await getPricingSettings();
    const payments = await getPaymentsForBot(botId, 10);

    const now = new Date();
    const trialActive = sub && sub.trial_ends_at && now < new Date(sub.trial_ends_at);
    const paidActive = sub && sub.paid_until && now < new Date(sub.paid_until);

    let statusText;
    if (trialActive) {
      const daysLeft = Math.ceil((new Date(sub.trial_ends_at) - now) / (1000 * 60 * 60 * 24));
      statusText = `Free trial — ${daysLeft} day(s) left`;
    } else if (paidActive) {
      statusText = `Paid (${sub.plan}) — active until ${new Date(sub.paid_until).toLocaleDateString()}`;
    } else {
      statusText = 'Expired — your bot is currently paused';
    }

    const paymentRows = payments.map((p) => `
      <div class="row">
        <span>${p.plan} — KES ${p.amount}</span>
        <span class="pill ${p.status === 'success' ? 'on' : p.status === 'pending' ? '' : 'off'}">${p.status}</span>
      </div>
    `).join('') || '<p>No payments yet.</p>';

    const features = await getFeatures(botId);
    const keywordResponses = await getAllKeywordResponses(botId);
    const statusPosts = await getRecentPostsWithViewers(botId, 10);
    const scheduledPosts = await getScheduledStatusPostsForBot(botId);
    const groupPosts = await getScheduledGroupPostsForBot(botId);

    // Live-fetched, not stored — the bot's actual current group list from
    // WhatsApp itself, so the dropdown can never show a stale/left group.
    let botGroups = [];
    if (live && live.sock && live.status === 'connected') {
      try {
        const groupsObj = await live.sock.groupFetchAllParticipating();
        botGroups = Object.values(groupsObj).map((g) => ({ id: g.id, subject: g.subject }));
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to fetch participating groups');
      }
    }

    // Usage analytics — last 7 days.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const msgStats = await getMessageStatsForBot(botId, sevenDaysAgo);
    const aiReplyCount = await countAiReplies(botId, sevenDaysAgo);
    const activeContactCount = await countActiveContacts(botId, sevenDaysAgo);
    const products = await getProductsForBot(botId);
    const recentOrders = await getOrdersForBot(botId, 100);
    const pendingOrderCount = recentOrders.filter((o) => o.status === 'pending').length;

    // Referral info.
    const clientAccount = await getClientAccountByBotId(botId);
    const referralCount = clientAccount ? await countReferrals(clientAccount.referral_code) : 0;
    const referralLink = clientAccount ? `${req.protocol}://${req.get('host')}/client/register?ref=${clientAccount.referral_code}` : null;

    // Disconnect alert — only shows when actually disconnected, with how long.
    const disconnectBanner = (connectionStatus !== 'connected' && bot?.disconnected_at)
      ? `<div class="error-box">⚠️ Your bot has been disconnected since ${new Date(bot.disconnected_at).toLocaleString()}. Reconnect below to keep your bot running.</div>`
      : '';

    const featureRows = FEATURE_COLUMNS.map((col) => `
      <div class="row">
        <span>${FEATURE_LABELS[col]}</span>
        <form method="POST" action="/client/settings/toggle" style="width:auto;margin:0;">
          <input type="hidden" name="feature" value="${col}" />
          <label class="switch">
            <input type="checkbox" name="enabled" value="1" ${features[col] ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </form>
      </div>
    `).join('');

    const keywordRows = keywordResponses.map((k) => `
      <div class="row">
        <span><strong>"${k.keyword}"</strong> → ${k.response.slice(0, 60)}${k.response.length > 60 ? '...' : ''}</span>
        <form method="POST" action="/client/settings/keywords/${k.id}/delete" style="width:auto;">
          <button type="submit" class="danger" style="width:auto;">Delete</button>
        </form>
      </div>
    `).join('') || '<p>No keyword responses set up yet.</p>';

    res.send(layout('Dashboard', `
      <h2>Your Bot</h2>
      ${disconnectBanner}
      <div class="card">
        <p><span class="pill ${active ? 'on' : 'off'}">${active ? 'ACTIVE' : 'EXPIRED'}</span></p>
        <p>${statusText}</p>
      </div>

      <div class="card">
        <h3>📊 Activity (last 7 days)</h3>
        <div class="row"><span>Messages received</span><strong>${msgStats.incoming}</strong></div>
        <div class="row"><span>Replies sent</span><strong>${msgStats.outgoing}</strong></div>
        <div class="row"><span>AI replies</span><strong>${aiReplyCount}</strong></div>
        <div class="row"><span>Active contacts</span><strong>${activeContactCount}</strong></div>
      </div>

      ${clientAccount ? `
      <div class="card">
        <h3>🎁 Refer & Earn</h3>
        <p><small>Share your link — when someone signs up through it, you both get <strong>${REFERRAL_BONUS_DAYS} bonus days</strong> automatically.</small></p>
        <code style="display:block;margin:10px 0;word-break:break-all;">${referralLink}</code>
        <p><small>${referralCount} referral${referralCount === 1 ? '' : 's'} so far</small></p>
      </div>
      ` : ''}

      <div class="card">
        <h3>📱 WhatsApp Connection</h3>
        <p><span class="pill ${connectionStatus === 'connected' ? 'on' : 'off'}">${connectionStatus.toUpperCase()}</span></p>
        ${connectionStatus === 'connected' ? `
          <p><small>Your WhatsApp is linked. If you ever unlink this device from WhatsApp (Settings → Linked Devices), come back here and tap the button below to get a fresh link to reconnect.</small></p>
        ` : `
          <p><small>Your bot isn't connected right now. Use the link below to scan a QR code or enter a pairing code with the same WhatsApp number you registered with.</small></p>
        `}
        ${pricing.tutorial_url ? `<p>📺 <a href="${pricing.tutorial_url}" target="_blank" rel="noopener">Watch: How to connect your bot</a></p>` : ''}
        ${onboardingUrl ? `<code style="display:block;margin:10px 0;word-break:break-all;">${onboardingUrl}</code>` : ''}
        <form method="POST" action="/client/settings/regenerate-link">
          <button type="submit">Generate new connection link</button>
        </form>
        <p><small>This link only works with your registered number (${req.session.clientPhoneNumber}). Generating a new one invalidates the old link.</small></p>
      </div>

      <div class="card">
        <h3>Subscribe / Renew</h3>
        <p>Monthly: KES ${pricing.monthly_price} &nbsp;|&nbsp; Yearly: KES ${pricing.yearly_price}</p>
        <form method="POST" action="/client/pay">
          <select name="plan">
            <option value="monthly">Monthly — KES ${pricing.monthly_price}</option>
            <option value="yearly">Yearly — KES ${pricing.yearly_price}</option>
          </select>
          <input name="phoneNumber" placeholder="M-Pesa number to pay from" value="${req.session.clientPhoneNumber}" required />
          <button type="submit">Pay with M-Pesa (STK Push)</button>
        </form>
      </div>

      <div class="card">
        <h3>Payment History</h3>
        ${paymentRows}
      </div>

      <div class="card">
        <h3>⚙️ Bot Features</h3>
        <p><small>Turn features on/off for your own bot. Your platform admin can also override these.</small></p>
        ${featureRows}
      </div>

      <div class="card">
        <h3>Stealth Read Mode</h3>
        <p><small>Controls whether incoming messages get marked as "read" (blue ticks) on the sender's side.</small></p>
        <form method="POST" action="/client/settings/stealth-mode">
          <select name="mode">
            ${STEALTH_READ_MODES.map((m) => `
              <option value="${m}" ${features.stealth_read_mode === m ? 'selected' : ''}>
                ${STEALTH_READ_MODE_LABELS[m]}
              </option>
            `).join('')}
          </select>
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>Auto-reply message</h3>
        <form method="POST" action="/client/settings/reply-message">
          <input name="message" value="${(features.auto_reply_message || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>Welcome message</h3>
        <p><small>Sent once, the first time a contact messages this bot.</small></p>
        <form method="POST" action="/client/settings/welcome-message">
          <input name="message" value="${(features.welcome_message_text || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>📦 Orders</h3>
        <p><span class="pill ${pendingOrderCount > 0 ? 'off' : 'on'}">${pendingOrderCount} pending</span> <small>${recentOrders.length} total</small></p>
        <a href="/client/orders" style="display:inline-block;background:#00a884;color:white;text-decoration:none;padding:8px 14px;border-radius:6px;">View all orders</a>
      </div>

      <div class="card">
        <h3>🛒 Products (!order menu)</h3>
        <p><small>Customers type !order to see this list and pick an item. Leave empty and !order falls back to asking them to type what they want.</small></p>
        ${products.map((p) => `
          <div class="row">
            <span>${p.name}${p.price ? ` — KES ${p.price}` : ''}</span>
            <form method="POST" action="/client/products/${p.id}/delete" style="width:auto;margin:0;">
              <button type="submit" class="danger" style="width:auto;">Remove</button>
            </form>
          </div>
        `).join('') || '<p>No products added yet.</p>'}
        <form method="POST" action="/client/products/add" style="display:flex;gap:8px;margin-top:10px;">
          <input name="name" placeholder="Item name" required style="flex:2;" />
          <input name="price" type="number" placeholder="Price (optional)" style="flex:1;" />
          <button type="submit" style="width:auto;">Add</button>
        </form>
      </div>

      <div class="card">
        <h3>💳 Payment Method</h3>
        <p><small>Shown to customers automatically after they place an order via !order, so they know how to pay. Nothing is charged automatically — payment is arranged directly between you and the customer.</small></p>
        <form method="POST" action="/client/settings/payment-method">
          <select name="type">
            <option value="none" ${features.payment_method_type === 'none' || !features.payment_method_type ? 'selected' : ''}>Not set</option>
            <option value="till" ${features.payment_method_type === 'till' ? 'selected' : ''}>M-Pesa Till Number</option>
            <option value="paybill" ${features.payment_method_type === 'paybill' ? 'selected' : ''}>M-Pesa Paybill</option>
            <option value="phone" ${features.payment_method_type === 'phone' ? 'selected' : ''}>M-Pesa Send Money (phone)</option>
          </select>
          <input name="till_number" placeholder="Till number" value="${(features.payment_till_number || '').replace(/"/g, '&quot;')}" />
          <input name="paybill_number" placeholder="Paybill number" value="${(features.payment_paybill_number || '').replace(/"/g, '&quot;')}" />
          <input name="paybill_account" placeholder="Paybill account/reference" value="${(features.payment_paybill_account || '').replace(/"/g, '&quot;')}" />
          <input name="phone_number" placeholder="Phone number (for Send Money)" value="${(features.payment_phone_number || '').replace(/"/g, '&quot;')}" />
          <input name="notes" placeholder="Optional note (e.g. 'send confirmation screenshot')" value="${(features.payment_notes || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save payment method</button>
        </form>
      </div>

      <div class="card">
        <h3>👥 Group Settings</h3>
        <p><small>Applies in any group this bot is a member of.</small></p>
        <div class="row">
          <span>Welcome new members</span>
          <form method="POST" action="/client/settings/toggle" style="width:auto;margin:0;">
            <input type="hidden" name="feature" value="group_welcome_enabled" />
            <label class="switch"><input type="checkbox" name="enabled" value="1" ${features.group_welcome_enabled ? 'checked' : ''} /><span class="slider"></span></label>
          </form>
        </div>
        <form method="POST" action="/client/settings/text-field" style="margin-bottom:10px;">
          <input type="hidden" name="field" value="group_welcome_text" />
          <input name="value" value="${(features.group_welcome_text || '').replace(/"/g, '&quot;')}" placeholder="Use {mention} to tag the new member" />
          <button type="submit">Save</button>
        </form>
        <div class="row">
          <span>Goodbye on leave/remove</span>
          <form method="POST" action="/client/settings/toggle" style="width:auto;margin:0;">
            <input type="hidden" name="feature" value="group_goodbye_enabled" />
            <label class="switch"><input type="checkbox" name="enabled" value="1" ${features.group_goodbye_enabled ? 'checked' : ''} /><span class="slider"></span></label>
          </form>
        </div>
        <form method="POST" action="/client/settings/text-field" style="margin-bottom:10px;">
          <input type="hidden" name="field" value="group_goodbye_text" />
          <input name="value" value="${(features.group_goodbye_text || '').replace(/"/g, '&quot;')}" placeholder="Use {mention} to tag the member who left" />
          <button type="submit">Save</button>
        </form>
        <div class="row">
          <span>Anti-Link (remove links from non-admins)</span>
          <form method="POST" action="/client/settings/toggle" style="width:auto;margin:0;">
            <input type="hidden" name="feature" value="group_antilink_enabled" />
            <label class="switch"><input type="checkbox" name="enabled" value="1" ${features.group_antilink_enabled ? 'checked' : ''} /><span class="slider"></span></label>
          </form>
        </div>
        <div class="row">
          <span>Tag-All (!tagall, admins only)</span>
          <form method="POST" action="/client/settings/toggle" style="width:auto;margin:0;">
            <input type="hidden" name="feature" value="group_tagall_enabled" />
            <label class="switch"><input type="checkbox" name="enabled" value="1" ${features.group_tagall_enabled ? 'checked' : ''} /><span class="slider"></span></label>
          </form>
        </div>
      </div>

      <div class="card">
        <h3>🕒 Business Hours</h3>
        <div class="row">
          <span>Only send away-message outside these hours</span>
          <form method="POST" action="/client/settings/toggle" style="width:auto;margin:0;">
            <input type="hidden" name="feature" value="business_hours_enabled" />
            <label class="switch"><input type="checkbox" name="enabled" value="1" ${features.business_hours_enabled ? 'checked' : ''} /><span class="slider"></span></label>
          </form>
        </div>
        <form method="POST" action="/client/settings/business-hours" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <label style="flex:1;min-width:100px;"><small>Opens</small><input type="time" name="start" value="${features.business_hours_start || '09:00'}" /></label>
          <label style="flex:1;min-width:100px;"><small>Closes</small><input type="time" name="end" value="${features.business_hours_end || '18:00'}" /></label>
          <label style="flex:1;min-width:140px;"><small>Timezone</small><input name="timezone" value="${features.business_hours_timezone || 'Africa/Nairobi'}" /></label>
          <button type="submit" style="width:auto;">Save hours</button>
        </form>
        <form method="POST" action="/client/settings/text-field" style="margin-top:8px;">
          <input type="hidden" name="field" value="business_hours_away_text" />
          <input name="value" value="${(features.business_hours_away_text || '').replace(/"/g, '&quot;')}" placeholder="Message sent outside business hours" />
          <button type="submit">Save message</button>
        </form>
      </div>

      <div class="card">
        <h3>Away message</h3>
        <form method="POST" action="/client/settings/away-message">
          <input name="message" value="${(features.away_message_text || '').replace(/"/g, '&quot;')}" />
          <button type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>🤖 AI Chat Assistant</h3>
        <form method="POST" action="/client/settings/ai-provider">
          <select name="provider">
            ${AI_PROVIDERS.map((p) => `<option value="${p}" ${features.ai_provider === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <button type="submit">Save Provider</button>
        </form>
        <form method="POST" action="/client/settings/ai-prompt" style="margin-top:10px;">
          <input name="prompt" value="${(features.ai_system_prompt || '').replace(/"/g, '&quot;')}" placeholder="System prompt / personality" />
          <button type="submit">Save Prompt</button>
        </form>
      </div>

      <div class="card">
        <h3>Keyword Responses</h3>
        ${keywordRows}
        <form method="POST" action="/client/settings/keywords">
          <input name="keyword" placeholder="Keyword (e.g. 'price')" required />
          <input name="response" placeholder="Response to send" required />
          <button type="submit">Add Keyword Response</button>
        </form>
      </div>

      <div class="card">
        <h3>🪪 Bot display name</h3>
        <p><small>Changes the WhatsApp profile name — this is what people who <b>haven't</b> saved this number in their own contacts will see. If someone already saved this number under a different name (e.g. "John"), they'll keep seeing that name no matter what — that's controlled by their phone, not this bot, and nothing can override it.</small></p>
        ${req.query.nameError ? `<p style="color:#f87171;">${req.query.nameError}</p>` : ''}
        ${req.query.nameSuccess ? `<p style="color:#4ade80;">Updated.</p>` : ''}
        ${bot?.display_name ? `<p>Currently set to: <b>${bot.display_name}</b></p>` : ''}
        <form method="POST" action="/client/settings/display-name">
          <input name="displayName" placeholder="e.g. Titus 1" required maxlength="25" />
          <button type="submit">Update Name</button>
        </form>
      </div>

      <div class="card">
        <h3>⏰ Scheduled status posts</h3>
        <p><small>Pick a time. Leave date blank to repeat daily, or set a date to post once. Attach an image/video, add a caption, or both.</small></p>
        ${req.query.postError ? `<p style="color:#f87171;">${req.query.postError}</p>` : ''}
        ${scheduledPosts.map((p) => `
          <div class="row">
            <span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'ACTIVE' : 'OFF'}</span>
            <span>${p.cron_expression ? 'Daily ' + p.cron_expression : new Date(p.run_at).toLocaleString()}${p.media_path ? ` ${p.media_type === 'video' ? '🎥' : '📷'}` : ''} — "${p.caption || ''}"</span>
            ${p.is_active ? `<form method="POST" action="/client/settings/scheduled-posts/${p.id}/cancel" style="width:auto;"><button class="danger" style="width:auto;">Cancel</button></form>` : ''}
            <form method="POST" action="/client/settings/scheduled-posts/${p.id}/delete" style="width:auto;"><button class="danger" style="width:auto;">Delete</button></form>
          </div>
          <details style="margin-bottom:10px;">
            <summary style="cursor:pointer;"><small>Edit caption</small></summary>
            <form method="POST" action="/client/settings/scheduled-posts/${p.id}/edit-caption" style="margin-top:8px;">
              <input name="caption" placeholder="New caption" value="${(p.caption || '').replace(/"/g, '&quot;')}" />
              <button type="submit" style="width:auto;">Save Caption</button>
            </form>
          </details>
        `).join('') || '<p>None scheduled.</p>'}
        <form method="POST" action="/client/settings/scheduled-posts" enctype="multipart/form-data">
          <label><small>Time</small><input type="time" name="time" required /></label>
          <label><small>Date (optional — leave blank to repeat every day)</small><input type="date" name="date" /></label>
          <input type="hidden" name="timezone" class="tz-input" />
          <label><small>Caption</small><input name="caption" placeholder="Optional if attaching media" /></label>
          <label><small>Media (optional)</small><input type="file" name="media" accept="image/jpeg,image/png,image/webp,video/mp4" /></label>
          <button type="submit">Schedule</button>
        </form>
      </div>

      <div class="card">
        <h3>👥 Group auto-posts</h3>
        <p><small>Post to a group your bot is in. Leave date blank to repeat daily, or set a date to post once. Attach an image/video, add a caption, or both.</small></p>
        ${req.query.groupPostError ? `<p style="color:#f87171;">${req.query.groupPostError}</p>` : ''}
        ${groupPosts.map((p) => `
          <div class="row">
            <span class="pill ${p.is_active ? 'on' : 'off'}">${p.is_active ? 'ACTIVE' : 'OFF'}</span>
            <span>${p.cron_expression ? 'Daily ' + p.cron_expression : new Date(p.run_at).toLocaleString()}${p.media_path ? ` ${p.media_type === 'video' ? '🎥' : '📷'}` : ''} → ${p.group_name || p.group_jid} — "${p.caption || ''}"</span>
            ${p.is_active ? `<form method="POST" action="/client/settings/group-posts/${p.id}/cancel" style="width:auto;"><button class="danger" style="width:auto;">Cancel</button></form>` : ''}
            <form method="POST" action="/client/settings/group-posts/${p.id}/delete" style="width:auto;"><button class="danger" style="width:auto;">Delete</button></form>
          </div>
          <details style="margin-bottom:10px;">
            <summary style="cursor:pointer;"><small>Edit caption</small></summary>
            <form method="POST" action="/client/settings/group-posts/${p.id}/edit-caption" style="margin-top:8px;">
              <input name="caption" placeholder="New caption" value="${(p.caption || '').replace(/"/g, '&quot;')}" />
              <button type="submit" style="width:auto;">Save Caption</button>
            </form>
          </details>
        `).join('') || '<p>None scheduled.</p>'}
        ${botGroups.length > 0 ? `
          <form method="POST" action="/client/settings/group-posts" enctype="multipart/form-data">
            <label><small>Group(s) — tap each one you want to include.</small></label>
            <div class="group-checklist">
              ${botGroups.map((g) => `
                <label class="group-check-row">
                  <input type="checkbox" name="groupId" value="${g.id}" />
                  <span>${g.subject}</span>
                </label>
              `).join('')}
            </div>
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
        <h3>👀 Status Views</h3>
        <p><small>Post a status from here, or wait for your scheduled posts — either way, viewers show up below once they open it. Only tracked while your bot is connected and only counts views that happen after posting.</small></p>
        <form method="POST" action="/client/settings/post-status">
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
      ${TOGGLE_AUTOSUBMIT_JS}
    `));
  });

  router.post('/settings/display-name', async (req, res) => {
    const botId = req.session.clientBotId;
    const displayName = (req.body.displayName || '').trim();
    if (!displayName) {
      return res.redirect(`/client/dashboard?nameError=${encodeURIComponent('Enter a name.')}`);
    }

    const live = getBotState(botId);
    if (!live || !live.sock || live.status !== 'connected') {
      return res.redirect(`/client/dashboard?nameError=${encodeURIComponent("Bot isn't connected right now, so the name can't be changed.")}`);
    }

    try {
      await live.sock.updateProfileName(displayName);
      await setBotDisplayName(botId, displayName);
    } catch (err) {
      logger.error({ err, botId }, 'Failed to update bot profile name');
      const isMissingSyncKey = /appStateKey.*not present/i.test(err.message || '');
      const message = isMissingSyncKey
        ? "This bot's session is missing some WhatsApp sync data needed to change the name. Re-link the bot (new QR/pairing code) to fix it — this can't be fixed by retrying."
        : 'Failed: ' + (err.message || 'unknown error') + ' — check server logs for details.';
      return res.redirect(`/client/dashboard?nameError=${encodeURIComponent(message)}`);
    }
    res.redirect('/client/dashboard?nameSuccess=1');
  });

  router.post('/settings/post-status', async (req, res) => {
    const botId = req.session.clientBotId;
    const caption = (req.body.caption || '').trim();
    if (!caption) return res.redirect('/client/dashboard');

    const live = getBotState(botId);
    if (!live || !live.sock || live.status !== 'connected') {
      return res.send(layout('Not connected', `<p>Your bot isn't connected right now, so it can't post a status.</p><a href="/client/dashboard">Back</a>`));
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
      logger.error({ err, botId }, 'Failed to post manual status from client dashboard');
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/scheduled-posts', async (req, res) => {
    const botId = req.session.clientBotId;
    try {
      await handleScheduledMediaUpload(req, res);
    } catch (err) {
      logger.warn({ err, botId }, 'Scheduled status post media upload rejected');
      return res.redirect(`/client/dashboard?postError=${encodeURIComponent(err.message || 'Media upload failed.')}`);
    }

    try {
      const caption = (req.body.caption || '').trim();
      if (!caption && !req.file) {
        return res.redirect(`/client/dashboard?postError=${encodeURIComponent('Add a caption or attach media.')}`);
      }
      const { cronExpression, runAt, timezone, error } = resolveSchedule(req.body.time, req.body.date, req.body.timezone);
      if (error) {
        return res.redirect(`/client/dashboard?postError=${encodeURIComponent(error)}`);
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
      return res.redirect(`/client/dashboard?postError=${encodeURIComponent('Something went wrong saving that — try again in a moment.')}`);
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/scheduled-posts/:postId/cancel', async (req, res) => {
    await deactivateScheduledStatusPost(parseInt(req.params.postId, 10));
    await refreshScheduler();
    res.redirect('/client/dashboard');
  });

  router.post('/settings/scheduled-posts/:postId/delete', async (req, res) => {
    await deleteScheduledStatusPost(parseInt(req.params.postId, 10));
    await refreshScheduler();
    res.redirect('/client/dashboard');
  });

  router.post('/settings/scheduled-posts/:postId/edit-caption', async (req, res) => {
    await updateScheduledStatusPostCaption(parseInt(req.params.postId, 10), (req.body.caption || '').trim());
    await refreshScheduler();
    res.redirect('/client/dashboard');
  });

  router.post('/settings/group-posts', async (req, res) => {
    const botId = req.session.clientBotId;
    try {
      await handleScheduledMediaUpload(req, res);
    } catch (err) {
      logger.warn({ err, botId }, 'Group post media upload rejected');
      return res.redirect(`/client/dashboard?groupPostError=${encodeURIComponent(err.message || 'Media upload failed.')}`);
    }

    try {
      const groupJids = [].concat(req.body.groupId || []).map((g) => g.trim()).filter(Boolean);
      const caption = (req.body.caption || '').trim();
      if (groupJids.length === 0) {
        return res.redirect(`/client/dashboard?groupPostError=${encodeURIComponent('Pick at least one group.')}`);
      }
      if (!caption && !req.file) {
        return res.redirect(`/client/dashboard?groupPostError=${encodeURIComponent('Add a caption or attach media.')}`);
      }
      const { cronExpression, runAt, timezone, error } = resolveSchedule(req.body.time, req.body.date, req.body.timezone);
      if (error) {
        return res.redirect(`/client/dashboard?groupPostError=${encodeURIComponent(error)}`);
      }

      const live = getBotState(botId);
      for (const groupJid of groupJids) {
        let groupName = null;
        if (live && live.sock && live.status === 'connected') {
          const metadata = await live.sock.groupMetadata(groupJid).catch(() => null);
          groupName = metadata?.subject || null;
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
      }
      await refreshScheduler();
    } catch (err) {
      logger.error({ err, botId }, 'Failed to create scheduled group post');
      return res.redirect(`/client/dashboard?groupPostError=${encodeURIComponent('Something went wrong saving that — try again in a moment.')}`);
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/group-posts/:postId/cancel', async (req, res) => {
    await deactivateScheduledGroupPost(parseInt(req.params.postId, 10));
    await refreshScheduler();
    res.redirect('/client/dashboard');
  });

  router.post('/settings/group-posts/:postId/delete', async (req, res) => {
    await deleteScheduledGroupPost(parseInt(req.params.postId, 10));
    await refreshScheduler();
    res.redirect('/client/dashboard');
  });

  router.post('/settings/group-posts/:postId/edit-caption', async (req, res) => {
    await updateScheduledGroupPostCaption(parseInt(req.params.postId, 10), (req.body.caption || '').trim());
    await refreshScheduler();
    res.redirect('/client/dashboard');
  });

  router.post('/settings/regenerate-link', async (req, res) => {
    // Scoped to the logged-in client's own bot only — a client can never
    // regenerate or obtain another client's link, since botId comes from
    // their session, not from user input. The new slug still resolves to
    // the same bot, so only the number registered on this account can
    // complete pairing (the QR/pairing flow logs into that bot's own
    // WhatsApp session).
    const botId = req.session.clientBotId;
    const bot = await getBotById(botId);
    if (!bot) return res.redirect('/client/dashboard');
    await deleteBotSession(botId);
    const newSlug = crypto.randomBytes(6).toString('hex');
    const db = await getDb();
    await db.collection('bots').updateOne({ id: Number(botId) }, { $set: { slug: newSlug, status: 'pending' } });
    await startBotSocket(botId, newSlug, require('./botStartHook').onBotReady).catch((err) =>
      logger.error({ err, botId }, 'Failed to restart bot socket on client link regeneration')
    );
    res.redirect('/client/dashboard');
  });

  // --- Client-controlled feature settings (mirrors /admin toggles, scoped to own bot) ---
  router.post('/settings/toggle', async (req, res) => {
    const botId = req.session.clientBotId;
    const feature = req.body.feature;
    if (FEATURE_COLUMNS.includes(feature)) {
      // A real checkbox only submits its field when checked — unchecked
      // simply omits "enabled" from the form body. So presence = on.
      await setFeature(botId, feature, req.body.enabled === '1');
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/stealth-mode', async (req, res) => {
    const botId = req.session.clientBotId;
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
    res.redirect('/client/dashboard');
  });

  router.post('/settings/reply-message', async (req, res) => {
    await setAutoReplyMessage(req.session.clientBotId, req.body.message || '');
    res.redirect('/client/dashboard');
  });

  router.post('/settings/welcome-message', async (req, res) => {
    await setWelcomeMessage(req.session.clientBotId, req.body.message || '');
    res.redirect('/client/dashboard');
  });

  router.post('/products/add', async (req, res) => {
    const name = (req.body.name || '').trim();
    const price = req.body.price ? Number(req.body.price) : null;
    if (name) {
      await addProduct(req.session.clientBotId, name, price);
    }
    res.redirect('/client/dashboard');
  });

  router.post('/products/:id/delete', async (req, res) => {
    await deleteProduct(req.session.clientBotId, req.params.id);
    res.redirect('/client/dashboard');
  });

  router.post('/settings/text-field', async (req, res) => {
    const { field, value } = req.body;
    if (field) {
      await setTextField(req.session.clientBotId, field, value || '');
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/business-hours', async (req, res) => {
    const botId = req.session.clientBotId;
    if (req.body.start) await setTextField(botId, 'business_hours_start', req.body.start);
    if (req.body.end) await setTextField(botId, 'business_hours_end', req.body.end);
    if (req.body.timezone) await setTextField(botId, 'business_hours_timezone', req.body.timezone);
    res.redirect('/client/dashboard');
  });

  router.post('/settings/payment-method', async (req, res) => {
    const botId = req.session.clientBotId;
    await setTextField(botId, 'payment_method_type', req.body.type || 'none');
    await setTextField(botId, 'payment_till_number', req.body.till_number || '');
    await setTextField(botId, 'payment_paybill_number', req.body.paybill_number || '');
    await setTextField(botId, 'payment_paybill_account', req.body.paybill_account || '');
    await setTextField(botId, 'payment_phone_number', req.body.phone_number || '');
    await setTextField(botId, 'payment_notes', req.body.notes || '');
    res.redirect('/client/dashboard');
  });

  const ORDER_STATUSES = ['pending', 'confirmed', 'paid', 'out_for_delivery', 'completed', 'cancelled'];
  const ORDER_STATUS_LABELS = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    paid: 'Paid',
    out_for_delivery: 'Out for delivery',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  // What the customer gets told on WhatsApp when the owner updates their
  // order — not every status change needs a message (e.g. no need to
  // notify on "pending", since that's already what they saw right after
  // ordering).
  const ORDER_STATUS_CUSTOMER_MESSAGE = {
    confirmed: (o) => `✅ Your order for *${o.product_name}* has been confirmed!`,
    paid: (o) => `💳 Payment received for your order (*${o.product_name}*). Thank you!`,
    out_for_delivery: (o) => `🚚 Your order (*${o.product_name}*) is out for delivery.`,
    completed: (o) => `🎉 Your order (*${o.product_name}*) is complete. Thanks for your business!`,
    cancelled: (o) => `❌ Your order for *${o.product_name}* has been cancelled. Message us if you have questions.`,
  };

  router.get('/orders', async (req, res) => {
    const botId = req.session.clientBotId;
    const orders = await getOrdersForBot(botId, 100);

    const rows = orders.map((o) => `
      <div class="card">
        <div class="row">
          <strong>${o.product_name}${o.price ? ` — KES ${o.price}` : ''}</strong>
          <span class="pill ${o.status === 'completed' ? 'on' : o.status === 'cancelled' ? 'off' : ''}">${ORDER_STATUS_LABELS[o.status] || o.status}</span>
        </div>
        <p><small>From: ${o.customer_jid.split('@')[0]} · Phone: ${o.phone}<br/>Address: ${o.address}<br/>Placed: ${new Date(o.created_at).toLocaleString()}</small></p>
        <form method="POST" action="/client/orders/${o.id}/status" style="display:flex;gap:8px;">
          <select name="status" style="flex:1;">
            ${ORDER_STATUSES.map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${ORDER_STATUS_LABELS[s]}</option>`).join('')}
          </select>
          <button type="submit" style="width:auto;">Update</button>
        </form>
      </div>
    `).join('') || '<p>No orders yet.</p>';

    res.send(layout('Orders', `
      <h2>Orders</h2>
      <p><a href="/client/dashboard">&larr; Back to dashboard</a></p>
      ${rows}
    `));
  });

  router.post('/orders/:id/status', async (req, res) => {
    const botId = req.session.clientBotId;
    const orderId = req.params.id;
    const status = req.body.status;

    if (ORDER_STATUSES.includes(status)) {
      await setOrderStatus(botId, orderId, status);

      // Notify the customer, if the bot is currently connected and this
      // status change has a message worth sending.
      const messageFn = ORDER_STATUS_CUSTOMER_MESSAGE[status];
      if (messageFn) {
        try {
          const order = await getOrderById(botId, orderId);
          const live = getBotState(botId);
          if (order && live && live.sock && live.status === 'connected') {
            await live.sock.sendMessage(order.customer_jid, { text: messageFn(order) });
          }
        } catch (err) {
          logger.warn({ err, botId, orderId }, 'Failed to notify customer of order status change');
        }
      }
    }
    res.redirect('/client/orders');
  });

  router.post('/settings/away-message', async (req, res) => {
    await setAwayMessage(req.session.clientBotId, req.body.message || '');
    res.redirect('/client/dashboard');
  });

  router.post('/settings/ai-provider', async (req, res) => {
    if (AI_PROVIDERS.includes(req.body.provider)) {
      await setAiProvider(req.session.clientBotId, req.body.provider);
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/ai-prompt', async (req, res) => {
    await setAiSystemPrompt(req.session.clientBotId, req.body.prompt || '');
    res.redirect('/client/dashboard');
  });

  router.post('/settings/keywords', async (req, res) => {
    const botId = req.session.clientBotId;
    const { keyword, response } = req.body;
    if (keyword && response) {
      await addKeywordResponse(botId, keyword, response);
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/keywords/:keywordId/delete', async (req, res) => {
    const botId = req.session.clientBotId;
    // Ensure the keyword belongs to this client's own bot before deleting.
    const owned = await getAllKeywordResponses(botId);
    if (owned.some((k) => k.id === parseInt(req.params.keywordId, 10))) {
      await deleteKeywordResponse(parseInt(req.params.keywordId, 10));
    }
    res.redirect('/client/dashboard');
  });

  router.post('/pay', async (req, res) => {
    const botId = req.session.clientBotId;
    const plan = req.body.plan === 'yearly' ? 'yearly' : 'monthly';
    const phoneNumber = (req.body.phoneNumber || '').replace(/[^0-9]/g, '');

    if (!phoneNumber) {
      return res.send(layout('Error', '<p>Invalid phone number.</p><a href="/client/dashboard">Back</a>'));
    }

    const pricing = await getPricingSettings();
    const amount = plan === 'yearly' ? pricing.yearly_price : pricing.monthly_price;
    const callbackUrl = `${req.protocol}://${req.get('host')}/client/payment-callback`;

    try {
      const result = await initiateStkPush({
        phoneNumber,
        amount,
        accountReference: `BOT${botId}`,
        transactionDesc: `${plan} subscription`,
        callbackUrl,
      });

      await createPaymentRecord({
        botId,
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        phoneNumber,
        amount,
        plan,
      });

      res.send(layout('Check your phone', `
        <h2>📱 Check your phone</h2>
        <p>An M-Pesa payment prompt has been sent to ${phoneNumber}. Enter your PIN to complete the payment.</p>
        <p>This page will refresh automatically.</p>
        <meta http-equiv="refresh" content="8;url=/client/dashboard">
        <a href="/client/dashboard">Back to dashboard</a>
      `));
    } catch (err) {
      logger.error({ err, botId }, 'Failed to initiate STK push');
      res.send(layout('Payment failed', `
        <h2>Payment request failed</h2>
        <p>${err.message}</p>
        <a href="/client/dashboard">Back</a>
      `));
    }
  });

  return router;
}

function createPaymentCallbackRoute() {
  const router = express.Router();
  router.use(express.json());

  router.post('/payment-callback', async (req, res) => {
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

    try {
      const parsed = parseStkCallback(req.body);
      if (!parsed) return;

      const payment = await getPaymentByCheckoutId(parsed.checkoutRequestId);
      if (!payment) {
        logger.warn({ checkoutRequestId: parsed.checkoutRequestId }, 'Callback for unknown payment');
        return;
      }

      if (payment.status !== 'pending') return;

      if (parsed.success) {
        await markPaymentResult(parsed.checkoutRequestId, {
          status: 'success',
          mpesaReceiptNumber: parsed.mpesaReceiptNumber,
          resultDesc: parsed.resultDesc,
        });
        await extendSubscription(payment.bot_id, payment.plan);
        logger.info({ botId: payment.bot_id, plan: payment.plan }, 'Subscription extended after successful payment');
      } else {
        await markPaymentResult(parsed.checkoutRequestId, {
          status: parsed.resultCode === 1032 ? 'cancelled' : 'failed',
          resultDesc: parsed.resultDesc,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error processing payment callback');
    }
  });

  return router;
}

module.exports = { createClientRoutes, createPaymentCallbackRoute };
