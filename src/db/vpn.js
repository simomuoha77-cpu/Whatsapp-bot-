const { getDb, nextSequence } = require('./mongo');
const { randomUUID } = require('crypto');

// Every URI ages by one package day per 24 hours from its original upload time.
// Day 7 -> Day 6 -> ... -> Day 1 -> expired and removed from sale.
async function ageVpnInventory(db, now = new Date()) {
  const rows = await db.collection('vpn_uris').find({ status: 'available' }).toArray();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const row of rows) {
    const uploadedAt = row.created_at ? new Date(row.created_at) : now;
    const ageDays = Math.floor(Math.max(0, now.getTime() - uploadedAt.getTime()) / DAY_MS);
    if (!ageDays) continue;
    const nextDay = Number(row.initial_day ?? row.day) - ageDays;
    if (nextDay <= 0) {
      await db.collection('vpn_uris').updateOne(
        { _id: row._id, status: 'available' },
        { $set: { status: 'expired', expired_at: now }, $unset: { reservation_id: '', reserved_at: '' } }
      );
    } else {
      await db.collection('vpn_uris').updateOne(
        { _id: row._id, status: 'available' },
        { $set: { day: nextDay, initial_day: Number(row.initial_day ?? row.day), aged_days: ageDays, last_aged_at: now } }
      );
    }
  }
}

async function getVpnPackages() {
  const db = await getDb();
  await ageVpnInventory(db);
  const packages = await db.collection('vpn_packages').find({}).sort({ day: 1 }).toArray();
  for (const p of packages) { if (p.uri) { let u; try { u = new URL(p.uri); } catch (_) {} if (u && ['https:', 'http:'].includes(u.protocol)) await db.collection('vpn_uris').updateOne({ day: Number(p.day), uri: u.href }, { $setOnInsert: { day: Number(p.day), initial_day: Number(p.day), uri: u.href, status: 'available', created_at: new Date() } }, { upsert: true }); } }
  const uriRows = await db.collection('vpn_uris').find({}).toArray();
  const uriMap = new Map();
  for (const row of uriRows) { if (!uriMap.has(Number(row.day))) uriMap.set(Number(row.day), []); uriMap.get(Number(row.day)).push(row); }
  const stock = await db.collection('vpn_uris').aggregate([
    { $group: { _id: '$day', available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } }, reserved: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } }, sold: { $sum: { $cond: [{ $eq: ['$status', 'sold'] }, 1, 0] } } } }
  ]).toArray();
  const counts = new Map(stock.map(x => [Number(x._id), x]));
  return packages.map(p => ({ ...p, uris: (uriMap.get(Number(p.day)) || []).filter(x => x.status === 'available').map(x => x.uri), inventory: counts.get(Number(p.day)) || { available: 0, reserved: 0, sold: 0 }, remaining: (counts.get(Number(p.day)) || {}).available || 0 }));
}

async function getVpnPackage(day) {
  const db = await getDb();
  await ageVpnInventory(db);
  const pkg = await db.collection('vpn_packages').findOne({ day: Number(day) });
  if (!pkg) return null;
  if (pkg.uri) { let u; try { u = new URL(pkg.uri); } catch (_) {} if (u && ['https:', 'http:'].includes(u.protocol)) await db.collection('vpn_uris').updateOne({ day: Number(day), uri: u.href }, { $setOnInsert: { day: Number(day), initial_day: Number(day), uri: u.href, status: 'available', created_at: new Date() } }, { upsert: true }); }
  const stock = await db.collection('vpn_uris').countDocuments({ day: Number(day), status: 'available' });
  return { ...pkg, remaining: stock };
}

async function saveVpnPackage({ day, title, amount, uris, uri, active = true }) {
  const db = await getDb();
  await ageVpnInventory(db);
  const n = Number(day);
  const cleanUris = [...new Set((Array.isArray(uris) ? uris : String(uri || '').split(/\r?\n/)).map(x => String(x || '').trim()).filter(Boolean))];
  const doc = { day: n, title: String(title || '').trim(), amount: Number(amount), active: Boolean(active), updated_at: new Date() };
  await db.collection('vpn_packages').updateOne({ day: n }, { $set: doc, $setOnInsert: { created_at: new Date() } }, { upsert: true });
  // Add new stock without overwriting or deleting previously sold/reserved URIs.
  for (const value of cleanUris) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { continue; }
    if (!['https:', 'http:'].includes(parsed.protocol)) continue;
    await db.collection('vpn_uris').updateOne({ day: n, uri: parsed.href }, { $setOnInsert: { day: n, initial_day: n, uri: parsed.href, status: 'available', created_at: new Date() } }, { upsert: true });
  }
  // Migrate a legacy single URI into inventory once, if present.
  if (uri && !Array.isArray(uris)) {
    let parsed;
    try { parsed = new URL(String(uri).trim()); } catch (_) {}
    if (parsed && ['https:', 'http:'].includes(parsed.protocol)) await db.collection('vpn_uris').updateOne({ day: n, uri: parsed.href }, { $setOnInsert: { day: n, initial_day: n, uri: parsed.href, status: 'available', created_at: new Date() } }, { upsert: true });
  }
  return doc;
}

