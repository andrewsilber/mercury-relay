// Inline file attachments: shared helpers for the CLI (read/save) and relay (validate plaintext attachments).
// Wire/envelope shape: files: [{ name, mime, size, sha256, data /* base64 */ }]. Inside the encrypted v2 payload when E2E.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ATTACH_MAX_DEFAULT = 256 * 1024;
const MIME = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar' };
const mimeOf = name => MIME[(path.extname(name).slice(1) || '').toLowerCase()] || 'application/octet-stream';
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Sanitize a received file name: basename only (no directories, no traversal), safe chars, no leading dots, bounded length.
function safeName(name) {
  let n = String(name || '').replace(/\\/g, '/').split('/').pop().normalize('NFC');
  n = n.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '').replace(/\s+$/, '').slice(0, 120);
  if (!n || n === '.' || n === '..') n = 'file';
  return n;
}
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
// Validate an attachment list (shape + total decoded size). Returns null if ok, else an error string.
function checkFiles(files, max = ATTACH_MAX_DEFAULT) {
  if (files == null) return null;
  if (!Array.isArray(files) || files.length > 20) return 'files must be an array of at most 20 attachments';
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || typeof f.data !== 'string' || !B64.test(f.data)) return 'each attachment needs a name and base64 data';
    total += Buffer.byteLength(f.data, 'base64');
  }
  if (total > max) return `attachments too large: ${fmtSize(total)} exceeds the limit of ${fmtSize(max)} (ATTACH_MAX)`;
  return null;
}
function readFiles(paths, max = ATTACH_MAX_DEFAULT) {
  const out = []; let total = 0;
  for (const p of paths) {
    const st = fs.statSync(p); if (!st.isFile()) throw new Error(`${p} is not a regular file`);
    const buf = fs.readFileSync(p); total += buf.length;
    if (total > max) throw new Error(`attachments too large: ${fmtSize(total)} exceeds the limit of ${fmtSize(max)} (ATTACH_MAX); send a link or split the file`);
    const name = path.basename(p);
    out.push({ name, mime: mimeOf(name), size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64') });
  }
  return out;
}
// Save received attachments under baseDir/<msgId>/<safe-name>. Never executable (mode 0600). Returns printable lines.
function saveFiles(baseDir, msgId, files, label = '') {
  if (!Array.isArray(files) || !files.length) return [];
  const dir = path.join(baseDir, String(msgId).replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64) || 'msg');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const used = new Set(), lines = [];
  for (const f of files) {
    try {
      let n = safeName(f && f.name), base = n, i = 1;
      while (used.has(n.toLowerCase())) { const e = path.extname(base); n = base.slice(0, base.length - e.length) + '-' + i++ + e; }
      used.add(n.toLowerCase());
      const target = path.join(dir, n);
      if (path.dirname(target) !== dir) throw new Error('unsafe file name');
      const buf = Buffer.from(String(f.data || ''), 'base64'), sum = crypto.createHash('sha256').update(buf).digest('hex');
      if (f.sha256 && sum !== String(f.sha256).toLowerCase()) { lines.push(`attachment${label}: ${n} NOT SAVED (sha256 MISMATCH: corrupted or tampered)`); continue; }
      try { fs.unlinkSync(target); } catch {}
      fs.writeFileSync(target, buf, { mode: 0o600, flag: 'wx' });
      lines.push(`attachment${label}: ${target} (${fmtSize(buf.length)}, ${f.sha256 ? 'sha256 ok' : 'no sha256 given'})${n !== String(f.name) ? ` [renamed from ${JSON.stringify(String(f.name).slice(0, 200))}]` : ''}`);
    } catch (e) { lines.push(`attachment${label}: NOT SAVED (${e.message})`); }
  }
  return lines;
}
module.exports = { ATTACH_MAX_DEFAULT, safeName, checkFiles, readFiles, saveFiles, mimeOf, fmtSize };
