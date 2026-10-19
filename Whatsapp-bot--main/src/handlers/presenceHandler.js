const logger = require('../utils/logger');
const { getFeatures } = require('../db/botFeatures');
const { updatePresence } = require('../db/presence');

// Tracks which contacts we've already subscribed to per bot, so we don't
// call presenceSubscribe repeatedly for the same contact on every message.
const subscribedContacts = new Map(); // botId -> Set of jids

function getSubscribedSet(botId) {
  if (!subscribedContacts.has(botId)) subscribedContacts.set(botId, new Set());
  return subscribedContacts.get(botId);
}

/**
 * Subscribes to presence updates for a contact, if presence_tracking is
 * enabled for this bot and we haven't already subscribed to them. Call
 * this when a contact messages the bot, so we start getting their
 * online/offline/last-seen updates going forward.
 *
 * Note: this only works for contacts whose own privacy settings allow
 * their presence to be visible — WhatsApp enforces this server-side, so
 * subscribing to a contact with presence privacy restricted simply won't
 * produce any updates, regardless of anything our code does.
 */
async function maybeSubscribeToPresence(sock, botId, contactJid) {
  try {
    const features = await getFeatures(botId);
    if (!features.presence_tracking_enabled) return;

    const subscribed = getSubscribedSet(botId);
    if (subscribed.has(contactJid)) return;

    await sock.presenceSubscribe(contactJid);
    subscribed.add(contactJid);
  } catch (err) {
    logger.warn({ err, botId, contactJid }, 'Failed to subscribe to presence updates');
  }
}

/**
 * Registers the presence.update listener for one bot's socket. Logs every
 * presence change (online/offline/typing/etc.) to the database, scoped to
 * this bot, only when presence_tracking_enabled is on.
 */
function registerPresenceHandler(sock, botId) {
  sock.ev.on('presence.update', async ({ id, presences }) => {
    try {
      const features = await getFeatures(botId);
      if (!features.presence_tracking_enabled) return;
    } catch (err) {
      return;
    }

    for (const [jid, presenceInfo] of Object.entries(presences || {})) {
      try {
        const lastSeenAt = presenceInfo.lastKnownPresence === 'unavailable' && presenceInfo.lastSeen
          ? new Date(presenceInfo.lastSeen * 1000).toISOString()
          : null;
        await updatePresence(botId, jid, presenceInfo.lastKnownPresence || 'unknown', lastSeenAt);
      } catch (err) {
        logger.warn({ err, botId, jid }, 'Failed to log presence update');
      }
    }
  });
}

module.exports = { registerPresenceHandler, maybeSubscribeToPresence };
