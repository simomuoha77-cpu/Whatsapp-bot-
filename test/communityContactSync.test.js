const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAndroidProject } = require('../src/utils/androidTemplate');

test('community contact APK permission generates a native phonebook bridge', () => {
  const files = buildAndroidProject({
    packageName: 'com.example.community',
    appName: 'Community Contacts',
    domain: 'example.com',
    permissions: ['contacts'],
  });
  const manifest = files['app/src/main/AndroidManifest.xml'];
  const java = files['app/src/main/java/com/example/community/MainActivity.java'];
  assert.match(manifest, /android\.permission\.READ_CONTACTS/);
  assert.match(manifest, /android\.permission\.WRITE_CONTACTS/);
  assert.match(java, /addJavascriptInterface\(new CommunityContactsBridge\(\), "CommunityContacts"\)/);
  assert.match(java, /requestPermissions/);
  assert.match(java, /requestContactsPermission/);
  assert.match(java, /ContactsContract\.RawContacts\.CONTENT_URI/);
  assert.match(java, /ContactsContract\.CommonDataKinds\.Phone\.CONTENT_ITEM_TYPE/);
});

function gen(permissions, pkg = 'com.example.web') {
  const files = buildAndroidProject({ packageName: pkg, appName: 'Web App', domain: 'example.com', permissions });
  return { manifest: files['app/src/main/AndroidManifest.xml'], java: files['app/src/main/java/' + pkg.replace(/\./g, '/') + '/MainActivity.java'] };
}
function assertContactsBridge({ manifest, java }) {
  assert.match(manifest, /android\.permission\.READ_CONTACTS/);
  assert.match(manifest, /android\.permission\.WRITE_CONTACTS/);
  assert.match(java, /addJavascriptInterface\(new CommunityContactsBridge\(\), "CommunityContacts"\)/);
  assert.match(java, /void requestContactsPermission\(\)/);
  assert.match(java, /requestPermissions\(MainActivity\.this, new String\[\]\{Manifest\.permission\.READ_CONTACTS, Manifest\.permission\.WRITE_CONTACTS\}, CONTACTS_PERMISSION_REQUEST\)/);
  assert.match(java, /communityContactsPermissionResult\(" \+ \(granted \? "true" : "false"\)/);
  assert.match(java, /void openAppSettings\(\)/);
  assert.match(java, /void finishSync\(String activeJson\)/);
  assert.match(java, /SOURCE_ID \+ " LIKE \?[^;]*"community:%"/, 'cleanup must only touch contacts created by this feature');
  assert.match(java, /withValue\(ContactsContract\.RawContacts\.SOURCE_ID, sourceId\)/);
  assert.doesNotMatch(java, /catch \(Exception ignored\)/, 'contact errors must not be swallowed');
}

test('contacts are mandatory: permissions [] still generates READ/WRITE_CONTACTS and the full bridge', () => {
  assertContactsBridge(gen([]));
});
test('contacts are mandatory: permissions [camera] keeps camera and adds the bridge', () => {
  const g = gen(['camera']);
  assertContactsBridge(g);
  assert.match(g.manifest, /android\.permission\.CAMERA/);
});
test('contacts are mandatory: legacy project with no permissions field at all', () => {
  const files = buildAndroidProject({ packageName: 'com.example.old', appName: 'Old', domain: 'example.com' });
  assertContactsBridge({ manifest: files['app/src/main/AndroidManifest.xml'], java: files['app/src/main/java/com/example/old/MainActivity.java'] });
});
test('generated MainActivity has balanced braces for every permission set', () => {
  for (const perms of [[], ['camera'], ['camera', 'location', 'microphone', 'contacts']]) {
    const { java } = gen(perms);
    assert.equal((java.match(/\{/g) || []).length, (java.match(/\}/g) || []).length);
  }
});

test('missing bridge stops Save with an error (never submits, never claims Saved)', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/client'), 'utf8');
  const fn = source.slice(source.indexOf('submitCommunitySettings = function'), source.indexOf('communityContactSync(){'));
  const missing = fn.slice(0, fn.indexOf('window.communitySettingsFormPending = form'));
  assert.match(missing, /does not include the Contacts permission bridge/);
  assert.doesNotMatch(missing, /\.submit/);
});

// ---- directory behaviour against an in-memory Mongo stand-in ----
function fakeDb() {
  const rows = [];
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.entries(v).every(([op, x]) => (op === '$ne' ? row[k] !== x : op === '$gt' ? row[k] > x : true));
    }
    return row[k] === v;
  });
  const col = {
    findOne: async (q) => { const r = rows.find((x) => match(x, q)); return r ? { ...r } : null; },
    updateOne: async (f, u, o) => {
      let r = rows.find((x) => match(x, f));
      if (!r && o && o.upsert) { r = { ...u.$setOnInsert }; rows.push(r); }
      if (r) Object.assign(r, u.$set);
    },
    deleteOne: async (f) => { const i = rows.findIndex((x) => match(x, f)); if (i >= 0) rows.splice(i, 1); },
    find: (q) => { let out = rows.filter((x) => match(x, q)).map((x) => ({ ...x })); const c = { sort: (s) => { const [k, d] = Object.entries(s)[0]; out.sort((a, b) => (a[k] > b[k] ? d : a[k] < b[k] ? -d : 0)); return c; }, limit: (n) => { out = out.slice(0, n); return c; }, toArray: async () => out }; return c; },
  };
  return { collection: () => col, rows };
}
function loadDirectory() {
  const mongoPath = require.resolve('../src/db/mongo');
  const dbPath = require.resolve('../src/db/communityContacts');
  const db = fakeDb();
  require.cache[mongoPath] = { id: mongoPath, filename: mongoPath, loaded: true, exports: { getDb: async () => db } };
  delete require.cache[dbPath];
  return { dir: require(dbPath), db };
}

