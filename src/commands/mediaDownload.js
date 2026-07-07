const { register } = require('./registry');
const logger = require('../utils/logger');

const MAX_DURATION_SECONDS = 600; // 10 min cap — keeps downloads quick and file sizes sane

async function searchYoutube(query) {
  const yts = require('yt-search');
  const results = await yts(query);
  return results.videos && results.videos.length > 0 ? results.videos[0] : null;
}

async function downloadToBuffer(url, quality) {
  const ytdl = require('@distube/ytdl-core');
  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = ytdl(url, { quality, highWaterMark: 1 << 25 });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

register('song', {
  description: 'Download a song by name: !song <song name>',
  requiredFeature: 'media_download_enabled',
  handler: async ({ reply, args }) => {
    const query = args.join(' ').trim();
    if (!query) {
      await reply('Usage: *!song <song name>*\nExample: *!song shape of you*');
      return;
    }
    try {
      await reply(`🔎 Searching for "${query}"...`);
      const video = await searchYoutube(query);
      if (!video) {
        await reply('No results found for that song.');
        return;
      }
      if (video.seconds > MAX_DURATION_SECONDS) {
        await reply(`That result is too long (${Math.round(video.seconds / 60)} min). Try a shorter/more specific title.`);
        return;
      }
      await reply(`⬇️ Downloading *${video.title}*...`);
      const buffer = await downloadToBuffer(video.url, 'highestaudio');
      await reply({
        audio: buffer,
        mimetype: 'audio/mp4',
        fileName: `${video.title}.m4a`,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to download song');
      await reply('Sorry, something went wrong downloading that song. Try a different search.');
    }
  },
});

register('video', {
  description: 'Download a video by name: !video <video name>',
  requiredFeature: 'media_download_enabled',
  handler: async ({ reply, args }) => {
    const query = args.join(' ').trim();
    if (!query) {
      await reply('Usage: *!video <video name>*\nExample: *!video funny cats compilation*');
      return;
    }
    try {
      await reply(`🔎 Searching for "${query}"...`);
      const video = await searchYoutube(query);
      if (!video) {
        await reply('No results found for that video.');
        return;
      }
      if (video.seconds > MAX_DURATION_SECONDS) {
        await reply(`That result is too long (${Math.round(video.seconds / 60)} min). Try a shorter/more specific title.`);
        return;
      }
      await reply(`⬇️ Downloading *${video.title}*...`);
      const buffer = await downloadToBuffer(video.url, 'lowest'); // keep file size manageable over WhatsApp
      await reply({
        video: buffer,
        mimetype: 'video/mp4',
        fileName: `${video.title}.mp4`,
        caption: video.title,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to download video');
      await reply('Sorry, something went wrong downloading that video. Try a different search.');
    }
  },
});
