const logger = require('../utils/logger');
const commands = require('../commands/index');
const { upsertContact, isBlocked, getContact } = require('../db/contacts');
const { logMessage } = require('../db/messages');
const { logCommand } = require('../db/logs');
const { getState } = require('../db/sessionState');
const { handleStatefulFlow } = require('../commands/order');
const { handleInteractiveReply } = require('../commands/interactive');
const { getFeatures } = require('../db/botFeatures');
const { handlePotentialViewOnce } = require('./antiViewOnce');
const { getLatestCaptureForChat, getCapturesForChat } = require('../db/viewOnceCaptures');
const { cacheIncomingMessage, handlePotentialDelete } = require('./antiDelete');
const { getKeywordResponses, matchKeyword } = require('../db/keywordResponses');
const { generateAiReply } = require('../utils/aiProvider');
const { addChatMessage, getRecentHistory } = require('../db/aiChatHistory');
const { maybeSubscribeToPresence } = require('./presenceHandler');
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

    // Subscription gate: if this bot's trial/paid period has expired, it
    // does nothing at all — no auto-reply, no commands, no AI, nothing.
    // Checked once per batch rather than per-message for efficiency.
    try {
      const { isSubscriptionActive } = require('../db/subscriptions');
      const active = await isSubscriptionActive(botId);
      if (!active) return;
    } catch (err) {
      logger.error({ err, botId }, 'Failed to check subscription status, allowing message through as a safe default');
      // Fail open rather than closed — a database hiccup shouldn't lock
      // out a paying client's bot. Worth revisiting if abuse becomes a
      // concern, but a false negative here is worse than a rare false
      // positive.
    }

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue; // handled separately

        const ownJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        const isSelfChat = msg.key.remoteJid === ownJid;

        // Normally we ignore everything the bot itself sent (fromMe), to
        // avoid reply loops. The one exception: messages sent in the bot's
        // own self-chat ("Message Yourself"), since that's the one place
        // fromMe is expected to be true for messages the owner is
        // deliberately sending TO the bot for retrieval commands like .v.
        if (msg.key.fromMe && !isSelfChat) continue;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const text = extractText(msg).trim();
        const messageType = getMessageType(msg);
        const interactiveSelection = extractInteractiveSelection(msg);

        // Anti View Once runs before the group/direct split below, since
        // it's the one feature that's explicitly in scope for groups too —
        // everything else (commands, auto-reply, etc.) stays direct-chat-only.
        try {
          const wasViewOnce = await handlePotentialViewOnce(sock, botId, msg);
          if (wasViewOnce) continue; // nothing else to do with a view-once message
        } catch (err) {
          logger.error({ err, botId }, 'Error in anti-view-once handling');
        }

        // Anti Delete: check if this message is a delete notification
        // (referencing an earlier cached message), before any other
        // filtering — deletes can happen in groups and self-chat too.
        try {
          const wasDelete = await handlePotentialDelete(sock, botId, msg);
          if (wasDelete) continue;
        } catch (err) {
          logger.error({ err, botId }, 'Error in anti-delete handling');
        }
        // Cache this message in memory in case it gets deleted shortly
        // after — done for every message regardless of whether anti-delete
        // is currently enabled, so toggling it on later still catches
        // messages cached during this same process's lifetime.
        cacheIncomingMessage(botId, msg);

        // .v and .vlist are core to the Anti View Once feature itself, so
        // they work independently of the general commands_enabled toggle —
        // they're only gated by anti_view_once_enabled. Only the bot owner
        // (i.e. messages in their own direct chats) can use them, and .v
        // always returns the latest capture from THIS specific chat only.
        if (text === '.v' || text === '.vlist') {
          let viewOnceFeatures;
          try {
            viewOnceFeatures = await getFeatures(botId);
          } catch (err) {
            viewOnceFeatures = null;
          }

          if (viewOnceFeatures && viewOnceFeatures.anti_view_once_enabled) {
            if (text === '.v') {
              const capture = await getLatestCaptureForChat(botId, sender);
              if (!capture || !capture.media_path || !fs.existsSync(capture.media_path)) {
                await sock.sendMessage(sender, { text: 'No saved view-once media found for this chat.' });
              } else {
                const buffer = fs.readFileSync(capture.media_path);
                const payload =
                  capture.media_type === 'video'
                    ? { video: buffer, caption: capture.caption || undefined }
                    : { image: buffer, caption: capture.caption || undefined };
                await sock.sendMessage(sender, payload);
              }
            } else {
              const captures = await getCapturesForChat(botId, sender, 10);
              if (captures.length === 0) {
                await sock.sendMessage(sender, { text: 'No saved view-once history for this chat.' });
              } else {
                const lines = captures.map((c, i) =>
                  `${i + 1}. ${c.media_type === 'video' ? '🎥' : '📷'} ${new Date(c.captured_at).toLocaleString()}`
                );
                await sock.sendMessage(sender, {
                  text: `*View-Once History (this chat)*\n\n${lines.join('\n')}\n\nUse *.v* to get the most recent one.`,
                });
              }
            }
          }
          continue; // .v / .vlist never fall through to normal command processing
        }

        // Only direct 1:1 contacts are tracked — groups are out of scope entirely.
        // Self-chat is also excluded here: it's only ever used for .v/.vlist
        // retrieval above, never for normal auto-reply/command processing.
        if (isGroup || isSelfChat) continue;

        const features = await getFeatures(botId);
        const stealthMode = features.stealth_read_mode || 'normal';

        const contactRecord = await upsertContact(botId, sender, msg.pushName);
        const isFirstMessageFromContact = contactRecord && contactRecord.message_count === 1;

        // Best-effort, fire-and-forget — don't block message processing on this.
        maybeSubscribeToPresence(sock, botId, sender).catch(() => {});

        if (await isBlocked(botId, sender)) continue;

        // Stealth Read Mode controls whether we ever tell WhatsApp this
        // message was read. 'normal' marks it read like a regular client
        // would. 'stealth' and 'no_mark' both skip this entirely — the bot
        // still fully processes the message and can auto-reply, but the
        // sender never gets the blue double-tick, only the regular grey
        // sent/delivered ticks.
        if (stealthMode === 'normal') {
          try {
            await sock.readMessages([msg.key]);
          } catch (err) {
            logger.warn({ err, botId, sender }, 'Failed to mark message as read');
          }
        }

        const reply = async (content) => {
          const payload = typeof content === 'string' ? { text: content } : content;
          await sock.sendMessage(sender, payload);
          await logMessage({
            botId,
            jid: sender,
            direction: 'outgoing',
            messageType: typeof content === 'string' ? 'text' : Object.keys(content)[0],
            body: typeof content === 'string' ? content : JSON.stringify(content),
          });
        };

        await logMessage({
          botId,
          jid: sender,
          messageId: msg.key.id,
          direction: 'incoming',
          messageType,
          body: text || null,
        });
        // Internal bookkeeping: regardless of stealth mode, we always know
        // and record that the bot itself has processed this message — the
        // mode only controls whether WhatsApp's read receipt is sent to
        // the other person, not whether the bot considers it "read."
        logger.debug({ botId, sender, stealthMode, statusId: msg.key.id }, 'Message processed internally as read');

        // Welcome Message: sent once, the very first time a contact messages
        // this bot. Independent of Auto Reply, which can fire repeatedly.
        if (features.welcome_message_enabled && isFirstMessageFromContact) {
          await reply(features.welcome_message_text || 'Welcome! Thanks for messaging us.');
        }

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

        // Keyword Responses and AI Chat both operate on plain text that
        // isn't a !-prefixed command, and are independent of the general
        // commands_enabled toggle — a bot can have commands off but still
        // respond to keywords or chat with AI.
        if (!text.startsWith(PREFIX)) {
          if (features.keyword_responses_enabled) {
            try {
              const keywordList = await getKeywordResponses(botId);
              const match = matchKeyword(keywordList, text);
              if (match) {
                await reply(match.response);
                continue;
              }
            } catch (err) {
              logger.warn({ err, botId }, 'Keyword response lookup failed');
            }
          }

          if (features.ai_chat_enabled) {
            try {
              const history = await getRecentHistory(botId, sender, 10);
              const aiReply = await generateAiReply({
                provider: features.ai_provider || 'groq',
                systemPrompt: features.ai_system_prompt || 'You are a helpful assistant responding to WhatsApp messages. Keep replies concise.',
                history,
                userMessage: text,
                botId,
              });
              if (aiReply) {
                await addChatMessage(botId, sender, 'user', text);
                await addChatMessage(botId, sender, 'assistant', aiReply);
                await reply(aiReply);

                // AI-Only Silent Mode: immediately archive and mute this
                // conversation so it doesn't sit visibly in the owner's
                // chat list demanding attention. This can't stop messages
                // from existing on the account (that's a WhatsApp protocol
                // limit, not something any code can change), but it does
                // keep the conversation tucked away out of the main inbox.
                if (features.ai_only_silent_mode) {
                  try {
                    await sock.chatModify(
                      { archive: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] },
                      sender
                    );
                    await sock.chatModify({ mute: 7 * 24 * 60 * 60 * 1000 }, sender); // mute for 7 days
                  } catch (err) {
                    logger.warn({ err, botId, sender }, 'Failed to auto-archive/mute AI conversation');
                  }
                }
                continue;
              }
              logger.warn({ botId, sender }, 'AI reply generation returned null, falling through');
            } catch (err) {
              logger.error({ err, botId }, 'AI chat handling failed');
            }
          }
        }

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
