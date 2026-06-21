const { register } = require('./registry');
const cron = require('node-cron');
const {
  createScheduledStatusPost,
  getAllScheduledStatusPosts,
  deactivateScheduledStatusPost,
} = require('../db/scheduledStatusPosts');
const {
  createReminder,
  getRemindersForUser,
  deactivateReminder,
} = require('../db/reminders');

function parseTargetJid(numberStr) {
  if (!numberStr) return null;
  const digits = numberStr.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function timeToCron(hhmm) {
  // Accepts "7:00" or "07:00" -> returns cron expression for daily at that time
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour > 23 || minute > 59) return null;
  return `${minute} ${hour} * * *`;
}

register('schedulestatus', {
  description:
    'Schedule a daily status post — usage: !schedulestatus <HH:MM> <caption text>',
  adminOnly: true,
  handler: async ({ reply, args, sender }) => {
    const time = args[0];
    const caption = args.slice(1).join(' ').trim();
    const cronExpr = timeToCron(time);

    if (!cronExpr || !caption) {
      await reply(
        `Usage: !schedulestatus <HH:MM> <caption text>\n\n` +
        `Example: !schedulestatus 07:00 Good morning! Have a great day ☀️\n\n` +
        `Note: this posts text-only. To post with an image, upload media to the ` +
        `server's downloads folder and use !schedulestatusmedia instead (see README).`
      );
      return;
    }

    const post = await createScheduledStatusPost({
      createdBy: sender,
      cronExpression: cronExpr,
      caption,
    });

    await reply(
      `✅ Scheduled daily status post (ID ${post.id}) at ${time}:\n"${caption}"\n\n` +
      `This will take effect after the bot restarts, or immediately on the next deploy. ` +
      `Use !liststatusposts to see all scheduled posts, !cancelstatuspost <id> to remove one.`
    );
  },
});

register('liststatusposts', {
  description: 'List all scheduled status posts (admin only)',
  adminOnly: true,
  handler: async ({ reply }) => {
    const posts = await getAllScheduledStatusPosts();
    if (posts.length === 0) {
      await reply('No scheduled status posts yet. Use !schedulestatus to create one.');
      return;
    }
    let text = `*Scheduled Status Posts*\n\n`;
    for (const p of posts) {
      text += `#${p.id} [${p.is_active ? 'active' : 'inactive'}] ${p.cron_expression}\n"${p.caption || '(media only)'}"\n\n`;
    }
    await reply(text.trim());
  },
});

register('cancelstatuspost', {
  description: 'Cancel a scheduled status post — usage: !cancelstatuspost <id>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const id = parseInt(args[0], 10);
    if (!id) {
      await reply('Usage: !cancelstatuspost <id> (use !liststatusposts to find the id)');
      return;
    }
    await deactivateScheduledStatusPost(id);
    await reply(`✅ Cancelled scheduled status post #${id}. Takes effect on next restart/deploy.`);
  },
});

register('remind', {
  description:
    'Schedule a reminder — usage: !remind <number> <HH:MM|YYYY-MM-DDTHH:MM> <message> [--notifyme]',
  adminOnly: true,
  handler: async ({ reply, args, sender }) => {
    const numberArg = args[0];
    const timeArg = args[1];
    const notifyMe = args.includes('--notifyme');
    const messageArgs = args.slice(2).filter((a) => a !== '--notifyme');
    const message = messageArgs.join(' ').trim();
    const jid = parseTargetJid(numberArg);

    if (!jid || !timeArg || !message) {
      await reply(
        `Usage: !remind <number> <time> <message> [--notifyme]\n\n` +
        `For a daily recurring reminder, use HH:MM, e.g.:\n` +
        `!remind 254712345678 08:00 Take your medicine\n\n` +
        `For a one-time reminder, use a full date/time, e.g.:\n` +
        `!remind 254712345678 2026-06-25T14:30 Meeting in 30 minutes\n\n` +
        `Add --notifyme at the end if you also want to be pinged when it's sent.`
      );
      return;
    }

    const dailyCron = timeToCron(timeArg);
    let reminder;

    if (dailyCron) {
      reminder = await createReminder({
        createdBy: sender,
        targetJid: jid,
        message,
        cronExpression: dailyCron,
        notifyAdmin: notifyMe,
      });
      await reply(`✅ Daily reminder set for ${jid} at ${timeArg}: "${message}"`);
    } else {
      const date = new Date(timeArg);
      if (isNaN(date.getTime())) {
        await reply('Could not parse the time. Use HH:MM for daily, or YYYY-MM-DDTHH:MM for a specific date/time.');
        return;
      }
      reminder = await createReminder({
        createdBy: sender,
        targetJid: jid,
        message,
        runAt: date.toISOString(),
        notifyAdmin: notifyMe,
      });
      await reply(`✅ One-time reminder set for ${jid} at ${date.toLocaleString()}: "${message}"`);
    }
  },
});

register('myreminders', {
  description: 'List active reminders for a user (admin only) — usage: !myreminders <number>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const jid = parseTargetJid(args[0]);
    if (!jid) {
      await reply('Usage: !myreminders <number>');
      return;
    }
    const reminders = await getRemindersForUser(jid);
    if (reminders.length === 0) {
      await reply(`No active reminders for ${jid}.`);
      return;
    }
    let text = `*Reminders for ${jid}*\n\n`;
    for (const r of reminders) {
      const when = r.cron_expression ? `daily (${r.cron_expression})` : new Date(r.run_at).toLocaleString();
      text += `#${r.id} — ${when}\n"${r.message}"\n\n`;
    }
    await reply(text.trim());
  },
});

register('cancelreminder', {
  description: 'Cancel a reminder — usage: !cancelreminder <id>',
  adminOnly: true,
  handler: async ({ reply, args }) => {
    const id = parseInt(args[0], 10);
    if (!id) {
      await reply('Usage: !cancelreminder <id> (use !myreminders <number> to find the id)');
      return;
    }
    await deactivateReminder(id);
    await reply(`✅ Cancelled reminder #${id}.`);
  },
});
