const express = require('express');
const QRCode = require('qrcode');
const { getStatus, requestPairingCode } = require('./whatsapp');

function createServer() {
  const app = express();

  app.get('/', (req, res) => {
    res.send('WhatsApp bot is running. Visit /qr to scan login QR code, /pair to log in with a phone number instead, or /health for status.');
  });

  app.get('/health', (req, res) => {
    const { status } = getStatus();
    res.json({ ok: true, whatsapp_status: status, uptime_seconds: process.uptime() });
  });

  app.get('/qr', async (req, res) => {
    const { status, qr } = getStatus();
    if (status === 'connected') {
      res.send('<h2>✅ Already connected to WhatsApp.</h2>');
      return;
    }
    if (!qr) {
      res.send('<h2>No QR code available right now.</h2><p>Refresh in a few seconds, or use <a href="/pair">/pair</a> to log in with your phone number instead.</p>');
      return;
    }
    try {
      const qrImageDataUrl = await QRCode.toDataURL(qr, { width: 320 });
      res.send(`
        <html>
          <head><meta http-equiv="refresh" content="20"></head>
          <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;">
            <h2>Scan with WhatsApp &rarr; Linked Devices</h2>
            <img src="${qrImageDataUrl}" alt="QR Code" />
            <p>This page refreshes automatically every 20 seconds.</p>
            <p>Only one phone? Use <a href="/pair">/pair</a> instead.</p>
          </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send('Failed to render QR code.');
    }
  });

  app.get('/pair', (req, res) => {
    const { status, pairingCode } = getStatus();
    if (status === 'connected') {
      res.send('<h2>✅ Already connected to WhatsApp.</h2>');
      return;
    }
    if (pairingCode) {
      res.send(`
        <html>
          <head><meta http-equiv="refresh" content="15"></head>
          <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;">
            <h2>Your pairing code:</h2>
            <h1 style="letter-spacing:4px;">${pairingCode}</h1>
            <p>On WhatsApp: Settings &rarr; Linked Devices &rarr; Link a Device &rarr; Link with phone number instead<br>then enter this code.</p>
            <p>This page refreshes every 15 seconds.</p>
          </body>
        </html>
      `);
      return;
    }
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;">
          <h2>Enter the phone number to link</h2>
          <p>Digits only, with country code (e.g. 254712345678).</p>
          <form action="/pair/request" method="get">
            <input type="text" name="number" placeholder="254712345678" style="font-size:18px;padding:8px;" required />
            <button type="submit" style="font-size:18px;padding:8px;">Get pairing code</button>
          </form>
        </body>
      </html>
    `);
  });

  app.get('/pair/request', (req, res) => {
    const number = (req.query.number || '').replace(/[^0-9]/g, '');
    if (!number) {
      res.status(400).send('Please provide a valid phone number with country code, digits only.');
      return;
    }
    requestPairingCode(number);
    res.send('<h3>Requesting pairing code...</h3><meta http-equiv="refresh" content="3;url=/pair">');
  });

  return app;
}

module.exports = { createServer };
