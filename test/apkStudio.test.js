'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Module = require('module');

// ---------- stubs: express / multer / logger / db are not installed in the sandbox ----------
const routes = [], mws = [];
const router = { use: (...a) => { mws.push(a[a.length - 1]); }, get: (p, ...h) => routes.push({ m: 'GET', p, h }), post: (p, ...h) => routes.push({ m: 'POST', p, h }) };
const multerState = { err: null };
const stubs = {
  express: Object.assign(() => ({}), { Router: () => router, urlencoded: () => (q, s, n) => n() }),
  multer: Object.assign(() => ({ single: () => (req, res, cb) => cb(multerState.err) }), { diskStorage: () => ({}) }),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: stubs[k] };
const root = path.join(__dirname, '..', 'src');
const storeCalls = { created: [], stored: [], audits: [] };
const storeStub = {
  storeFile: async (p) => { storeCalls.stored.push(p); return 'key123'; },
  createProjectWithArtifact: async (x) => { storeCalls.created.push(x); return { projectId: 'p1', artifactId: 'a1' }; },
  audit: async (...a) => { storeCalls.audits.push(a); },
  purgeExpired: async () => 0, getProject: async () => null, addRequest: async () => ({}),
};
const seed = (rel, exp) => { const f = path.join(root, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
seed('utils/logger.js', { warn() {}, info() {}, error() {} });
seed('db/apkStudio.js', storeStub);

const { inspectApkFile, ApkError } = require('../src/utils/apkInspect');
const { buildFeasibilityReport } = require('../src/utils/apkFeasibility');
const { createApkStudioRoutes, esc } = require('../src/handlers/apkStudio');

// ---------- fixture builders ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function buildZip(entries, { signingBlock = Buffer.alloc(0) } = {}) {
  const locals = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const method = e.deflate ? 8 : 0, comp = method ? zlib.deflateRawSync(data) : data, crc = crc32(data), flags = e.flags || 0;
    const lh = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length), u16(name.length), u16(0), name]);
    locals.push(lh, comp);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name]));
    off += lh.length + comp.length;
  }
  const cdOffset = off + signingBlock.length, cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(cdOffset), u16(0)]);
  return Buffer.concat([...locals, signingBlock, cd, eocd]);
}

function buildAxml(elems) {
  const strings = []; const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  elems.forEach((e) => { idx(e.name); e.attrs.forEach((a) => { idx(a.name); if (a.type === 'string') idx(a.value); }); });
  const strBufs = strings.map((s) => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)]));
  const offsets = []; let o = 0; strBufs.forEach((b) => { offsets.push(o); o += b.length; });
  let strData = Buffer.concat(strBufs); while (strData.length % 4) strData = Buffer.concat([strData, Buffer.alloc(1)]);
  const hdr = 28, stringsStart = hdr + 4 * strings.length;
  const pool = Buffer.concat([u16(1), u16(hdr), u32(stringsStart + strData.length), u32(strings.length), u32(0), u32(0), u32(stringsStart), u32(0), ...offsets.map(u32), strData]);
  const chunks = elems.map((e) => {
    const attrs = e.attrs.map((a) => {
      let raw = 0xffffffff, dt, data;
      if (a.type === 'string') { raw = idx(a.value); dt = 3; data = raw; } else if (a.type === 'int') { dt = 0x10; data = a.value; } else if (a.type === 'ref') { dt = 1; data = a.value; } else { dt = 0x12; data = a.value ? 0xffffffff : 0; }
      return Buffer.concat([u32(0xffffffff), u32(idx(a.name)), u32(raw), u16(8), Buffer.from([0, dt]), u32(data)]);
    });
    const size = 36 + 20 * attrs.length;
    return Buffer.concat([u16(0x0102), u16(16), u32(size), u32(1), u32(0xffffffff), u32(0xffffffff), u32(idx(e.name)), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0), ...attrs]);
  });
  const body = Buffer.concat([pool, ...chunks]);
  return Buffer.concat([u16(3), u16(8), u32(8 + body.length), body]);
}

