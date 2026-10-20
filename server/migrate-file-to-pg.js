#!/usr/bin/env node
// One-shot import of a JSON data file into Postgres:  DATABASE_URL=postgres://... node server/migrate-file-to-pg.js [data.json] [--force]
// Stop the relay first (single-instance). Refuses to overwrite a non-empty database unless --force. Safe to re-run with --force.
'use strict';
const fs = require('fs');
const createPgStore = require('../core/store-postgres.js');
(async () => {
  const args = process.argv.slice(2), force = args.includes('--force');
  const file = args.find(a => !a.startsWith('--')) || process.env.DATA_FILE || './data.json';
  const url = process.env.DATABASE_URL; if (!url) { console.error('Set DATABASE_URL (and optionally DATABASE_SCHEMA).'); process.exit(2); }
  const src = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = createPgStore({ url, schema: process.env.DATABASE_SCHEMA || 'public' });
  await store.init();
  const data = store.load();
  const nonEmpty = Object.keys(data.handles).length || Object.keys(data.spaces).length;
  if (nonEmpty && !force) { console.error(`Database already has ${Object.keys(data.handles).length} handle(s) and ${Object.keys(data.spaces).length} space(s); re-run with --force to replace them with ${file}.`); await store.close(); process.exit(1); }
  for (const k of Object.keys(data)) delete data[k];
  Object.assign(data, src); data.handles ||= {}; data.queues ||= {}; data.spaces ||= {}; data.settings ||= {};
  await store.saveNow(); const info = await store.info(); await store.close();
  if (info.lastError) { console.error('import failed: ' + info.lastError); process.exit(1); }
  const q = Object.values(data.queues).reduce((n, x) => n + (x || []).length, 0);
  console.log(`Imported ${file} into postgres schema ${info.schema}: ${Object.keys(data.handles).length} handles, ${Object.keys(data.spaces).length} spaces, ${q} queued messages.`);
})().catch(e => { console.error('migration failed: ' + e.message); process.exit(1); });
