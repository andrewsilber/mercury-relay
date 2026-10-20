// Postgres store: real tables + in-memory cache with batched write-through.
// Same interface as store-file.js: load() -> data, save() (batched), saveNow(), pending(), flush(); plus async init(), drain(), close(), info().
// The relay core works on the whole state in memory, so this store loads every table into the same `data` shape at startup
// and, on each batched save, diffs rows against what was last committed and writes only changed/removed rows in one transaction.
// SINGLE-INSTANCE: exactly one relay process may own a schema at a time (it holds the cache). Multi-instance would need the core
// to read/write per request (or row-level locking + LISTEN/NOTIFY cache invalidation), shared rate-limit/waiter state, and
// cross-instance wake/long-poll fan-out (e.g. NOTIFY on queue insert).
'use strict';
const MIGRATIONS = [ // append-only; each runs once, inside a transaction
  s => `
  CREATE TABLE IF NOT EXISTS ${s}.relay_handles (name text PRIMARY KEY, space text NOT NULL DEFAULT 'public', data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS relay_handles_space_idx ON ${s}.relay_handles (space);
  CREATE TABLE IF NOT EXISTS ${s}.relay_keys (handle text PRIMARY KEY, keys jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS ${s}.relay_spaces (name text PRIMARY KEY, owner text, data jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS ${s}.relay_invites (space text NOT NULL, hash text NOT NULL, expires timestamptz, data jsonb NOT NULL, PRIMARY KEY (space, hash));
  CREATE INDEX IF NOT EXISTS relay_invites_expires_idx ON ${s}.relay_invites (expires);
  CREATE TABLE IF NOT EXISTS ${s}.relay_queue (handle text NOT NULL, id text NOT NULL, ord bigint NOT NULL, ts timestamptz, msg jsonb NOT NULL, PRIMARY KEY (handle, id));
  CREATE INDEX IF NOT EXISTS relay_queue_handle_ord_idx ON ${s}.relay_queue (handle, ord);
  CREATE INDEX IF NOT EXISTS relay_queue_ts_idx ON ${s}.relay_queue (ts);
  CREATE TABLE IF NOT EXISTS ${s}.relay_settings (key text PRIMARY KEY, value jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS ${s}.relay_counters (key text PRIMARY KEY, value jsonb NOT NULL);`,
];
// table -> { key columns, row builder }. Each row: [keyString, columns...]; diffing uses the JSON of the whole row.
const TABLES = {
  relay_handles: { pk: ['name'], cols: ['name', 'space', 'data'], types: ['text', 'text', 'jsonb'] },
  relay_keys: { pk: ['handle'], cols: ['handle', 'keys'], types: ['text', 'jsonb'] },
  relay_spaces: { pk: ['name'], cols: ['name', 'owner', 'data'], types: ['text', 'text', 'jsonb'] },
  relay_invites: { pk: ['space', 'hash'], cols: ['space', 'hash', 'expires', 'data'], types: ['text', 'text', 'timestamptz', 'jsonb'] },
  relay_queue: { pk: ['handle', 'id'], cols: ['handle', 'id', 'ord', 'ts', 'msg'], types: ['text', 'text', 'bigint', 'timestamptz', 'jsonb'] },
  relay_settings: { pk: ['key'], cols: ['key', 'value'], types: ['text', 'jsonb'] },
  relay_counters: { pk: ['key'], cols: ['key', 'value'], types: ['text', 'jsonb'] },
};
const CORE_KEYS = new Set(['handles', 'queues', 'spaces', 'settings']);
const isoOrNull = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

