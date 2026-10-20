'use strict';
/**
 * Group-invite workflow core (no Express / DB imports so it is unit-testable).
 * Used by BOTH the preview and start endpoints via computeEligibility().
 */
const { compareGroups, formatStats, maskJid } = require('./groupParticipants');

const BATCH_LIMIT = 50;
const RECHECK_EVERY = 10;
const GROUP_JID_RE = /^[0-9]+(-[0-9]+)?@g\.us$/;

class GroupInviteError extends Error {
  constructor(code, message, httpStatus = 500) { super(message); this.code = code; this.httpStatus = httpStatus; }
}

function validateGroupIds(sourceId, destinationId) {
  const s = typeof sourceId === 'string' ? sourceId.trim().toLowerCase() : '';
  const d = typeof destinationId === 'string' ? destinationId.trim().toLowerCase() : '';
  if (!GROUP_JID_RE.test(s) || !GROUP_JID_RE.test(d)) throw new GroupInviteError('BAD_GROUP_ID', 'Choose two valid groups.', 400);
  if (s === d) throw new GroupInviteError('SAME_GROUP', 'Choose two different groups.', 400);
  return { sourceId: s, destinationId: d };
}

/** Use a LID->PN mapping only if this Baileys build actually exposes one. */
function getLidResolver(sock) {
  const store = sock && sock.signalRepository && sock.signalRepository.lidMapping;
  if (store && typeof store.getPNForLIDSync === 'function') return (lid) => store.getPNForLIDSync(lid);
  return null; // no verified mapping available -> LID-only members stay unresolved
}

/**
 * Fresh lookup + comparison. Throws GroupInviteError with a real cause; a
 * genuinely empty group is returned as counts of 0 with sourceEmpty=true.
 */
async function computeEligibility({ sock, sourceId, destinationId, logger, limit = BATCH_LIMIT }) {
  if (!sock) throw new GroupInviteError('NOT_CONNECTED', 'Connect your WhatsApp bot first.', 409);
  let all;
  try { all = await sock.groupFetchAllParticipating(); }
  catch (err) {
    logger && logger.warn({ err: err && err.message }, 'groupFetchAllParticipating failed');
    throw new GroupInviteError('LOOKUP_FAILED', 'WhatsApp group lookup failed: ' + ((err && err.message) || 'unknown error'), 502);
  }
  const source = all && all[sourceId], destination = all && all[destinationId];
  if (!source || !destination) throw new GroupInviteError('GROUP_NOT_FOUND', 'Both groups must be present in the connected bot\'s current group list.', 404);
  if (!Array.isArray(source.participants) || !Array.isArray(destination.participants)) {
    throw new GroupInviteError('PARTICIPANTS_UNAVAILABLE', 'WhatsApp did not return a participant list for one of the groups. This is a lookup failure, not an empty group.', 502);
  }
  const selfIds = [sock.user && sock.user.id, sock.user && sock.user.lid].filter(Boolean);
  const cmp = compareGroups(source.participants, destination.participants, { resolveLid: getLidResolver(sock), selfIds });
  const diagnostics = { source: formatStats(source.participants), destination: formatStats(destination.participants), lidMappingAvailable: !!getLidResolver(sock) };
  logger && logger.info({ sourceId: maskJid(sourceId), destinationId: maskJid(destinationId), counts: { ...cmp, eligibleJids: undefined }, diagnostics }, 'Group invite eligibility computed');
  const selected = cmp.eligibleJids.slice(0, limit);
  return { ...cmp, selected, selectedForRun: selected.length, skippedBatchLimit: Math.max(0, cmp.eligible - selected.length), batchLimit: limit, sourceEmpty: source.participants.length === 0, diagnostics };
}

/** Map a groupParticipantsUpdate() per-member entry to an outcome. */
function classifyUpdateEntry(entry) {
  const code = String(entry && entry.status !== undefined ? entry.status : '');
  if (code === '200') return 'added';
  if (code === '409') return 'alreadyInDestination';
  if (code === '403' || code === '401') return 'privacyBlocked'; // privacy / invite-only / blocked
  return 'failed'; // 408 (recently left), 5xx, missing entry, anything unconfirmed
}

