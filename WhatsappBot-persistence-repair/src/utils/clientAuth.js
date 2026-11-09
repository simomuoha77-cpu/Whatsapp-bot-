const { getClientAccountByBotId } = require('../db/clientAccounts');

/**
 * Express middleware: blocks access to client dashboard routes unless
 * logged in as a client account (separate session namespace from the
 * platform admin login).
 *
 * Re-checks the session's botId against client_accounts on every request
 * (not just at login) so toggles and other actions can never silently act
 * on a stale or mismatched bot — if the account record is gone or the
 * session is out of sync, the client is logged out and asked to log back
 * in rather than continuing against the wrong bot.
 */
async function requireClientAuth(req, res, next) {
  if (!req.session || !req.session.clientBotId) return res.redirect('/client/login');

  try {
    const account = await getClientAccountByBotId(req.session.clientBotId);
    if (!account) {
      return req.session.destroy(() => res.redirect('/client/login'));
    }
    // Keep the session's phone number in sync with the account record.
    req.session.clientPhoneNumber = account.phone_number;
    return next();
  } catch (err) {
    return res.redirect('/client/login');
  }
}

module.exports = { requireClientAuth };
