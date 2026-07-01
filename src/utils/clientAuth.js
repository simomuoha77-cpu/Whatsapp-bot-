const { getClientAccountByBotId } = require('../db/clientAccounts');

function requireClientAuth(req, res, next) {
  if (!req.session || !req.session.clientBotId) return res.redirect('/client/login');

  getClientAccountByBotId(req.session.clientBotId)
    .then((account) => {
      if (!account) {
        return req.session.destroy(() => res.redirect('/client/login'));
      }
      req.session.clientPhoneNumber = account.phone_number;
      next();
    })
    .catch(() => res.redirect('/client/login'));
}

module.exports = { requireClientAuth };
