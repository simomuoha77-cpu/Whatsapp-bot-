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

test('community contact bridge is not exposed when contacts permission is omitted', () => {
  const files = buildAndroidProject({
    packageName: 'com.example.web', appName: 'Web App', domain: 'example.com', permissions: [],
  });
  const java = files['app/src/main/java/com/example/web/MainActivity.java'];
  assert.doesNotMatch(java, /addJavascriptInterface\(new CommunityContactsBridge/);
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