const manifestElems = (over = {}) => [
  { name: 'manifest', attrs: [{ name: 'package', type: 'string', value: over.pkg || 'com.example.demo' }, { name: 'versionCode', type: 'int', value: 42 }, { name: 'versionName', type: 'string', value: '1.2.3' }] },
  { name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', type: 'int', value: 21 }, { name: 'targetSdkVersion', type: 'int', value: 34 }] },
  { name: 'uses-permission', attrs: [{ name: 'name', type: 'string', value: 'android.permission.INTERNET' }] },
  { name: 'uses-permission', attrs: [{ name: 'name', type: 'string', value: 'android.permission.CAMERA' }] },
  { name: 'application', attrs: over.labelRef ? [{ name: 'label', type: 'ref', value: 0x7f010001 }, { name: 'icon', type: 'ref', value: 0x7f020000 }] : [{ name: 'label', type: 'string', value: over.label || 'Demo App' }] },
];
const baseEntries = (over = {}) => [
  { name: 'AndroidManifest.xml', data: buildAxml(manifestElems(over)), deflate: true },
  { name: 'classes.dex', data: Buffer.from('dex\n035\0'.padEnd(64, 'x')), deflate: true },
  { name: 'classes2.dex', data: Buffer.from('dex'), deflate: true },
  { name: 'resources.arsc', data: Buffer.from('arsc') },
  { name: 'res/mipmap-hdpi/ic_launcher.png', data: Buffer.from('png') },
  { name: 'assets/a.txt', data: Buffer.from('a') },
  { name: 'lib/arm64-v8a/libx.so', data: Buffer.from('so') },
  { name: 'lib/armeabi-v7a/libx.so', data: Buffer.from('so') },
];

const tmp = (buf) => { const p = path.join(os.tmpdir(), 'apktest-' + crypto.randomUUID() + '.apk'); fs.writeFileSync(p, buf); return p; };
const inspectBuf = (buf) => { const p = tmp(buf); try { return inspectApkFile(p); } finally { fs.unlinkSync(p); } };
const rejectCode = (buf) => { try { inspectBuf(buf); } catch (e) { return e instanceof ApkError ? e.code : 'OTHER:' + e.message; } return 'ACCEPTED'; };

// real self-signed certificate via openssl (skip signature tests if unavailable)
let certDer = null;
try {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', d + '/k.pem', '-out', d + '/c.der', '-outform', 'DER', '-days', '30', '-subj', '/CN=Test Signer/O=Unit'], { stdio: 'ignore' });
  certDer = fs.readFileSync(d + '/c.der');
} catch (e) { certDer = null; }
const fp = (der) => crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
const tlv = (tag, c) => { const l = c.length < 128 ? Buffer.from([c.length]) : c.length < 256 ? Buffer.from([0x81, c.length]) : Buffer.from([0x82, c.length >> 8, c.length & 255]); return Buffer.concat([Buffer.from([tag]), l, c]); };
const pkcs7 = (der) => tlv(0x30, Buffer.concat([tlv(0x06, Buffer.from('2a864886f70d010702', 'hex')), tlv(0xa0, tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), tlv(0x31, Buffer.alloc(0)), tlv(0x30, tlv(0x06, Buffer.from('2a864886f70d010701', 'hex'))), tlv(0xa0, der), tlv(0x31, Buffer.alloc(0))])))]));
function sigBlock(der, id = 0x7109871a) {
  const certs = Buffer.concat([u32(der.length), der]);
  const sd = Buffer.concat([u32(0), u32(certs.length), certs]);
  const signer = Buffer.concat([u32(sd.length), sd]);
  const signers = Buffer.concat([u32(signer.length), signer]);
  const value = Buffer.concat([u32(signers.length), signers]);
  const pair = Buffer.concat([Buffer.alloc(8), u32(id), value]); pair.writeBigUInt64LE(BigInt(4 + value.length), 0);
  const size = pair.length + 8 + 16;
  const sz = Buffer.alloc(8); sz.writeBigUInt64LE(BigInt(size));
  return Buffer.concat([sz, pair, sz, Buffer.from('APK Sig Block 42')]);
}

