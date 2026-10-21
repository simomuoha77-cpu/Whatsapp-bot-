'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const Module = require('module');

const { buildAndroidProject, validatePackageName, hexColor, sanitizeAppName } = require('../src/utils/androidTemplate');
const { ZipBuilder } = require('../src/utils/zipBuilder');
const { readPng } = require('../src/utils/pngCheck');
const { normalizeDomain, newToken } = require('../src/utils/domainVerify');

// ---------- package / color / name validation ----------
test('validatePackageName accepts dotted lowercase ids, rejects junk and reserved words', () => {
  assert.strictEqual(validatePackageName('com.example.app'), 'com.example.app');
  assert.strictEqual(validatePackageName('com.my_co.app2'), 'com.my_co.app2');
  assert.strictEqual(validatePackageName('notdotted'), null);
  assert.strictEqual(validatePackageName('Com.Example.App'), null);
  assert.strictEqual(validatePackageName('com.1example.app'), null);
  assert.strictEqual(validatePackageName('com.class.app'), null);
  assert.strictEqual(validatePackageName(''), null);
  assert.strictEqual(validatePackageName('com.example."><script>'), null);
});
test('hexColor and sanitizeAppName', () => {
  assert.strictEqual(hexColor('#aabbcc', '#000000'), '#aabbcc');
  assert.strictEqual(hexColor('red', '#000000'), '#000000');
  assert.strictEqual(hexColor('#ggg', '#000000'), '#000000');
  assert.strictEqual(sanitizeAppName('  My <script>App</script>  '), 'My  script App /script');
  assert.strictEqual(sanitizeAppName(''), 'My App');
});
test('normalizeDomain strips scheme/path/port and rejects junk', () => {
  assert.strictEqual(normalizeDomain('https://Example.com/path?x=1'), 'example.com');
  assert.strictEqual(normalizeDomain('example.com:8080'), 'example.com');
  assert.strictEqual(normalizeDomain('sub.example.co.uk'), 'sub.example.co.uk');
  assert.strictEqual(normalizeDomain('not a domain'), null);
  assert.strictEqual(normalizeDomain('javascript:alert(1)'), null);
  assert.strictEqual(normalizeDomain(''), null);
  assert.match(newToken(), /^wab_[0-9a-f]{32}$/);
});

// ---------- PNG check ----------
function crc32(buf) { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const ty = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([ty, data]))); return Buffer.concat([len, ty, data, crc]); }
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function makePng(w, h) { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]); }
test('readPng reads real dimensions and rejects non-PNG', () => {
  assert.deepStrictEqual(readPng(makePng(512, 512)), { width: 512, height: 512 });
  assert.strictEqual(readPng(Buffer.from('this is definitely not a png file at all')), null);
  assert.strictEqual(readPng(Buffer.concat([Buffer.from('\xff\xd8\xff'), Buffer.alloc(20)])), null); // JPEG magic
});

// ---------- zip builder round-trips with a real unzip ----------
test('ZipBuilder output opens correctly with system unzip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-'));
  const z = new ZipBuilder().add('a/b.txt', 'hello').add('big.bin', Buffer.alloc(20000, 7)).add('empty.txt', '');
  fs.writeFileSync(path.join(dir, 't.zip'), z.toBuffer());
  execFileSync('unzip', ['-o', 't.zip'], { cwd: dir });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a/b.txt'), 'utf8'), 'hello');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'big.bin')).length, 20000);
});
test('ZipBuilder rejects unsafe entry names', () => {
  assert.throws(() => new ZipBuilder().add('../evil', 'x'));
  assert.throws(() => new ZipBuilder().add('/abs', 'x'));
});

