const express = require('express');
const QRCode = require('qrcode');
const { getStatus } = require('../whatsapp');

function createServer() {
  const app = express();

  app.get('/', (req, res) => {
    res.send('WhatsApp bot is running. Visit /qr to scan login QR code, or /health for status.');
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
      res.send('<h2>No QR code available right now. Refresh in a few seconds.</h2>');
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
          </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send('Failed to render QR code.');
    }
  });

  return app;
}

module.exports = { createServer };
