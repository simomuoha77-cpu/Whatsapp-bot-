'use strict';
/**
 * APK inspection (Phase 1) — pure JavaScript, no external tools, NEVER executes the APK.
 *
 * Reads the ZIP structure straight from a file descriptor with hard limits, decodes the
 * binary AndroidManifest.xml, and extracts signing information. Nothing is extracted to disk.
 *
 * Limits of this phase (reported honestly in `warnings`):
 *  - the app label / icon are usually resource references; resolving them needs resources.arsc
 *    parsing, which is not implemented, so they are reported as references.
 *  - ZIP64 archives are rejected.
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const LIMITS = {
  maxEntries: 40000,
  maxCentralDirBytes: 16 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
  maxSignatureBlobBytes: 1 * 1024 * 1024,
  maxSigningBlockBytes: 16 * 1024 * 1024,
  maxTotalUncompressed: 6 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1000,
};

class ApkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- low-level ZIP reading ----------
function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, offset + got);
    if (n === 0) throw new ApkError('TRUNCATED', 'File ended unexpectedly.');
    got += n;
  }
  return buf;
}

function unsafeName(name) {
  return !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) || name.split('/').some((seg) => seg === '..');
}

function readCentralDirectory(fd, fileSize) {
  if (fileSize < 22) throw new ApkError('NOT_ZIP', 'File is too small to be an APK.');
  const head = readAt(fd, 0, 4);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new ApkError('NOT_ZIP', 'File is not a ZIP/APK archive (bad signature).');

  const tailLen = Math.min(fileSize, 65557);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ApkError('MALFORMED', 'ZIP end-of-central-directory record not found.');
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ApkError('ZIP64', 'ZIP64 archives are not supported.');
  if (total === 0) throw new ApkError('MALFORMED', 'Archive contains no entries.');
  if (total > LIMITS.maxEntries) throw new ApkError('TOO_MANY_ENTRIES', 'Archive has too many entries.');
  if (cdSize > LIMITS.maxCentralDirBytes || cdOffset + cdSize > fileSize) throw new ApkError('MALFORMED', 'Central directory is out of range.');

  const cd = readAt(fd, cdOffset, cdSize);
  const entries = new Map();
  let p = 0, totalUncompressed = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ApkError('MALFORMED', 'Corrupt central directory entry.');
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ApkError('MALFORMED', 'Corrupt central directory entry.');
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (unsafeName(name)) throw new ApkError('UNSAFE_ENTRY', 'Archive contains an unsafe entry path.');
    if (entries.has(name)) throw new ApkError('DUPLICATE_ENTRY', 'Archive contains duplicate entry names.');
    if (flags & 1) throw new ApkError('ENCRYPTED', 'Archive contains encrypted entries.');
    if (localOffset >= fileSize) throw new ApkError('MALFORMED', 'Entry offset is out of range.');
    totalUncompressed += size;
    entries.set(name, { name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (totalUncompressed > LIMITS.maxTotalUncompressed) throw new ApkError('ZIP_BOMB', 'Archive expands to an unreasonable size.');
  if (fileSize > 0 && totalUncompressed / fileSize > LIMITS.maxCompressionRatio && totalUncompressed > 1024 * 1024 * 1024) {
    throw new ApkError('ZIP_BOMB', 'Archive compression ratio is suspicious.');
  }
  return { entries, cdOffset, totalUncompressed };
}

function readEntry(fd, fileSize, entry, maxBytes) {
  if (entry.size > maxBytes) throw new ApkError('ENTRY_TOO_LARGE', 'Entry ' + entry.name + ' is too large to inspect.');
  const lh = readAt(fd, entry.localOffset, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new ApkError('MALFORMED', 'Corrupt local header.');
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (dataStart + entry.compSize > fileSize) throw new ApkError('MALFORMED', 'Entry data is out of range.');
  const raw = readAt(fd, dataStart, entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }); }
    catch (e) { throw new ApkError('MALFORMED', 'Could not decompress ' + entry.name + '.'); }
  }
  throw new ApkError('UNSUPPORTED_METHOD', 'Unsupported compression method for ' + entry.name + '.');
}

// ---------- binary AndroidManifest.xml (AXML) ----------
function readStringPool(buf, off) {
  const headerSize = buf.readUInt16LE(off + 2), size = buf.readUInt32LE(off + 4);
  const count = buf.readUInt32LE(off + 8), flags = buf.readUInt32LE(off + 16), stringsStart = buf.readUInt32LE(off + 20);
  if (count > 200000) throw new ApkError('BAD_MANIFEST', 'String pool too large.');
  const utf8 = (flags & 0x100) !== 0, end = off + size, out = [];
  for (let i = 0; i < count; i++) {
    let p = off + stringsStart + buf.readUInt32LE(off + headerSize + 4 * i);
    if (p >= end) { out.push(''); continue; }
    try {
      if (utf8) {
        p += (buf[p] & 0x80) ? 2 : 1;
        let blen = buf[p];
        if (blen & 0x80) { blen = ((blen & 0x7f) << 8) | buf[p + 1]; p += 2; } else p += 1;
        out.push(buf.toString('utf8', p, Math.min(p + blen, end)));
      } else {
        let l = buf.readUInt16LE(p);
        if (l & 0x8000) { l = ((l & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 4; } else p += 2;
        out.push(buf.toString('utf16le', p, Math.min(p + l * 2, end)));
      }
    } catch (e) { out.push(''); }
  }
  return out;
}

function parseAxml(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new ApkError('BAD_MANIFEST', 'AndroidManifest.xml is not binary XML.');
  const total = Math.min(buf.readUInt32LE(4), buf.length);
  let off = buf.readUInt16LE(2), pool = [];
  const elements = [];
  while (off + 8 <= total) {
    const type = buf.readUInt16LE(off), size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > total) break;
    if (type === 0x0001) pool = readStringPool(buf, off);
    else if (type === 0x0102) {
      const base = off + 16;
      const name = pool[buf.readUInt32LE(base + 4)] || '';
      const attrStart = buf.readUInt16LE(base + 8), attrSize = buf.readUInt16LE(base + 10), attrCount = buf.readUInt16LE(base + 12);
      const attrs = {};
      for (let i = 0; i < attrCount && i < 512; i++) {
        const a = base + attrStart + i * attrSize;
        if (a + 20 > off + size) break;
        const aName = pool[buf.readUInt32LE(a + 4)] || '';
        const raw = buf.readUInt32LE(a + 8), dt = buf[a + 15], data = buf.readUInt32LE(a + 16);
        let value;
        if (dt === 0x03) value = pool[raw] != null ? pool[raw] : (pool[data] || '');
        else if (dt === 0x10) value = buf.readInt32LE(a + 16);
        else if (dt === 0x11) value = data;
        else if (dt === 0x12) value = data !== 0;
        else if (dt === 0x01) value = { ref: '@0x' + data.toString(16) };
        else value = null;
        if (aName) attrs[aName] = value;
      }
      elements.push({ name, attrs });
    }
    off += size;
  }
  return elements;
}

function summariseManifest(elements) {
  const m = elements.find((e) => e.name === 'manifest');
  if (!m) throw new ApkError('BAD_MANIFEST', 'No <manifest> element found.');
  const out = { package: typeof m.attrs.package === 'string' ? m.attrs.package : null, versionCode: null, versionName: null, split: null,
    minSdk: null, targetSdk: null, permissions: [], label: null, labelIsReference: false, iconIsReference: false, debuggable: false, allowBackup: null };
  if (typeof m.attrs.versionCode === 'number') out.versionCode = m.attrs.versionCode;
  if (typeof m.attrs.versionName === 'string') out.versionName = m.attrs.versionName;
  if (typeof m.attrs.split === 'string') out.split = m.attrs.split;
  const sdk = elements.find((e) => e.name === 'uses-sdk');
  if (sdk) {
    if (typeof sdk.attrs.minSdkVersion === 'number') out.minSdk = sdk.attrs.minSdkVersion;
    if (typeof sdk.attrs.targetSdkVersion === 'number') out.targetSdk = sdk.attrs.targetSdkVersion;
  }
  const perms = new Set();
  for (const e of elements) {
    if ((e.name === 'uses-permission' || e.name === 'uses-permission-sdk-23') && typeof e.attrs.name === 'string') perms.add(e.attrs.name);
  }
  out.permissions = [...perms].sort().slice(0, 300);
  const app = elements.find((e) => e.name === 'application');
  if (app) {
    if (typeof app.attrs.label === 'string') out.label = app.attrs.label;
    else if (app.attrs.label && app.attrs.label.ref) { out.labelIsReference = true; out.labelRef = app.attrs.label.ref; }
    if (app.attrs.icon && app.attrs.icon.ref) out.iconIsReference = true;
    out.debuggable = app.attrs.debuggable === true;
    if (typeof app.attrs.allowBackup === 'boolean') out.allowBackup = app.attrs.allowBackup;
  }
  return out;
}

// ---------- signing ----------
function readTlv(buf, off) {
  if (off + 2 > buf.length) throw new ApkError('BAD_SIGNATURE', 'Truncated DER.');
  const tag = buf[off]; let len = buf[off + 1], p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > buf.length) throw new ApkError('BAD_SIGNATURE', 'Bad DER length.');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  if (p + len > buf.length) throw new ApkError('BAD_SIGNATURE', 'DER length out of range.');
  return { tag, headerStart: off, start: p, end: p + len };
}

/** First X.509 certificate (DER) inside a PKCS#7 SignedData blob (META-INF/*.RSA). */
function certFromPkcs7(buf) {
  const top = readTlv(buf, 0);
  if (top.tag !== 0x30) throw new ApkError('BAD_SIGNATURE', 'Not a PKCS#7 structure.');
  const oid = readTlv(buf, top.start);
  const content = readTlv(buf, oid.end);
  if (content.tag !== 0xa0) throw new ApkError('BAD_SIGNATURE', 'No SignedData content.');
  const sd = readTlv(buf, content.start);
  let pos = sd.start;
  while (pos < sd.end) {
    const t = readTlv(buf, pos);
    if (t.tag === 0xa0) { // [0] certificates
      const cert = readTlv(buf, t.start);
      if (cert.tag !== 0x30) break;
      return buf.subarray(cert.headerStart, cert.end);
    }
    pos = t.end;
  }
  throw new ApkError('BAD_SIGNATURE', 'No certificate found in signature file.');
}

