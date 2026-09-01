const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Shared home for any media a client uploads to attach to a scheduled post
// (status or group). Kept separate from downloads/status-saves (that's for
// media the bot *captures* from other people's statuses, not what it posts).
const SCHEDULED_MEDIA_ROOT = path.join(__dirname, '..', '..', 'downloads', 'scheduled-media');
if (!fs.existsSync(SCHEDULED_MEDIA_ROOT)) fs.mkdirSync(SCHEDULED_MEDIA_ROOT, { recursive: true });

const ALLOWED_MIME_TO_TYPE = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
};

function sanitizeFilenamePart(s) {
  return (s || 'file').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SCHEDULED_MEDIA_ROOT),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || (file.mimetype === 'video/mp4' ? '.mp4' : '.jpg');
    cb(null, `${Date.now()}_${sanitizeFilenamePart(path.basename(file.originalname || 'upload', ext))}${ext}`);
  },
});

// Single optional 'media' field — routes that don't send a file just get
// req.file === undefined and fall back to text-only, same as before.
const scheduledMediaUpload = multer({
  storage,
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB — generous for a WhatsApp status/group image or short video
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TO_TYPE[file.mimetype]) return cb(null, true);
    cb(new Error(`Unsupported file type "${file.mimetype}". Use JPEG/PNG/WEBP images or MP4 video.`));
  },
}).single('media');

// Wraps multer's callback style so routes can just `await` it and get a
// normal thrown error instead of juggling a callback themselves.
function handleScheduledMediaUpload(req, res) {
  return new Promise((resolve, reject) => {
    scheduledMediaUpload(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function mediaTypeForFile(file) {
  if (!file) return null;
  return ALLOWED_MIME_TO_TYPE[file.mimetype] || null;
}

module.exports = { handleScheduledMediaUpload, mediaTypeForFile, SCHEDULED_MEDIA_ROOT };