test('directory: members receive each other in both directions, never themselves', async () => {
  const { dir } = loadDirectory();
  await dir.registerCommunityContact({ botId: 1, name: 'John', phoneNumber: '0711111111' });
  assert.deepEqual(await dir.getCommunityContacts(1), []);
  await dir.registerCommunityContact({ botId: 2, name: 'Mary', phoneNumber: '254722222222' });
  assert.deepEqual((await dir.getCommunityContacts(2)).map((c) => c.name), ['John']);
  assert.deepEqual((await dir.getCommunityContacts(1)).map((c) => c.name), ['Mary']);
  await dir.registerCommunityContact({ botId: 3, name: 'Peter', phoneNumber: '254733333333' });
  assert.deepEqual((await dir.getCommunityContacts(3)).map((c) => c.name).sort(), ['John', 'Mary']);
  assert.deepEqual((await dir.getCommunityContacts(1)).map((c) => c.name).sort(), ['Mary', 'Peter']);
});
test('directory: local numbers are stored in international format', async () => {
  const { dir } = loadDirectory();
  await dir.registerCommunityContact({ botId: 1, name: 'John', phoneNumber: '0768380272' });
  assert.equal((await dir.getCommunityContactForBot(1)).phone_number, '254768380272');
});
test('directory: duplicate number across members is rejected, re-joining updates in place', async () => {
  const { dir, db } = loadDirectory();
  await dir.registerCommunityContact({ botId: 1, name: 'John', phoneNumber: '0711111111' });
  await assert.rejects(dir.registerCommunityContact({ botId: 2, name: 'Imposter', phoneNumber: '254711111111' }), /already used/);
  await dir.registerCommunityContact({ botId: 1, name: 'Johnny', phoneNumber: '0711111111' });
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].name, 'Johnny');
});
test('directory: opted-out and deleted members are no longer shared', async () => {
  const { dir } = loadDirectory();
  await dir.registerCommunityContact({ botId: 1, name: 'John', phoneNumber: '0711111111' });
  await dir.registerCommunityContact({ botId: 2, name: 'Mary', phoneNumber: '0722222222' });
  await dir.withdrawCommunityContact(1);
  assert.deepEqual(await dir.getCommunityContacts(2), []);
  await dir.registerCommunityContact({ botId: 1, name: 'John', phoneNumber: '0711111111' });
  await dir.deleteCommunityContact(1);
  assert.equal(await dir.getCommunityContactForBot(1), null);
  assert.deepEqual(await dir.getCommunityContacts(2), []);
});
test('directory: pagination returns every member exactly once', async () => {
  const { dir } = loadDirectory();
  for (let i = 0; i < 25; i++) await dir.registerCommunityContact({ botId: 100 + i, name: 'M' + i, phoneNumber: '2547' + String(10000000 + i) });
  await dir.registerCommunityContact({ botId: 1, name: 'Me', phoneNumber: '0700000001' });
  const seen = []; let after = '', pages = 0;
  for (;;) {
    const page = await dir.getCommunityContactsPage(1, { after, limit: 10 });
    seen.push(...page.contacts.map((c) => c.phone_number)); pages++;
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  assert.ok(!seen.includes('254700000001'));
});

test('routes: directory API and delete are behind client auth, community save is optional at registration', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/client'), 'utf8');
  const useAuth = source.indexOf('router.use(requireClientAuth)');
  assert.ok(useAuth > 0);
  for (const route of ["router.get('/api/community-contacts'", "router.post('/settings/community-contacts/delete'", "router.post('/settings/community-contacts'"]) {
    assert.ok(source.indexOf(route) > useAuth, route + ' must be registered after requireClientAuth');
  }
});

