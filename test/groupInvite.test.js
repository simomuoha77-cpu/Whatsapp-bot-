'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { compareGroups, classifyId, formatStats } = require('../src/utils/groupParticipants');
const gi = require('../src/utils/groupInvite');

const pn = (n) => n + '@s.whatsapp.net';
const lid = (n) => n + '@lid';

// ---- Test A: participant matching ----
test('A: PN match in both groups', () => {
  const r = compareGroups([{ id: pn('254700000001') }, { id: pn('254700000002') }], [{ id: pn('254700000001') }]);
  assert.strictEqual(r.alreadyInDestination, 1); assert.strictEqual(r.eligible, 1);
  assert.deepStrictEqual(r.eligibleJids, [pn('254700000002')]);
});
test('A: LID with verified mapping matches destination PN', () => {
  const map = { [lid('111111')]: pn('254700000003') };
  const r = compareGroups([{ id: lid('111111') }], [{ id: pn('254700000003') }], { resolveLid: (l) => map[l] });
  assert.strictEqual(r.alreadyInDestination, 1); assert.strictEqual(r.eligible, 0); assert.strictEqual(r.unresolved, 0);
});
test('A: same LID in both groups = already in destination even without mapping', () => {
  const r = compareGroups([{ id: lid('222222') }], [{ id: lid('222222') }]);
  assert.strictEqual(r.alreadyInDestination, 1); assert.strictEqual(r.unresolved, 0);
});
test('A: record carrying both lid and phoneNumber links the two namespaces', () => {
  const r = compareGroups([{ id: lid('333333'), phoneNumber: pn('254700000004') }], [{ id: pn('254700000004') }]);
  assert.strictEqual(r.alreadyInDestination, 1);
});
test('A: LID-only without mapping is unresolved, never eligible, never assumed equal to a PN', () => {
  const r = compareGroups([{ id: lid('444444') }], [{ id: pn('444444') }]);
  assert.strictEqual(r.eligible, 0); assert.strictEqual(r.unresolved, 1); assert.strictEqual(r.alreadyInDestination, 0);
  assert.deepStrictEqual(r.eligibleJids, []);
});
test('A: duplicates, device suffixes and malformed ids', () => {
  const r = compareGroups([
    { id: pn('254700000005') }, { id: '254700000005:7@s.whatsapp.net' }, { jid: '+254700000005' },
    { id: 'garbage' }, {}, null, { id: '' }, { id: pn('12') },
  ], []);
  assert.strictEqual(r.eligible, 1); assert.strictEqual(r.duplicatesIgnored, 2); assert.strictEqual(r.malformed, 5);
  assert.strictEqual(r.sourceCount, 8);
});
test('A: self is excluded', () => {
  const r = compareGroups([{ id: pn('254700000006') }], [], { selfIds: ['254700000006:3@s.whatsapp.net'] });
  assert.strictEqual(r.eligible, 0); assert.strictEqual(r.selfExcluded, 1);
});
test('A: classifyId never converts lid to pn', () => {
  assert.deepStrictEqual(classifyId('123456@lid'), { type: 'lid', key: '123456@lid' });
  assert.strictEqual(classifyId('abc@s.whatsapp.net'), null);
});

// ---- Test B: group comparison with known overlap ----
test('B: known overlap', () => {
  const src = [], dst = [];
  for (let i = 0; i < 100; i++) src.push({ id: pn(String(254710000000 + i)) });
  for (let i = 0; i < 30; i++) src.push({ id: lid(String(900000 + i)) });          // unresolved
  for (let i = 0; i < 40; i++) dst.push({ id: pn(String(254710000000 + i)) });     // overlap = 40
  for (let i = 0; i < 20; i++) dst.push({ id: pn(String(254720000000 + i)) });     // dest-only
  const r = compareGroups(src, dst);
  assert.strictEqual(r.alreadyInDestination, 40); assert.strictEqual(r.eligible, 60);
  assert.strictEqual(r.unresolved, 30); assert.strictEqual(r.sourceCount, 130);
  assert.strictEqual(r.alreadyInDestination + r.eligible + r.unresolved, 130);
});