module.exports = function createPgStore({ url, schema = 'public', saveMs = 200, Pool } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('DATABASE_SCHEMA must be a plain identifier');
  Pool ||= require('pg').Pool; // only required when DATABASE_URL is set
  const pool = new Pool({ connectionString: url, max: 4 });
  const S = `"${schema}"`;
  let data = null, timer = null, dirty = false, inflight = 0, chain = Promise.resolve(), ordSeq = 0, lastError = null;
  const committed = {}; for (const t of Object.keys(TABLES)) committed[t] = new Map(); // table -> key -> row JSON
  const queueOrd = new Map(); // "handle\0id" -> ord (stable once assigned)

  function rows() { // current in-memory state -> table -> Map(key -> row array)
    const out = {}; for (const t of Object.keys(TABLES)) out[t] = new Map();
    const put = (t, row) => out[t].set(TABLES[t].pk.map((_, i) => row[i]).join('\0'), row);
    for (const [name, h] of Object.entries(data.handles || {})) {
      const { keys, ...rest } = h; put('relay_handles', [name, rest.space || 'public', rest]);
      if (keys) put('relay_keys', [name, keys]);
    }
    for (const [name, sp] of Object.entries(data.spaces || {})) {
      const { invites, ...rest } = sp; put('relay_spaces', [name, rest.owner || null, rest]);
      for (const [hash, inv] of Object.entries(invites || {})) put('relay_invites', [name, hash, isoOrNull(inv.expires), inv]);
    }
    for (const [handle, q] of Object.entries(data.queues || {})) (q || []).forEach((m, i) => {
      const id = String(m.id ?? 'idx-' + i), k = handle + '\0' + id;
      let ord = queueOrd.get(k); if (ord == null) { ord = ++ordSeq; queueOrd.set(k, ord); }
      put('relay_queue', [handle, id, ord, isoOrNull(m.ts), m]);
    });
    for (const [k, v] of Object.entries(data.settings || {})) put('relay_settings', [k, v]);
    for (const [k, v] of Object.entries(data)) if (!CORE_KEYS.has(k) && v !== undefined) put('relay_counters', [k, v]);
    return out;
  }
  async function writeDiff() {
    const cur = rows(), plan = [];
    for (const [t, m] of Object.entries(cur)) {
      const old = committed[t], ups = [], dels = [], next = new Map();
      for (const [k, row] of m) { const j = JSON.stringify(row); next.set(k, j); if (old.get(k) !== j) ups.push(row); }
      for (const k of old.keys()) if (!m.has(k)) dels.push(k.split('\0'));
      if (ups.length || dels.length) plan.push({ t, ups, dels, next });
    }
    for (const k of queueOrd.keys()) if (!cur.relay_queue.has(k)) queueOrd.delete(k);
    if (!plan.length) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const { t, ups, dels } of plan) {
        const T = TABLES[t];
        if (dels.length) await c.query(`DELETE FROM ${S}.${t} d USING jsonb_array_elements($1::jsonb) x WHERE ${T.pk.map((p, i) => `d.${p} = x->>${i}`).join(' AND ')}`, [JSON.stringify(dels)]);
        for (let i = 0; i < ups.length; i += 1000) {
          const chunk = ups.slice(i, i + 1000);
          const sel = T.cols.map((col, j) => T.types[j] === 'jsonb' ? `x->${j}` : `(x->>${j})::${T.types[j]}`).join(', ');
          const upd = T.cols.filter(col => !T.pk.includes(col)).map(col => `${col} = EXCLUDED.${col}`).concat(t === 'relay_handles' || t === 'relay_keys' ? ['updated_at = now()'] : []).join(', ');
          await c.query(`INSERT INTO ${S}.${t} (${T.cols.join(', ')}) SELECT ${sel} FROM jsonb_array_elements($1::jsonb) x ON CONFLICT (${T.pk.join(', ')}) DO UPDATE SET ${upd}`, [JSON.stringify(chunk)]);
        }
      }
      await c.query('COMMIT');
      for (const { t, next } of plan) committed[t] = next;
      lastError = null;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); lastError = e.message; console.error('postgres save failed (will retry): ' + e.message); setTimeout(() => store.save(), 2000).unref(); }
    finally { c.release(); }
  }
  const store = {
    backend: 'postgres', schema,
    async init() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${S}`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${S}.relay_schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const c = await pool.connect();
      try { // advisory lock so two starting processes don't race the migrations
        await c.query('SELECT pg_advisory_lock(hashtext($1))', ['agentrelay:' + schema]);
        const done = new Set((await c.query(`SELECT version FROM ${S}.relay_schema_migrations`)).rows.map(r => r.version));
        for (let v = 1; v <= MIGRATIONS.length; v++) if (!done.has(v)) {
          await c.query('BEGIN'); await c.query(MIGRATIONS[v - 1](S)); await c.query(`INSERT INTO ${S}.relay_schema_migrations (version) VALUES ($1)`, [v]); await c.query('COMMIT');
        }
      } finally { await c.query('SELECT pg_advisory_unlock(hashtext($1))', ['agentrelay:' + schema]).catch(() => {}); c.release(); }
      const q = t => pool.query(`SELECT * FROM ${S}.${t}`).then(r => r.rows);
      const [hs, ks, sps, invs, qs, sets, cnts] = await Promise.all(['relay_handles', 'relay_keys', 'relay_spaces', 'relay_invites', 'relay_queue ORDER BY handle, ord', 'relay_settings', 'relay_counters'].map(q));
      data = { handles: {}, queues: {}, spaces: {}, settings: {} };
      for (const r of cnts) data[r.key] = r.value;
      for (const r of hs) { data.handles[r.name] = r.data; data.queues[r.name] = []; }
      for (const r of ks) if (data.handles[r.handle]) data.handles[r.handle].keys = r.keys;
      for (const r of sps) data.spaces[r.name] = r.data;
      for (const r of invs) if (data.spaces[r.space]) (data.spaces[r.space].invites ||= {})[r.hash] = r.data;
      for (const r of qs) { (data.queues[r.handle] ||= []).push(r.msg); const ord = +r.ord; queueOrd.set(r.handle + '\0' + r.id, ord); if (ord > ordSeq) ordSeq = ord; }
      for (const r of sets) data.settings[r.key] = r.value;
      // seed the committed snapshot from what is in the DB, so the first save only writes real changes
      const cur = rows(); for (const [t, m] of Object.entries(cur)) committed[t] = new Map([...m].map(([k, row]) => [k, JSON.stringify(row)]));
      return store;
    },
    load() { if (!data) throw new Error('postgres store: call await init() before load()'); return data; },
    saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false; inflight++;
      chain = chain.then(writeDiff).finally(() => { inflight--; });
      return chain;
    },
    save() { dirty = true; if (!timer) timer = setTimeout(store.saveNow, saveMs); },
    pending() { return dirty || !!timer || inflight > 0; },
    flush() { return store.pending() ? store.saveNow() : chain; },
    drain() { return store.flush(); },
    async close() { await store.drain(); await pool.end(); },
    async info() {
      const r = await pool.query(`SELECT c.relname AS t, pg_total_relation_size(c.oid) AS bytes, c.reltuples::bigint AS est FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'relay\\_%'`, [schema]);
      const tables = {}; let bytes = 0; for (const x of r.rows) { tables[x.t] = { bytes: +x.bytes }; bytes += +x.bytes; }
      for (const t of Object.keys(TABLES)) if (tables[t]) tables[t].rows = committed[t].size;
      return { backend: 'postgres', schema, bytes, tables, lastError, singleInstance: true };
    },
  };
  return store;
};