// ---------- inspection ----------
test('inspect: valid APK metadata, structure and permissions', () => {
  const r = inspectBuf(buildZip(baseEntries()));
  assert.strictEqual(r.manifest.package, 'com.example.demo');
  assert.strictEqual(r.manifest.versionCode, 42); assert.strictEqual(r.manifest.versionName, '1.2.3');
  assert.strictEqual(r.manifest.minSdk, 21); assert.strictEqual(r.manifest.targetSdk, 34);
  assert.strictEqual(r.manifest.label, 'Demo App');
  assert.deepStrictEqual(r.manifest.permissions, ['android.permission.CAMERA', 'android.permission.INTERNET']);
  assert.strictEqual(r.structure.dexFiles, 2); assert.deepStrictEqual(r.structure.nativeAbis, ['arm64-v8a', 'armeabi-v7a']);
  assert.strictEqual(r.structure.hasResourcesArsc, true); assert.strictEqual(r.signing.signed, false);
  assert.ok(r.warnings.some((w) => /No signature/.test(w)));
});
test('inspect: label resource reference is reported, not invented', () => {
  const r = inspectBuf(buildZip(baseEntries({ labelRef: true })));
  assert.strictEqual(r.manifest.label, null); assert.strictEqual(r.manifest.labelIsReference, true); assert.strictEqual(r.manifest.iconIsReference, true);
  assert.ok(r.warnings.some((w) => /resource reference/.test(w)));
});
test('inspect: v1 signature certificate fingerprint', { skip: !certDer }, () => {
  const r = inspectBuf(buildZip([...baseEntries(), { name: 'META-INF/CERT.RSA', data: pkcs7(certDer) }, { name: 'META-INF/CERT.SF', data: 'x' }]));
  assert.strictEqual(r.signing.signed, true); assert.ok(r.signing.schemes.includes('v1'));
  assert.strictEqual(r.signing.primaryFingerprint, fp(certDer));
  assert.match(r.signing.certificates[0].subject, /Test Signer/);
});
test('inspect: v2 signing block certificate fingerprint', { skip: !certDer }, () => {
  const r = inspectBuf(buildZip(baseEntries(), { signingBlock: sigBlock(certDer) }));
  assert.ok(r.signing.schemes.includes('v2')); assert.strictEqual(r.signing.primaryFingerprint, fp(certDer));
});
test('inspect: rejects malformed / hostile / wrong-type files', () => {
  assert.strictEqual(rejectCode(Buffer.from('hello this is a text file renamed .apk, long enough to pass size check')), 'NOT_ZIP');
  assert.strictEqual(rejectCode(Buffer.from('PK')), 'NOT_ZIP');
  assert.strictEqual(rejectCode(buildZip(baseEntries()).subarray(0, 120)), 'MALFORMED');
  assert.strictEqual(rejectCode(buildZip([{ name: 'a.txt', data: 'x' }])), 'NO_MANIFEST');
  assert.strictEqual(rejectCode(buildZip([{ name: 'BundleConfig.pb', data: 'x' }, { name: 'base/manifest/AndroidManifest.xml', data: 'x' }])), 'APP_BUNDLE');
  assert.strictEqual(rejectCode(buildZip([{ name: 'base.apk', data: 'x' }, { name: 'config.arm64.apk', data: 'x' }])), 'SPLIT_BUNDLE');
  assert.strictEqual(rejectCode(buildZip([...baseEntries(), { name: '../../evil.so', data: 'x' }])), 'UNSAFE_ENTRY');
  assert.strictEqual(rejectCode(buildZip([...baseEntries(), { name: '/abs/evil', data: 'x' }])), 'UNSAFE_ENTRY');
  assert.strictEqual(rejectCode(buildZip([...baseEntries(), { name: 'dir\\evil', data: 'x' }])), 'UNSAFE_ENTRY');
  assert.strictEqual(rejectCode(buildZip([...baseEntries(), { name: 'classes.dex', data: 'dup' }])), 'DUPLICATE_ENTRY');
  assert.strictEqual(rejectCode(buildZip([...baseEntries(), { name: 'secret.bin', data: 'x', flags: 1 }])), 'ENCRYPTED');
  assert.strictEqual(rejectCode(buildZip([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }, { name: 'classes.dex', data: 'x' }])), 'BAD_MANIFEST');
});

