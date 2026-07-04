const express = require('express');
const crypto = require('crypto');
const { requireClientAuth } = require('../utils/clientAuth');
const { createBot, getBotById } = require('../db/bots');
const { createClientAccount, verifyClientLogin, getClientAccountByPhone, getClientAccountByBotId } = require('../db/clientAccounts');
const { startTrial, getSubscription, isSubscriptionActive, extendSubscription } = require('../db/subscriptions');
const { getPricingSettings } = require('../db/pricingSettings');
const { createPaymentRecord, getPaymentByCheckoutId, markPaymentResult, getPaymentsForBot } = require('../db/payments');
const { initiateStkPush, parseStkCallback } = require('../utils/daraja');
const { startBotSocket, getBotState, deleteBotSession } = require('../utils/botManager');
const { query } = require('../db/pool');
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
const { getAllKeywordResponses, addKeywordResponse, deleteKeywordResponse } = require('../db/keywordResponses');
const { recordOwnStatusPost, getRecentPostsWithViewers } = require('../db/ownStatusPosts');
const logger = require('../utils/logger');

function layout(title, body) {
  return `
    <html>
      <head>
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 20px auto; padding: 0 16px; background: #0f0f0f; color: #eee; }
          a { color: #4da6ff; }
          input, button, select { font-size: 16px; padding: 10px; margin: 6px 0; width: 100%; box-sizing: border-box; background: #1c1c1c; color: #eee; border: 1px solid #333; border-radius: 8px; }
          button { background: #2563eb; color: white; cursor: pointer; border: none; }
          .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
          .pill { padding: 2px 10px; border-radius: 12px; font-size: 13px; }
          .on { background: #14532d; color: #4ade80; }
          .off { background: #450a0a; color: #f87171; }
          .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #2a2a2a; }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `;
}

function createClientRoutes() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  router.get('/register', (req, res) => {
    const error = req.query.error ? `<p style="color:#f87171;">${req.query.error}</p>` : '';
    res.send(layout('Register', `
      <h2>Create Your Account</h2>
      ${error}
      <p>Register once with the WhatsApp number you'll connect your bot to. This number gets a free trial — it can't be reused for another trial later.</p>
      <form method="POST" action="/client/register">
        <input name="phoneNumber" placeholder="Phone number (e.g. 254712345678)" required />
        <input name="password" type="password" placeholder="Choose a password" required minlength="6" />
        <button type="submit">Register</button>
      </form>
      <p>Already registered? <a href="/client/login">Log in</a></p>
    `));
  });

  router.post('/register', async (req, res) => {
    const digits = (req.body.phoneNumber || '').replace(/[^0-9]/g, '');
    const password = req.body.password || '';

    if (!digits || password.length < 6) {
      return res.redirect('/client/register?error=' + encodeURIComponent('Enter a valid number and a password of at least 6 characters.'));
    }

    const existing = await getClientAccountByPhone(digits);
    if (existing) {
      return res.redirect('/client/register?error=' + encodeURIComponent('This number is already registered. Please log in instead.'));
    }

    const bot = await createBot(digits);
    await startTrial(bot.id);
    await createClientAccount(bot.id, digits, password);

    const { onBotReady } = require('./botStartHook');
    startBotSocket(bot.id, bot.slug, onBotReady).catch((err) =>
      logger.error({ err, botId: bot.id }, 'Failed to start bot socket on client registration')
    );

    req.session.clientBotId = bot.id;
    req.session.clientPhoneNumber = digits;
    res.redirect(`/connect/${bot.slug}`);
  });

  router.get('/login', (req, res) => {
    if (req.session && req.session.clientBotId) return res.redirect('/client/dashboard');
    const error = req.query.error ? '<p style="color:#f87171;">Invalid phone number or password.</p>' : '';
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

    const featureRows = FEATURE_COLUMNS.map((col) => `
      <div class="row">
        <span>${FEATURE_LABELS[col]}</span>
        <form method="POST" action="/client/settings/toggle" style="width:auto;display:flex;gap:8px;align-items:center;">
          <input type="hidden" name="feature" value="${col}" />
          <span class="pill ${features[col] ? 'on' : 'off'}">${features[col] ? 'ON' : 'OFF'}</span>
          <button type="submit" style="width:auto;">Toggle</button>
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
      <div class="card">
        <p><span class="pill ${active ? 'on' : 'off'}">${active ? 'ACTIVE' : 'EXPIRED'}</span></p>
        <p>${statusText}</p>
      </div>

      <div class="card">
        <h3>📱 WhatsApp Connection</h3>
        <p><span class="pill ${connectionStatus === 'connected' ? 'on' : 'off'}">${connectionStatus.toUpperCase()}</span></p>
        ${connectionStatus === 'connected' ? `
          <p><small>Your WhatsApp is linked. If you ever unlink this device from WhatsApp (Settings → Linked Devices), come back here and tap the button below to get a fresh link to reconnect.</small></p>
        ` : `
          <p><small>Your bot isn't connected right now. Use the link below to scan a QR code or enter a pairing code with the same WhatsApp number you registered with.</small></p>
        `}
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

      <p><a href="/client/logout">Log out</a></p>
    `));
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
      const sent = await live.sock.sendMessage('status@broadcast', { text: caption });
      if (sent?.key?.id) {
        await recordOwnStatusPost(botId, sent.key.id, { source: 'manual', caption });
      }
    } catch (err) {
      logger.error({ err, botId }, 'Failed to post manual status from client dashboard');
    }
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
    await query('UPDATE bots SET slug = $1, status = $2 WHERE id = $3', [newSlug, 'pending', botId]);
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
      const current = await getFeatures(botId);
      await setFeature(botId, feature, !current[feature]);
    }
    res.redirect('/client/dashboard');
  });

  router.post('/settings/stealth-mode', async (req, res) => {
    const botId = req.session.clientBotId;
    const mode = req.body.mode;
    if (STEALTH_READ_MODES.includes(mode)) {
      await setStealthReadMode(botId, mode);
      // NOTE: We do NOT touch sock.updateReadReceiptsPrivacy() here. That's
      // the account-wide WhatsApp privacy setting that also controls status
      // view visibility (see botManager.js) — it's intentionally always
      // kept 'all' regardless of this mode, since Stealth/No-Mark is only
      // meant to affect per-message read receipts, not status views.
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
