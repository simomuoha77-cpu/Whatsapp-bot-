'use strict';
/** Mongo access for APK Studio. Files live in a private GridFS bucket; nothing is public. */
const crypto = require('crypto');
const fs = require('fs');
const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb } = require('./mongo');

const BUCKET = 'apk_studio';
const newId = () => crypto.randomUUID();
let indexed = false;

async function cols() {
  const db = await getDb();
  if (!indexed) {
    indexed = true;
    try {
      await db.collection('apk_projects').createIndex({ deletedAt: 1, createdAt: -1 });
      await db.collection('apk_artifacts').createIndex({ projectId: 1, createdAt: -1 });
      await db.collection('apk_requests').createIndex({ projectId: 1, createdAt: -1 });
      await db.collection('apk_audit').createIndex({ timestamp: -1 });
    } catch (e) { indexed = false; }
  }
  return {
    db,
    projects: db.collection('apk_projects'),
    artifacts: db.collection('apk_artifacts'),
    requests: db.collection('apk_requests'),
    builds: db.collection('apk_builds'), // populated by the Phase 2 build server
    audit: db.collection('apk_audit'),
  };
}

async function bucket() { const db = await getDb(); return new GridFSBucket(db, { bucketName: BUCKET }); }

function storeFile(filePath, storageName) {
  return bucket().then((b) => new Promise((resolve, reject) => {
    const up = b.openUploadStream(storageName, { contentType: 'application/vnd.android.package-archive' });
    fs.createReadStream(filePath).on('error', reject).pipe(up).on('error', reject).on('finish', () => resolve(up.id.toString()));
  }));
}
async function openDownload(storageKey) { return (await bucket()).openDownloadStream(new ObjectId(storageKey)); }
async function deleteStored(storageKey) { try { await (await bucket()).delete(new ObjectId(storageKey)); } catch (e) { /* already gone */ } }

async function audit(adminId, action, projectId, safeMetadata) {
  const { audit: a } = await cols();
  await a.insertOne({ _id: newId(), adminId, action, projectId: projectId || null, jobId: null, timestamp: new Date(), safeMetadata: safeMetadata || {} });
}

async function createProjectWithArtifact({ name, adminId, originalFilename, sizeBytes, sha256, storageKey, analysis, scanStatus, retentionDays }) {
  const { projects, artifacts } = await cols();
  const now = new Date(), projectId = newId(), artifactId = newId();
  const m = analysis.manifest;
  await projects.insertOne({ _id: projectId, name, ownerAdminId: adminId, createdAt: now, updatedAt: now, status: 'inspected', deletedAt: null });
  await artifacts.insertOne({
    _id: artifactId, projectId, type: 'original', privateStorageKey: storageKey, originalFilename, sizeBytes, sha256,
    packageName: m.package, versionName: m.versionName, versionCode: m.versionCode, appLabel: m.label,
    certificateFingerprint: analysis.signing.primaryFingerprint, scanStatus, analysis, createdAt: now,
    expiresAt: retentionDays > 0 ? new Date(now.getTime() + retentionDays * 86400000) : null, deletedAt: null,
  });
  return { projectId, artifactId };
}

async function listProjects({ q, status, sort, page, pageSize }) {
  const { projects, artifacts } = await cols();
  const filter = { deletedAt: null };
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100), 'i');
    const hits = await artifacts.find({ deletedAt: null, $or: [{ originalFilename: rx }, { packageName: rx }, { appLabel: rx }] }).project({ projectId: 1 }).limit(500).toArray();
    filter.$or = [{ name: rx }, { _id: { $in: hits.map((h) => h.projectId) } }];
  }
  const sorts = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1 } };
  const total = await projects.countDocuments(filter);
  const rows = await projects.find(filter).sort(sorts[sort] || sorts.newest).skip((page - 1) * pageSize).limit(pageSize).toArray();
  const arts = await artifacts.find({ projectId: { $in: rows.map((r) => r._id) }, type: 'original', deletedAt: null }).toArray();
  const byProject = new Map(arts.map((a) => [a.projectId, a]));
  return { total, rows: rows.map((r) => ({ ...r, artifact: byProject.get(r._id) || null })) };
}

