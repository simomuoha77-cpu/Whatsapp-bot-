// Turns the output of <input type="time"> (always "HH:MM", 24h) and an
// optional <input type="date"> (always "YYYY-MM-DD") into either a daily
// cron expression or a one-off run_at timestamp.
//
// Returns { cronExpression } | { runAt } | { error }.
function resolveSchedule(time, date) {
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
  if (!timeMatch) {
    return { error: 'Please pick a time.' };
  }

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);

  const trimmedDate = (date || '').trim();
  if (!trimmedDate) {
    return { cronExpression: `${minute} ${hour} * * *` };
  }

  const runAt = new Date(`${trimmedDate}T${time}`);
  if (isNaN(runAt.getTime())) {
    return { error: 'That date/time doesn\'t look valid.' };
  }
  if (runAt.getTime() <= Date.now()) {
    return { error: 'That date/time is in the past — pick one in the future.' };
  }
  return { runAt: runAt.toISOString() };
}

module.exports = { resolveSchedule };
