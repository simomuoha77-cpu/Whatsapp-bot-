const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { logStatusView } = require('../db/logs');
const { getFeatures } = require('../db/botFeatures');
const { saveStatusMedia } = require('../db/statusSaves');

const STATUS_MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'status-saves');
if (!fs.existsSync(STATUS_MEDIA_ROOT)) fs.mkdirSync(STATUS_MEDIA_ROOT, { recursive: true });

const STATUS_JID = 'status@broadcast';
const VIEW_DELAY_MIN_MS = parseInt(process.env.STATUS_VIEW_DELAY_MIN_MS || '800', 10);
const VIEW_DELAY_MAX_MS = parseInt(process.env.STATUS_VIEW_DELAY_MAX_MS || '3000', 10);
// Minimum time between marking a status viewed and reacting to it — required
// for the reaction to actually register server-side (see reactToStatus).
// Deliberately much shorter than the old 1.5-5s anti-ban pacing delay.
// Minimum time between marking a status viewed and reacting to it — required
// for the reaction to actually register server-side (see reactToStatus).
// Reacting to your OWN status is a same-account shortcut that doesn't need
// full server round-trip delivery, so a short gap looked fine when tested
// that way — but reacting to someone else's status genuinely has to travel
// through WhatsApp's servers to reach their account, which takes longer.
// 600ms wasn't enough for that; bumped to something more realistic.
const REACT_MIN_GAP_MS = parseInt(process.env.STATUS_REACT_MIN_GAP_MS || '2500', 10);

// Baileys can redeliver the same status update multiple times (retries,
// multi-device sync, etc.). Without deduplication, the bot would react to
// the same status over and over in a tight loop — which is both spammy
// and a strong signal to WhatsApp's anti-abuse systems. We track which
// status IDs we've already handled, per bot, and skip repeats.
const processedStatusIds = new Map(); // key: `${botId}:${statusId}` -> timestamp
const DEDUPE_TTL_MS = 10 * 60 * 1000; // forget after 10 minutes

function cleanupOldEntries() {
  const now = Date.now();
  for (const [key, ts] of processedStatusIds) {
    if (now - ts > DEDUPE_TTL_MS) processedStatusIds.delete(key);
  }
}
setInterval(cleanupOldEntries, 60 * 1000);

function alreadyProcessed(botId, statusId) {
  const key = `${botId}:${statusId}`;
  if (processedStatusIds.has(key)) return true;
  processedStatusIds.set(key, Date.now());
  return false;
}

/**
 * Two independent per-bot queues — one for views, one for reactions.
 *
 * THE CORE FIX (kept): previously, reactToStatus() was called without
 * awaiting it, so when WhatsApp delivered several statuses at once (multiple
 * contacts posting around the same time, or a backlog after reconnecting),
 * every reaction's random delay started counting down in parallel and they
 * all fired within the same 1-2 second window — a burst pattern WhatsApp's
 * servers appear to silently drop rather than reject outright. Each queue
 * still forces its own tasks to fully complete, delay included, one at a
 * time, so reactions stay spaced out for real.
 *
 * WHY TWO QUEUES: views and reactions used to share one queue, chained
 * view-then-react per status. That meant a reaction's 1.5-5s spacing delay
 * blocked the *next* status's view from even starting — so during a busy
 * period (several contacts posting close together), views could lag well
 * behind when statuses were actually posted. Splitting them means viewing
 * stays fast and immediate regardless of how backed up reactions are.
 */
const viewQueues = new Map(); // botId -> { queue: [], processing: boolean }
const reactionQueues = new Map(); // botId -> { queue: [], processing: boolean }

function getQueue(map, botId) {
  if (!map.has(botId)) {
    map.set(botId, { queue: [], processing: false });
  }
  return map.get(botId);
}

function enqueueView(botId, task) {
  const q = getQueue(viewQueues, botId);
  q.queue.push(task);
  processQueue(viewQueues, botId);
}

function enqueueReaction(botId, task) {
  const q = getQueue(reactionQueues, botId);
  q.queue.push(task);
  processQueue(reactionQueues, botId);
}

const TASK_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Task timed out')), ms)),
  ]);
}

