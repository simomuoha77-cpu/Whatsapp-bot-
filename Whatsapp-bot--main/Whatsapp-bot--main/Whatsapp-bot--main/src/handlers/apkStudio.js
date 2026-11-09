'use strict';
/**
 * APK Studio (Phase 1): upload, inspect, feasibility planning, history.
 * Mounted under /admin/apk-studio AFTER requirePlatformAuth, so every route is admin-only.
 * Does NOT build or modify APKs — that belongs to the isolated build server (Phase 2).
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { inspectApkFile, ApkError } = require('../utils/apkInspect');
const { buildFeasibilityReport, BUILD_SERVER_AVAILABLE } = require('../utils/apkFeasibility');
const store = require('../db/apkStudio');

const cfg = () => ({
  maxMb: Math.max(1, Number(process.env.APK_MAX_MB) || 100),
  perHour: Math.max(1, Number(process.env.APK_UPLOADS_PER_HOUR) || 10),
  retentionDays: Math.max(0, Number(process.env.APK_RETENTION_DAYS) || 0),
  quotaMb: Math.max(1, Number(process.env.APK_STORAGE_QUOTA_MB) || 400),
  workerConfigured: !!process.env.APK_BUILD_WORKER_URL,
});

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');
const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const cleanName = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

const hits = new Map(); // admin -> [timestamps]; in-memory limiter (resets on restart)
function rateLimited(adminId, perHour) {
  const now = Date.now(), list = (hits.get(adminId) || []).filter((t) => now - t < 3600000);
  if (list.length >= perHour) { hits.set(adminId, list); return true; }
  list.push(now); hits.set(adminId, list); return false;
}

const uploadDir = path.join(os.tmpdir(), 'apk-studio-uploads');
function makeUploader() {
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  return multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.upload') }),
    limits: { fileSize: cfg().maxMb * 1048576, files: 1, fields: 5, fieldSize: 8 * 1024 },
  }).single('apk');
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const FEAS_LABEL = { supported: 'Supported now', conditionally_supported: 'Conditionally supported', unsupported: 'Unsupported', requires_manual_review: 'Needs manual review', not_permitted: 'Not permitted' };
const FEAS_CLASS = { supported: 'on', conditionally_supported: 'pending', unsupported: 'off', requires_manual_review: 'pending', not_permitted: 'off' };

function renderReport(report) {
  return '<p><small>' + esc(report.summary) + '</small></p>' + report.items.map((i) => `
    <div class="card">
      <strong>${esc(i.requestedChange)}</strong> <span class="pill ${FEAS_CLASS[i.feasibility]}">${esc(FEAS_LABEL[i.feasibility])}</span>
      <p><small><b>Why:</b> ${esc(i.reason)}</small></p>
      <p><small><b>Risk:</b> ${esc(i.risk)}</small></p>
      <p><small><b>Proposed action:</b> ${esc(i.proposedAction)}</small></p>
      <p><small>${i.approvalRequired ? 'Needs your explicit approval before any build. ' : ''}${i.buildAvailable ? '' : 'Build not available yet.'}</small></p>
    </div>`).join('') + '<details><summary><small>General risks of modifying an APK</small></summary><ul>' + report.generalRisks.map((r) => '<li><small>' + esc(r) + '</small></li>').join('') + '</ul></details>';
}

function createApkStudioRoutes({ layout, nav }) {
  const router = express.Router();
  const adminOf = (req) => (req.session && req.session.platformUsername) || 'admin';
  const sub = () => '<nav><a href="/admin/apk-studio">Overview</a><a href="/admin/apk-studio/new">New project</a><a href="/admin/apk-studio/projects">Projects</a><a href="/admin/apk-studio/history">History</a><a href="/admin/apk-studio/settings">Settings</a></nav>';
  const page = (title, body) => layout('APK Studio — ' + title, nav() + '<h1>APK Studio</h1>' + sub() + body);
  const fail = (res, err, msg) => { logger.warn({ err: err && err.message }, msg); return res.status(500).send(page('Error', '<p style="color:#f87171">' + esc(msg) + '</p>')); };

  // Same-origin check for state-changing requests (the admin session cookie is the only credential).
  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const src = req.get('origin') || req.get('referer');
    if (src) { try { if (new URL(src).host !== req.get('host')) return res.status(403).json({ ok: false, error: 'Cross-origin request blocked.' }); } catch (e) { return res.status(403).json({ ok: false, error: 'Bad origin.' }); } }
    return next();
  });
  const form = express.urlencoded({ extended: false, limit: '32kb' });

  router.get('/', async (req, res) => {
    try {
      const c = cfg();
      await store.purgeExpired().catch(() => 0);
      const o = await store.overview();
      const pct = Math.round((o.storageBytes / (c.quotaMb * 1048576)) * 100);
      res.send(page('Overview', `
        <div class="card">
          <div class="row"><span>Projects</span><b>${o.projectCount}</b></div>
          <div class="row"><span>Uploaded APKs</span><b>${o.uploadCount}</b></div>
          <div class="row"><span>Builds queued / running</span><b>${o.queued} / ${o.running}</b></div>
          <div class="row"><span>Builds successful / failed</span><b>${o.ok} / ${o.failed}</b></div>
          <div class="row"><span>Build worker</span><span class="pill off">${c.workerConfigured ? 'CONFIGURED (not connected in this phase)' : 'NOT SET UP'}</span></div>
          <div class="row"><span>Storage used</span><b>${fmtBytes(o.storageBytes)} of ${c.quotaMb} MB (${pct}%)</b></div>
        </div>
        ${pct >= 80 ? '<p style="color:#facc15">⚠ Storage is nearly full. Delete old projects.</p>' : ''}
        ${o.expiring ? '<p style="color:#facc15">⚠ ' + o.expiring + ' file(s) will be removed within 7 days under the retention policy.</p>' : ''}
        <p><small>Customization builds are not available yet. Phase 1 covers upload, inspection and planning.</small></p>
        <a href="/admin/apk-studio/new"><button type="button">Start a new project</button></a>
        <h3>Recent activity</h3><div class="card">${o.recent.length ? o.recent.map((a) => '<div class="row"><span>' + esc(a.action) + '</span><small>' + fmtDate(a.timestamp) + '</small></div>').join('') : '<small>No activity yet.</small>'}</div>
        <h3>Recent downloads</h3><div class="card">${o.recentDl.length ? o.recentDl.map((a) => '<div class="row"><span>' + esc(a.safeMetadata && a.safeMetadata.filename) + '</span><small>' + fmtDate(a.timestamp) + '</small></div>').join('') : '<small>No downloads yet.</small>'}</div>
      `));
    } catch (err) { fail(res, err, 'Could not load the overview.'); }
  });

  router.get('/new', (req, res) => {
    const c = cfg();
    res.send(page('New project', `
      <h2>New customization project</h2>
      <div class="card">
        <label><small>Project name (optional)</small><input id="pname" maxlength="80" placeholder="Defaults to the app name" /></label>
        <label><small>APK file (max ${c.maxMb} MB, APK only)</small><input id="apkfile" type="file" accept=".apk,application/vnd.android.package-archive" /></label>
        <button type="button" id="upBtn">Upload and analyse</button>
        <progress id="prog" value="0" max="100" style="width:100%;display:none"></progress>
        <p id="upMsg" aria-live="polite"></p>
        <p><small>Only upload apps you own or have permission to modify. The file is stored privately, checked, and never run.</small></p>
      </div>
      <script>
      (function(){
        var btn=document.getElementById('upBtn'),msg=document.getElementById('upMsg'),prog=document.getElementById('prog');
        btn.addEventListener('click',function(){
          var f=document.getElementById('apkfile').files[0];
          if(!f){msg.textContent='Choose an APK file first.';return;}
          var fd=new FormData();fd.append('name',document.getElementById('pname').value);fd.append('apk',f);
          var x=new XMLHttpRequest();x.open('POST','/admin/apk-studio/upload');x.responseType='json';
          btn.disabled=true;prog.style.display='block';msg.textContent='Uploading…';
          x.upload.onprogress=function(e){if(e.lengthComputable){prog.value=Math.round(e.loaded/e.total*100);}};
          x.onload=function(){var r=x.response||{};if(x.status===200&&r.ok){msg.textContent='Done. Opening project…';location.href='/admin/apk-studio/projects/'+r.projectId;}else{msg.textContent=r.error||('Upload failed ('+x.status+').');btn.disabled=false;}};
          x.onerror=function(){msg.textContent='Network error. Try again.';btn.disabled=false;};
          x.send(fd);
        });
      })();
      </script>`));
  });

  router.post('/upload', (req, res) => {
    const c = cfg();
    const admin = adminOf(req);
    if (rateLimited(admin, c.perHour)) return res.status(429).json({ ok: false, error: 'Upload limit reached. Try again later.' });
    makeUploader()(req, res, async (mErr) => {
      const tmp = req.file && req.file.path;
      const cleanup = () => { if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* already removed */ } } };
      try {
        if (mErr) return res.status(400).json({ ok: false, error: mErr.code === 'LIMIT_FILE_SIZE' ? 'File is larger than the ' + c.maxMb + ' MB limit.' : 'Upload failed.' });
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });
        let analysis;
        try { analysis = inspectApkFile(tmp); }
        catch (e) {
          if (e instanceof ApkError) return res.status(400).json({ ok: false, error: 'Rejected: ' + e.message });
          logger.warn({ err: e && e.message }, 'APK inspection crashed'); return res.status(400).json({ ok: false, error: 'Rejected: the file could not be read as an APK.' });
        }
        const sha256 = await sha256File(tmp);
        const storageKey = await store.storeFile(tmp, crypto.randomUUID() + '.apk'); // generated name; the user's filename is never a path
        const name = cleanName(req.body && req.body.name, 80) || cleanName(analysis.manifest.label, 80) || analysis.manifest.package;
        const { projectId } = await store.createProjectWithArtifact({
          name, adminId: admin, originalFilename: cleanName(path.basename(req.file.originalname || 'app.apk'), 120),
          sizeBytes: req.file.size, sha256, storageKey, analysis, scanStatus: 'not_configured', retentionDays: c.retentionDays,
        });
        await store.audit(admin, 'upload', projectId, { sizeBytes: req.file.size, sha256, package: analysis.manifest.package });
        return res.json({ ok: true, projectId });
      } catch (err) {
        logger.warn({ err: err && err.message }, 'APK upload failed');
        return res.status(500).json({ ok: false, error: 'Could not store the APK. Nothing was saved.' });
      } finally { cleanup(); }
    });
  });

  router.get('/projects', async (req, res) => {
    try {
      const page_ = Math.max(1, parseInt(req.query.page, 10) || 1), size = 10;
      const q = cleanName(req.query.q, 100), status = ['inspected', 'expired'].includes(req.query.status) ? req.query.status : '', sort = ['newest', 'oldest', 'name'].includes(req.query.sort) ? req.query.sort : 'newest';
      const { total, rows } = await store.listProjects({ q, status, sort, page: page_, pageSize: size });
      const pages = Math.max(1, Math.ceil(total / size));
      const qs = (p) => '?q=' + encodeURIComponent(q) + '&status=' + status + '&sort=' + sort + '&page=' + p;
      res.send(page('Projects', `
        <form method="GET" class="card">
          <input name="q" value="${esc(q)}" placeholder="Search name, file or package" />
          <select name="status"><option value="">All statuses</option><option value="inspected"${status === 'inspected' ? ' selected' : ''}>Inspected</option><option value="expired"${status === 'expired' ? ' selected' : ''}>Expired</option></select>
          <select name="sort"><option value="newest"${sort === 'newest' ? ' selected' : ''}>Newest</option><option value="oldest"${sort === 'oldest' ? ' selected' : ''}>Oldest</option><option value="name"${sort === 'name' ? ' selected' : ''}>Name</option></select>
          <button type="submit">Search</button>
        </form>
        ${rows.length ? rows.map((r) => { const a = r.artifact; return `
          <div class="card"><strong>${esc(r.name)}</strong> <span class="pill pending">${esc(r.status)}</span><br/>
          <small>${a ? esc(a.originalFilename) + ' · ' + esc(a.packageName) + ' · v' + esc(a.versionName || a.versionCode || '?') : 'File removed'}<br/>Uploaded ${fmtDate(r.createdAt)} · Latest build: none</small><br/>
          <a href="/admin/apk-studio/projects/${esc(r._id)}">Open →</a></div>`; }).join('') : '<p><small>No projects found.</small></p>'}
        <div class="row"><span>${page_ > 1 ? '<a href="' + qs(page_ - 1) + '">← Prev</a>' : ''}</span><small>Page ${page_} of ${pages} (${total})</small><span>${page_ < pages ? '<a href="' + qs(page_ + 1) + '">Next →</a>' : ''}</span></div>`));
    } catch (err) { fail(res, err, 'Could not load projects.'); }
  });

  router.get('/projects/:id', async (req, res) => {
    try {
      const d = await store.getProject(req.params.id);
      if (!d) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      const a = d.artifacts.find((x) => x.type === 'original');
      const an = a && a.analysis, m = an && an.manifest, s = an && an.signing;
      const latest = d.requests[0];
      res.send(page(d.project.name, `
        <h2>${esc(d.project.name)}</h2>
        ${a ? `
        <div class="card">
          <div class="row"><span>App name</span><b>${esc(m.label || (m.labelIsReference ? '(resource reference)' : 'unknown'))}</b></div>
          <div class="row"><span>Package</span><code>${esc(m.package)}</code></div>
          <div class="row"><span>Version</span><span>${esc(m.versionName || '?')} (code ${esc(m.versionCode == null ? '?' : m.versionCode)})</span></div>
          <div class="row"><span>Android SDK</span><span>min ${esc(m.minSdk == null ? '?' : m.minSdk)} · target ${esc(m.targetSdk == null ? '?' : m.targetSdk)}</span></div>
          <div class="row"><span>File</span><span>${esc(a.originalFilename)} · ${fmtBytes(a.sizeBytes)}</span></div>
          <div class="row"><span>SHA-256</span><code>${esc(a.sha256)}</code></div>
          <div class="row"><span>Security scan</span><span class="pill pending">${a.scanStatus === 'not_configured' ? 'NOT CONFIGURED' : esc(a.scanStatus)}</span></div>
          <div class="row"><span>Native ABIs</span><span>${esc(an.structure.nativeAbis.join(', ') || 'none (Java/Kotlin only)')}</span></div>
          <div class="row"><span>Contents</span><span>${an.structure.dexFiles} dex · ${an.structure.resFiles} resources · ${an.structure.assetFiles} assets</span></div>
          <div class="row"><span>Signing</span><span>${s.signed ? esc(s.schemes.join(', ')) : 'UNSIGNED'}</span></div>
          ${s.certificates.slice(0, 2).map((c) => '<div class="row"><span>Certificate (' + esc(c.scheme) + ')</span><code>' + esc(c.sha256) + '</code></div>' + (c.subject ? '<small>' + esc(c.subject) + '</small>' : '')).join('')}
          <p><small>${esc(an.integrity.note)}</small></p>
          <p><small>App icon preview is not available in this phase.</small></p>
        </div>
        ${d.duplicatesElsewhere ? '<p style="color:#facc15"><small>The same file was uploaded in ' + d.duplicatesElsewhere + ' other project(s).</small></p>' : ''}
        ${an.warnings.length ? '<div class="card"><b>Warnings</b><ul>' + an.warnings.map((w) => '<li><small>' + esc(w) + '</small></li>').join('') + '</ul></div>' : ''}
        <details class="card"><summary>Permissions (${m.permissions.length})</summary>${m.permissions.map((p) => '<div><small><code>' + esc(p) + '</code></small></div>').join('') || '<small>None requested.</small>'}</details>
        <a href="/admin/apk-studio/artifacts/${esc(a._id)}/download"><button type="button">Download original APK</button></a>
        ` : '<p>The original file has been removed.</p>'}
        <h3>Describe the changes you want</h3>
        <form method="POST" action="/admin/apk-studio/projects/${esc(d.project._id)}/plan" class="card">
          <textarea name="description" rows="4" maxlength="2000" required style="width:100%;font-size:16px;background:#1c1c1c;color:#eee;border:1px solid #333;border-radius:6px;padding:8px;box-sizing:border-box" placeholder="Example: rename the app and replace its icon with my company logo"></textarea>
          <button type="submit">Check what is possible</button>
        </form>
        ${latest ? '<h3>Latest feasibility report</h3><p><small>' + fmtDate(latest.createdAt) + ' — “' + esc(latest.description.slice(0, 200)) + '”</small></p>' + renderReport(latest.report) : ''}
        ${d.requests.length > 1 ? '<details><summary><small>Earlier requests (' + (d.requests.length - 1) + ')</small></summary>' + d.requests.slice(1).map((r) => '<p><small>' + fmtDate(r.createdAt) + ' — ' + esc(r.description.slice(0, 200)) + '</small></p>').join('') + '</details>' : ''}
        <h3>Delete project</h3>
        <form method="POST" action="/admin/apk-studio/projects/${esc(d.project._id)}/delete" onsubmit="return confirm('Permanently delete this project and its APK files?')"><button class="danger" type="submit">Delete project and files</button></form>
      `));
    } catch (err) { fail(res, err, 'Could not load the project.'); }
  });

  router.post('/projects/:id/plan', form, async (req, res) => {
    try {
      const d = await store.getProject(req.params.id);
      if (!d) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      const description = cleanName(req.body.description, 2000);
      if (!description) return res.redirect('/admin/apk-studio/projects/' + encodeURIComponent(d.project._id));
      const a = d.artifacts.find((x) => x.type === 'original');
      const report = buildFeasibilityReport(description, a && a.analysis && a.analysis.manifest ? { manifest: a.analysis.manifest } : null);
      await store.addRequest({ projectId: d.project._id, adminId: adminOf(req), description, report });
      await store.audit(adminOf(req), 'plan', d.project._id, { items: report.items.map((i) => i.id + ':' + i.feasibility) });
      return res.redirect('/admin/apk-studio/projects/' + encodeURIComponent(d.project._id));
    } catch (err) { fail(res, err, 'Could not save the request.'); }
  });

  router.post('/projects/:id/delete', form, async (req, res) => {
    try {
      const d = await store.getProject(req.params.id);
      if (!d) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      const n = await store.deleteProject(d.project._id);
      await store.audit(adminOf(req), 'delete', d.project._id, { filesRemoved: n });
      return res.redirect('/admin/apk-studio/projects');
    } catch (err) { fail(res, err, 'Could not delete the project.'); }
  });

  router.get('/artifacts/:id/download', async (req, res) => {
    try {
      const a = await store.getArtifact(req.params.id);
      if (!a || !a.privateStorageKey) return res.status(404).send(page('Not found', '<p>File not found or already removed.</p>'));
      await store.audit(adminOf(req), 'download', a.projectId, { filename: a.originalFilename, sha256: a.sha256 });
      const stream = await store.openDownload(a.privateStorageKey);
      res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': a.sizeBytes, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="' + a.originalFilename.replace(/[^A-Za-z0-9._-]/g, '_') + '"' });
      stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
      stream.pipe(res);
    } catch (err) { fail(res, err, 'Could not download the file.'); }
  });

  router.get('/history', async (req, res) => {
    try {
      const [builds, reqs] = await Promise.all([store.recentBuilds(20), store.recentRequests(20)]);
      res.send(page('History', `
        <h3>Build history</h3>
        ${builds.length ? builds.map((b) => '<div class="card"><b>' + esc(b._id) + '</b> ' + esc(b.status) + '</div>').join('') : '<p><small>No builds yet. Builds arrive with the build server (Phase 2).</small></p>'}
        <h3>Customization requests</h3>
        ${reqs.length ? reqs.map((r) => '<div class="card"><strong>' + esc(r.projectName) + '</strong><br/><small>' + fmtDate(r.createdAt) + ' — ' + esc(r.description.slice(0, 200)) + '<br/>' + esc(r.report.items.map((i) => i.requestedChange + ': ' + FEAS_LABEL[i.feasibility]).join(' · ')) + '</small></div>').join('') : '<p><small>No requests yet.</small></p>'}`));
    } catch (err) { fail(res, err, 'Could not load history.'); }
  });

  router.get('/settings', (req, res) => {
    const c = cfg();
    res.send(page('Settings', `
      <h3>Security and limits</h3>
      <div class="card">
        <div class="row"><span>Maximum upload size</span><b>${c.maxMb} MB</b></div>
        <div class="row"><span>Uploads per hour</span><b>${c.perHour}</b></div>
        <div class="row"><span>Retention (0 = keep)</span><b>${c.retentionDays} days</b></div>
        <div class="row"><span>Storage quota (warning)</span><b>${c.quotaMb} MB</b></div>
        <div class="row"><span>Build worker</span><b>${c.workerConfigured ? 'URL set' : 'Not set up'}</b></div>
        <div class="row"><span>Build concurrency</span><b>n/a (no builds yet)</b></div>
        <div class="row"><span>Virus/malware scan</span><b>Not configured</b></div>
      </div>
      <p><small>These come from server environment variables, so nothing sensitive reaches the browser: APK_MAX_MB, APK_UPLOADS_PER_HOUR, APK_RETENTION_DAYS, APK_STORAGE_QUOTA_MB, APK_BUILD_WORKER_URL.</small></p>
      <h3>Allowed customization operations</h3>
      <div class="card">
        <div class="row"><span>Inspect and diagnostic report</span><span class="pill on">AVAILABLE</span></div>
        <div class="row"><span>Change app name</span><span class="pill pending">NEEDS BUILD SERVER</span></div>
        <div class="row"><span>Replace icon</span><span class="pill pending">NEEDS BUILD SERVER</span></div>
        <div class="row"><span>Change colours</span><span class="pill pending">NEEDS BUILD SERVER</span></div>
        <div class="row"><span>Change features or code</span><span class="pill off">NOT SUPPORTED</span></div>
      </div>`));
  });

  return router;
}

module.exports = { createApkStudioRoutes, esc };