/** Map a thrown error to a job-level outcome. */
function classifyThrown(err) {
  const msg = String((err && (err.message || (err.data && err.data.message))) || '').toLowerCase();
  const status = Number((err && err.output && err.output.statusCode) || (err && err.data) || 0);
  if (status === 429 || /rate-overlimit|rate limit|too many/.test(msg)) return 'rateLimited';
  if (status === 403 || /not-authorized|forbidden|not an admin|admin/.test(msg)) return 'permissionBlocked';
  return 'failed';
}

function newCounters() {
  return { added: 0, alreadyInDestination: 0, skipped: 0, unresolved: 0, privacyBlocked: 0, permissionBlocked: 0, failed: 0, rateLimited: 0 };
}

/**
 * Run a job. deps: { getSock(), persist(job), sleep(ms), logger }.
 * Stops (no retries) on disconnect, permission error or rate limit.
 */
async function runJob(job, { getSock, persist, sleep, logger, delayMs = 1000 }) {
  job.status = 'running';
  await persist(job);
  const queue = job.targets;
  let stop = null;
  for (let i = 0; i < queue.length; i++) {
    const jid = queue[i];
    const sock = getSock();
    if (!sock) { stop = 'disconnected'; break; }
    try {
      if (i % RECHECK_EVERY === 0) { // re-check destination membership; failure here is non-fatal (409 handles duplicates)
        try {
          const meta = await sock.groupMetadata(job.destinationId);
          const cmp = compareGroups([{ id: jid }], meta.participants || [], { resolveLid: getLidResolver(sock) });
          if (cmp.alreadyInDestination) { job.alreadyInDestination++; job.processed++; await persist(job); continue; }
        } catch (e) { logger && logger.warn({ err: e && e.message }, 'Destination re-check failed; relying on WhatsApp response'); }
      }
      const res = await sock.groupParticipantsUpdate(job.destinationId, [jid], 'add');
      const outcome = classifyUpdateEntry(Array.isArray(res) ? res[0] : null);
      job[outcome]++;
      if (outcome !== 'added') logger && logger.info({ jid: maskJid(jid), outcome, code: Array.isArray(res) && res[0] ? res[0].status : null }, 'Group add not confirmed');
    } catch (err) {
      const outcome = classifyThrown(err);
      logger && logger.warn({ jid: maskJid(jid), outcome, err: err && err.message }, 'Group add threw');
      if (outcome === 'rateLimited') { job.rateLimited++; job.processed++; stop = 'rate_limited'; break; }
      if (outcome === 'permissionBlocked') { job.permissionBlocked++; job.processed++; stop = 'no_permission'; break; }
      job.failed++;
    }
    job.processed++;
    await persist(job);
    await sleep(delayMs);
  }
  if (stop) { // members never attempted are not reported as added/failed-by-WhatsApp
    job.notAttempted = job.total - job.processed;
    job.stoppedReason = stop;
    job.status = stop === 'disconnected' ? 'failed' : 'stopped';
  } else job.status = 'completed';
  job.finishedAt = new Date().toISOString();
  await persist(job);
  return job;
}

function publicJob(job) {
  const failedTotal = job.privacyBlocked + job.permissionBlocked + job.failed + job.rateLimited;
  return {
    jobId: job.jobId, status: job.status, stoppedReason: job.stoppedReason || null,
    total: job.total, processed: job.processed, notAttempted: job.notAttempted || 0,
    added: job.added, alreadyInDestination: job.alreadyInDestination,
    skipped: job.skipped, unresolved: job.unresolved,
    privacyBlocked: job.privacyBlocked, permissionBlocked: job.permissionBlocked,
    rateLimited: job.rateLimited, failed: job.failed, failedTotal,
  };
}

function createJob({ jobId, botId, sourceId, destinationId, elig }) {
  return { jobId, botId, sourceId, destinationId, targets: elig.selected.slice(), total: elig.selected.length, processed: 0,
    ...newCounters(), skipped: elig.skippedBatchLimit, unresolved: elig.unresolved, notAttempted: 0, status: 'queued', createdAt: new Date().toISOString() };
}

module.exports = { BATCH_LIMIT, GroupInviteError, validateGroupIds, computeEligibility, classifyUpdateEntry, classifyThrown, runJob, publicJob, createJob, getLidResolver };
