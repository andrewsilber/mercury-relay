#!/usr/bin/env node
// Print the relay state as JSON (same shape as data.json) from the configured backend. Doubles as a Postgres -> JSON backup:
//   DATABASE_URL=postgres://... node server/dump-store.js > backup.json
'use strict';
const { createFileStore, createPgStore } = require('../core');
(async () => {
  const store = process.env.DATABASE_URL ? createPgStore({ url: process.env.DATABASE_URL, schema: process.env.DATABASE_SCHEMA || 'public' }) : createFileStore({ file: process.env.DATA_FILE || './data.json' });
  await store.init(); process.stdout.write(JSON.stringify(store.load()) + '\n'); if (store.backend === 'postgres') await store.close();
})().catch(e => { console.error('dump failed: ' + e.message); process.exit(1); });
