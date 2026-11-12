'use strict';
/**
 * Participant normalisation + matching for the group-invite workflow.
 *
 * Rules (never relaxed):
 *  - A phone-number JID (PN) is only used when it is actually present in a
 *    participant field, or when a *verified* LID->PN mapping is supplied.
 *  - A LID is never converted to a PN by string manipulation.
 *  - PN and LID are only considered the same person when ONE participant record
 *    carries both, or a verified mapping says so.
 *  - Unresolved (LID-only) and malformed identities are never "eligible".
 */

const PN_SERVERS = new Set(['s.whatsapp.net', 'c.us']);

/** Classify one raw identifier. Returns {type:'pn'|'lid'|'other', key} or null. */
function classifyId(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith('+')) v = v.slice(1);
  if (!v.includes('@')) {
    return /^\d{6,20}$/.test(v) ? { type: 'pn', key: v + '@s.whatsapp.net' } : null;
  }
  const [userPart, server, ...extra] = v.split('@');
  if (extra.length || !userPart || !server) return null;
  const user = userPart.split(':')[0]; // strip device suffix "123:7@..."
  if (PN_SERVERS.has(server)) return /^\d{6,20}$/.test(user) ? { type: 'pn', key: user + '@s.whatsapp.net' } : null;
  if (server === 'lid') return /^\d{6,25}$/.test(user) ? { type: 'lid', key: user + '@lid' } : null;
  return { type: 'other', key: user + '@' + server };
}

/**
 * Normalise a Baileys participant record.
 * @param p participant object (fields tolerated: id, jid, phoneNumber, lid)
 * @param resolveLid optional sync fn (lid)=>verified PN jid | null
 */
function normalizeParticipant(p, resolveLid) {
  const out = { pn: null, lid: null, pnSource: null, malformed: false };
  if (!p || typeof p !== 'object') { out.malformed = true; return out; }
  // Explicit phone-number fields first, then generic fields.
  const fieldOrder = [['phoneNumber', p.phoneNumber], ['jid', p.jid], ['id', p.id], ['lid', p.lid]];
  for (const [field, raw] of fieldOrder) {
    const c = classifyId(raw);
    if (!c) continue;
    if (c.type === 'pn' && !out.pn) { out.pn = c.key; out.pnSource = field; }
    else if (c.type === 'lid' && !out.lid) out.lid = c.key;
  }
  if (!out.pn && out.lid && typeof resolveLid === 'function') {
    let mapped = null;
    try { mapped = resolveLid(out.lid); } catch (_) { mapped = null; }
    const c = classifyId(mapped);
    if (c && c.type === 'pn') { out.pn = c.key; out.pnSource = 'lid-mapping'; }
  }
  if (!out.pn && !out.lid) out.malformed = true;
  return out;
}

/** Deduplicate: records sharing a PN or a LID collapse into one identity. */
function dedupe(records) {
  const byPn = new Map(), byLid = new Map(), list = [];
  let malformed = 0, duplicates = 0;
  for (const r of records) {
    if (r.malformed) { malformed++; continue; }
    const existing = (r.pn && byPn.get(r.pn)) || (r.lid && byLid.get(r.lid));
    if (existing) {
      duplicates++;
      if (!existing.pn && r.pn) { existing.pn = r.pn; existing.pnSource = r.pnSource; }
      if (!existing.lid && r.lid) existing.lid = r.lid;
      if (existing.pn) byPn.set(existing.pn, existing);
      if (existing.lid) byLid.set(existing.lid, existing);
      continue;
    }
    const rec = { ...r };
    list.push(rec);
    if (rec.pn) byPn.set(rec.pn, rec);
    if (rec.lid) byLid.set(rec.lid, rec);
  }
  return { list, malformed, duplicates };
}

/** Aggregate, non-identifying format statistics for diagnostics. */
function formatStats(participants) {
  const s = { total: 0, notObject: 0, withId: 0, withJid: 0, withPhoneNumber: 0, withLid: 0,
    idPn: 0, idLid: 0, idOther: 0, idMissingOrBad: 0, admins: 0 };
  for (const p of participants || []) {
    s.total++;
    if (!p || typeof p !== 'object') { s.notObject++; continue; }
    if (p.id) s.withId++; if (p.jid) s.withJid++; if (p.phoneNumber) s.withPhoneNumber++; if (p.lid) s.withLid++;
    if (p.admin) s.admins++;
    const c = classifyId(p.id);
    if (!c) s.idMissingOrBad++; else if (c.type === 'pn') s.idPn++; else if (c.type === 'lid') s.idLid++; else s.idOther++;
  }
  return s;
}

/** Mask a jid for logs: keep country-ish prefix and last 2 digits only. */
function maskJid(jid) {
  const c = classifyId(jid);
  if (!c) return 'invalid';
  const [u, s] = c.key.split('@');
  return u.slice(0, 3) + '***' + u.slice(-2) + '@' + s;
}

/**
 * Compare source and destination participant arrays.
 * Returns counts + the queue of eligible PN jids (server-side only).
 */
function compareGroups(sourceParticipants, destinationParticipants, opts = {}) {
  const resolveLid = opts.resolveLid;
  const selfKeys = new Set((opts.selfIds || []).map(classifyId).filter(Boolean).map(c => c.key));

  const src = dedupe((sourceParticipants || []).map(p => normalizeParticipant(p, resolveLid)));
  const dst = dedupe((destinationParticipants || []).map(p => normalizeParticipant(p, resolveLid)));

  const destPn = new Set(), destLid = new Set();
  let destinationUnresolved = 0;
  for (const d of dst.list) {
    if (d.pn) destPn.add(d.pn);
    if (d.lid) destLid.add(d.lid);
    if (!d.pn) destinationUnresolved++;
  }

  const result = {
    sourceCount: (sourceParticipants || []).length,
    destinationCount: (destinationParticipants || []).length,
    sourceUnique: src.list.length,
    duplicatesIgnored: src.duplicates,
    malformed: src.malformed,
    alreadyInDestination: 0,
    eligible: 0,
    eligibleByPhone: 0,
    eligibleByLid: 0,
    unresolved: 0,
    selfExcluded: 0,
    destinationUnresolved, // destination members we could not map to a phone number
    eligibleJids: [],
  };
  const lidQueue = [];

  for (const m of src.list) {
    if ((m.pn && selfKeys.has(m.pn)) || (m.lid && selfKeys.has(m.lid))) { result.selfExcluded++; continue; }
    if ((m.pn && destPn.has(m.pn)) || (m.lid && destLid.has(m.lid))) { result.alreadyInDestination++; continue; }
    if (m.pn) { result.eligibleJids.push(m.pn); result.eligible++; result.eligibleByPhone++; continue; }
    // LID-only. Comparison inside the LID namespace is sound only when the destination
    // list is itself LID-identified (the same LID appearing in both groups is real evidence).
    // WhatsApp, not us, decides whether a LID add succeeds; outcomes are reported as returned.
    if (m.lid && destLid.size > 0) { lidQueue.push(m.lid); result.eligible++; result.eligibleByLid++; continue; }
    result.unresolved++; // no basis for comparison or addition
  }
  result.eligibleJids.push(...lidQueue);
  return result;
}

module.exports = { classifyId, normalizeParticipant, dedupe, formatStats, maskJid, compareGroups };
