const logger = require('../utils/logger');
const commands = require('../commands/index');
const { upsertContact, isBlocked, getContact } = require('../db/contacts');
const { logMessage } = require('../db/messages');
const { logCommand } = require('../db/logs');
const { getState } = require('../db/sessionState');
const { handleStatefulFlow } = require('../commands/order');
const { handleInteractiveReply } = require('../commands/interactive');
const { getProductsForBot } = require('../db/products');
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
// Instant replies to every message is a clear bot signature to WhatsApp's
// detection. A short randomized delay before auto-replying/welcoming makes
// the timing look like someone actually reading the message first.
const REPLY_DELAY_MIN_MS = parseInt(process.env.REPLY_DELAY_MIN_MS || '1200', 10);
const REPLY_DELAY_MAX_MS = parseInt(process.env.REPLY_DELAY_MAX_MS || '4000', 10);

function replyDelay() {
  const ms = Math.floor(Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS + 1)) + REPLY_DELAY_MIN_MS;
  return new Promise((res) => setTimeout(res, ms));
}
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
const lastAutoReplyAt = new Map(); // `${botId}:${jid}` -> timestamp
// Baileys re-delivers the bot's own sent messages through messages.upsert
// (fromMe: true), same as any other linked-device echo. reply() already
// logs those the moment they're sent, so we track their IDs here to skip
// re-logging when that echo arrives — anything fromMe that ISN'T in this
// set is a message the account owner typed manually from their own phone,
// which we do want to log (just without triggering any bot logic on it).
const botSentMessageIds = new Map(); // botId -> Set of message ids
function getBotSentSet(botId) {
  if (!botSentMessageIds.has(botId)) botSentMessageIds.set(botId, new Set());
  return botSentMessageIds.get(botId);
}

/**
 * Checks whether the current time (in the given timezone) falls within
 * start-end, both as "HH:MM" strings. Handles overnight ranges correctly
 * (e.g. 22:00-06:00 means "9pm to 6am", wrapping past midnight) — a plain
 * numeric comparison would silently treat that as "never open".
 */