// ---- Helpers for D / E ----
function mockSock({ src, dst, updateImpl, fetchFail } = {}) {
  const calls = [];
  return {
    calls, user: { id: '254799999999:1@s.whatsapp.net' },
    groupFetchAllParticipating: async () => { if (fetchFail) throw new Error('boom'); return { '1@g.us': { id: '1@g.us', participants: src }, '2@g.us': { id: '2@g.us', participants: dst } }; },
    groupMetadata: async () => ({ participants: dst }),
    groupParticipantsUpdate: async (g, jids, act) => { calls.push([g, jids, act]); return updateImpl ? updateImpl(jids[0], calls.length) : [{ status: '200', jid: jids[0] }]; },
  };
}
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: pn(String(254730000000 + i)) }));
const run = async (sock, elig) => {
  const job = gi.createJob({ jobId: 'j', botId: 'b', sourceId: '1@g.us', destinationId: '2@g.us', elig });
  await gi.runJob(job, { getSock: () => sock, persist: async () => {}, sleep: async () => {}, logger: null });
  return job;
};

// ---- Test D: automatic workflow ----
test('D: eligibility auto-computed, 50 limit applied, queue prepared with no manual selection', async () => {
  const sock = mockSock({ src: many(80), dst: many(10) });
  const e = await gi.computeEligibility({ sock, sourceId: '1@g.us', destinationId: '2@g.us' });
  assert.strictEqual(e.alreadyInDestination, 10); assert.strictEqual(e.eligible, 70);
  assert.strictEqual(e.selectedForRun, 50); assert.strictEqual(e.skippedBatchLimit, 20);
  const job = await run(sock, e);
  assert.strictEqual(job.added, 50); assert.strictEqual(job.status, 'completed');
  assert.ok(sock.calls.every(c => c[2] === 'add' && c[0] === '2@g.us'));
});
test('D: group id validation', () => {
  assert.throws(() => gi.validateGroupIds('x', 'y'), { code: 'BAD_GROUP_ID' });
  assert.throws(() => gi.validateGroupIds('1@g.us', '1@g.us'), { code: 'SAME_GROUP' });
  assert.deepStrictEqual(gi.validateGroupIds('1@g.us', '2@g.us'), { sourceId: '1@g.us', destinationId: '2@g.us' });
});