// ---------- feasibility ----------
test('feasibility: honest classification, no fake build availability', () => {
  const r = buildFeasibilityReport('Rename my app and replace its icon with my logo, update the colors', { manifest: { labelIsReference: true, labelRef: '@0x7f010001' } });
  const ids = r.items.map((i) => i.id).sort();
  assert.deepStrictEqual(ids, ['icon', 'rename', 'visual']);
  assert.ok(r.items.every((i) => i.feasibility === 'conditionally_supported' && i.buildAvailable === false && i.approvalRequired === true));
  assert.match(r.items.find((i) => i.id === 'rename').reason, /resources\.arsc/);
  assert.strictEqual(r.buildServerAvailable, false); assert.match(r.summary, /not available yet/);
});
test('feasibility: refuses protection bypass, rejects logic changes, flags package rename', () => {
  assert.strictEqual(buildFeasibilityReport('unlock premium and remove ads', null).items[0].feasibility, 'not_permitted');
  assert.ok(buildFeasibilityReport('add a new login screen and change the api url', null).items.some((i) => i.id === 'logic_change' && i.feasibility === 'unsupported'));
  assert.ok(buildFeasibilityReport('change the package name to com.mine.app', null).items.some((i) => i.feasibility === 'requires_manual_review'));
  const u = buildFeasibilityReport('make it better somehow', null);
  assert.strictEqual(u.items[0].id, 'unmapped'); assert.strictEqual(u.items[0].feasibility, 'requires_manual_review');
  const d = buildFeasibilityReport('inspect it and show the permissions', null).items[0];
  assert.strictEqual(d.feasibility, 'supported'); assert.strictEqual(d.buildAvailable, true);
});

// ---------- handler (express/multer/db stubbed) ----------
function setup() {
  routes.length = 0; mws.length = 0;
  createApkStudioRoutes({ layout: (t, b) => b, nav: () => '' });
}
function fakeRes() {
  const r = { code: 200, body: null, headers: {} };
  r.done = new Promise((resolve) => { r.resolve = resolve; });
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; r.resolve(); return r; };
  r.send = (b) => { r.body = b; r.resolve(); return r; };
  r.redirect = (u) => { r.body = u; r.resolve(); return r; };
  r.set = () => r;
  return r;
}
async function call(method, p, req) {
  const route = routes.find((x) => x.m === method && x.p === p);
  assert.ok(route, 'route exists ' + method + ' ' + p);
  const res = fakeRes();
  req.method = method;
  req.get = req.get || ((h) => ({ host: 'x.test' }[h.toLowerCase()]));
  req.session = req.session || { platformUsername: 'adm' + Math.random() };
  req.params = req.params || {}; req.body = req.body || {}; req.query = req.query || {};
  let blocked = false;
  for (const mw of mws) { let nexted = false; await mw(req, res, () => { nexted = true; }); if (!nexted) { blocked = true; break; } }
  if (!blocked) { for (const h of route.h) { await h(req, res, () => {}); if (res.body !== null) break; } }
  await Promise.race([res.done, new Promise((r) => setTimeout(r, 300))]);
  return res;
}
const fileReq = (buf, extra = {}) => { const p = tmp(buf); return { path: p, req: { file: { path: p, size: buf.length, originalname: '../../weird name.apk' }, body: { name: '' }, ...extra } }; };

