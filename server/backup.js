// Automatic backups for the JSON-file backend: every intervalMs write a timestamped copy of the state to dir (temp file + rename),
// keeping the newest `keep`. Postgres deployments should use the provider's backups (plus GET /admin/api/export).
'use strict';
const fs = require('fs'), path = require('path');
const NAME = /^data-\d{8}T\d{6}Z\.json$/;
module.exports = function startAutoBackup({ getData, dir, intervalMs, keep = 14, firstDelayMs = 60e3 }) {
  const status = { enabled: intervalMs > 0, dir, intervalSeconds: intervalMs / 1000, keep, last: null, lastError: null, count: 0 };
  const list = () => { try { return fs.readdirSync(dir).filter(f => NAME.test(f)).sort(); } catch { return []; } };
  const last = list().pop(); if (last) { try { const st = fs.statSync(path.join(dir, last)); status.last = { at: st.mtime.toISOString(), file: last, bytes: st.size }; } catch {} }
  status.count = list().length;
  function run() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date(), name = 'data-' + now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '.json';
      const json = JSON.stringify(getData()), tmp = path.join(dir, '.' + name + '.tmp');
      fs.writeFileSync(tmp, json); fs.renameSync(tmp, path.join(dir, name));
      const all = list(); for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, f));
      status.last = { at: now.toISOString(), file: name, bytes: Buffer.byteLength(json) }; status.lastError = null; status.count = Math.min(all.length, keep);
    } catch (e) { status.lastError = e.message; console.error('backup failed: ' + e.message); }
  }
  if (status.enabled) {
    setTimeout(() => { run(); setInterval(run, intervalMs).unref(); }, Math.min(firstDelayMs, intervalMs)).unref();
  }
  status.run = run;
  return status;
};
