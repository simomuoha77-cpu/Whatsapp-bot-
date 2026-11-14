'use strict';
/**
 * Admin page to upload the Android app (APK) that clients can download from their dashboard.
 * Mounted under /admin/app-download AFTER requirePlatformAuth, so every route is admin-only.
 */
const express = require('express');
const multer = require('multer');
const logger = require('../utils/logger');
const store = require('../db/appRelease');
const { apkProblem } = require('../utils/apkCheck');

const MAX_MB = Math.max(1, Number(process.env.APP_APK_MAX_MB) || 100);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');
const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch (e) { return false; }
}

function createAppDownloadAdminRoutes({ layout, nav }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1048576, files: 1, fields: 5, fieldSize: 4 * 1024 } }).single('apk');
  const page = (body) => layout('App Download', nav() + '<h1>App Download</h1>' + body);

  router.get('/', async (req, res) => {
    let release = null;
    try { release = await store.getRelease(); } catch (e) { logger.warn({ err: e && e.message }, 'App release lookup failed'); }
    const msg = req.query.ok === '1' ? '<p style="color:#4ade80">APK uploaded. Clients can now download it from their dashboard.</p>'
      : req.query.removed === '1' ? '<p>APK removed. Clients no longer see the download card.</p>'
      : req.query.error ? '<p style="color:#fca5a5">' + esc(req.query.error) + '</p>' : '';
    res.send(page(`
      ${msg}
      <div class="card">
        <h3>Current app</h3>
        ${release ? `<p><strong>${esc(release.label || release.filename || 'WhatsApp-Bot.apk')}</strong><br>
          <small>${fmtBytes(release.size)} · uploaded ${fmtDate(release.uploadedAt)}<br>SHA-256 ${esc(String(release.sha256 || '').slice(0, 16))}…</small></p>
          <form method="POST" action="/admin/app-download/delete" onsubmit="return confirm('Remove the APK from client dashboards?')"><button class="danger" type="submit">Remove APK</button></form>`
          : '<p>No APK uploaded yet. Clients do not see a download card.</p>'}
      </div>
      <div class="card">
        <h3>Upload ${release ? 'a new version' : 'the APK'}</h3>
        <p><small>Choose the <code>.apk</code> file (unzip app-debug-apk.zip first). Max ${MAX_MB} MB. It replaces the current one and appears on every client dashboard.</small></p>
        <form method="POST" action="/admin/app-download/upload" enctype="multipart/form-data">
          <input type="file" name="apk" accept=".apk,application/vnd.android.package-archive" required />
          <input name="label" maxlength="60" placeholder="Version label, e.g. v1.1 (optional)" />
          <button type="submit">Upload APK</button>
        </form>
      </div>`));
  });

  router.post('/upload', (req, res) => {
    if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-origin request blocked.');
    upload(req, res, async (err) => {
      const back = (q) => res.redirect('/admin/app-download?' + q);
      if (err) return back('error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than ' + MAX_MB + ' MB.' : 'Upload failed. Try again.'));
      if (!req.file) return back('error=' + encodeURIComponent('Choose an APK file first.'));
      const problem = apkProblem(req.file.buffer);
      if (problem) return back('error=' + encodeURIComponent(problem));
      try {
        const label = String(req.body.label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
        await store.saveRelease(req.file.buffer, { filename: String(req.file.originalname || '').slice(0, 120), label, uploadedBy: 'admin' });
        return back('ok=1');
      } catch (e) {
        logger.warn({ err: e && e.message }, 'App release save failed');
        return back('error=' + encodeURIComponent('Could not save the APK. Nothing was changed.'));
      }
    });
  });

  router.post('/delete', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-origin request blocked.');
    try { await store.deleteRelease(); } catch (e) { logger.warn({ err: e && e.message }, 'App release delete failed'); }
    return res.redirect('/admin/app-download?removed=1');
  });

  return router;
}

module.exports = { createAppDownloadAdminRoutes };
