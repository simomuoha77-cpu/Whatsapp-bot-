'use strict';
/** A real APK is a ZIP (PK header) that contains AndroidManifest.xml. Returns an error string or null. */
function apkProblem(buffer) {
  if (!buffer || buffer.length < 1024) return 'That file is too small to be an APK.';
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) return 'That file is not an APK (not a valid ZIP archive). If you downloaded app-debug-apk.zip from GitHub, unzip it first and upload the .apk inside.';
  if (buffer.indexOf('AndroidManifest.xml') === -1) return 'That archive does not contain AndroidManifest.xml, so it is not an APK.';
  return null;
}

module.exports = { apkProblem };
