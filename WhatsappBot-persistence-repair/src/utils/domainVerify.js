'use strict';
/**
 * Domain-ownership verification: the admin must prove control of a domain before an app
 * wrapping it can be generated, by either serving a token file or publishing a DNS TXT record.
 * Uses only Node's built-in https/dns modules — no extra dependency.
 */
const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const crypto = require('crypto');

function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/.test(d)) return null;
  return d;
}

function newToken() { return 'wab_' + crypto.randomBytes(16).toString('hex'); }

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '', size = 0;
      res.on('data', (c) => { size += c.length; if (size > 4096) { req.destroy(); reject(new Error('Response too large')); } else body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

/** Returns { verified, method, detail }. Never throws; failures are reported in `detail`. */
async function verifyDomain(domain, token, { timeoutMs = 8000 } = {}) {
  const errors = [];
  try {
    const body = await fetchText('https://' + domain + '/.well-known/webapp-builder-verify.txt', timeoutMs);
    if (body.trim() === token) return { verified: true, method: 'file', detail: 'Found matching token at /.well-known/webapp-builder-verify.txt' };
    errors.push('Verification file found but did not match the expected token.');
  } catch (e) { errors.push('File check failed: ' + e.message); }
  try {
    const records = await dns.resolveTxt(domain);
    const flat = records.map((r) => r.join('')).join(' ');
    if (flat.includes(token)) return { verified: true, method: 'dns', detail: 'Found matching TXT record.' };
    errors.push('No matching TXT record found.');
  } catch (e) { errors.push('DNS check failed: ' + e.message); }
  return { verified: false, method: null, detail: errors.join(' ') };
}

module.exports = { normalizeDomain, newToken, verifyDomain };