function describeCert(der) {
  const info = { sha256: crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':') };
  try {
    const x = new crypto.X509Certificate(der);
    info.subject = x.subject.replace(/\n/g, ', ').slice(0, 300);
    info.issuer = x.issuer.replace(/\n/g, ', ').slice(0, 300);
    info.validFrom = x.validFrom; info.validTo = x.validTo;
    info.looksLikeDebugKey = /Android Debug/i.test(x.subject);
  } catch (e) { info.parseNote = 'Certificate fingerprint computed, but details could not be parsed.'; }
  return info;
}

const SIG_BLOCK_IDS = { 0x7109871a: 'v2', 0xf05368c0: 'v3', 0x1b93ad61: 'v3.1' };

/** Reads the APK Signing Block (v2/v3/v3.1) located directly before the central directory. */
function readSigningBlock(fd, cdOffset) {
  const result = { schemes: [], certs: [] };
  if (cdOffset < 32) return result;
  const footer = readAt(fd, cdOffset - 24, 24);
  if (footer.toString('latin1', 8, 24) !== 'APK Sig Block 42') return result;
  const blockSize = Number(footer.readBigUInt64LE(0));
  if (blockSize < 24 || blockSize > LIMITS.maxSigningBlockBytes || blockSize + 8 > cdOffset) {
    result.warning = 'Signing block present but has an invalid size.';
    return result;
  }
  const block = readAt(fd, cdOffset - blockSize - 8, blockSize + 8);
  let p = 8; const end = block.length - 24;
  while (p + 12 <= end) {
    const pairLen = Number(block.readBigUInt64LE(p));
    if (pairLen < 4 || p + 8 + pairLen > end) break;
    const id = block.readUInt32LE(p + 8);
    const scheme = SIG_BLOCK_IDS[id];
    if (scheme) {
      result.schemes.push(scheme);
      try {
        const v = block.subarray(p + 12, p + 8 + pairLen);
        // signers(u32) -> signer(u32) -> signedData(u32) -> digests(u32) -> certificates(u32) -> cert(u32 DER)
        let q = 4 + 4 + 4; // skip signers len, signer len, signedData len
        q += 4 + v.readUInt32LE(q); // skip digests
        const certsLen = v.readUInt32LE(q); q += 4;
        const certsEnd = q + certsLen;
        while (q + 4 <= certsEnd && result.certs.length < 5) {
          const l = v.readUInt32LE(q); q += 4;
          if (q + l > v.length) break;
          result.certs.push({ scheme, ...describeCert(v.subarray(q, q + l)) });
          q += l;
        }
      } catch (e) { result.warning = 'Could not read certificate from the ' + scheme + ' signature.'; }
    }
    p += 8 + pairLen;
  }
  return result;
}

