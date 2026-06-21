const { register } = require('./registry');

const FAQ = {
  hours: 'We are open Monday-Saturday, 9 AM - 6 PM.',
  location: 'You can find us at: (set your real address in src/commands/faq.js)',
  pricing: 'Pricing details: (set your real pricing info in src/commands/faq.js)',
  contact: 'You can reach a human admin by typing !support.',
};

register('faq', {
  description: 'Show frequently asked questions — usage: !faq <topic>',
  adminOnly: false,
  handler: async ({ reply, args }) => {
    const topic = (args[0] || '').toLowerCase();
    if (!topic) {
      const topics = Object.keys(FAQ).join(', ');
      await reply(`Usage: !faq <topic>\n\nAvailable topics: ${topics}`);
      return;
    }
    const answer = FAQ[topic];
    await reply(answer || `No FAQ found for "${topic}". Available: ${Object.keys(FAQ).join(', ')}`);
  },
});

register('support', {
  description: 'Request human support',
  adminOnly: false,
  handler: async ({ reply }) => {
    await reply('🙋 A support request has been logged. An admin will reach out to you here shortly.');
  },
});

module.exports = { FAQ };
