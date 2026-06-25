const logger = require('../utils/logger');
const commands = require('../commands/index');
const { upsertContact, isBlocked } = require('../db/contacts');
const { logMessage } = require('../db/messages');
const { logCommand } = require('../db/logs');
const { getState } = require('../db/sessionState');
const { handleStatefulFlow } = require('../commands/order');
const { handleInteractiveReply } = require('../commands/interactive');
const { getFeatures } = require('../db/botFeatures');
const { handlePotentialViewOnce } = require('./antiViewOnce');
const { getLatestCaptureForChat, getCapturesForChat } = require('../db/viewOnceCaptures');
const fs = require('fs');

const PREFIX = process.env.COMMAND_PREFIX || '!';
const AUTO_REPLY_COOLDOWN_MS = parseInt(process.env.AUTO_REPLY_COOLDOWN_MINUTES || '60', 10) * 60 * 1000;
const lastAutoReplyAt = new Map(); // `${botId}:${jid}` -> timestamp

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

function extractInteractiveSelection(msg) {
  const m = msg.message || {};
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage) return m.listResponseMessage.singleSelectReply?.selectedRowId;
  return null;
}

function getMessageType(msg) {
  const m = msg.message || {};
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage) return 'contact';
  return 'text';
}

/**
 * Registers message handling for one specific bot's socket. Every action
 * inside is scoped to botId, so client A's contacts/state/features never
 * leak into client B's bot.
 */
function registerMessageHandler(sock, botId) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue; // handled separately
        if (msg.key.fromMe) continue;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const text = extractText(msg).trim();
        const messageType = getMessageType(msg);
        const interactiveSelection = extractInteractiveSelection(msg);

        try {
          const wasViewOnce = await handlePotentialViewOnce(sock, botId, msg);
          if (wasViewOnce) continue;
        } catch (err) {
          logger.error({ err, botId }, 'Error in anti-view-once handling');
        }

        if (text === '.v' || text === '.vlist') {
          let vFeatures;
          try {
            vFeatures = await getFeatures(botId);
          } catch (err) {
            vFeatures = null;
          }
          if (vFeatures && vFeatures.anti_view_once_enabled) {
            if (text === '.v') {
              const capture = await getLatestCaptureForChat(botId, sender);
              if (!capture || !capture.media_path || !fs.existsSync(capture.media_path)) {
                await sock.sendMessage(sender, { text: 'No saved view-once media found for this chat.' });
              } else {
                const buffer = fs.readFileSync(capture.media_path);
                const payload = capture.media_type === 'video' ? { video: buffer, caption: capture.caption || undefined } : { image: buffer, caption: capture.caption || undefined };
                await sock.sendMessage(sender, payload);
              }
            } else {
              const captures = await getCapturesForChat(botId, sender, 10);
              if (captures.length === 0) {
                await sock.sendMessage(sender, { text: 'No saved view-once history for this chat.' });
              } else {
                const lines = captures.map(function(c, i) { return (i + 1) + '. ' + (c.media_type === 'video' ? '🎥' : '📷') + ' ' + new Date(c.captured_at).toLocaleString(); });
                await sock.sendMessage(sender, { text: '*View-Once History (this chat)*\n\n' + lines.join('\n') + '\n\nUse *.v* to get the most recent one.' });
              }
            }
          }
          continue;
        }

        // Only direct 1:1 contacts are tracked — groups are out of scope entirely.
        if (isGroup) continue;

        const features = await getFeatures(botId);
        const stealthMode = features.stealth_read_mode || "normal";

        await upsertContact(botId, sender, msg.pushName);

        if (await isBlocked(botId, sender)) continue;

        if (stealthMode === "normal") {
          try {
            await sock.readMessages([msg.key]);
          } catch (err) {
            logger.warn({ err, botId, sender }, "Failed to mark message as read");
          }
        }

        const reply = async (content) => {
          const payload = typeof content === 'string' ? { text: content } : content;
          const sentMsg = await sock.sendMessage(sender, payload);
          await logMessage({
            botId,
            jid: sender,
            direction: 'outgoing',
            messageType: typeof content === 'string' ? 'text' : Object.keys(content)[0],
            body: typeof content === 'string' ? content : JSON.stringify(content),
          });
          try {
            if (sentMsg) {
              await sock.chatModify({ markRead: false, lastMessages: [sentMsg] }, sender);
            }
          } catch (err) {
            logger.warn({ err, botId, sender }, 'Failed to restore unread state after reply');
          }
        };

        await logMessage({
          botId,
          jid: sender,
          messageId: msg.key.id,
          direction: 'incoming',
          messageType,
          body: text || null,
        });

        // Auto-reply (away message) — only if this bot has the feature enabled.
        if (features.auto_reply) {
          const key = `${botId}:${sender}`;
          const lastSent = lastAutoReplyAt.get(key) || 0;
          if (Date.now() - lastSent > AUTO_REPLY_COOLDOWN_MS) {
            lastAutoReplyAt.set(key, Date.now());
            await reply(features.auto_reply_message || "Thanks for your message! I'll reply shortly.");
          }
        }

        if (interactiveSelection) {
          if (features.commands_enabled) {
            await handleInteractiveReply({ sock, botId, sender, selectedId: interactiveSelection, reply });
          }
          continue;
        }

        if (!text) continue;

        // Commands and stateful flows are gated by commands_enabled — if a
        // client's bot is set to "auto-status-viewing only," typed commands
        // simply won't respond at all.
        if (!features.commands_enabled) continue;

        const state = await getState(botId, sender);
        if (state.state !== 'idle' && !text.startsWith(PREFIX)) {
          const handled = await handleStatefulFlow({ botId, state, text, reply, sender });
          if (handled) continue;
        }

        if (text.startsWith(PREFIX)) {
          const [rawCmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
          const cmd = commands.get(rawCmd);

          if (!cmd) {
            await reply(`Unknown command "${rawCmd}". Type ${PREFIX}menu to see available commands.`);
            continue;
          }

          if (cmd.requiresBroadcast && !features.broadcast_enabled) {
            await reply('🚫 This feature is not enabled for this bot.');
            continue;
          }

          await logCommand(botId, sender, rawCmd, args.join(' '));
          await cmd.handler({ sock, botId, sender, reply, args, msg, isGroup });
          continue;
        }

        await reply(`I didn't understand that. Type *${PREFIX}menu* to see what I can do.`);
      } catch (err) {
        logger.error({ err, botId }, 'Error handling incoming message');
      }
    }
  });
}

module.exports = { registerMessageHandler };
