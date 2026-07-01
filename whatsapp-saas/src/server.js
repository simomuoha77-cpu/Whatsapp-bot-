const express = require('express');
const session = require('express-session');
const logger = require('./utils/logger');
const { createAdminRoutes } = require('./handlers/admin');
const { createOnboardingRoutes } = require('./handlers/onboarding');
const { createClientRoutes, createPaymentCallbackRoute } = require('./handlers/client');

function createServer() {
  const app = express();

  app.set('trust proxy', 1);

  // Safaricom's payment callback is called directly by Daraja's servers,
  // not a logged-in browser — it must work without any session, and
  // must be mounted before the session-requiring routes below.
  app.use('/client', createPaymentCallbackRoute());

  if (!process.env.SESSION_SECRET) {
    logger.warn('SESSION_SECRET is not set — sessions reset every restart. Set it in production.');
  }

  app.use(session({
    secret: process.env.SESSION_SECRET || `dev-secret-${Date.now()}`,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  }));

  app.use('/admin', createAdminRoutes());
  app.use('/connect', createOnboardingRoutes());
  app.use('/client', createClientRoutes());

  app.get('/', (req, res) => {
    res.send('Multi-tenant WhatsApp bot platform. Visit /admin to manage clients, or /client/register to sign up for a bot.');
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, uptime_seconds: process.uptime() });
  });

  return app;
}

module.exports = { createServer };