// ---------- main entry ----------
function inspectApkFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const { entries, cdOffset, totalUncompressed } = readCentralDirectory(fd, fileSize);
    const names = [...entries.keys()];
    const warnings = [];

    if (entries.has('BundleConfig.pb') || names.some((n) => n.startsWith('base/manifest/'))) {
      throw new ApkError('APP_BUNDLE', 'This is an Android App Bundle (.aab), not an APK. Upload an installable APK.');
    }
    const manifestEntry = entries.get('AndroidManifest.xml');
    if (!manifestEntry) {
      if (names.some((n) => n.toLowerCase().endsWith('.apk'))) {
        throw new ApkError('SPLIT_BUNDLE', 'This looks like a split-APK bundle (XAPK/APKS). Upload a single APK.');
      }
      throw new ApkError('NO_MANIFEST', 'AndroidManifest.xml is missing; this is not an APK.');
    }

    let manifest;
    try { manifest = summariseManifest(parseAxml(readEntry(fd, fileSize, manifestEntry, LIMITS.maxManifestBytes))); }
    catch (e) { if (e instanceof ApkError) throw e; throw new ApkError('BAD_MANIFEST', 'AndroidManifest.xml could not be decoded.'); }
    if (!manifest.package) throw new ApkError('BAD_MANIFEST', 'Manifest has no package name.');

    const dexCount = names.filter((n) => /^classes\d*\.dex$/.test(n)).length;
    const hasArsc = entries.has('resources.arsc');
    const nativeAbis = [...new Set(names.filter((n) => /^lib\/[^/]+\/.+\.so$/.test(n)).map((n) => n.split('/')[1]))].sort();
    if (!dexCount && !hasArsc && !nativeAbis.length) throw new ApkError('NO_CONTENT', 'Archive has no code, resources or native libraries.');
    if (manifest.split) warnings.push('This is a split APK (split="' + manifest.split.slice(0, 60) + '"). It cannot be installed or customised on its own.');

    // v1 (JAR) signatures
    const v1Files = names.filter((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
    const signing = { v1: v1Files.length > 0, schemes: [], certificates: [] };
    for (const f of v1Files.slice(0, 3)) {
      try { signing.certificates.push({ scheme: 'v1', ...describeCert(certFromPkcs7(readEntry(fd, fileSize, entries.get(f), LIMITS.maxSignatureBlobBytes))) }); }
      catch (e) { warnings.push('Could not read v1 signature file ' + f + '.'); }
    }
    if (signing.v1) signing.schemes.push('v1');
    let block = { schemes: [], certs: [] };
    try { block = readSigningBlock(fd, cdOffset); } catch (e) { warnings.push('Could not read the APK signing block.'); }
    if (block.warning) warnings.push(block.warning);
    signing.schemes.push(...block.schemes);
    signing.certificates.push(...block.certs);
    signing.signed = signing.schemes.length > 0;
    signing.primaryFingerprint = (signing.certificates[0] && signing.certificates[0].sha256) || null;
    if (!signing.signed) warnings.push('No signature found. Android will refuse to install an unsigned APK.');
    if (signing.certificates.some((c) => c.looksLikeDebugKey)) warnings.push('Signed with an Android debug certificate; not suitable for distribution.');
    if (manifest.debuggable) warnings.push('The app is marked debuggable.');
    if (manifest.labelIsReference) warnings.push('App name is a resource reference; resolving it needs resources.arsc parsing, which is not available in this phase.');

    return {
      ok: true,
      manifest,
      signing,
      structure: {
        entryCount: entries.size, dexFiles: dexCount, hasResourcesArsc: hasArsc,
        resFiles: names.filter((n) => n.startsWith('res/')).length,
        assetFiles: names.filter((n) => n.startsWith('assets/')).length,
        nativeAbis, uncompressedBytes: totalUncompressed,
      },
      integrity: { zipStructureValid: true, note: 'ZIP structure and manifest verified. Per-file CRC and cryptographic signature verification are not performed in this phase.' },
      warnings,
    };
  } finally { fs.closeSync(fd); }
}

module.exports = { inspectApkFile, ApkError, LIMITS, parseAxml, summariseManifest, certFromPkcs7, describeCert };
