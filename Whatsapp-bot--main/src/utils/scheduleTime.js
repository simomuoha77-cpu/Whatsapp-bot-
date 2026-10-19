const { DateTime } = require('luxon');

// Turns the output of <input type="time"> (always "HH:MM", 24h) and an
// optional <input type="date"> (always "YYYY-MM-DD") into either a daily
// cron expression or a one-off run_at UTC timestamp — correctly accounting
// for the browser's timezone, not the server's.
//
// Without this, "07:20" typed on a phone in (say) Nairobi gets interpreted
// as 07:20 on the server's clock (usually UTC on Render), which is a
// completely different real-world moment — the post fires, just not when
// anyone's watching, so it looks like nothing happened at all.
//
// Returns { cronExpression, timezone } | { runAt } | { error }.
function resolveSchedule(time, date, timezone) {
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
  if (!timeMatch) {
    return { error: 'Please pick a time.' };
  }

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const zone = (timezone || '').trim() || 'UTC';

  // Validate the timezone the browser sent us — an unrecognized zone would
  // otherwise silently fall back to something wrong.
  if (!DateTime.local().setZone(zone).isValid) {
    return { error: 'Could not detect your timezone — try reloading the page.' };
  }

  const trimmedDate = (date || '').trim();
  if (!trimmedDate) {
    // Recurring daily: cron itself runs the hour/minute numbers as given,
    // so the caller must schedule this with { timezone: zone } — that's
    // what actually makes "07:20" mean the poster's 07:20, every day,
    // even across DST changes.
    return { cronExpression: `${minute} ${hour} * * *`, timezone: zone };
  }

  const local = DateTime.fromFormat(`${trimmedDate} ${time}`, 'yyyy-MM-dd HH:mm', { zone });
  if (!local.isValid) {
    return { error: 'That date/time doesn\'t look valid.' };
  }
  if (local.toMillis() <= Date.now()) {
    return { error: 'That date/time is in the past — pick one in the future.' };
  }
  return { runAt: local.toUTC().toISO() };
}

module.exports = { resolveSchedule };
