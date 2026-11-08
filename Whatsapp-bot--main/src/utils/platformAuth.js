const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

// Single platform-owner login, backed by env vars (simplest, no signup flow needed).
let cachedHash = null;

function getAdminUsername() {
  return process.env.PLATFORM_ADMIN_USERNAME || 'admin';
}

async function getPasswordHash() {
  if (cachedHash) return cachedHash;
  const plain = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!plain) {
    logger.warn('PLATFORM_ADMIN_PASSWORD is not set — dashboard login will reject all attempts.');
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

function requirePlatformAuth(req, res, next) {
  if (req.session && req.session.isPlatformAdmin) return next();
  if (req.path.startsWith('/admin/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/admin/login');
}

module.exports = { verifyCredentials, requirePlatformAuth, getAdminUsername };
