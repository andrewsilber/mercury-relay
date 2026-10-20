#!/usr/bin/env node
// Restore a backup/export JSON (same format as data.json, GET /admin/api/export, dump-store.js). STOP THE RELAY FIRST.
//   JSON-file backend:  DATA_FILE=/var/data/data.json node server/restore-backup.js backup.json [--force]
//   Postgres backend:   DATABASE_URL=... node server/restore-backup.js backup.json [--force]   (delegates to migrate-file-to-pg.js)
// Refuses to replace existing data without --force; for the file backend the old file is kept as <DATA_FILE>.pre-restore-<time>.
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), force = args.includes('--force'), src = args.find(a => !a.startsWith('--'));
if (!src) { console.error('usage: node server/restore-backup.js <backup.json> [--force]'); process.exit(2); }
let data; try { data = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { console.error('cannot read backup: ' + e.message); process.exit(1); }
if (!data || typeof data !== 'object' || !data.handles) { console.error('not a relay backup (no "handles")'); process.exit(1); }
if (process.env.DATABASE_URL) { process.argv = [process.argv[0], path.join(__dirname, 'migrate-file-to-pg.js'), src, ...(force ? ['--force'] : [])]; require('./migrate-file-to-pg.js'); }
else {
  const file = process.env.DATA_FILE || './data.json';
  if (fs.existsSync(file)) {
    if (!force) { console.error(`${file} exists; re-run with --force to replace it (the current file is kept as a .pre-restore copy).`); process.exit(1); }
    fs.copyFileSync(file, file + '.pre-restore-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
  }
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file);
  console.log(`Restored ${src} into ${file}: ${Object.keys(data.handles).length} handles, ${Object.keys(data.spaces || {}).length} spaces. Start the relay.`);
}
