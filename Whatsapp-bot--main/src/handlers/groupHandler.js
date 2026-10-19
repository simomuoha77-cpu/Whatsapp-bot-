const { getFeatures } = require('../db/botFeatures');
const logger = require('../utils/logger');

const LINK_REGEX = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/)\S+/i;

// Group admin lookups hit sock.groupMetadata() (a network call) — cache
// briefly per group so a burst of messages in an active group doesn't
// trigger a metadata fetch on every single one.
const adminCache = new Map(); // groupJid -> { admins: Set, expiresAt }
const ADMIN_CACHE_MS = 60 * 1000;

async function getGroupAdmins(sock, groupJid) {
  const cached = adminCache.get(groupJid);
  if (cached && cached.expiresAt > Date.now()) return cached.admins;
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const admins = new Set(
      metadata.participants.filter((p) => p.admin === 'admin' || p.admin === 'superadmin').map((p) => p.id)
    );
    adminCache.set(groupJid, { admins, expiresAt: Date.now() + ADMIN_CACHE_MS });
    return admins;
  } catch (err) {
    logger.warn({ err, groupJid }, 'Failed to fetch group metadata for admin check');
    return new Set();
  }
}

/**
 * Handles the two group-message features (anti-link, tag-all). Called for
 * every incoming group message, before the normal direct-chat-only
 * processing skips groups entirely. Returns true if it fully handled the
 * message (caller should not process it further).
 */
async function handleGroupMessage(sock, botId, msg, text) {
  const groupJid = msg.key.remoteJid;
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const features = await getFeatures(botId);

  // Tag-All — admin-only, mentions every participant in the group.
  if (features.group_tagall_enabled && (text === '!tagall' || text === '.tagall')) {
    const admins = await getGroupAdmins(sock, groupJid);
    if (!admins.has(senderJid)) return false; // not an admin, ignore silently
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const mentions = metadata.participants.map((p) => p.id);
      const text = mentions.map((jid) => `@${jid.split('@')[0]}`).join(' ');
      await sock.sendMessage(groupJid, { text, mentions });
    } catch (err) {
      logger.warn({ err, botId, groupJid }, 'Failed to tag-all');
    }
    return true;
  }

  // Anti-Link — deletes messages containing a link/invite from anyone who
  // isn't a group admin. Never touches admins' own messages.
  if (features.group_antilink_enabled && text && LINK_REGEX.test(text)) {
    const admins = await getGroupAdmins(sock, groupJid);
    if (admins.has(senderJid)) return false; // admin posted it, leave it alone
    try {
      await sock.sendMessage(groupJid, { delete: msg.key });
    } catch (err) {
      logger.warn({ err, botId, groupJid }, 'Failed to delete link message');
    }
    return true;
  }

  return false;
}

/**
 * Registers the group-participants.update listener for welcome/goodbye
 * messages — called once per bot at connect time, same as other event
 * listeners in botManager.js.
 */
function registerGroupParticipantHandler(sock, botId) {
  sock.ev.on('group-participants.update', async ({ id: groupJid, participants, action }) => {
    try {
      const features = await getFeatures(botId);
      if (action === 'add' && features.group_welcome_enabled) {
        const template = features.group_welcome_text || 'Welcome to the group, {mention}! 👋';
        for (const jid of participants) {
          const text = template.replace('{mention}', `@${jid.split('@')[0]}`);
          await sock.sendMessage(groupJid, { text, mentions: [jid] });
        }
      } else if (action === 'remove' && features.group_goodbye_enabled) {
        const template = features.group_goodbye_text || 'Goodbye, {mention}. 👋';
        for (const jid of participants) {
          const text = template.replace('{mention}', `@${jid.split('@')[0]}`);
          await sock.sendMessage(groupJid, { text, mentions: [jid] });
        }
      }
    } catch (err) {
      logger.warn({ err, botId, groupJid }, 'Failed to handle group-participants.update');
    }
  });
}

module.exports = { handleGroupMessage, registerGroupParticipantHandler };