async function getProject(id) {
  const { projects, artifacts, requests } = await cols();
  const project = await projects.findOne({ _id: String(id), deletedAt: null });
  if (!project) return null;
  const artifactList = await artifacts.find({ projectId: project._id, deletedAt: null }).sort({ createdAt: -1 }).toArray();
  const reqs = await requests.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(20).toArray();
  const dup = artifactList[0] ? await artifacts.countDocuments({ sha256: artifactList[0].sha256, projectId: { $ne: project._id }, deletedAt: null }) : 0;
  return { project, artifacts: artifactList, requests: reqs, duplicatesElsewhere: dup };
}

async function getArtifact(id) { const { artifacts } = await cols(); return artifacts.findOne({ _id: String(id), deletedAt: null }); }

async function addRequest({ projectId, adminId, description, report }) {
  const { requests, projects } = await cols();
  const doc = { _id: newId(), projectId, adminId, description, report, approvedPlan: null, approvalStatus: 'not_requested', createdAt: new Date(), approvedAt: null };
  await requests.insertOne(doc);
  await projects.updateOne({ _id: projectId }, { $set: { updatedAt: new Date() } });
  return doc;
}

async function deleteProject(id) {
  const { projects, artifacts } = await cols();
  const arts = await artifacts.find({ projectId: id, deletedAt: null }).toArray();
  for (const a of arts) await deleteStored(a.privateStorageKey);
  const now = new Date();
  await artifacts.updateMany({ projectId: id }, { $set: { deletedAt: now, privateStorageKey: null } });
  await projects.updateOne({ _id: id }, { $set: { deletedAt: now, status: 'deleted' } });
  return arts.length;
}

async function purgeExpired() {
  const { artifacts, projects } = await cols();
  const old = await artifacts.find({ deletedAt: null, expiresAt: { $ne: null, $lte: new Date() } }).limit(25).toArray();
  for (const a of old) {
    await deleteStored(a.privateStorageKey);
    await artifacts.updateOne({ _id: a._id }, { $set: { deletedAt: new Date(), privateStorageKey: null } });
    await projects.updateOne({ _id: a.projectId }, { $set: { status: 'expired' } });
  }
  return old.length;
}

async function overview() {
  const { projects, artifacts, builds, audit: a } = await cols();
  const [projectCount, uploadCount, queued, running, ok, failed, storage, recent, recentDl, expiring] = await Promise.all([
    projects.countDocuments({ deletedAt: null }),
    artifacts.countDocuments({ deletedAt: null, type: 'original' }),
    builds.countDocuments({ status: 'queued' }), builds.countDocuments({ status: 'running' }),
    builds.countDocuments({ status: 'success' }), builds.countDocuments({ status: 'failed' }),
    artifacts.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: null, bytes: { $sum: '$sizeBytes' } } }]).toArray(),
    a.find({ action: { $in: ['upload', 'plan', 'delete'] } }).sort({ timestamp: -1 }).limit(8).toArray(),
    a.find({ action: 'download' }).sort({ timestamp: -1 }).limit(5).toArray(),
    artifacts.countDocuments({ deletedAt: null, expiresAt: { $ne: null, $lte: new Date(Date.now() + 7 * 86400000) } }),
  ]);
  return { projectCount, uploadCount, queued, running, ok, failed, storageBytes: (storage[0] && storage[0].bytes) || 0, recent, recentDl, expiring };
}

async function recentRequests(limit) {
  const { requests, projects } = await cols();
  const rows = await requests.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  const ps = await projects.find({ _id: { $in: rows.map((r) => r.projectId) } }).toArray();
  const names = new Map(ps.map((p) => [p._id, p.name]));
  return rows.map((r) => ({ ...r, projectName: names.get(r.projectId) || '(deleted)' }));
}

async function recentBuilds(limit) { const { builds } = await cols(); return builds.find({}).sort({ createdAt: -1 }).limit(limit).toArray(); }

module.exports = { newId, storeFile, openDownload, deleteStored, audit, createProjectWithArtifact, listProjects, getProject, getArtifact, addRequest, deleteProject, purgeExpired, overview, recentRequests, recentBuilds };
