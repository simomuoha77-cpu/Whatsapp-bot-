/**
 * Express middleware: blocks access to client dashboard routes unless
 * logged in as a client account (separate session namespace from the
 * platform admin login).
 */
function requireClientAuth(req, res, next) {
  if (req.session && req.session.clientBotId) return next();
  return res.redirect('/client/login');
}

module.exports = { requireClientAuth };
