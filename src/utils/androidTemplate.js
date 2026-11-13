'use strict';
/**
 * Generates a complete, buildable Android Studio / Gradle project that wraps a verified
 * website in a WebView, as a map of { relativePath: string|Buffer }. This module only
 * produces source files; it does not compile anything (no JDK/Android SDK in this server).
 * Building happens in Android Studio or the included GitHub Actions workflow.
 */
const escXml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function validatePackageName(pkg) {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(String(pkg || '')) && !/\b(int|new|class|package|import|public|private|static|void|return|if|else|switch|default|do|while|for|null|true|false)\b/.test(pkg) ? pkg : null;
}
function hexColor(c, fallback) { return /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : fallback; }
function sanitizeAppName(n) { return String(n || 'My App').replace(/[\u0000-\u001f\u007f<>&"']/g, ' ').trim().slice(0, 50) || 'My App'; }

const PERMISSION_FLAGS = {
  camera: '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />',
  location: '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  microphone: '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  notifications: '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  contacts: '<uses-permission android:name="android.permission.READ_CONTACTS" />\n    <uses-permission android:name="android.permission.WRITE_CONTACTS" />',
};

function buildAndroidProject(config) {
  const pkg = validatePackageName(config.packageName);
  if (!pkg) throw new Error('Invalid package name.');
  const appName = sanitizeAppName(config.appName);
  const domain = config.domain; // must already be a normalized, verified domain (not escaped here — used in a URL, not XML text, except where noted)
  const startUrl = 'https://' + domain + '/';
  const primary = hexColor(config.primaryColor, '#2563EB');
  // Community phonebook sync is a core WhatsApp Bot dashboard feature. Always
  // include its manifest permissions and native bridge; do not depend on an
  // optional admin checkbox that can silently produce an incompatible APK.
  const requestedPermissions = Array.isArray(config.permissions) ? config.permissions.filter((p) => PERMISSION_FLAGS[p]) : [];
  const permissions = [...new Set([...requestedPermissions, 'contacts'])];
  const allowOffDomain = config.allowOffDomainLinks !== false; // default true: links to other domains open in the system browser
  const versionCode = Number.isInteger(config.versionCode) && config.versionCode > 0 ? config.versionCode : 1;
  const versionName = /^[0-9][0-9.]{0,19}$/.test(config.versionName || '') ? config.versionName : '1.0';

  const files = {};

  files['settings.gradle'] = `rootProject.name = "${appName.replace(/"/g, '')}"\ninclude ':app'\n`;
  files['build.gradle'] = `buildscript {\n    repositories { google(); mavenCentral() }\n    dependencies { classpath 'com.android.tools.build:gradle:8.5.2' }\n}\nallprojects { repositories { google(); mavenCentral() } }\n`;
  files['gradle.properties'] = 'android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2048m\n';
  files['gradle/wrapper/gradle-wrapper.properties'] = 'distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip\n';

  files['app/build.gradle'] = `plugins { id 'com.android.application' }\n\nandroid {\n    namespace '${pkg}'\n    compileSdk 34\n    defaultConfig {\n        applicationId "${pkg}"\n        minSdk 24\n        targetSdk 34\n        versionCode ${versionCode}\n        versionName "${versionName}"\n    }\n    buildTypes {\n        release {\n            minifyEnabled false\n            signingConfig signingConfigs.debug // replace with a real release signing config before publishing\n        }\n    }\n    compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }\n}\n\ndependencies {\n    implementation 'androidx.appcompat:appcompat:1.7.0'\n    implementation 'androidx.swiperefreshlayout:swiperefreshlayout:1.1.0'\n    implementation 'androidx.webkit:webkit:1.12.1'\n}\n`;

  const manifestPerms = ['<uses-permission android:name="android.permission.INTERNET" />', '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />', ...permissions.map((p) => PERMISSION_FLAGS[p])].join('\n    ');
  files['app/src/main/AndroidManifest.xml'] = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    ${manifestPerms}\n\n    <application\n        android:label="@string/app_name"\n        android:icon="@mipmap/ic_launcher"\n        android:roundIcon="@mipmap/ic_launcher"\n        android:allowBackup="true"\n        android:theme="@style/AppTheme"\n        android:usesCleartextTraffic="false">\n        <activity android:name=".MainActivity" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">\n            <intent-filter>\n                <action android:name="android.intent.action.MAIN" />\n                <category android:name="android.intent.category.LAUNCHER" />\n            </intent-filter>\n        </activity>\n        <activity android:name="androidx.appcompat.app.AppCompatActivity" android:exported="false" />\n        <provider\n            android:name="androidx.core.content.FileProvider"\n            android:authorities="${pkg}.fileprovider"\n            android:exported="false"\n            android:grantUriPermissions="true">\n            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />\n        </provider>\n    </application>\n</manifest>\n`;

  files['app/src/main/res/xml/file_paths.xml'] = `<?xml version="1.0" encoding="utf-8"?>\n<paths>\n    <external-cache-path name="uploads" path="." />\n</paths>\n`;
  files['app/src/main/res/values/strings.xml'] = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${escXml(appName)}</string>\n</resources>\n`;
  files['app/src/main/res/values/colors.xml'] = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="brand_primary">${primary}</color>\n</resources>\n`;
  files['app/src/main/res/values/styles.xml'] = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <style name="AppTheme" parent="Theme.AppCompat.Light.NoActionBar">\n        <item name="colorPrimary">@color/brand_primary</item>\n        <item name="colorPrimaryDark">@color/brand_primary</item>\n        <item name="android:windowBackground">@color/brand_primary</item>\n    </style>\n</resources>\n`;
  files['app/src/main/res/layout/activity_main.xml'] = `<?xml version="1.0" encoding="utf-8"?>\n<androidx.swiperefreshlayout.widget.SwipeRefreshLayout xmlns:android="http://schemas.android.com/apk/res/android"\n    android:id="@+id/swipe"\n    android:layout_width="match_parent"\n    android:layout_height="match_parent">\n    <WebView\n        android:id="@+id/webview"\n        android:layout_width="match_parent"\n        android:layout_height="match_parent" />\n</androidx.swiperefreshlayout.widget.SwipeRefreshLayout>\n`;

  const pkgPath = 'app/src/main/java/' + pkg.replace(/\./g, '/') + '/MainActivity.java';
  files[pkgPath] = `package ${pkg};

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.ContentProviderOperation;
import android.content.ContentResolver;
import android.database.Cursor;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.*;
import android.provider.ContactsContract;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * Generated by the Website-to-App builder. Loads ${startUrl} in a WebView.
 * Links to other domains ${allowOffDomain ? 'open in the system browser' : 'are blocked'} (see shouldOverrideUrlLoading).
 * Editing this file by hand is fine; re-generating the project will overwrite it.
 */
public class MainActivity extends AppCompatActivity {
    private static final String START_URL = "${startUrl.replace(/"/g, '')}";
    private static final String HOME_HOST = "${domain.replace(/"/g, '')}";
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_CHOOSER_REQUEST = 51;
    private static final int CONTACTS_PERMISSION_REQUEST = 52;
    private String pendingContactsJson;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        SwipeRefreshLayout swipe = findViewById(R.id.swipe);
        webView = findViewById(R.id.webview);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        ${permissions.includes('contacts') ? 'webView.addJavascriptInterface(new CommunityContactsBridge(), "CommunityContacts");' : ''}

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                boolean sameSite = HOME_HOST.equals(uri.getHost()) || (uri.getHost() != null && uri.getHost().endsWith("." + HOME_HOST));
                if (sameSite) return false;
                ${allowOffDomain
                  ? 'startActivity(new Intent(Intent.ACTION_VIEW, uri)); return true;'
                  : 'return true; // off-domain navigation blocked by project configuration'}
            }
            @Override public void onPageFinished(WebView view, String url) { swipe.setRefreshing(false); }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, true, false); }
            @Override public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb, FileChooserParams params) {
                filePathCallback = cb;
                Intent intent = params.createIntent();
                try { startActivityForResult(intent, FILE_CHOOSER_REQUEST); } catch (Exception e) { filePathCallback = null; return false; }
                return true;
            }
        });
        swipe.setOnRefreshListener(() -> webView.reload());

        String[] needed = { ${permissions.map((p) => ({ camera: '"' + 'android.permission.CAMERA' + '"', location: '"android.permission.ACCESS_FINE_LOCATION"', microphone: '"android.permission.RECORD_AUDIO"' }[p])).filter(Boolean).join(', ')} };
        if (needed.length > 0) ActivityCompat.requestPermissions(this, needed, 1);

        if (savedInstanceState == null) webView.loadUrl(START_URL);
    }

    ${permissions.includes('contacts') ? `private class CommunityContactsBridge {
        // Called directly from the dashboard Save button so Android can show
        // its native Contacts permission dialog in response to the user action.
        @JavascriptInterface public void requestContactsPermission() {
            runOnUiThread(() -> {
                boolean readGranted = checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
                boolean writeGranted = checkSelfPermission(Manifest.permission.WRITE_CONTACTS) == PackageManager.PERMISSION_GRANTED;
                if (readGranted && writeGranted) {
                    webView.evaluateJavascript("if(window.communityContactsPermissionResult)window.communityContactsPermissionResult(true)", null);
                } else {
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS}, CONTACTS_PERMISSION_REQUEST);
                }
            });
        }

        @JavascriptInterface public void saveContacts(String json) {
            runOnUiThread(() -> {
                if (checkSelfPermission(Manifest.permission.WRITE_CONTACTS) != PackageManager.PERMISSION_GRANTED || checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
                    pendingContactsJson = json;
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS}, CONTACTS_PERMISSION_REQUEST);
                } else saveContactsNow(json);
            });
        }
    }

    private void saveContactsNow(String json) {
        try {
            JSONArray contacts = new JSONArray(json);
            ContentResolver resolver = getContentResolver();
            for (int i = 0; i < contacts.length(); i++) {
                JSONObject item = contacts.optJSONObject(i);
                if (item == null) continue;
                String name = item.optString("name", "").trim();
                String phone = item.optString("phone_number", "").replaceAll("[^0-9+]", "");
                if (name.isEmpty() || phone.length() < 7) continue;
                Cursor cursor = resolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI.buildUpon().appendPath(Uri.encode(phone)).build(), new String[]{ContactsContract.CommonDataKinds.Phone.CONTACT_ID}, null, null, null);
                boolean exists = cursor != null && cursor.moveToFirst();
                if (cursor != null) cursor.close();
                if (exists) continue;
                ArrayList<ContentProviderOperation> ops = new ArrayList<>();
                ops.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI).withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null).withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build());
                ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0).withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE).withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name).build());
                ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0).withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE).withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone).withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE).build());
                resolver.applyBatch(ContactsContract.AUTHORITY, ops);
            }
        } catch (Exception ignored) { }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CONTACTS_PERMISSION_REQUEST) {
            boolean granted = checkSelfPermission(Manifest.permission.WRITE_CONTACTS) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
            if (pendingContactsJson != null) {
                String payload = pendingContactsJson; pendingContactsJson = null;
                if (granted) saveContactsNow(payload);
            }
            webView.evaluateJavascript("if(window.communityContactsPermissionResult)window.communityContactsPermissionResult(" + (granted ? "true" : "false") + ")", null);
        }
    }` : ''}

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            Uri[] results = (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) ? new Uri[]{ data.getData() } : null;
            if (filePathCallback != null) { filePathCallback.onReceiveValue(results); filePathCallback = null; }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override public void onBackPressed() { if (webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
}
`;

  // Icon: a single source PNG copied into every mipmap bucket. Android will scale it, which is
  // not ideal, but this phase does not include per-density resizing (documented limitation).
  if (config.iconBuffer) {
    for (const dir of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
      files['app/src/main/res/' + dir + '/ic_launcher.png'] = config.iconBuffer;
      files['app/src/main/res/' + dir + '/ic_launcher_round.png'] = config.iconBuffer;
    }
  }

  files['.github/workflows/build-apk.yml'] = `name: Build APK
on: { workflow_dispatch: {}, push: { branches: [ main ] } }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: 'temurin', java-version: '17' }
      - name: Make gradlew executable
        run: chmod +x ./gradlew || true
      - name: Build debug APK
        run: ./gradlew assembleDebug --no-daemon
      - uses: actions/upload-artifact@v4
        with: { name: app-debug-apk, path: app/build/outputs/apk/debug/*.apk }
      # A release build needs a signing key. Add one as repository secrets, then extend this
      # workflow to run "./gradlew assembleRelease" with those secrets — see README.md.
`;

  files['README.md'] = `# ${appName}

Generated by the Website-to-App builder for **${domain}**.

This is Android project **source code**, not a compiled .apk — no Android build tools run on
the WhatsApp Bot server. Build it one of two ways:

1. **Android Studio**: open this folder, then Build → Build Bundle(s)/APK(s) → Build APK(s).
2. **GitHub Actions**: push this folder to a GitHub repository and the included
   `+ '`.github/workflows/build-apk.yml`' + ` will build a debug APK automatically (see the
   repository's Actions tab, then the workflow run's Artifacts).

## What this app does
- Loads \`${startUrl}\` in a full-screen WebView, with pull-to-refresh.
- Links to other domains ${allowOffDomain ? 'open in the phone\'s normal browser' : 'are blocked'}.
- Permissions requested: ${permissions.length ? permissions.join(', ') : 'none beyond internet access'}.
- The debug build from Android Studio or the workflow above is signed with a debug key and is
  for testing only. Before distributing the app, create a real release signing key and update
  \`app/build.gradle\` and the workflow to use it — never commit a real signing key to a public
  repository.
- The app icon is a single image placed at every size; for crisp results on all screens,
  replace the files under \`app/src/main/res/mipmap-*/\` with properly sized icons later.
`;

  return files;
}

module.exports = { buildAndroidProject, validatePackageName, hexColor, sanitizeAppName, PERMISSION_FLAGS };