async function getVpnInventoryForAdmin(day) {
  const db = await getDb();
  await ageVpnInventory(db);
  return db.collection('vpn_uris').find({ day: Number(day), status: 'available' }).sort({ created_at: 1 }).toArray();
}

async function updateAvailableVpnUri({ day, oldUri, newUri }) {
  const db = await getDb();
  await ageVpnInventory(db);
  const result = await db.collection('vpn_uris').updateOne(
    { day: Number(day), uri: String(oldUri), status: 'available' },
    { $set: { uri: String(newUri), updated_at: new Date() } }
  );
  return result.modifiedCount === 1;
}

async function deleteAvailableVpnUri({ day, uri }) {
  const db = await getDb();
  await ageVpnInventory(db);
  const result = await db.collection('vpn_uris').deleteOne({ day: Number(day), uri: String(uri), status: 'available' });
  return result.deletedCount === 1;
}

async function reserveVpnUris(day, quantity) {
  const db = await getDb();
  await ageVpnInventory(db);
  const token = randomUUID();
  const reserved = [];
  for (let i = 0; i < quantity; i++) {
    const result = await db.collection('vpn_uris').findOneAndUpdate(
      { day: Number(day), status: 'available' },
      { $set: { status: 'reserved', reservation_id: token, reserved_at: new Date() } },
      { returnDocument: 'after' }
    );
    const item = result && (result.value || result);
    if (!item || !item._id) break;
    reserved.push(item.uri);
  }
  if (reserved.length !== quantity) {
    await db.collection('vpn_uris').updateMany({ reservation_id: token, status: 'reserved' }, { $set: { status: 'available' }, $unset: { reservation_id: '', reserved_at: '' } });
    return null;
  }
  return { token, uris: reserved };
}

async function releaseVpnReservation(token) {
  if (!token) return;
  const db = await getDb();
  await db.collection('vpn_uris').updateMany({ reservation_id: token, status: 'reserved' }, { $set: { status: 'available' }, $unset: { reservation_id: '', reserved_at: '' } });
}

async function getVpnPurchasesForBot(botId) {
  const db = await getDb();
  return db.collection('vpn_purchases').find({ bot_id: Number(botId) }).sort({ purchased_at: -1 }).toArray();
}

async function completeVpnReservation({ token, botId, day, title, amount, checkoutRequestId, mpesaReceiptNumber }) {
  const db = await getDb();
  const existing = await db.collection('vpn_purchases').find({ checkout_request_id: checkoutRequestId }).toArray();
  if (existing.length) return existing;
  const stock = await db.collection('vpn_uris').find({ reservation_id: token, status: 'reserved' }).toArray();
  if (!stock.length) throw new Error('Reserved VPN URI stock not found for paid transaction');
  const purchases = [];
  for (const item of stock) {
    const id = await nextSequence('vpn_purchases');
    const doc = { id, bot_id: Number(botId), day: Number(day), title, amount: Number(amount) / stock.length, uri: item.uri, checkout_request_id: checkoutRequestId, mpesa_receipt_number: mpesaReceiptNumber || null, purchased_at: new Date() };
    await db.collection('vpn_purchases').insertOne(doc);
    await db.collection('vpn_uris').updateOne({ _id: item._id, status: 'reserved', reservation_id: token }, { $set: { status: 'sold', bot_id: Number(botId), sold_at: new Date(), checkout_request_id: checkoutRequestId }, $unset: { reservation_id: '', reserved_at: '' } });
    purchases.push(doc);
  }
  return purchases;
}

module.exports = { ageVpnInventory, getVpnPackages, getVpnPackage, saveVpnPackage, getVpnInventoryForAdmin, updateAvailableVpnUri, deleteAvailableVpnUri, reserveVpnUris, releaseVpnReservation, getVpnPurchasesForBot, completeVpnReservation };
