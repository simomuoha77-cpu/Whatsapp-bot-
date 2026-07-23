const express = require('express');
const QRCode = require('qrcode');
const { getBotBySlug } = require('../db/bots');
const { getBotState, requestPairingCodeForBot, startBotSocket } = require('../utils/botManager');

function layout(title, body) {
  return `
    <html>
      <head>
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; background: #0f0f0f; color: #eee; text-align: center; }
          input, button { font-size: 18px; padding: 10px; margin: 8px 0; width: 100%; box-sizing: border-box; background: #1c1c1c; color: #eee; border: 1px solid #333; border-radius: 8px; }
          button { background: #2563eb; color: white; cursor: pointer; border: none; }
          h1 { letter-spacing: 4px; font-size: 32px; }
          img { max-width: 100%; }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `;
}

function createOnboardingRoutes() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  router.get('/:slug', async (req, res) => {
    const bot = await getBotBySlug(req.params.slug);
    if (!bot) return res.status(404).send(layout('Not found', '<h2>This link is invalid or has expired.</h2>'));

    let state = getBotState(bot.id);

    // Same self-healing logic as the pairing code route: the socket should
    // already exist from bot creation, but that initial start is
    // fire-and-forget and can fail silently, leaving no state at all with
    // no visible error. If there's truly nothing running for this bot yet,
    // start it now instead of showing a dead end forever.
    if (!state) {
      try {
        const { onBotReady } = require('./botStartHook');
        await startBotSocket(bot.id, bot.slug, onBotReady);
        state = getBotState(bot.id);
      } catch (err) {
        return res.send(layout('Error', '<h2>Something went wrong starting your bot. Please try again in a moment.</h2>'));
      }
    }

    const status = state?.status || bot.status;

    if (status === 'connected') {
      return res.send(layout('Connected', '<h2>✅ Already connected!</h2><p>Your bot is up and running.</p>'));
    }

    if (state?.qr) {
      const qrImage = await QRCode.toDataURL(state.qr, { width: 280 });
      return res.send(layout('Scan to connect', `
        <head><meta http-equiv="refresh" content="20"></head>
        <h2>Scan with WhatsApp</h2>
        <p>Settings &rarr; Linked Devices &rarr; Link a Device</p>
        <img src="${qrImage}" />
        <p><a href="/connect/${bot.slug}/pair">Only one phone? Use a pairing code instead</a></p>
      `));
    }

    return res.send(layout('Connect your WhatsApp', `
      <h2>Connect your WhatsApp</h2>
      <p>Choose how you'd like to log in:</p>
      <p><a href="/connect/${bot.slug}/qr"><button>Scan QR Code</button></a></p>
      <p><a href="/connect/${bot.slug}/pair"><button>Use Pairing Code</button></a></p>
    `));
  });

  router.get('/:slug/qr', async (req, res) => {
    const bot = await getBotBySlug(req.params.slug);
    if (!bot) return res.status(404).send('Invalid link.');
    res.redirect(`/connect/${bot.slug}`);
  });

  router.get('/:slug/pair', async (req, res) => {
    const bot = await getBotBySlug(req.params.slug);
    if (!bot) return res.status(404).send(layout('Not found', '<h2>This link is invalid or has expired.</h2>'));

    const state = getBotState(bot.id);
    if (state?.status === 'connected') {
      return res.send(layout('Connected', '<h2>✅ Already connected!</h2>'));
    }

    if (state?.pairingCode) {
      return res.send(layout('Pairing code', `
        <head><meta http-equiv="refresh" content="15"></head>
        <h2>Your pairing code</h2>
        <h1>${state.pairingCode}</h1>
        <p>On WhatsApp: Settings &rarr; Linked Devices &rarr; Link a Device &rarr; Link with phone number instead<br/>then enter this code.</p>
      `));
    }

    return res.send(layout('Enter your number', `
      <h2>Enter your WhatsApp number</h2>
      <p>Digits only, with country code (e.g. 254712345678)</p>
      <form method="POST" action="/connect/${bot.slug}/pair">
        <input name="number" placeholder="254712345678" required />
        <button type="submit">Get pairing code</button>
      </form>
    `));
  });

  router.post('/:slug/pair', async (req, res) => {
    const bot = await getBotBySlug(req.params.slug);
    if (!bot) return res.status(404).send('Invalid link.');
    const digits = (req.body.number || '').replace(/[^0-9]/g, '');
    if (!digits) return res.status(400).send('Invalid phone number.');
    const ok = await requestPairingCodeForBot(bot.id, bot.slug, digits);
    if (!ok) {
      return res.send(layout('Error', `
        <h2>Something went wrong requesting a pairing code.</h2>
        <p><a href="/connect/${bot.slug}/pair">Try again</a></p>
      `));
    }
    res.send(layout('Requesting...', `
      <head><meta http-equiv="refresh" content="3;url=/connect/${bot.slug}/pair"></head>
      <h3>Requesting pairing code...</h3>
    `));
  });

  return router;
}

module.exports = { createOnboardingRoutes };
