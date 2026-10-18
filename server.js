const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || './data.json';
const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

let data = { handles: {}, queues: {} }; // handles: handle -> {tokenHash, created}; queues: handle -> [msgs]
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); data.handles ||= {}; data.queues ||= {}; } catch {}
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}
const waiters = {}; // handle -> [{res, timer}]
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function body(req, cb, res) {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { json(res, 400, { error: 'bad json' }); } });
}
function authed(req) { // returns handle for the bearer token, or null
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1]);
  for (const [name, v] of Object.entries(data.handles)) {
    const a = Buffer.from(v.tokenHash), b = Buffer.from(h);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return name;
  }
  return null;
}
const ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
function badHost(hn) { // basic SSRF guard
  return /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|fc|fd|fe80))/i.test(hn) || hn.endsWith('.local') || hn.endsWith('.internal');
}
function fireWebhook(msg) { // fire-and-forget; never blocks or fails the send
  const w = (data.handles[msg.to] || {}).webhook;
  if (!w) return;
  fetch(w.url, { method: 'POST', headers: { ...w.headers, 'content-type': 'application/json' }, body: JSON.stringify({ from: msg.from, text: msg.text, ts: msg.ts }), signal: AbortSignal.timeout(5000) })
    .catch(e => console.log('webhook failed for @' + msg.to + ': ' + e.message));
}
function flush(h) {
  const w = waiters[h] || [];
  const q = data.queues[h] || [];
  if (!w.length || !q.length) return;
  waiters[h] = [];
  for (const x of w) { clearTimeout(x.timer); json(x.res, 200, { messages: q }); }
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && u.pathname === '/register') {
    return body(req, m => {
      const handle = String(m.handle || '').replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'handle must be 3-32 chars of a-z, 0-9, _ or -' });
      if (data.handles[handle]) return json(res, 409, { error: 'handle taken' });
      const token = crypto.randomBytes(32).toString('hex');
      data.handles[handle] = { tokenHash: sha(token), created: new Date().toISOString() };
      data.queues[handle] = [];
      save();
      json(res, 200, { handle, token });
    }, res);
  }
  const me = authed(req);
  if (req.method === 'POST' && u.pathname === '/send') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return body(req, m => {
      const to = String(m.to || '').replace(/^@/, '');
      if (!to || !m.text) return json(res, 400, { error: 'to and text required' });
      if (!data.handles[to]) return json(res, 404, { error: 'unknown recipient' });
      const msg = { id: Date.now() + '-' + crypto.randomBytes(3).toString('hex'), from: me, to, text: String(m.text), ts: new Date().toISOString() };
      (data.queues[to] ||= []).push(msg);
      save();
      flush(to);
      fireWebhook(msg);
      json(res, 200, { ok: true, id: msg.id });
    }, res);
  }
  if (req.method === 'GET' && u.pathname === '/poll') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    const h = u.searchParams.get('handle');
    if (h && h.replace(/^@/, '') !== me) return json(res, 403, { error: 'token does not match handle' });
    const t = Math.min(Math.max(u.searchParams.has('timeout') ? +u.searchParams.get('timeout') || 0 : 30, 0), 120) * 1000;
    const q = data.queues[me] || [];
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
  if (req.method === 'POST' && u.pathname === '/webhook') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    return body(req, m => {
      if (m.url === null || m.url === '') { delete data.handles[me].webhook; save(); return json(res, 200, { ok: true, webhook: null }); }
      let url; try { url = new URL(String(m.url)); } catch { return json(res, 400, { error: 'invalid url' }); }
      if (!/^https?:$/.test(url.protocol)) return json(res, 400, { error: 'url must be http(s)' });
      if (!ALLOW_PRIVATE && badHost(url.hostname)) return json(res, 400, { error: 'private/local webhook hosts not allowed' });
      const headers = {};
      for (const [k, v] of Object.entries(m.headers && typeof m.headers === 'object' ? m.headers : {})) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length < 2000) headers[k] = v;
      data.handles[me].webhook = { url: url.toString(), headers };
      save();
      json(res, 200, { ok: true, webhook: url.origin + url.pathname });
    }, res);
  }
  if (req.method === 'POST' && u.pathname === '/ack') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
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
