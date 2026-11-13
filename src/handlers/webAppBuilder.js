'use strict';
/**
 * Website → Android App builder. Verifies the admin controls the domain, lets them choose a
 * name, icon, color and permissions, then generates a buildable Android project as a ZIP.
 * Nothing here compiles an APK — see README.md inside the generated project.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');
const store = require('../db/webApps');
const { normalizeDomain, newToken, verifyDomain } = require('../utils/domainVerify');
const { buildAndroidProject, validatePackageName, hexColor, sanitizeAppName, PERMISSION_FLAGS } = require('../utils/androidTemplate');
const { ZipBuilder } = require('../utils/zipBuilder');
const { readPng } = require('../utils/pngCheck');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const ALL_PERMS = Object.keys(PERMISSION_FLAGS);
const MAX_ICON_BYTES = 2 * 1024 * 1024;

const uploadDir = path.join(os.tmpdir(), 'webapp-builder-icons');
function iconUploader() {
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  return multer({ storage: multer.diskStorage({ destination: uploadDir, filename: (r, f, cb) => cb(null, crypto.randomUUID()) }), limits: { fileSize: MAX_ICON_BYTES, files: 1 } }).single('icon');
}

function createWebAppBuilderRoutes({ layout, nav }) {
  const router = express.Router();
  const adminOf = (req) => (req.session && req.session.platformUsername) || 'admin';
  const sub = () => '<nav><a href="/admin/webapp-builder">Projects</a><a href="/admin/webapp-builder/new">New project</a></nav>';
  const page = (title, body) => layout('App Builder — ' + title, nav() + '<h1>Website → Android App Builder</h1>' + sub() + body);
  const fail = (res, err, msg) => { logger.warn({ err: err && err.message }, msg); return res.status(500).send(page('Error', '<p style="color:#f87171">' + esc(msg) + '</p>')); };

  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const src = req.get('origin') || req.get('referer');
    if (src) { try { if (new URL(src).host !== req.get('host')) return res.status(403).json({ ok: false, error: 'Cross-origin request blocked.' }); } catch (e) { return res.status(403).json({ ok: false, error: 'Bad origin.' }); } }
    return next();
  });
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  router.get('/', async (req, res) => {
    try {
      const rows = await store.listProjects(adminOf(req));
      res.send(page('Projects', `
        <a href="/admin/webapp-builder/new"><button type="button">New website → app project</button></a>
        ${rows.length ? rows.map((p) => `<div class="card"><strong>${esc(p.appName)}</strong> <span class="pill ${p.verifiedAt ? 'on' : 'pending'}">${p.verifiedAt ? 'DOMAIN VERIFIED' : 'NOT VERIFIED'}</span><br/>
          <small>${esc(p.domain)} · ${esc(p.packageName)} · created ${fmtDate(p.createdAt)}</small><br/>
          <a href="/admin/webapp-builder/projects/${esc(p._id)}">Open →</a></div>`).join('') : '<p><small>No projects yet.</small></p>'}
      `));
    } catch (err) { fail(res, err, 'Could not load projects.'); }
  });

  router.get('/new', (req, res) => {
    res.send(page('New project', `
      <div class="card">
        <label><small>Website domain you own (e.g. example.com)</small><input id="domain" placeholder="example.com" /></label>
        <label><small>App name</small><input id="appName" maxlength="50" /></label>
        <label><small>Android package name</small><input id="pkg" placeholder="com.yourcompany.app" /></label>
        <label><small>Primary color</small><input id="color" type="color" value="#2563eb" /></label>
        <button type="button" id="createBtn">Create project</button>
        <p id="msg" aria-live="polite"></p>
      </div>
      <script>
      (function(){
        document.getElementById('createBtn').addEventListener('click', function(){
          var b = { domain: document.getElementById('domain').value, appName: document.getElementById('appName').value, packageName: document.getElementById('pkg').value, primaryColor: document.getElementById('color').value };
          var msg = document.getElementById('msg'); msg.textContent = 'Creating…';
          fetch('/admin/webapp-builder/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) })
            .then(function(r){return r.json().then(function(j){ if(!r.ok||!j.ok) throw new Error(j.error||'Failed'); return j; });})
            .then(function(j){ location.href = '/admin/webapp-builder/projects/' + j.projectId; })
            .catch(function(e){ msg.textContent = e.message; });
        });
      })();
      </script>`));
  });

  router.post('/projects', express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const domain = normalizeDomain(req.body && req.body.domain);
      if (!domain) return res.status(400).json({ ok: false, error: 'Enter a valid domain, e.g. example.com' });
      const packageName = validatePackageName(req.body && req.body.packageName);
      if (!packageName) return res.status(400).json({ ok: false, error: 'Package name must look like com.yourcompany.app (lowercase, at least two parts).' });
      const appName = sanitizeAppName(req.body && req.body.appName) || domain;
      const primaryColor = hexColor(req.body && req.body.primaryColor, '#2563EB');
      const token = newToken();
      const p = await store.createProject({ ownerAdminId: adminOf(req), domain, packageName, appName, primaryColor, permissions: ['contacts'], allowOffDomainLinks: true, verificationToken: token, iconStorageKey: null });
      return res.json({ ok: true, projectId: p._id });
    } catch (err) { logger.warn({ err: err && err.message }, 'Create webapp project failed'); return res.status(500).json({ ok: false, error: 'Could not create the project.' }); }
  });

  router.get('/projects/:id', async (req, res) => {
    try {
      const p = await store.getProject(req.params.id, adminOf(req));
      if (!p) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      res.send(page(p.appName, `
        <h2>${esc(p.appName)}</h2>
        <div class="card">
          <div class="row"><span>Domain</span><code>${esc(p.domain)}</code></div>
          <div class="row"><span>Package</span><code>${esc(p.packageName)}</code></div>
          <div class="row"><span>Verification</span><span class="pill ${p.verifiedAt ? 'on' : 'pending'}">${p.verifiedAt ? 'VERIFIED ' + fmtDate(p.verifiedAt) : 'NOT VERIFIED'}</span></div>
        </div>
        ${!p.verifiedAt ? `
        <div class="card">
          <h3>Prove you control ${esc(p.domain)}</h3>
          <p><small>Choose one:</small></p>
          <p><small>1. Serve this file: <code>https://${esc(p.domain)}/.well-known/webapp-builder-verify.txt</code> containing exactly:</small><br/><code>${esc(p.verificationToken)}</code></p>
          <p><small>2. Or publish a DNS TXT record on <code>${esc(p.domain)}</code> containing:</small><br/><code>${esc(p.verificationToken)}</code></p>
          <form method="POST" action="/admin/webapp-builder/projects/${esc(p._id)}/verify"><button type="submit">Check now</button></form>
          ${p.lastVerifyAttempt ? '<p><small>Last attempt: ' + esc(p.lastVerifyAttempt) + '</small></p>' : ''}
        </div>` : `
        <div class="card">
          <h3>App icon</h3>
          <p><small>Square PNG, at least 192×192px, recommended 512×512px.</small></p>
          <input type="file" id="iconFile" accept="image/png" />
          <button type="button" id="iconBtn">Upload icon</button>
          <p id="iconMsg"></p>
          ${p.iconStorageKey ? '<p><small>Icon uploaded.</small></p>' : '<p><small>No icon uploaded yet — a default will be used.</small></p>'}
        </div>
        <div class="card">
          <h3>Permissions the app may request</h3>
          <form method="POST" action="/admin/webapp-builder/projects/${esc(p._id)}/settings">
            ${ALL_PERMS.map((perm) => perm === 'contacts' ? '<label><input type="checkbox" checked disabled style="width:auto"/> contacts (required for automatic community phonebook sync)</label><input type="hidden" name="permissions" value="contacts"/>' : `<label><input type="checkbox" name="permissions" value="${perm}"${p.permissions.includes(perm) ? ' checked' : ''} style="width:auto"/> ${esc(perm)}</label>`).join('<br/>')}
            <br/><label><input type="checkbox" name="allowOffDomainLinks"${p.allowOffDomainLinks ? ' checked' : ''} style="width:auto"/> Open links to other domains in the phone's browser</label>
            <br/><button type="submit">Save settings</button>
          </form>
        </div>
        <form method="POST" action="/admin/webapp-builder/projects/${esc(p._id)}/generate"><button type="submit">Generate Android project (.zip)</button></form>
        <p><small>This downloads source code and a GitHub Actions workflow that builds a debug APK — not a compiled APK directly. See the README inside.</small></p>
        <script>
        document.getElementById('iconBtn').addEventListener('click', function(){
          var f = document.getElementById('iconFile').files[0], msg = document.getElementById('iconMsg');
          if (!f) { msg.textContent = 'Choose a PNG file first.'; return; }
          var fd = new FormData(); fd.append('icon', f);
          msg.textContent = 'Uploading…';
          fetch('/admin/webapp-builder/projects/${esc(p._id)}/icon', { method:'POST', body: fd })
            .then(function(r){return r.json().then(function(j){ if(!r.ok||!j.ok) throw new Error(j.error||'Failed'); return j; });})
            .then(function(){ location.reload(); }).catch(function(e){ msg.textContent = e.message; });
        });
        </script>`}
        <form method="POST" action="/admin/webapp-builder/projects/${esc(p._id)}/delete" onsubmit="return confirm('Delete this project?')"><button class="danger" type="submit">Delete project</button></form>
      `));
    } catch (err) { fail(res, err, 'Could not load the project.'); }
  });

  router.post('/projects/:id/verify', form, async (req, res) => {
    try {
      const p = await store.getProject(req.params.id, adminOf(req));
      if (!p) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      const result = await verifyDomain(p.domain, p.verificationToken);
      await store.updateProject(p._id, { verifiedAt: result.verified ? new Date() : p.verifiedAt, lastVerifyAttempt: fmtDate(new Date()) + ' — ' + result.detail });
      return res.redirect('/admin/webapp-builder/projects/' + encodeURIComponent(p._id));
    } catch (err) { fail(res, err, 'Could not check domain ownership.'); }
  });

  router.post('/projects/:id/icon', (req, res) => {
    iconUploader()(req, res, async (mErr) => {
      const tmp = req.file && req.file.path;
      const cleanup = () => { if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } } };
      try {
        if (mErr) return res.status(400).json({ ok: false, error: mErr.code === 'LIMIT_FILE_SIZE' ? 'Icon is larger than 2 MB.' : 'Upload failed.' });
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });
        const p = await store.getProject(req.params.id, adminOf(req));
        if (!p) return res.status(404).json({ ok: false, error: 'Project not found.' });
        if (!p.verifiedAt) return res.status(403).json({ ok: false, error: 'Verify the domain first.' });
        const buf = fs.readFileSync(tmp);
        const dims = readPng(buf);
        if (!dims) return res.status(400).json({ ok: false, error: 'Not a valid PNG file.' });
        if (dims.width !== dims.height) return res.status(400).json({ ok: false, error: 'Icon must be square (got ' + dims.width + '×' + dims.height + ').' });
        if (dims.width < 192) return res.status(400).json({ ok: false, error: 'Icon must be at least 192×192px (got ' + dims.width + '×' + dims.height + ').' });
        if (p.iconStorageKey) await store.deleteIcon(p.iconStorageKey);
        const key = await store.storeIcon(buf, p._id + '.png');
        await store.updateProject(p._id, { iconStorageKey: key });
        return res.json({ ok: true });
      } catch (err) { logger.warn({ err: err && err.message }, 'Icon upload failed'); return res.status(500).json({ ok: false, error: 'Could not store the icon.' }); }
      finally { cleanup(); }
    });
  });

  router.post('/projects/:id/settings', form, async (req, res) => {
    try {
      const p = await store.getProject(req.params.id, adminOf(req));
      if (!p) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      const raw = req.body.permissions == null ? [] : (Array.isArray(req.body.permissions) ? req.body.permissions : [req.body.permissions]);
      // Keep Contacts enabled for every companion APK: dashboard community
      // sync requires the native bridge and READ/WRITE_CONTACTS declarations.
      const permissions = [...new Set([...raw.filter((x) => ALL_PERMS.includes(x)), 'contacts'])];
      await store.updateProject(p._id, { permissions, allowOffDomainLinks: req.body.allowOffDomainLinks === 'on' });
      return res.redirect('/admin/webapp-builder/projects/' + encodeURIComponent(p._id));
    } catch (err) { fail(res, err, 'Could not save settings.'); }
  });

  router.post('/projects/:id/generate', form, async (req, res) => {
    try {
      const p = await store.getProject(req.params.id, adminOf(req));
      if (!p) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      if (!p.verifiedAt) return res.status(403).send(page('Not verified', '<p>Verify the domain before generating the project.</p>'));
      const iconBuffer = p.iconStorageKey ? await store.readIcon(p.iconStorageKey) : null;
      const files = buildAndroidProject({
        packageName: p.packageName, appName: p.appName, domain: p.domain, primaryColor: p.primaryColor,
        permissions: [...new Set([...(p.permissions || []), 'contacts'])], allowOffDomainLinks: p.allowOffDomainLinks, versionCode: p.buildCount + 1, versionName: '1.0', iconBuffer,
      });
      const zip = new ZipBuilder();
      const root = p.appName.replace(/[^A-Za-z0-9._-]/g, '_') || 'webapp';
      for (const [name, data] of Object.entries(files)) zip.add(root + '/' + name, data);
      const buf = zip.toBuffer();
      await store.updateProject(p._id, { buildCount: p.buildCount + 1, lastBuildAt: new Date() });
      res.set({ 'Content-Type': 'application/zip', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + root + '-android-project.zip"' });
      return res.send(buf);
    } catch (err) { fail(res, err, 'Could not generate the project: ' + (err && err.message)); }
  });

  router.post('/projects/:id/delete', form, async (req, res) => {
    try {
      const p = await store.getProject(req.params.id, adminOf(req));
      if (!p) return res.status(404).send(page('Not found', '<p>Project not found.</p>'));
      await store.deleteProject(p._id);
      return res.redirect('/admin/webapp-builder');
    } catch (err) { fail(res, err, 'Could not delete the project.'); }
  });

  return router;
}

module.exports = { createWebAppBuilderRoutes, esc };
