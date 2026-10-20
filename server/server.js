const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || './data.json';
const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

let RESEND_KEY = process.env.RESEND_API_KEY || '';
if (!RESEND_KEY) { for (const d of [process.cwd(), require('path').join(__dirname, '..'), __dirname]) { try { RESEND_KEY = fs.readFileSync(require('path').join(d, '.resend-key'), 'utf8').trim(); break; } catch {} } }
const EMAIL_RE = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,255}$/;

let data = { handles: {}, queues: {} }; // handles: handle -> {tokenHash, created}; queues: handle -> [msgs]
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); data.handles ||= {}; data.queues ||= {}; } catch {}
data.settings ||= {}; data.settings.suspended = !!data.settings.suspended;
data.settings.pairPerHour = +data.settings.pairPerHour || 0; data.settings.sendPerMinute = +data.settings.sendPerMinute || 0;
data.settings.requireEncryption = !!data.settings.requireEncryption;
const B64 = /^[A-Za-z0-9+/=]{1,200000}$/;
function validKey(k, len) { return typeof k === 'string' && B64.test(k) && Buffer.from(k, 'base64').length === len; } // SPKI DER: x25519/ed25519 = 44 bytes
function validEnc(e) { return e && typeof e === 'object' && (e.v === 1 || e.v === 2) && validKey(e.epk, 44) && typeof e.nonce === 'string' && B64.test(e.nonce) && typeof e.ct === 'string' && B64.test(e.ct) && typeof e.sig === 'string' && B64.test(e.sig); }
data.stats ||= { day: '', count: 0 };
// Batched, atomic persistence: save() schedules a write at most every SAVE_MS; saveNow() writes immediately.
// Pending data is flushed on SIGTERM/SIGINT/exit so deploys don't lose messages.
const SAVE_MS = +process.env.SAVE_MS || 200;
let saveTimer = null, dirty = false;
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  dirty = false;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}
function save() { dirty = true; if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_MS); }
let seenDirty = false; // lastSeen-only changes: persisted with the next real save, or every 30 s
setInterval(() => { if (seenDirty && !saveTimer) { seenDirty = false; save(); } }, 30000).unref();
function flushOnExit() { if (dirty || seenDirty || saveTimer) { try { saveNow(); } catch (e) { console.error('final save failed: ' + e.message); } } }
process.on('exit', flushOnExit);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushOnExit(); process.exit(0); });
const waiters = {}; // handle -> [{res, timer}]
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function body(req, cb, res) {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { json(res, 400, { error: 'bad json' }); } });
}
// token hash -> handle index. Tokens are hashed (SHA-256) before lookup, so lookup timing reveals nothing useful about the token.
const tokenIndex = new Map(); let indexedCount = -1;
function reindex() { tokenIndex.clear(); for (const [name, v] of Object.entries(data.handles)) if (v.tokenHash) tokenIndex.set(v.tokenHash, name); indexedCount = Object.keys(data.handles).length; }
function authed(req) { // returns handle for the bearer token, or null
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1]);
  let name = tokenIndex.get(h);
  if (!name && indexedCount !== Object.keys(data.handles).length) { reindex(); name = tokenIndex.get(h); } // handles added/removed elsewhere
  if (!name) return null;
  const v = data.handles[name];
  if (!v || v.tokenHash !== h) { tokenIndex.delete(h); return null; } // deleted or token rotated
  return name;
}
const ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
function badHost(hn) { // basic SSRF guard
  return /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|fc|fd|fe80))/i.test(hn) || hn.endsWith('.local') || hn.endsWith('.internal');
}
function fireWebhook(msg) { // fire-and-forget; never blocks or fails the send
  const w = (data.handles[msg.to] || {}).webhook;
  if (!w) return;
  const rec = st => { const h = data.handles[msg.to]; if (h) { h.lastWebhookAt = new Date().toISOString(); h.lastWebhookStatus = st; save(); } };
  fetch(w.url, { method: 'POST', headers: { ...w.headers, 'content-type': 'application/json' }, body: JSON.stringify({ to: msg.to, from: msg.from, ts: msg.ts, encrypted: !!msg.enc }), signal: AbortSignal.timeout(5000) })
    .then(r => rec(r.ok ? 'ok' : 'http ' + r.status))
    .catch(e => { console.log('webhook failed for @' + msg.to + ': ' + e.message); rec('error: ' + e.message); });
}
function sendEmail(msg) { // fire-and-forget wake-up email; never blocks or fails the send
  const h0 = data.handles[msg.to] || {};
  if (!h0.email) return;
  const rec = st => { const h = data.handles[msg.to]; if (h) { h.lastEmailAt = new Date().toISOString(); h.lastEmailStatus = st; save(); } };
  if (!RESEND_KEY) return rec('error: relay has no Resend key');
  if (!process.env.EMAIL_FROM) { console.warn('EMAIL_FROM not set; skipping wake-up email'); return rec('error: EMAIL_FROM not set'); }
  const text = 'Relay wake-up: a message is waiting for @' + msg.to + '.\n\nFrom: @' + msg.from + '\nTime: ' + msg.ts + '\n\nThe message text is not included. This email is only a wake-up signal. Run `node relay.js poll` to read and ack the message.';
  fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + RESEND_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [h0.email], subject: 'Relay: message for @' + msg.to + ' from @' + msg.from, text }), signal: AbortSignal.timeout(10000) })
    .then(async r => rec(r.ok ? 'ok' : 'http ' + r.status + ' ' + String(await r.text().catch(() => '')).slice(0, 150)))
    .catch(e => { console.log('email failed for @' + msg.to + ': ' + e.message); rec('error: ' + e.message); });
}
function flush(h) {
  if (data.settings.suspended) return;
  if ((data.handles[h] || {}).status === 'blocked') return;
  const w = waiters[h] || [];
  const q = data.queues[h] || [];
  if (!w.length || !q.length) return;
  waiters[h] = [];
  for (const x of w) { clearTimeout(x.timer); json(x.res, 200, { messages: q }); }
}
function seen(h) { if (data.handles[h]) { data.handles[h].lastSeen = new Date().toISOString(); seenDirty = true; } }
// --- admin state (in-memory) ---
const msgLog = []; // ring buffer of recent messages
const sendTimes = {}; // handle -> [ms]
const pairTimes = {}; // "a|b" -> [ms]
function recent(arr, win, now) { while (arr.length && arr[0] <= now - win) arr.shift(); return arr; }
function checkSend(me, to) { // returns [code, error] or null
  if (data.settings.suspended) return [503, 'relay suspended by admin'];
  const st = (data.handles[me] || {}).status;
  if (st === 'blocked') return [403, 'handle blocked by admin'];
  if (st === 'muted') return [403, 'handle muted by admin (can receive, cannot send)'];
  if ((data.handles[to] || {}).status === 'blocked') return [403, 'recipient blocked by admin'];
  const now = Date.now(), s = data.settings;
  const st1 = recent(sendTimes[me] ||= [], 60e3, now), pk = [me, to].sort().join('|'), st2 = recent(pairTimes[pk] ||= [], 3600e3, now);
  if (s.sendPerMinute > 0 && st1.length >= s.sendPerMinute) return [429, 'rate limit: max ' + s.sendPerMinute + ' sends per minute per handle'];
  if (s.pairPerHour > 0 && st2.length >= s.pairPerHour) return [429, 'rate limit: max ' + s.pairPerHour + ' messages per hour between @' + me + ' and @' + to];
  st1.push(now); st2.push(now);
  return null;
}
function logMsg(msg) {
  msgLog.push({ id: msg.id, from: msg.from, to: msg.to, ts: msg.ts, encrypted: !!msg.enc, size: msg.enc ? Buffer.byteLength(msg.enc.ct, 'base64') - 16 : Buffer.byteLength(msg.text), text: msg.enc ? '(end-to-end encrypted)' : msg.text });
  if (msgLog.length > 500) msgLog.shift();
  const day = msg.ts.slice(0, 10);
  if (data.stats.day !== day) data.stats = { day, count: 0 };
  data.stats.count++;
}
const admin = require('./admin.js')({ data, save, json, body, waiters, msgLog, flush });
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/admin' || u.pathname.startsWith('/admin/')) return admin(req, res, u);
  if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && u.pathname === '/register') {
    return body(req, m => {
      const handle = String(m.handle || '').replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'handle must be 3-32 chars of a-z, 0-9, _ or -' });
      if (data.handles[handle]) return json(res, 409, { error: 'handle taken' });
      const token = crypto.randomBytes(32).toString('hex');
      data.handles[handle] = { tokenHash: sha(token), created: new Date().toISOString() };
      data.queues[handle] = [];
      tokenIndex.set(data.handles[handle].tokenHash, handle); indexedCount++;
      save();
      json(res, 200, { handle, token });
    }, res);
  }
  const km = /^\/keys\/@?([a-z0-9_-]{3,32})$/.exec(u.pathname);
  if (req.method === 'GET' && km) { const h = data.handles[km[1]]; if (!h || !h.keys) return json(res, 404, { error: 'no keys for handle' }); return json(res, 200, { handle: km[1], ...h.keys }); }
  const me = authed(req);
  if (req.method === 'POST' && u.pathname === '/keys') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return body(req, m => {
      if (!validKey(m.x25519, 44) || !validKey(m.ed25519, 44)) return json(res, 400, { error: 'x25519 and ed25519 must be base64 SPKI DER public keys' });
      const h = data.handles[me]; h.keys = { x25519: m.x25519, ed25519: m.ed25519, updated: new Date().toISOString() }; save();
      json(res, 200, { ok: true });
    }, res);
  }
  if (req.method === 'POST' && u.pathname === '/send') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return body(req, m => {
      const to = String(m.to || '').replace(/^@/, '');
      const enc = m.enc;
      if (!to || (!m.text && !enc)) return json(res, 400, { error: 'to and text (or enc) required' });
      if (enc && !validEnc(enc)) return json(res, 400, { error: 'invalid encrypted envelope' });
      if (!enc && data.settings.requireEncryption) return json(res, 400, { error: 'this relay requires end-to-end encryption; update the CLI (git pull) and retry' });
      if (!data.handles[to]) return json(res, 404, { error: 'unknown recipient' });
      const deny = checkSend(me, to); if (deny) return json(res, deny[0], { error: deny[1] });
      const msg = { id: Date.now() + '-' + crypto.randomBytes(3).toString('hex'), from: me, to, ts: new Date().toISOString() };
      if (enc) msg.enc = { v: enc.v, epk: enc.epk, nonce: enc.nonce, ct: enc.ct, sig: enc.sig }; else { msg.text = String(m.text); msg.plaintext = true; }
      (data.queues[to] ||= []).push(msg);
      logMsg(msg);
      save();
      flush(to);
      fireWebhook(msg);
      sendEmail(msg);
      json(res, 200, { ok: true, id: msg.id });
    }, res);
  }
  if (req.method === 'GET' && u.pathname === '/status') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    const h = data.handles[me];
    return json(res, 200, { handle: me, webhook: !!h.webhook, lastWebhookStatus: h.lastWebhookStatus || null, lastWebhookAt: h.lastWebhookAt || null, email: !!h.email, lastEmailStatus: h.lastEmailStatus || null, lastEmailAt: h.lastEmailAt || null, unreadCount: (data.queues[me] || []).length, keys: !!h.keys, requireEncryption: data.settings.requireEncryption, lastPollAt: h.lastSeen || null });
  }
  if (req.method === 'GET' && u.pathname === '/poll') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    seen(me);
    const h = u.searchParams.get('handle');
    if (h && h.replace(/^@/, '') !== me) return json(res, 403, { error: 'token does not match handle' });
    if (data.handles[me].status === 'blocked') return json(res, 403, { error: 'handle blocked by admin' });
    const t = Math.min(Math.max(u.searchParams.has('timeout') ? +u.searchParams.get('timeout') || 0 : 30, 0), 120) * 1000;
    const q = data.settings.suspended ? [] : (data.queues[me] || []);
    if (data.settings.suspended && t === 0) return json(res, 200, { messages: [] });
    if (q.length || t === 0) return json(res, 200, { messages: q });
    const waiter = { res };
    waiter.timer = setTimeout(() => {
      waiters[me] = (waiters[me] || []).filter(x => x !== waiter);
      json(res, 200, { messages: [] });
    }, t);
    (waiters[me] ||= []).push(waiter);
    req.on('close', () => { clearTimeout(waiter.timer); waiters[me] = (waiters[me] || []).filter(x => x !== waiter); });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/webhook') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    const w = data.handles[me].webhook; let shown = null; if (w) { const x = new URL(w.url); shown = x.origin + x.pathname; }
    return json(res, 200, { webhook: shown });
  }
  if (req.method === 'POST' && u.pathname === '/webhook') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return body(req, m => {
      if (m.url === null || m.url === '') { delete data.handles[me].webhook; delete data.handles[me].lastWebhookStatus; delete data.handles[me].lastWebhookAt; save(); return json(res, 200, { ok: true, webhook: null }); }
      let url; try { url = new URL(String(m.url)); } catch { return json(res, 400, { error: 'invalid url' }); }
      if (!/^https?:$/.test(url.protocol)) return json(res, 400, { error: 'url must be http(s)' });
      if (!ALLOW_PRIVATE && badHost(url.hostname)) return json(res, 400, { error: 'private/local webhook hosts not allowed' });
      const headers = {};
      for (const [k, v] of Object.entries(m.headers && typeof m.headers === 'object' ? m.headers : {})) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length < 2000) headers[k] = v;
      data.handles[me].webhook = { url: url.toString(), headers };
      delete data.handles[me].lastWebhookStatus; delete data.handles[me].lastWebhookAt;
      save();
      json(res, 200, { ok: true, webhook: url.origin + url.pathname });
    }, res);
  }
  if (req.method === 'GET' && u.pathname === '/email') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return json(res, 200, { email: data.handles[me].email || null });
  }
  if (req.method === 'POST' && u.pathname === '/email') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return body(req, m => {
      if (m.email === null || m.email === '') { const h = data.handles[me]; delete h.email; delete h.lastEmailStatus; delete h.lastEmailAt; save(); return json(res, 200, { ok: true, email: null }); }
      const e = String(m.email).trim();
      if (!EMAIL_RE.test(e)) return json(res, 400, { error: 'invalid email address' });
      const h = data.handles[me]; h.email = e; delete h.lastEmailStatus; delete h.lastEmailAt; save();
      json(res, 200, { ok: true, email: e });
    }, res);
  }
  if (req.method === 'POST' && u.pathname === '/ack') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    seen(me);
    return body(req, m => {
      const ids = new Set(Array.isArray(m.ids) ? m.ids : []);
      const before = (data.queues[me] || []).length;
      data.queues[me] = (data.queues[me] || []).filter(x => !ids.has(x.id));
      save();
      json(res, 200, { ok: true, deleted: before - data.queues[me].length });
    }, res);
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, HOST, () => console.log(`relay listening on ${HOST}:${PORT}, data in ${DATA_FILE}`));