// ---- Test E: error handling ----
test('E: lookup failure is an error, not zero counts', async () => {
  await assert.rejects(gi.computeEligibility({ sock: mockSock({ fetchFail: true }), sourceId: '1@g.us', destinationId: '2@g.us' }), { code: 'LOOKUP_FAILED' });
});
test('E: disconnected session', async () => {
  await assert.rejects(gi.computeEligibility({ sock: null, sourceId: '1@g.us', destinationId: '2@g.us' }), { code: 'NOT_CONNECTED' });
});
test('E: stale/missing group', async () => {
  await assert.rejects(gi.computeEligibility({ sock: mockSock({ src: [], dst: [] }), sourceId: '9@g.us', destinationId: '2@g.us' }), { code: 'GROUP_NOT_FOUND' });
});
test('E: missing participant array is failure; genuinely empty is not', async () => {
  const bad = mockSock({ src: undefined, dst: [] });
  await assert.rejects(gi.computeEligibility({ sock: bad, sourceId: '1@g.us', destinationId: '2@g.us' }), { code: 'PARTICIPANTS_UNAVAILABLE' });
  const empty = await gi.computeEligibility({ sock: mockSock({ src: [], dst: many(3) }), sourceId: '1@g.us', destinationId: '2@g.us' });
  assert.strictEqual(empty.sourceEmpty, true); assert.strictEqual(empty.eligible, 0);
});
test('E: mixed per-member outcomes are counted separately; nothing false-positive', async () => {
  const codes = ['200', '403', '409', '408', '401', undefined];
  const sock = mockSock({ src: many(6), dst: [], updateImpl: (j, n) => codes[n - 1] === undefined ? [] : [{ status: codes[n - 1], jid: j }] });
  const e = await gi.computeEligibility({ sock, sourceId: '1@g.us', destinationId: '2@g.us' });
  const job = await run(sock, e);
  assert.strictEqual(job.added, 1); assert.strictEqual(job.privacyBlocked, 2);
  assert.strictEqual(job.alreadyInDestination, 1); assert.strictEqual(job.failed, 2);
  assert.strictEqual(job.processed, 6); assert.strictEqual(sock.calls.length, 6); // no retries
});
test('E: permission error stops the job, no retry, remainder not attempted', async () => {
  const sock = mockSock({ src: many(5), dst: [], updateImpl: () => { const e = new Error('not-authorized'); e.output = { statusCode: 403 }; throw e; } });
  const e = await gi.computeEligibility({ sock, sourceId: '1@g.us', destinationId: '2@g.us' });
  const job = await run(sock, e);
  assert.strictEqual(job.status, 'stopped'); assert.strictEqual(job.permissionBlocked, 1);
  assert.strictEqual(job.added, 0); assert.strictEqual(sock.calls.length, 1); assert.strictEqual(job.notAttempted, 4);
});
test('E: rate limit stops the job', async () => {
  const sock = mockSock({ src: many(5), dst: [], updateImpl: () => { const e = new Error('rate-overlimit'); throw e; } });
  const e = await gi.computeEligibility({ sock, sourceId: '1@g.us', destinationId: '2@g.us' });
  const job = await run(sock, e);
  assert.strictEqual(job.stoppedReason, 'rate_limited'); assert.strictEqual(sock.calls.length, 1); assert.strictEqual(job.added, 0);
});
test('E: disconnect mid-job marks failed, does not claim success', async () => {
  const sock = mockSock({ src: many(4), dst: [] });
  const e = await gi.computeEligibility({ sock, sourceId: '1@g.us', destinationId: '2@g.us' });
  const job = gi.createJob({ jobId: 'j', botId: 'b', sourceId: '1@g.us', destinationId: '2@g.us', elig: e });
  let n = 0;
  await gi.runJob(job, { getSock: () => (n++ < 2 ? sock : null), persist: async () => {}, sleep: async () => {}, logger: null });
  assert.strictEqual(job.status, 'failed'); assert.strictEqual(job.stoppedReason, 'disconnected');
  assert.ok(job.added <= 2); assert.strictEqual(job.notAttempted, 4 - job.processed);
});
test('E: unresolved identities are never queued', async () => {
  const sock = mockSock({ src: [{ id: lid('555555') }, { id: pn('254700000009') }], dst: [] });
  const e = await gi.computeEligibility({ sock, sourceId: '1@g.us', destinationId: '2@g.us' });
  assert.strictEqual(e.unresolved, 1); assert.deepStrictEqual(e.selected, [pn('254700000009')]);
});

// ---- Test F (part): the inline page script must be valid JS, and diagnostics must not leak ids ----
test('F: group-invites page script parses', () => {
  const src = fs.readFileSync(__dirname + '/../src/handlers/client.js', 'utf8');
  const m = src.match(/router\.get\('\/group-invites'[\s\S]*?<script>([\s\S]*?)<\/script>/);
  assert.ok(m); new vm.Script(m[1]);
  assert.ok(!/targetJids|type="checkbox"[^>]*member/i.test(m[0]));
});
test('F: formatStats contains only counts', () => {
  const s = formatStats([{ id: pn('254700000001') }, { id: lid('1234567') }]);
  assert.ok(Object.values(s).every(v => typeof v === 'number'));
  assert.strictEqual(s.idPn, 1); assert.strictEqual(s.idLid, 1);
});
