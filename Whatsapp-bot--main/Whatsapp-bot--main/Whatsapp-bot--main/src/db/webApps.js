'use strict';
/** DB access for the Website → Android App builder. */
const crypto = require('crypto');
const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb } = require('./mongo');

const newId = () => crypto.randomUUID();
let indexed = false;
async function cols() {
  const db = await getDb();
  if (!indexed) { indexed = true; try { await db.collection('webapp_projects').createIndex({ deletedAt: 1, createdAt: -1 }); } catch (e) { indexed = false; } }
  return { db, projects: db.collection('webapp_projects') };
}
async function bucket() { const db = await getDb(); return new GridFSBucket(db, { bucketName: 'webapp_icons' }); }

function storeIcon(buf, name) {
  return bucket().then((b) => new Promise((resolve, reject) => {
    const up = b.openUploadStream(name, { contentType: 'image/png' });
    up.on('error', reject).on('finish', () => resolve(up.id.toString()));
    up.end(buf);
  }));
}
async function readIcon(key) {
  const chunks = [];
  const stream = (await bucket()).openDownloadStream(new ObjectId(key));
  return new Promise((resolve, reject) => { stream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject); });
}
async function deleteIcon(key) { try { await (await bucket()).delete(new ObjectId(key)); } catch (e) { /* already gone */ } }

async function createProject(doc) {
  const { projects } = await cols();
  const now = new Date();
  const rec = { _id: newId(), createdAt: now, updatedAt: now, deletedAt: null, verifiedAt: null, buildCount: 0, lastBuildAt: null, ...doc };
  await projects.insertOne(rec);
  return rec;
}
async function getProject(id, ownerAdminId) {
  const { projects } = await cols();
  return projects.findOne({ _id: String(id), deletedAt: null, ...(ownerAdminId ? { ownerAdminId } : {}) });
}
async function updateProject(id, patch) {
  const { projects } = await cols();
  await projects.updateOne({ _id: id }, { $set: { ...patch, updatedAt: new Date() } });
  return getProject(id);
}
async function listProjects(ownerAdminId) {
  const { projects } = await cols();
  return projects.find({ deletedAt: null, ...(ownerAdminId ? { ownerAdminId } : {}) }).sort({ createdAt: -1 }).toArray();
}
async function deleteProject(id) {
  const p = await getProject(id);
  if (p && p.iconStorageKey) await deleteIcon(p.iconStorageKey);
  const { projects } = await cols();
  await projects.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
}

module.exports = { newId, storeIcon, readIcon, deleteIcon, createProject, getProject, updateProject, listProjects, deleteProject };
