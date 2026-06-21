const { register } = require('./registry');

register('sticker', {
  description: 'Reply to an image with !sticker to convert it (requires sharp/wa-sticker-formatter to fully implement)',
  adminOnly: false,
  handler: async ({ reply }) => {
    await reply(
      'Sticker conversion needs the image you want converted. Send an image with the caption "!sticker", ' +
      'or reply to an image with "!sticker". (Hook this up to `wa-sticker-formatter` for full conversion.)'
    );
  },
});

register('echo', {
  description: 'Echoes back whatever text you send after the command',
  adminOnly: false,
  handler: async ({ reply, args }) => {
    const text = args.join(' ');
    await reply(text || 'Nothing to echo — try: !echo hello');
  },
});