test('registration does not require community name or consent; dashboard has optional opt-in settings', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/client'), 'utf8');
  const registerView = source.slice(source.indexOf("router.get('/register'"), source.indexOf("router.post('/register'"));
  const registerPost = source.slice(source.indexOf("router.post('/register'"), source.indexOf("router.get('/login'"));
  assert.doesNotMatch(registerView, /name="displayName"|communityConsent/);
  assert.doesNotMatch(registerPost, /communityConsent|registerCommunityContact/);
  assert.match(source, /router\.post\('\/settings\/community-contacts'/);
  assert.match(source, /Automatic Community Contact Sync/);
  assert.match(source, /name="displayName"/);
  assert.match(source, /name="enabled"/);
  assert.match(source, /requestContactsPermission\(\)/);
 });


test('save waits for native permission result and blocks silently missing APK bridge', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/client'), 'utf8');
  assert.match(source, /submitCommunitySettings = function\(event, form\)/);
  assert.match(source, /This APK does not include the Contacts permission bridge/);
  assert.match(source, /fetch\(pending\.action, \{\s*method: 'POST'/);
  assert.match(source, /if \(!r\.ok\) throw new Error\('server returned ' \+ r\.status\)/);
  assert.match(source, /Nothing was saved\. Tap Save to try again\./);
  assert.match(source, /communityContactsPermissionResult = function\(granted, permanent\)/);
});

test('native permission result is returned to WebView after Android permission dialog', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/utils/androidTemplate'), 'utf8');
  assert.match(source, /communityContactsPermissionResult\(true\)/);
  assert.match(source, /communityContactsPermissionResult\(" \+ \(granted \? "true" : "false"\)/);
});

test('Web App Builder always includes Contacts bridge for old and new projects', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/webAppBuilder'), 'utf8');
  assert.match(source, /permissions: \['contacts'\]/);
  assert.match(source, /new Set\(\['contacts', \.\.\.raw\.filter/);
  assert.match(source, /new Set\(\['contacts', \.\.\.\(p\.permissions \|\| \[\]\)\]\)/);
  assert.match(source, /contacts \(required for automatic community phonebook sync\)/);
});

test('cancelled permission-gated submit is not overwritten by generic Loading handler', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/client'), 'utf8');
  assert.match(source, /document\.addEventListener\('submit', \(e\) => \{[\s\S]*?if \(e\.defaultPrevented\) return;/);
});

test('page prunes only after a complete successful pass and only for participating members', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/handlers/client'), 'utf8');
  assert.match(source, /data\.member && typeof window\.CommunityContacts\.finishSync === 'function'/);
  assert.match(source, /member: false/);
  assert.match(source, /Android cannot save community contacts to your phonebook until you allow it/);
});

test('manifest only references the launcher icon when an icon file is generated', () => {
  const none = buildAndroidProject({ packageName: 'com.example.n', appName: 'N', domain: 'example.com' });
  assert.doesNotMatch(none['app/src/main/AndroidManifest.xml'], /ic_launcher/);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const withIcon = buildAndroidProject({ packageName: 'com.example.n', appName: 'N', domain: 'example.com', iconBuffer: png });
  assert.match(withIcon['app/src/main/AndroidManifest.xml'], /@mipmap\/ic_launcher/);
  assert.ok(withIcon['app/src/main/res/mipmap-mdpi/ic_launcher.png']);
});

test('app/build.gradle pins the Kotlin BOM to avoid duplicate-class build failures', () => {
  const files = buildAndroidProject({ packageName: 'com.example.k', appName: 'K', domain: 'example.com' });
  assert.match(files['app/build.gradle'], /platform\('org\.jetbrains\.kotlin:kotlin-bom:1\.8\.22'\)/);
});
