const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');

/**
 * Scheduled-post media (image/video for auto status/group posts) was being
 * saved to local disk (downloads/scheduled-media/) via multer.diskStorage.
 * That works for the FIRST run, but Render's filesystem is ephemeral — it's
 * wiped on every redeploy, and on free/starter tiers, on every spin-down
 * after inactivity too. A recurring daily post survives exactly one cycle:
 * the file exists when it's first uploaded and the next cron run happens
 * soon after, then the instance sleeps overnight, wakes up with a fresh
 * filesystem, the file is gone, and every subsequent run silently skips
 * (buildMessagePayload logs "media file is missing on disk" and returns
 * null) — which is exactly "not auto-posting the next day" with no visible
 * error to the client.
 *
 * GridFS stores the file's bytes inside MongoDB itself (chunked, no 16MB
 * document-size limit issue), which this app already depends on and is NOT
 * on the same ephemeral disk as the app process — so it survives restarts,
 * redeploys, and spin-downs.
 */

const BUCKET_NAME = 'scheduled_media';

async function getBucket() {
  const db = await getDb();
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

/**
 * Saves a buffer to GridFS and returns a string id prefixed with "gridfs:"
 * so callers reading media_path back can tell a GridFS-backed post apart
 * from an old row that still has a (now-broken) local filesystem path,
 * without needing a schema migration or a new column.
 */
async function saveBufferToGridFS(buffer, filename, contentType) {
  const bucket = await getBucket();
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename || 'upload', { contentType });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(`gridfs:${uploadStream.id.toString()}`));
    uploadStream.end(buffer);
  });
}

/**
 * Reads a "gridfs:<id>" reference back into a full buffer. Returns null
 * (rather than throwing) if the id is malformed or the file no longer
 * exists, so callers can log-and-skip exactly like the old
 * fs.existsSync check did for a missing local file.
 */
async function readBufferFromGridFS(ref) {
  const idStr = ref.startsWith('gridfs:') ? ref.slice('gridfs:'.length) : ref;
  let objectId;
  try {
    objectId = new ObjectId(idStr);
  } catch (err) {
    return null;
  }
  const bucket = await getBucket();
  const chunks = [];
  try {
    await new Promise((resolve, reject) => {
      const downloadStream = bucket.openDownloadStream(objectId);
      downloadStream.on('data', (chunk) => chunks.push(chunk));
      downloadStream.on('error', reject);
      downloadStream.on('end', resolve);
    });
  } catch (err) {
    return null;
  }
  return Buffer.concat(chunks);
}

function isGridFsRef(value) {
  return typeof value === 'string' && value.startsWith('gridfs:');
}

module.exports = { saveBufferToGridFS, readBufferFromGridFS, isGridFsRef };
