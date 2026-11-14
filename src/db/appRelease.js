'use strict';
/** The Android app (APK) offered to clients on their dashboard. One current release, stored in GridFS. */
const crypto = require('crypto');
const { Readable } = require('stream');
const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb } = require('./mongo');

const BUCKET = 'app_release';
const DOC_ID = 'current';

async function bucket() { return new GridFSBucket(await getDb(), { bucketName: BUCKET }); }
async function releases() { return (await getDb()).collection('app_release'); }

async function getRelease() {
  return (await releases()).findOne({ _id: DOC_ID }, { projection: { _id: 0 } });
}

async function saveRelease(buffer, { filename, label, uploadedBy }) {
  const b = await bucket();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const fileId = await new Promise((resolve, reject) => {
    const up = b.openUploadStream('WhatsApp-Bot.apk', { contentType: 'application/vnd.android.package-archive' });
    Readable.from([buffer]).on('error', reject).pipe(up).on('error', reject).on('finish', () => resolve(up.id.toString()));
  });
  const col = await releases();
  const previous = await col.findOne({ _id: DOC_ID });
  await col.updateOne({ _id: DOC_ID }, { $set: { fileId, filename, label: label || '', size: buffer.length, sha256, uploadedAt: new Date(), uploadedBy: uploadedBy || 'admin' } }, { upsert: true });
  if (previous && previous.fileId) { try { await b.delete(new ObjectId(previous.fileId)); } catch (e) { /* already gone */ } }
  return getRelease();
}

async function readReleaseBuffer() {
  const release = await getRelease();
  if (!release) return null;
  const stream = (await bucket()).openDownloadStream(new ObjectId(release.fileId));
  const chunks = [];
  await new Promise((resolve, reject) => stream.on('data', (c) => chunks.push(c)).on('error', reject).on('end', resolve));
  return { release, buffer: Buffer.concat(chunks) };
}

async function openReleaseDownload() {
  const release = await getRelease();
  if (!release) return null;
  return { release, stream: (await bucket()).openDownloadStream(new ObjectId(release.fileId)) };
}

async function deleteRelease() {
  const col = await releases();
  const previous = await col.findOne({ _id: DOC_ID });
  if (!previous) return;
  await col.deleteOne({ _id: DOC_ID });
  try { await (await bucket()).delete(new ObjectId(previous.fileId)); } catch (e) { /* already gone */ }
}

module.exports = { getRelease, saveRelease, openReleaseDownload, readReleaseBuffer, deleteRelease };