function isWithinBusinessHours(startStr, endStr, timezone) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    const nowMinutes = hour * 60 + minute;

    const [startH, startM] = (startStr || '09:00').split(':').map(Number);
    const [endH, endM] = (endStr || '18:00').split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Overnight range (e.g. 22:00-06:00)
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  } catch (err) {
    return true; // if anything about the config is malformed, fail open (treat as business hours, matching old always-reply behavior)
  }
}

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
        if (msg.key.fromMe && !isSelfChat) {
          const sentSet = getBotSentSet(botId);
          if (sentSet.has(msg.key.id)) {
            // This is Baileys echoing back a message the bot itself just
            // sent via reply() — already logged there, skip re-logging.
            sentSet.delete(msg.key.id);
          } else {
            // The account owner typed this manually from their own phone.
            // We still want it visible in the admin chat viewer, even
            // though it should never trigger auto-reply/commands/AI.
            try {
              await logMessage({
                botId,
                jid: msg.key.remoteJid,
                messageId: msg.key.id,
                direction: 'outgoing',
                messageType: getMessageType(msg),
                body: extractText(msg).trim() || null,
              });
            } catch (err) {
              logger.warn({ err, botId }, 'Failed to log manually-sent message');
            }
          }
          continue;
        }

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

        // Group-specific features (anti-link, tag-all) — the only group
        // message handling this bot does, everything else below stays
        // direct-chat-only.
        if (isGroup && !isSelfChat) {
          try {
            const { handleGroupMessage } = require('./groupHandler');
            const wasHandled = await handleGroupMessage(sock, botId, msg, text);
            if (wasHandled) continue;
          } catch (err) {
            logger.error({ err, botId }, 'Error in group message handling');
          }
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
        // message was read.
        //
        // 'normal' now means genuinely normal — like a real phone, it takes
        // NO automatic action on read status at all. The bot still fully
        // processes the message and can auto-reply, but the blue double-tick
        // only appears once the human actually opens the chat themselves on
        // their own device (which sends WhatsApp's own natural read receipt,
        // completely outside this code). Previously 'normal' called
        // readMessages() here, which marked it read instantly — before
        // anyone had actually looked. That's the bug this fixes.
        //
        // 'stealth' and 'no_mark' actively force the chat to stay unread
        // (see below) — useful if you want to browse the chat yourself on
        // this linked session without tipping off the sender.
        if (stealthMode === 'normal') {
          // Intentionally does nothing — see comment above.
        } else {
          // Explicitly force this chat to stay marked unread, rather than
          // just never calling readMessages(). This is a stronger signal
          // than silence — it directly tells WhatsApp not to consider this
          // read, instead of relying only on the absence of a call.
          try {
            await sock.chatModify(
              { markRead: false, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] },
              sender
            );
          } catch (err) {
            logger.warn({ err, botId, sender }, 'Failed to force chat unread in stealth mode');
          }
        }

        const reply = async (content) => {
          const payload = typeof content === 'string' ? { text: content } : content;
          // Real phones show "typing..." (or "recording audio...") for a
          // moment before a message appears — sending instantly with no
          // presence state at all is itself a signal that this isn't a
          // person. Fake Recording takes priority if both are somehow on,
          // since it's the more specific choice.
          if (features.fake_recording_enabled || features.fake_typing_enabled) {
            try {
              // Baileys' sendPresenceUpdate('composing'/'recording', jid)
              // is frequently a silent no-op unless we've first subscribed
              // to presence for that chat — this is a well-documented
              // Baileys quirk, not something obvious from the API surface.
              // presenceSubscribe() only needs to happen once per chat, but
              // calling it again here is harmless and guarantees it's in
              // place before every single typing/recording indicator.
              await sock.presenceSubscribe(sender);
              const presenceType = features.fake_recording_enabled ? 'recording' : 'composing';
              await sock.sendPresenceUpdate(presenceType, sender);
              const textLen = typeof content === 'string' ? content.length : 40;
              const typingMs = Math.min(4000, Math.max(600, textLen * 35));
              await delay(typingMs);
              await sock.sendPresenceUpdate('paused', sender);
            } catch (err) {
              logger.warn({ err, botId, sender }, 'Failed to show typing/recording indicator');
            }
          }
          const sentMsg = await sock.sendMessage(sender, payload);
          if (sentMsg?.key?.id) {
            getBotSentSet(botId).add(sentMsg.key.id);
          }
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

        // Auto React to Messages: a lightweight emoji reaction on regular
        // chat messages. Unlike status reactions, message reactions are a
        // fully native, documented WhatsApp feature — they reliably show up
        // for the sender exactly like a manual long-press reaction would.
        if (features.auto_react_messages_enabled) {
          try {
            const pool = ['👍', '❤️', '😂', '🔥', '👏', '😮'];
            const emoji = pool[Math.floor(Math.random() * pool.length)];
            await sock.sendMessage(sender, { react: { text: emoji, key: msg.key } });
          } catch (err) {
            logger.warn({ err, botId, sender }, 'Failed to auto-react to message');
          }
        }

        // Auto Save Contacts: the first time a new contact messages in,
        // automatically send them the bot owner's own contact card (vCard)
        // so they can save this number — the actual, documented way a
        // WhatsApp bot can "save" a contact via Baileys (there's no API to
        // silently write into someone else's phone address book).
        if (features.auto_save_contacts_enabled && isFirstMessageFromContact) {
          try {
            const ownNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
            if (ownNumber) {
              const vcard =
                'BEGIN:VCARD\n' +
                'VERSION:3.0\n' +
                `FN:${ownNumber}\n` +
                `TEL;type=CELL;waid=${ownNumber}:+${ownNumber}\n` +
                'END:VCARD';
              await sock.sendMessage(sender, {
                contacts: { displayName: ownNumber, contacts: [{ vcard }] },
              });
            }
          } catch (err) {
            logger.warn({ err, botId, sender }, 'Failed to auto-send contact card');
          }
        }

        // Fetched here (rather than down where it's used for command/order
        // routing) so Welcome Message and Auto-Reply can also check it —
        // neither should ever fire while the customer is in the middle of
        // an active flow like an order, which was firing independently of
        // this and interrupting mid-conversation.
        const state = await getState(botId, sender);
        const isMidFlow = state.state !== 'idle';

        // Welcome Message: sent once, the very first time a contact messages
        // this bot. Independent of Auto Reply, which can fire repeatedly.
        if (features.welcome_message_enabled && isFirstMessageFromContact && !isMidFlow) {
          await replyDelay();
          await reply(features.welcome_message_text || 'Welcome! Thanks for messaging us.');
        }

        // Auto-reply (away message) — only if this bot has the feature enabled.
        // If Business Hours is also on, this only fires OUTSIDE the
        // configured hours, using the business-hours-specific text instead
        // of the generic auto-reply message — inside business hours, no
        // away message is sent at all (a real person might reply instead).
        // Never fires mid-flow (e.g. while someone's answering order
        // questions) — that was firing on every message regardless and
        // interleaving with the order flow's own replies.
        if (features.auto_reply && !isMidFlow) {
          const outsideHours = features.business_hours_enabled
            ? !isWithinBusinessHours(
                features.business_hours_start,
                features.business_hours_end,
                features.business_hours_timezone
              )
            : true; // business hours off = always eligible, same as before

          if (outsideHours) {
            const key = `${botId}:${sender}`;
            const lastSent = lastAutoReplyAt.get(key) || 0;
            if (Date.now() - lastSent > AUTO_REPLY_COOLDOWN_MS) {
              lastAutoReplyAt.set(key, Date.now());
              await replyDelay();
              const message = features.business_hours_enabled
                ? (features.business_hours_away_text || "We're currently outside business hours. We'll respond when we're back.")
                : (features.auto_reply_message || "Thanks for your message! I'll reply shortly.");
              await reply(message);
            }
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

              // Give the AI real, current context about this specific bot
              // — its actual commands and product catalog — so it can
              // naturally say "type !order to see our menu" or recognize
              // a product by name, instead of only knowing whatever the
              // owner manually wrote in their system prompt.
              const commandList = [...commands.getAll().entries()]
                .map(([name, def]) => `${PREFIX}${name} — ${def.description || ''}`)
                .join('\n');
              const products = await getProductsForBot(botId);
              const productList = products.length
                ? products.map((p) => `${p.name}${p.price ? ` (KES ${p.price})` : ''}`).join(', ')
                : null;

              const basePrompt = features.ai_system_prompt || 'You are a helpful assistant responding to WhatsApp messages. Keep replies concise.';
              const systemPrompt =
                `${basePrompt}\n\n` +
                `Available commands on this bot (mention the relevant one when it fits, e.g. suggest ${PREFIX}order if someone wants to buy something):\n${commandList}` +
                (productList ? `\n\nCurrent products for sale: ${productList}` : '');

              const aiReply = await generateAiReply({
                provider: features.ai_provider || 'groq',
                systemPrompt,
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

        if (state.state !== 'idle' && !text.startsWith(PREFIX)) {
          const handled = await handleStatefulFlow({ botId, state, text, reply, sender, sock });
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

          if (cmd.requiredFeature && !features[cmd.requiredFeature]) {
            await reply('🚫 This feature is not enabled for this bot.');
            continue;
          }

          await logCommand(botId, sender, rawCmd, args.join(' '));
          await cmd.handler({ sock, botId, sender, reply, args, msg, isGroup });
          continue;
        }

        await reply(`Type *${PREFIX}menu* to see more.`);
      } catch (err) {
        logger.error({ err, botId }, 'Error handling incoming message');
      }
    }
  });
}

module.exports = { registerMessageHandler };
