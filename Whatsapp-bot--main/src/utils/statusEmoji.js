const KEYWORD_EMOJI_MAP = [
  { keywords: ['happy birthday', 'birthday', 'bday'], emoji: '🎉' },
  { keywords: ['congrat', 'congratulation', 'graduat', 'promotion'], emoji: '🎊' },
  { keywords: ['sad', 'sorry for your loss', 'rip', 'rest in peace', 'condolence'], emoji: '😢' },
  { keywords: ['love', 'miss you', '❤️', 'anniversary'], emoji: '❤️' },
  { keywords: ['funny', 'lol', 'lmao', 'haha', 'joke'], emoji: '😂' },
  { keywords: ['wow', 'amazing', 'incredible', 'omg'], emoji: '😍' },
  { keywords: ['food', 'lunch', 'dinner', 'breakfast', 'meal', 'eating'], emoji: '😋' },
  { keywords: ['workout', 'gym', 'fitness', 'training'], emoji: '💪' },
  { keywords: ['travel', 'trip', 'vacation', 'holiday', 'beach'], emoji: '✈️' },
  { keywords: ['music', 'song', 'concert', 'singing'], emoji: '🎶' },
  { keywords: ['good morning', 'morning'], emoji: '☀️' },
  { keywords: ['good night', 'goodnight'], emoji: '🌙' },
  { keywords: ['fire', '🔥'], emoji: '🔥' },
  { keywords: ['beautiful', 'gorgeous', 'stunning'], emoji: '😍' },
  { keywords: ['angry', 'mad', 'furious'], emoji: '😠' },
  { keywords: ['tired', 'exhausted', 'sleepy'], emoji: '😴' },
  { keywords: ['win', 'won', 'victory', 'champion'], emoji: '🏆' },
  { keywords: ['pray', 'blessed', 'thank god', 'alhamdulillah'], emoji: '🙏' },
];

const DEFAULT_EMOJI = '👍';

// Used when there's no caption or no keyword match (most photo/video statuses).
// A random pick from here instead of a fixed emoji is what makes reactions look human.
const FALLBACK_EMOJI_POOL = ['👍', '❤️', '🔥', '😍', '😂', '👏', '💯', '😮'];

function pickRandomFallbackEmoji() {
  return FALLBACK_EMOJI_POOL[Math.floor(Math.random() * FALLBACK_EMOJI_POOL.length)];
}

function pickEmojiForCaption(caption) {
  if (!caption || typeof caption !== 'string') return pickRandomFallbackEmoji();
  const lower = caption.toLowerCase();
  for (const { keywords, emoji } of KEYWORD_EMOJI_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) return emoji;
  }
  return pickRandomFallbackEmoji();
}

module.exports = { pickEmojiForCaption, KEYWORD_EMOJI_MAP, DEFAULT_EMOJI, FALLBACK_EMOJI_POOL };