test('handler: valid upload is stored privately, recorded, audited and temp file removed', async () => {
  setup(); storeCalls.created.length = storeCalls.stored.length = storeCalls.audits.length = 0;
  const { path: p, req } = fileReq(buildZip(baseEntries())); req.body.name = '  My App  ';
  const res = await call('POST', '/upload', req);
  assert.strictEqual(res.code, 200); assert.deepStrictEqual(res.body, { ok: true, projectId: 'p1' });
  const c = storeCalls.created[0];
  assert.strictEqual(c.name, 'My App'); assert.strictEqual(c.originalFilename, 'weird name.apk'); // path stripped
  assert.match(c.sha256, /^[0-9a-f]{64}$/); assert.strictEqual(c.scanStatus, 'not_configured');
  assert.strictEqual(c.analysis.manifest.package, 'com.example.demo');
  assert.strictEqual(storeCalls.audits[0][1], 'upload'); assert.strictEqual(fs.existsSync(p), false);
});
test('handler: non-APK rejected, nothing stored, temp file removed', async () => {
  setup(); storeCalls.created.length = storeCalls.stored.length = 0;
  const { path: p, req } = fileReq(Buffer.from('not an apk at all, just text content here'));
  const res = await call('POST', '/upload', req);
  assert.strictEqual(res.code, 400); assert.match(res.body.error, /Rejected/);
  assert.strictEqual(storeCalls.stored.length, 0); assert.strictEqual(storeCalls.created.length, 0); assert.strictEqual(fs.existsSync(p), false);
});
test('handler: oversize, missing file, cross-origin and rate limit', async () => {
  setup();
  multerState.err = { code: 'LIMIT_FILE_SIZE' };
  let res = await call('POST', '/upload', { body: {} });
  assert.strictEqual(res.code, 400); assert.match(res.body.error, /larger than/); multerState.err = null;
  res = await call('POST', '/upload', { body: {} });
  assert.strictEqual(res.code, 400); assert.match(res.body.error, /No file/);
  res = await call('POST', '/upload', { body: {}, get: (h) => ({ host: 'x.test', origin: 'https://evil.example' }[h.toLowerCase()]) });
  assert.strictEqual(res.code, 403);
  process.env.APK_UPLOADS_PER_HOUR = '2';
  const session = { platformUsername: 'limited-admin' }, codes = [];
  for (let i = 0; i < 3; i++) codes.push((await call('POST', '/upload', { body: {}, session })).code);
  delete process.env.APK_UPLOADS_PER_HOUR;
  assert.deepStrictEqual(codes, [400, 400, 429]);
});
test('handler: attacker-controlled app name is HTML-escaped on the project page', async () => {
  setup();
  const evil = '<img src=x onerror=alert(1)>';
  storeStub.getProject = async () => ({ project: { _id: 'p1', name: evil }, duplicatesElsewhere: 0, requests: [], artifacts: [{
    _id: 'a1', type: 'original', originalFilename: evil + '.apk', sizeBytes: 10, sha256: 'ab', scanStatus: 'not_configured',
    analysis: { manifest: { label: evil, package: evil, versionName: '1', versionCode: 1, minSdk: 1, targetSdk: 2, permissions: [evil] },
      structure: { nativeAbis: [], dexFiles: 1, resFiles: 0, assetFiles: 0 }, signing: { signed: true, schemes: ['v1'], certificates: [{ scheme: 'v1', sha256: 'AA', subject: evil }] },
      integrity: { note: 'n' }, warnings: [evil] } }] });
  const res = await call('GET', '/projects/:id', { params: { id: 'p1' } });
  assert.ok(!res.body.includes('<img src=x'), 'no raw tag');
  assert.ok(res.body.includes('&lt;img src=x'));
  assert.strictEqual(esc('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});
