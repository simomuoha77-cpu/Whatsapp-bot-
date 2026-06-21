// Loading these files runs their register() calls against the shared registry.
require('./menu');
require('./info');
require('./interactive');
require('./broadcast');
require('./moderation');
require('./order');
require('./faq');
require('./media');

module.exports = require('./registry');
