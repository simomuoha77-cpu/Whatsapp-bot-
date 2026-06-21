// Loading these files runs their register() calls against the shared registry.
require('./menu');
require('./info');
require('./interactive');
require('./broadcast');
require('./moderation');
require('./order');
require('./faq');
require('./media');
require('./features');
require('./scheduling');

module.exports = require('./registry');
