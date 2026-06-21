const logger = require('../utils/logger');
const commands = require('../commands/index');
const { upsertUser, isAdmin, isBlocked } = require('../db/users');
const { logMessage } = require('../db/messages');
const { logCommand } = require('../db/logs');
const { getState } = require('../db/sessionState');
const { handleStatefulFlow } = require('../commands/order');
const { handleInteractiveReply } = require('../commands/interactive');
const { saveMediaFromMessage } = require('../utils/media');

const PREFIX = process.env.COMMAND_PREFIX || '!';

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

function registerMessageHandler(sock) {
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

        await upsertUser(sender, msg.pushName);

        if (await isBlocked(sender)) {
          continue; // silently ignore blocked users
        }

        const reply = async (content) => {
          const payload = typeof content === 'string' ? { text: content } : content;
          await sock.sendMessage(sender, payload);
          await logMessage({
            jid: sender,
            direction: 'outgoing',
            messageType: typeof content === 'string' ? 'text' : Object.keys(content)[0],
            body: typeof content === 'string' ? content : JSON.stringify(content),
          });
        };

        await logMessage({
          jid: sender,
          messageId: msg.key.id,
          direction: 'incoming',
          messageType,
          body: text || null,
        });

        // Save incoming media (images/docs/audio sent TO the bot) for later retrieval
        if (['image', 'video', 'audio', 'document'].includes(messageType)) {
          await saveMediaFromMessage(msg, 'incoming').catch((err) =>
            logger.warn({ err }, 'Failed to save incoming media')
          );
        }

        // 1. Handle button/list interactive replies first
        if (interactiveSelection) {
          await handleInteractiveReply({ sock, sender, selectedId: interactiveSelection, reply });
          continue;
        }

        if (!text) continue; // media with no caption/command, nothing more to do

        // 2. Handle stateful multi-step flows (e.g. mid-order)
        const state = await getState(sender);
        if (state.state !== 'idle' && !text.startsWith(PREFIX)) {
          const handled = await handleStatefulFlow({ state, text, reply, sender });
          if (handled) continue;
        }

        // 3. Handle commands
        if (text.startsWith(PREFIX)) {
          const [rawCmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
          const cmd = commands.get(rawCmd);

          if (!cmd) {
            await reply(`Unknown command "${rawCmd}". Type ${PREFIX}menu to see available commands.`);
            continue;
          }

          if (cmd.adminOnly && !(await isAdmin(sender))) {
            await reply('🚫 This command is restricted to bot admins.');
            continue;
          }

          await logCommand(sender, rawCmd, args.join(' '));
          await cmd.handler({ sock, sender, reply, args, msg, isGroup });
          continue;
        }

        // 4. Fallback for plain text with no active flow and no command
        await reply(
          `I didn't understand that. Type *${PREFIX}menu* to see what I can do.`
        );
      } catch (err) {
        logger.error({ err }, 'Error handling incoming message');
      }
    }
  });
}

module.exports = { registerMessageHandler };