async function processQueue(map, botId) {
  const q = getQueue(map, botId);
  if (q.processing) return; // already draining, this call just added to the line
  q.processing = true;
  while (q.queue.length > 0) {
    const task = q.queue.shift();
    try {
      // A hung task (e.g. sendMessage that never resolves because the
      // socket died mid-call during a disconnect) would otherwise leave
      // q.processing stuck true forever — silently blocking every future
      // view/reaction for this bot with no error and no recovery. The
      // timeout guarantees the queue always keeps moving.
      await withTimeout(task(), TASK_TIMEOUT_MS);
    } catch (err) {
      logger.warn({ err, botId }, 'View/reaction queue task failed or timed out');
    }
  }
  q.processing = false;
}

function getMessageType(msg) {
  const keys = Object.keys(msg.message || {});
  return keys.find((k) =>
    ['imageMessage', 'videoMessage', 'audioMessage', 'extendedTextMessage', 'conversation'].includes(k)
  ) || keys[0] || 'unknown';
}

function getCaption(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

function randomDelay(min, max) {
  return new Promise((resolve) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(resolve, ms);
  });
}

function sanitizeFilenamePart(s) {
  return (s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

/**
 * WhatsApp is migrating contacts to opaque @lid identifiers. When a status
 * update's participant only comes through as @lid (confirmed via server
 * logs — no participantAlt/participantPn/participantLid present at all in
 * this environment), reactions addressed purely to that @lid frequently
 * don't resolve into anything the poster's device displays, even though
 * the send itself reports success. Baileys keeps its own PN<->LID mapping
 * in the signal repository (built up as it interacts with each contact) —
 * this looks it up and returns the phone-number JID when available,
 * falling back to the original @lid if there's no mapping yet.
 */
async function resolveToPhoneJid(sock, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
    return pn || jid;
  } catch (err) {
    logger.warn({ err, jid }, 'Failed to resolve @lid to phone JID');
    return jid;
  }
}

/**
 * The socket's own JID comes back as "<number>:<device>@s.whatsapp.net".
 * Every other place in this codebase (antiViewOnce.js, messageHandler.js,
 * order.js) strips the ":<device>" part before treating it as a JID for
 * session/addressing purposes — do the same here instead of pushing the
 * raw device-suffixed form into statusJidList.
 */
function normalizeSelfJid(rawId) {
  if (!rawId) return null;
  const [user] = rawId.split(':');
  return user ? `${user}@s.whatsapp.net` : null;
}

/**
 * Every identifier Baileys might use to refer to THIS bot's own account —
 * phone-number JID, its own @lid, and the device-suffixed raw form — so a
 * status can be matched against "is this actually us" regardless of which
 * form the participant field happens to arrive in for a given event.
 *
 * fromMe is supposed to be the authoritative signal for "this is our own
 * status" (see the check right after this in registerStatusHandler), but
 * it's a flag Baileys derives from the raw stanza's `from`/`participant`
 * attrs — if a status ever gets redelivered through a path where that
 * derivation is wrong (multi-device history sync, a stanza addressed via
 * @lid before the LID<->PN mapping existed, etc.), fromMe can end up false
 * for a status that is, in fact, ours. This is the second, JID-based line
 * of defense: even if fromMe misses it, comparing the status owner's JID
 * (in every form we know how to compute) against every form of our own
 * identity catches it here instead.
 */
function getOwnJidCandidates(sock) {
  const candidates = new Set();
  const rawSelf = sock.user?.id;
  if (rawSelf) {
    candidates.add(rawSelf);
    const normalized = normalizeSelfJid(rawSelf);
    if (normalized) candidates.add(normalized);
  }
  if (sock.user?.lid) candidates.add(sock.user.lid);
  const creds = sock.authState?.creds;
  if (creds?.me?.id) {
    candidates.add(creds.me.id);
    const normalized = normalizeSelfJid(creds.me.id);
    if (normalized) candidates.add(normalized);
  }
  if (creds?.me?.lid) candidates.add(creds.me.lid);
  return candidates;
}

function isOwnJid(sock, jid) {
  if (!jid) return false;
  return getOwnJidCandidates(sock).has(jid);
}

const REACTION_ACK_LABELS = { 0: 'ERROR', 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ', 5: 'PLAYED' };
const REACTION_SEND_MAX_ATTEMPTS = 3;
const REACTION_ACK_WAIT_MS = 6000;

/**
 * Every prior test showed the same thing: correct key, correct target,
 * "sent successfully" locally — and then NOTHING, ever, not even a
 * SERVER_ACK. Meanwhile the logs from those same windows showed other
 * bots on this instance disconnecting (statusCode 408) and reconnecting
 * every few seconds. That combination means the send is very likely
 * landing on a socket that's mid-reconnect and getting silently dropped
 * — a connection-health problem, not a targeting bug.
 *
 * The fix for a flaky connection is not "log more" — it's retry with
 * confirmation. This waits for a real SERVER_ACK (or better) after each
 * send attempt; if none arrives within a few seconds, it tries again
 * (up to REACTION_SEND_MAX_ATTEMPTS times) rather than accepting Baileys'
 * local "it sent" as good enough, which the evidence says it is not.
 */
function isSocketOpen(sock) {
  const ws = sock?.ws;
  // Baileys' underlying transport exposes readyState directly on some
  // versions, and via a wrapped .socket on others — check both rather
  // than assuming one shape and silently treating "open" as "unknown".
  const state = ws?.readyState ?? ws?.socket?.readyState;
  return state === 1; // WebSocket.OPEN
}

function waitForReactionAck(sock, reactionMsgId, timeoutMs) {
  return new Promise((resolve) => {
    if (!reactionMsgId) return resolve(null);
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      sock.ev.off('messages.update', handler);
      clearTimeout(timer);
      resolve(status);
    };
    const handler = (updates) => {
      for (const u of updates) {
        if (u.key?.id !== reactionMsgId) continue;
        const status = u.update?.status;
        // 2 = SERVER_ACK. That's the minimum bar for "WhatsApp's server
        // actually has this" — below that, nothing downstream happened.
        if (typeof status === 'number' && status >= 2) return finish(status);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.ev.on('messages.update', handler);
  });
}

async function sendStatusReactionWithRetry(sock, reactionKey, emoji, opts, statusId) {
  for (let attempt = 1; attempt <= REACTION_SEND_MAX_ATTEMPTS; attempt++) {
    if (!isSocketOpen(sock)) {
      // Sending into a dead/reconnecting socket is exactly the failure
      // mode the logs showed — wait briefly for it to come back up
      // rather than firing into it anyway.
      logger.warn({ statusId, attempt }, 'Socket not open when attempting status reaction, waiting before send');
      await randomDelay(1000, 2500);
    }

    let sentId = null;
    try {
      const sent = await sock.sendMessage(STATUS_JID, { react: { text: emoji, key: reactionKey } }, opts);
      sentId = sent?.key?.id;
    } catch (err) {
      logger.warn({ err, statusId, attempt }, 'Status reaction send threw, will retry if attempts remain');
    }

    if (sentId) {
      const ackStatus = await waitForReactionAck(sock, sentId, REACTION_ACK_WAIT_MS);
      if (ackStatus !== null) {
        logger.info(
          { statusId, attempt, reactionMsgId: sentId, ackStatus, ackLabel: REACTION_ACK_LABELS[ackStatus] || ackStatus },
          'Status reaction confirmed by server'
        );
        return { confirmed: true, attempt, reactionMsgId: sentId, ackStatus };
      }
      logger.warn({ statusId, attempt, reactionMsgId: sentId }, 'No server ack for status reaction within timeout, retrying');
    }

    if (attempt < REACTION_SEND_MAX_ATTEMPTS) await randomDelay(1500, 3000);
  }
  logger.error({ statusId }, `Status reaction unconfirmed after ${REACTION_SEND_MAX_ATTEMPTS} attempts — giving up`);
  return { confirmed: false };
}

async function reactToStatus(sock, msg, stealthMode) {
  // WhatsApp's status viewer sheet only ever renders the native heart badge
  // for a status reaction, no matter what emoji is actually sent underneath.
  // Sending a rotating/keyword emoji just wastes effort on something that
  // will always display as ❤️ anyway — so send the heart directly.
  const emoji = '❤️';

  // WhatsApp's servers must register the *view* before they'll accept a
  // *reaction* to that same status — react too soon after readMessages()
  // resolves locally (which only means "the request went out", not "the
  // server has processed it yet") and the reaction gets silently dropped:
  // no error, view still shows, but no heart ever appears for the poster.
  // This is a fixed, short buffer for correctness, not pacing for
  // anti-detection — it's the minimum gap needed for the reaction to
  // actually register.
  await randomDelay(REACT_MIN_GAP_MS, REACT_MIN_GAP_MS + 800);

  // Read Receipts privacy gates BOTH whether a view registers AND whether a
  // reaction is ever shown to the poster — same underlying WhatsApp
  // mechanism as the view toggle above. The view's own toggle flips privacy
  // back off right after readMessages() resolves, which happens *before*
  // this reaction fires (reactions are queued separately with their own
  // 2.5s+ delay). So by the time we get here, receipts may already be back
  // off — meaning the reaction goes out "successfully" but WhatsApp never
  // tells the poster about it. This toggle is reaction's own copy of the
  // same fix, scoped to just this send.
  const needsToggle = (stealthMode || 'normal') !== 'normal';

  const participant = msg.key.participant;
  // participantAlt/participantPn is the phone-number counterpart WhatsApp's
  // own server attaches directly to this message when participant is a
  // @lid — trust that over a locally-derived lookup when it's present.
  const participantAlt = msg.key.participantAlt || msg.key.participantPn || msg.key.participantLid;
  const resolvedParticipant = await resolveToPhoneJid(sock, participant);
  const selfJid = normalizeSelfJid(sock.user?.id);

  // THE ACTUAL BUG: this used to compute resolvedParticipant above and then
  // throw it away, sending the reaction with the *original* msg.key — so if
  // participant only ever arrived as an unmapped @lid, the reaction was
  // encrypted and "sent successfully" but keyed to an identity the owner's
  // device can't attach to anything, and it never rendered on their side.
  // The reaction's key has to carry the same resolved/addressable identity
  // that we're actually building sessions for below.
  const preferredParticipant = participantAlt || resolvedParticipant || participant;

  // Last-resort guard, at the point of actually sending: if resolving the
  // @lid landed us on one of our OWN identities (e.g. a stale/incorrect
  // signalRepository mapping), refuse to send rather than firing a
  // self-reaction. registerStatusHandler already checks this on the raw
  // participant before we ever get here, but resolvedParticipant is
  // computed fresh in this function, so it gets its own check too.
  if (isOwnJid(sock, preferredParticipant)) {
    logger.warn(
      { participant, participantAlt, resolvedParticipant, preferredParticipant },
      'Resolved status-reaction target is our own account — refusing to send self-reaction'
    );
    return { emoji, skipped: true, reason: 'resolved_to_own_jid', participant, participantAlt, resolvedParticipant, preferredParticipant };
  }

  const reactionKey = { ...msg.key, participant: preferredParticipant };

  // Resolved/preferred form first — some contacts only resolve after this
  // point (e.g. session established moments ago), so keep every candidate
  // form in the list, but the one we're actually addressing goes first.
  const statusJidList = [
    ...new Set(
      [preferredParticipant, participantAlt, resolvedParticipant, participant, selfJid].filter(Boolean)
    ),
  ];
  // Every other status@broadcast send in this codebase (scheduler.js,
  // client.js, admin.js — all posting your OWN status) includes
  // `broadcast: true` alongside statusJidList. This reaction send was the
  // only one missing it. Without it, Baileys has no signal that this
  // send should be treated as status-type traffic rather than an
  // ordinary chat message addressed to the unusual 'status@broadcast'
  // JID — which is consistent with everything we've seen: it reports
  // success, but never renders as an actual status reaction on the
  // recipient's side.
  const opts = statusJidList.length > 0 ? { statusJidList, broadcast: true } : { broadcast: true };

  try {
    if (needsToggle) await sock.updateReadReceiptsPrivacy('all');
    const result = await sendStatusReactionWithRetry(sock, reactionKey, emoji, opts, msg.key.id);
    return {
      emoji,
      participant,
      participantAlt,
      resolvedParticipant,
      preferredParticipant,
      statusJidList,
      reactionKey,
      ...result,
    };
  } finally {
    if (needsToggle) {
      try {
        await sock.updateReadReceiptsPrivacy('none');
      } catch (err) {
        logger.warn({ err }, 'Failed to restore read receipts privacy after status reaction');
      }
    }
  }
}

async function saveStatusIfMedia(botId, msg, messageType, caption, contactJid) {
  if (!['imageMessage', 'videoMessage'].includes(messageType)) return;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    const ext = messageType === 'videoMessage' ? 'mp4' : 'jpg';
    const filename = `${Date.now()}_${sanitizeFilenamePart(contactJid.split('@')[0])}.${ext}`;
    const mediaPath = path.join(STATUS_MEDIA_ROOT, filename);
    fs.writeFileSync(mediaPath, buffer);
    await saveStatusMedia({
      botId,
      contactJid,
      mediaType: messageType === 'videoMessage' ? 'video' : 'image',
      mediaPath,
      caption,
    });
  } catch (err) {
    logger.warn({ err, botId, contactJid }, 'Failed to save status media');
  }
}

/**
 * Registers status (story) handling for one specific bot's socket.
 * Whether it views/reacts at all is controlled entirely by that bot's
 * own feature row — this is exactly the "client only wants auto-status-
 * viewing" control surface.
 */
function registerStatusHandler(sock, botId) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    // Subscription gate — same as messageHandler.js, checked once per batch.
    try {
      const { isSubscriptionActive } = require('../db/subscriptions');
      const active = await isSubscriptionActive(botId);
      if (!active) return;
    } catch (err) {
      logger.error({ err, botId }, 'Failed to check subscription status for status handler, allowing through');
    }

    for (const msg of messages) {
      if (msg.key?.remoteJid !== STATUS_JID) continue;
      if (!msg.message) continue;
      if (!msg.key.id) continue;

      // Diagnostic snapshot of every status event this bot sees, taken
      // BEFORE any filtering below. If a self-status ever slips through
      // both guards that follow, this line is what tells us why (e.g.
      // fromMe:false and participant already equal to one of ourJids, or
      // participant in a JID form ourJids doesn't recognize yet).
      const ourJids = getOwnJidCandidates(sock);
      // Logged at info level (not debug) deliberately: this is the exact
      // line needed to diagnose a self-reaction bug, and this project's
      // logger defaults to 'info' — at 'debug' it would go unseen in a
      // normal run and the next report would have no evidence in it again.
      logger.info(
        {
          botId,
          fromMe: msg.key.fromMe,
          participant: msg.key.participant,
          participantAlt: msg.key.participantAlt || msg.key.participantPn || msg.key.participantLid,
          remoteJid: msg.key.remoteJid,
          statusId: msg.key.id,
          ourJids: [...ourJids],
        },
        'Status event received'
      );

      // This is the bot's own status post coming back through the same
      // event stream — view/react logic is only ever meant to apply to
      // OTHER people's statuses. Without this check, every status the bot
      // posts (manual or scheduled) gets "viewed" and "reacted to" by
      // itself, which is exactly the "reacting to my own status" bug.
      if (msg.key.fromMe) continue;

      // Second, independent guard: compare the status owner's JID (in
      // every form we have — raw participant, server-supplied alt, and
      // our own identity in every form) directly, instead of relying only
      // on fromMe. This is a belt-and-suspenders check for exactly the
      // failure mode above — it must never be reached for a genuine own
      // status, but if fromMe is ever wrong, this is what actually stops
      // the bot from reacting to itself.
      const ownerJid = msg.key.participant || msg.key.remoteJid;
      const ownerAlt = msg.key.participantAlt || msg.key.participantPn || msg.key.participantLid;
      if (isOwnJid(sock, ownerJid) || isOwnJid(sock, ownerAlt)) {
        logger.warn(
          { botId, ownerJid, ownerAlt, fromMe: msg.key.fromMe, statusId: msg.key.id },
          'Status owner resolved to the bot\'s own account even though fromMe was false — skipping (fromMe appears unreliable for this event)'
        );
        continue;
      }

      // Skip if we've already handled this exact status update for this bot.
      if (alreadyProcessed(botId, msg.key.id)) continue;

      const contactJid = msg.key.participant || msg.key.remoteJid;
      const messageType = getMessageType(msg);
      const caption = getCaption(msg);

      let features;
      try {
        features = await getFeatures(botId);
      } catch (err) {
        logger.warn({ err, botId }, 'Failed to load bot features for status handling');
        continue;
      }

      if (features.auto_view_status) {
        // Fast, near-immediate queue — separate from reactions, so a
        // backlog of reactions (each spaced 1.5-5s apart) never delays
        // viewing the next status that comes in.
        enqueueView(botId, async () => {
          await randomDelay(VIEW_DELAY_MIN_MS, VIEW_DELAY_MAX_MS);

          // Read Receipts privacy is one global WhatsApp setting that gates
          // BOTH message blue-ticks and whether a status view registers with
          // the poster. In stealth/no_mark mode it rests at 'none' (so
          // message reads stay invisible) — but that also means
          // readMessages() below succeeds locally while WhatsApp silently
          // never reports the view. So: briefly flip to 'all' just for this
          // one view, then put it back right after, exactly as documented
          // (but never actually implemented) in botManager.js/client.js/admin.js.
          const stealthMode = features.stealth_read_mode || 'normal';
          const needsToggle = stealthMode !== 'normal';

          try {
            if (needsToggle) await sock.updateReadReceiptsPrivacy('all');

            try {
              await sock.readMessages([msg.key]);
            } catch (err) {
              // One retry before giving up — most failures here are transient
              // (a reconnect happening at that exact moment, a brief network
              // blip), and permanently dropping the view on the first hiccup
              // is what was causing views to go missing intermittently.
              logger.warn({ err, botId }, 'Failed to mark status as viewed, retrying once');
              try {
                await randomDelay(500, 1500);
                await sock.readMessages([msg.key]);
              } catch (retryErr) {
                logger.warn({ err: retryErr, botId }, 'Retry also failed, giving up on this status view');
              }
            }
          } finally {
            if (needsToggle) {
              try {
                await sock.updateReadReceiptsPrivacy('none');
              } catch (err) {
                logger.warn({ err, botId }, 'Failed to restore read receipts privacy after status view');
              }
            }
          }

          if (features.auto_react_status) {
            // Every status gets reacted to — no random skipping. Queued
            // immediately (right after the view above), and reactToStatus
            // itself no longer waits before sending.
            enqueueReaction(botId, async () => {
              const result = await reactToStatus(sock, msg, features.stealth_read_mode);
              logger.info({ botId, contactJid, statusId: msg.key.id, originalKey: msg.key, ...result }, 'Reacted to status');
            });
          }
        });
      } else if (features.auto_react_status) {
        // Viewing is off but reacting is on — still react on its own, every time.
        enqueueReaction(botId, async () => {
          const result = await reactToStatus(sock, msg, features.stealth_read_mode);
          logger.info({ botId, contactJid, statusId: msg.key.id, originalKey: msg.key, ...result }, 'Reacted to status');
        });
      }

      if (features.auto_status_save_enabled) {
        saveStatusIfMedia(botId, msg, messageType, caption, contactJid).catch((err) =>
          logger.warn({ err, botId }, 'Status save task failed')
        );
      }

      try {
        await logStatusView({
          botId,
          contactJid,
          statusId: msg.key.id,
          mediaType: messageType,
          caption,
        });
      } catch (err) {
        logger.error({ err, botId }, 'Failed to log status view to database');
      }
    }
  });
}

function resetQueue(botId) {
  // Both queues, not just reactions — a view task still sitting here from
  // right before a disconnect holds a closure over the now-dead socket. If
  // only reactions get cleared, that stale task stays in line, eventually
  // fails/times out against the dead connection, and burns the full
  // TASK_TIMEOUT_MS delaying every real view queued behind it on the new
  // connection. This was a real, confirmed cause of views being missed.
  viewQueues.delete(botId);
  reactionQueues.delete(botId);
}

module.exports = { registerStatusHandler, resetQueue };
