const multer = require('multer');

const ALLOWED_MIME_TO_TYPE = {
  'image/jpeg': 'image',
  'image/jpg': 'image', // some Android pickers report this non-standard variant instead of image/jpeg
  'image/png': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};

// Memory storage, not disk: req.file.buffer goes straight to GridFS (see
// gridfsMedia.js) instead of local disk, which doesn't survive Render
// redeploys or free-tier spin-downs — that mismatch was why recurring
// image/video posts silently stopped firing after the first day while the
// upload itself appeared to work fine.
const storage = multer.memoryStorage();

// Single optional 'media' field — routes that don't send a file just get
// req.file === undefined and fall back to text-only, same as before.
const scheduledMediaUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — GridFS itself has no size limit (it chunks automatically), but multer.memoryStorage() holds the whole upload in the Node process's RAM before it's streamed to GridFS. Given this same instance is already resource-constrained enough to cause connection drops (see botManager.js), capping this bounds worst-case memory pressure during an upload; raise it if the instance has headroom.
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

module.exports = { handleScheduledMediaUpload, mediaTypeForFile };
