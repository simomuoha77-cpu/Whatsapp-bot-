const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

// Credentials come from env vars, set once by you in Render's dashboard.
// The password is stored as a bcrypt hash so it's never kept in plain text
// in memory longer than necessary, and never logged.
let cachedHash = null;

function getAdminUsername() {
  return process.env.DASHBOARD_USERNAME || 'admin';
}

async function getPasswordHash() {
  if (cachedHash) return cachedHash;
  const plain = process.env.DASHBOARD_PASSWORD;
  if (!plain) {
    logger.warn('DASHBOARD_PASSWORD is not set — dashboard login will reject all attempts.');
    return null;
  }
  cachedHash = await bcrypt.hash(plain, 10);
  return cachedHash;
}

async function verifyCredentials(username, password) {
  const expectedUsername = getAdminUsername();
  const hash = await getPasswordHash();
  if (!hash) return false;
  if (username !== expectedUsername) return false;
  return bcrypt.compare(password || '', hash);
}

/**
 * Express middleware: blocks access unless the session is authenticated.
 * Redirects HTML requests to /dashboard/login; returns 401 JSON for API calls.
 */
function requireDashboardAuth(req, res, next) {
  if (req.session && req.session.isDashboardAdmin) {
    return next();
  }
  if (req.path.startsWith('/dashboard/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/dashboard/login');
}

module.exports = { verifyCredentials, requireDashboardAuth, getAdminUsername };