// ---------- Android project generation ----------
function genProject(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const files = buildAndroidProject(Object.assign({
    packageName: 'com.example.site', appName: 'Demo <App> & "Co"', domain: 'example.com',
    primaryColor: '#112233', permissions: ['camera', 'location'], allowOffDomainLinks: true,
    versionCode: 2, versionName: '1.1', iconBuffer: makePng(512, 512),
  }, overrides));
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(dir, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data);
  }
  return { dir, files };
}
// Pure-JS well-formedness check (balanced, properly nested tags; no unescaped bare `&`/`<`
// in text) so this test has no dependency on an external `xmllint` binary being installed.
function assertWellFormedXml(xml, label) {
  assert.match(xml, /^<\?xml /, label + ': missing XML declaration');
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w.:-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, selfClose] = m;
    if (closing) { assert.strictEqual(stack.pop(), name, label + ': mismatched closing tag </' + name + '>'); }
    else if (!selfClose) stack.push(name);
  }
  assert.strictEqual(stack.length, 0, label + ': unclosed tag(s): ' + stack.join(','));
  // text between tags must not contain a bare & or < (would mean escXml was skipped)
  const textRe = />([^<]*)</g; let t;
  while ((t = textRe.exec(xml))) { assert.doesNotMatch(t[1], /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/, label + ': unescaped & in text'); }
}
test('generated manifest and all XML resources are well-formed, with required permissions', () => {
  const { dir } = genProject({});
  for (const rel of ['app/src/main/AndroidManifest.xml', 'app/src/main/res/values/strings.xml', 'app/src/main/res/values/colors.xml', 'app/src/main/res/values/styles.xml', 'app/src/main/res/layout/activity_main.xml', 'app/src/main/res/xml/file_paths.xml']) {
    assertWellFormedXml(fs.readFileSync(path.join(dir, rel), 'utf8'), rel);
  }
  const manifest = fs.readFileSync(path.join(dir, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android.permission.INTERNET/);
  assert.match(manifest, /android.permission.CAMERA/);
  assert.match(manifest, /android.permission.ACCESS_FINE_LOCATION/);
  assert.doesNotMatch(manifest, /RECORD_AUDIO/);
  const strings = fs.readFileSync(path.join(dir, 'app/src/main/res/values/strings.xml'), 'utf8');
  assert.doesNotMatch(strings, /<App>/); // raw tag must not survive into XML text
});
test('app name is sanitized before XML-escaping (no injected tag, no double-escaping)', () => {
  const { files } = genProject({ appName: 'A & B <script>' });
  assert.match(files['app/src/main/res/values/strings.xml'], /<string name="app_name">A   B  script<\/string>/);
});
test('rejects an invalid package name even if upstream validation is bypassed', () => {
  assert.throws(() => buildAndroidProject({ packageName: 'not valid', appName: 'x', domain: 'example.com' }), /Invalid package name/);
});
test('start URL and host checks use the verified domain, off-domain toggle changes generated behaviour', () => {
  const { files } = genProject({ domain: 'my-site.example', allowOffDomainLinks: true });
  const java = files['app/src/main/java/com/example/site/MainActivity.java'];
  assert.match(java, /START_URL = "https:\/\/my-site\.example\/"/);
  assert.match(java, /HOME_HOST = "my-site\.example"/);
  assert.match(java, /startActivity\(new Intent\(Intent\.ACTION_VIEW, uri\)\); return true;/);
  const blocked = buildAndroidProject({ packageName: 'com.example.site', appName: 'x', domain: 'example.com', allowOffDomainLinks: false });
  assert.match(blocked['app/src/main/java/com/example/site/MainActivity.java'], /off-domain navigation blocked/);
});
test('icon bytes are copied verbatim into every mipmap density, not silently skipped', () => {
  const icon = makePng(256, 256);
  const files = buildAndroidProject({ packageName: 'com.example.site', appName: 'x', domain: 'example.com', iconBuffer: icon });
  for (const dir of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) assert.ok(files['app/src/main/res/mipmap-' + dir + '/ic_launcher.png'].equals(icon));
});
test('no icon provided: project still generates without a launcher icon file', () => {
  const files = buildAndroidProject({ packageName: 'com.example.site', appName: 'x', domain: 'example.com' });
  assert.strictEqual(Object.keys(files).some((k) => k.includes('mipmap')), false);
});
// Pure-JS structural check (consistent indentation, no tabs, keys look like YAML) so this
// test has no dependency on an external YAML library being installed.
test('generated GitHub Actions workflow looks like valid YAML; README is honest about build output', () => {
  const { files } = genProject({});
  const yml = files['.github/workflows/build-apk.yml'];
  assert.doesNotMatch(yml, /\t/, 'YAML must not contain tabs');
  assert.match(yml, /^name: /m); assert.match(yml, /^jobs:/m); assert.match(yml, /^\s+runs-on: ubuntu-latest/m);
  assert.match(yml, /^\s+- uses: actions\/checkout@v4/m); assert.match(yml, /^\s+- uses: actions\/upload-artifact@v4/m);
  const lines = yml.split('\n').filter(Boolean);
  for (const line of lines) { const indent = line.match(/^ */)[0].length; assert.strictEqual(indent % 2, 0, 'uneven indent: ' + JSON.stringify(line)); }
  assert.ok(files['README.md'].includes('not a compiled .apk'));
});

// ============ handler tests (express/multer/db/domainVerify stubbed) ============
(function () {
  const routes = [], mws = [];
  const router = { use: (...a) => mws.push(a[a.length - 1]), get: (p, ...h) => routes.push({ m: 'GET', p, h }), post: (p, ...h) => routes.push({ m: 'POST', p, h }) };
  const multerState = { err: null };
  const stubs = {
    express: Object.assign(() => ({}), { Router: () => router, urlencoded: () => (q, s, n) => n(), json: () => (q, s, n) => n() }),
    multer: Object.assign(() => ({ single: () => (req, res, cb) => cb(multerState.err) }), { diskStorage: () => ({}) }),
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
  for (const k of Object.keys(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: stubs[k] };
  const root = path.join(__dirname, '..', 'src');
  const seed = (rel, exp) => { const f = path.join(root, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
  seed('utils/logger.js', { warn() {}, info() {}, error() {} });

  const db = { projects: new Map() };
  const storeStub = {
    createProject: async (doc) => { const rec = { _id: 'proj' + (db.projects.size + 1), createdAt: new Date(), buildCount: 0, verifiedAt: null, iconStorageKey: null, ...doc }; db.projects.set(rec._id, rec); return rec; },
    getProject: async (id, owner) => { const p = db.projects.get(id); return p && (!owner || p.ownerAdminId === owner) ? p : null; },
    updateProject: async (id, patch) => { const p = db.projects.get(id); Object.assign(p, patch); return p; },
    listProjects: async (owner) => [...db.projects.values()].filter((p) => !owner || p.ownerAdminId === owner),
    deleteProject: async (id) => { db.projects.delete(id); },
    storeIcon: async (buf) => 'iconkey1',
    readIcon: async (key) => Buffer.alloc(0),
    deleteIcon: async () => {},
  };
  seed('db/webApps.js', storeStub);
  let verifyResult = { verified: true, method: 'file', detail: 'ok' };
  seed('utils/domainVerify.js', { normalizeDomain: require('../src/utils/domainVerify').normalizeDomain, newToken: require('../src/utils/domainVerify').newToken, verifyDomain: async () => verifyResult });

  const { createWebAppBuilderRoutes } = require('../src/handlers/webAppBuilder');

  function fakeRes() {
    const r = { code: 200, body: null };
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
    req.session = req.session || { platformUsername: 'adm1' };
    req.params = req.params || {}; req.body = req.body || {};
    let blocked = false;
    for (const mw of mws) { let nexted = false; await mw(req, res, () => { nexted = true; }); if (!nexted) { blocked = true; break; } }
    if (!blocked) for (const h of route.h) { await h(req, res, () => {}); if (res.body !== null) break; }
    await Promise.race([res.done, new Promise((r) => setTimeout(r, 300))]);
    return res;
  }
  function setup() { routes.length = 0; mws.length = 0; db.projects.clear(); createWebAppBuilderRoutes({ layout: (t, b) => b, nav: () => '' }); }

  test('handler: create project validates domain and package name', async () => {
    setup();
    let res = await call('POST', '/projects', { body: { domain: 'not a domain', packageName: 'com.a.b' } });
    assert.strictEqual(res.code, 400); assert.match(res.body.error, /valid domain/);
    res = await call('POST', '/projects', { body: { domain: 'example.com', packageName: 'bad' } });
    assert.strictEqual(res.code, 400); assert.match(res.body.error, /Package name/);
    res = await call('POST', '/projects', { body: { domain: 'https://Example.com/x', packageName: 'com.example.app', appName: 'Hi', primaryColor: '#abcdef' } });
    assert.strictEqual(res.body.ok, true);
    const p = [...db.projects.values()][0];
    assert.strictEqual(p.domain, 'example.com'); assert.strictEqual(p.verifiedAt, null); assert.match(p.verificationToken, /^wab_/);
  });

  test('handler: cross-origin POST blocked', async () => {
    setup();
    const res = await call('POST', '/projects', { body: {}, get: (h) => ({ host: 'x.test', origin: 'https://evil.example' }[h.toLowerCase()]) });
    assert.strictEqual(res.code, 403);
  });

  test('handler: domain verify flips verifiedAt only on success', async () => {
    setup();
    const p = await storeStub.createProject({ ownerAdminId: 'adm1', domain: 'example.com', packageName: 'com.e.a', appName: 'A', primaryColor: '#000', permissions: [], allowOffDomainLinks: true, verificationToken: 't1' });
    verifyResult = { verified: false, method: null, detail: 'nope' };
    let res = await call('POST', '/projects/:id/verify', { params: { id: p._id } });
    assert.strictEqual(res.code, 200); assert.strictEqual(db.projects.get(p._id).verifiedAt, null);
    verifyResult = { verified: true, method: 'dns', detail: 'yep' };
    res = await call('POST', '/projects/:id/verify', { params: { id: p._id } });
    assert.ok(db.projects.get(p._id).verifiedAt);
  });

  test('handler: icon upload requires verified domain, validates real PNG and dimensions', async () => {
    setup();
    const p = await storeStub.createProject({ ownerAdminId: 'adm1', domain: 'example.com', packageName: 'com.e.a', appName: 'A', primaryColor: '#000', permissions: [], allowOffDomainLinks: true, verificationToken: 't1' });
    const tmpFile = path.join(os.tmpdir(), 'icon-' + crypto.randomUUID());
    fs.writeFileSync(tmpFile, makePng(300, 300));
    let res = await call('POST', '/projects/:id/icon', { params: { id: p._id }, file: { path: tmpFile, size: 10 } });
    assert.strictEqual(res.code, 403); assert.match(res.body.error, /Verify the domain/);
    db.projects.get(p._id).verifiedAt = new Date();
    fs.writeFileSync(tmpFile, Buffer.from('not a png'));
    res = await call('POST', '/projects/:id/icon', { params: { id: p._id }, file: { path: tmpFile, size: 9 } });
    assert.strictEqual(res.code, 400); assert.match(res.body.error, /valid PNG/);
    fs.writeFileSync(tmpFile, makePng(100, 300));
    res = await call('POST', '/projects/:id/icon', { params: { id: p._id }, file: { path: tmpFile, size: 10 } });
    assert.strictEqual(res.code, 400); assert.match(res.body.error, /square/);
    fs.writeFileSync(tmpFile, makePng(100, 100));
    res = await call('POST', '/projects/:id/icon', { params: { id: p._id }, file: { path: tmpFile, size: 10 } });
    assert.strictEqual(res.code, 400); assert.match(res.body.error, /at least 192/);
    fs.writeFileSync(tmpFile, makePng(256, 256));
    res = await call('POST', '/projects/:id/icon', { params: { id: p._id }, file: { path: tmpFile, size: 10 } });
    assert.strictEqual(res.body.ok, true); assert.strictEqual(db.projects.get(p._id).iconStorageKey, 'iconkey1');
    assert.strictEqual(fs.existsSync(tmpFile), false);
  });

  test('handler: generate refuses an unverified project and never claims a build', async () => {
    setup();
    const p = await storeStub.createProject({ ownerAdminId: 'adm1', domain: 'example.com', packageName: 'com.e.a', appName: 'A', primaryColor: '#000', permissions: [], allowOffDomainLinks: true, verificationToken: 't1' });
    const res = await call('POST', '/projects/:id/generate', { params: { id: p._id } });
    assert.strictEqual(res.code, 403);
  });

  test('handler: generate produces a downloadable ZIP once verified, increments buildCount', async () => {
    setup();
    const p = await storeStub.createProject({ ownerAdminId: 'adm1', domain: 'example.com', packageName: 'com.example.app', appName: 'A', primaryColor: '#2563eb', permissions: ['camera'], allowOffDomainLinks: true, verificationToken: 't1', verifiedAt: new Date() });
    const res = await call('POST', '/projects/:id/generate', { params: { id: p._id } });
    assert.strictEqual(res.code, 200); assert.ok(Buffer.isBuffer(res.body));
    assert.strictEqual(db.projects.get(p._id).buildCount, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
    fs.writeFileSync(path.join(dir, 'out.zip'), res.body);
    const listing = execFileSync('unzip', ['-l', 'out.zip'], { cwd: dir }).toString();
    assert.match(listing, /AndroidManifest\.xml/);
  });

  test('handler: project is scoped to its owning admin', async () => {
    setup();
    const p = await storeStub.createProject({ ownerAdminId: 'adm1', domain: 'example.com', packageName: 'com.e.a', appName: 'A', primaryColor: '#000', permissions: [], allowOffDomainLinks: true, verificationToken: 't1' });
    const res = await call('GET', '/projects/:id', { params: { id: p._id }, session: { platformUsername: 'someone-else' } });
    assert.strictEqual(res.code, 404);
  });
})();
