// relay-core: all relay logic, no HTTP. createRelay({ store, notifier }) -> methods returning { code, body }.
const crypto = require('crypto');
const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,255}$/;
const B64 = /^[A-Za-z0-9+/=]{1,200000}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const validKey = (k, len) => typeof k === 'string' && B64.test(k) && Buffer.from(k, 'base64').length === len; // SPKI DER x25519/ed25519 = 44 bytes
const validEnc = e => e && typeof e === 'object' && (e.v === 1 || e.v === 2) && validKey(e.epk, 44) && typeof e.nonce === 'string' && B64.test(e.nonce) && typeof e.ct === 'string' && B64.test(e.ct) && typeof e.sig === 'string' && B64.test(e.sig);
const ok = body => ({ code: 200, body });
const err = (code, error) => ({ code, body: { error } });
const ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
const badHost = hn => /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|fc|fd|fe80))/i.test(hn) || hn.endsWith('.local') || hn.endsWith('.internal');

function createRelay({ store, notifier }) {
  const data = store.load();
  data.handles ||= {}; data.queues ||= {};
  data.settings ||= {}; const S = data.settings;
  S.suspended = !!S.suspended; S.pairPerHour = +S.pairPerHour || 0; S.sendPerMinute = +S.sendPerMinute || 0; S.requireEncryption = !!S.requireEncryption;
  data.stats ||= { day: '', count: 0 };
  const save = () => store.save();
  let seenDirty = false; // lastSeen-only changes: persisted with the next real save, or every 30 s
  setInterval(() => { if (seenDirty && !store.pending()) { seenDirty = false; save(); } }, 30000).unref();
  const flushStore = () => { if (store.pending() || seenDirty) { seenDirty = false; store.saveNow(); } };

  // token hash -> handle index (tokens hashed before lookup)
  const tokenIndex = new Map(); let indexedCount = -1;
  const reindex = () => { tokenIndex.clear(); for (const [name, v] of Object.entries(data.handles)) if (v.tokenHash) tokenIndex.set(v.tokenHash, name); indexedCount = Object.keys(data.handles).length; };
  function auth(token) {
    if (!token) return null;
    const h = sha(token);
    let name = tokenIndex.get(h);
    if (!name && indexedCount !== Object.keys(data.handles).length) { reindex(); name = tokenIndex.get(h); }
    if (!name) return null;
    const v = data.handles[name];
    if (!v || v.tokenHash !== h) { tokenIndex.delete(h); return null; }
    return name;
  }

  const waiters = {}; // handle -> [{ cb(code, body), timer }]
  function flush(h) {
    if (S.suspended) return;
    if ((data.handles[h] || {}).status === 'blocked') return;
    const w = waiters[h] || [], q = data.queues[h] || [];
    if (!w.length || !q.length) return;
    waiters[h] = [];
    for (const x of w) { clearTimeout(x.timer); x.cb(200, { messages: q }); }
  }
  const seen = h => { if (data.handles[h]) { data.handles[h].lastSeen = new Date().toISOString(); seenDirty = true; } };

  const msgLog = [], sendTimes = {}, pairTimes = {};
  const recent = (arr, win, now) => { while (arr.length && arr[0] <= now - win) arr.shift(); return arr; };
  function checkSend(me, to) {
    if (S.suspended) return err(503, 'relay suspended by admin');
    const st = (data.handles[me] || {}).status;
    if (st === 'blocked') return err(403, 'handle blocked by admin');
    if (st === 'muted') return err(403, 'handle muted by admin (can receive, cannot send)');
    if ((data.handles[to] || {}).status === 'blocked') return err(403, 'recipient blocked by admin');
    const now = Date.now(), st1 = recent(sendTimes[me] ||= [], 60e3, now), pk = [me, to].sort().join('|'), st2 = recent(pairTimes[pk] ||= [], 3600e3, now);
    if (S.sendPerMinute > 0 && st1.length >= S.sendPerMinute) return err(429, 'rate limit: max ' + S.sendPerMinute + ' sends per minute per handle');
    if (S.pairPerHour > 0 && st2.length >= S.pairPerHour) return err(429, 'rate limit: max ' + S.pairPerHour + ' messages per hour between @' + me + ' and @' + to);
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
  function notify(msg) {
    const h = data.handles[msg.to] || {};
    const rec = kind => st => { const x = data.handles[msg.to]; if (x) { x['last' + kind + 'At'] = new Date().toISOString(); x['last' + kind + 'Status'] = st; save(); } };
    if (h.webhook) notifier.webhook(msg, h.webhook, rec('Webhook'));
    if (h.email) notifier.email(msg, h.email, rec('Email'));
  }

  const relay = {
    data, waiters, msgLog, flush, save, flushStore, auth,
    register(m) {
      const handle = String(m.handle || '').replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) return err(400, 'handle must be 3-32 chars of a-z, 0-9, _ or -');
      if (data.handles[handle]) return err(409, 'handle taken');
      const token = crypto.randomBytes(32).toString('hex');
      data.handles[handle] = { tokenHash: sha(token), created: new Date().toISOString() };
      data.queues[handle] = [];
      tokenIndex.set(data.handles[handle].tokenHash, handle); indexedCount++;
      save();
      return ok({ handle, token });
    },
    getKeys(handle) { const h = data.handles[String(handle).replace(/^@/, '')]; if (!h || !h.keys) return err(404, 'no keys for handle'); return ok({ handle: String(handle).replace(/^@/, ''), ...h.keys }); },
    setKeys(me, m) {
      if (!validKey(m.x25519, 44) || !validKey(m.ed25519, 44)) return err(400, 'x25519 and ed25519 must be base64 SPKI DER public keys');
      data.handles[me].keys = { x25519: m.x25519, ed25519: m.ed25519, updated: new Date().toISOString() }; save();
      return ok({ ok: true });
    },
    send(me, m) {
      const to = String(m.to || '').replace(/^@/, ''), enc = m.enc;
      if (!to || (!m.text && !enc)) return err(400, 'to and text (or enc) required');
      if (enc && !validEnc(enc)) return err(400, 'invalid encrypted envelope');
      if (!enc && S.requireEncryption) return err(400, 'this relay requires end-to-end encryption; update the CLI (git pull) and retry');
      if (!data.handles[to]) return err(404, 'unknown recipient');
      const deny = checkSend(me, to); if (deny) return deny;
      const msg = { id: Date.now() + '-' + crypto.randomBytes(3).toString('hex'), from: me, to, ts: new Date().toISOString() };
      if (enc) msg.enc = { v: enc.v, epk: enc.epk, nonce: enc.nonce, ct: enc.ct, sig: enc.sig }; else { msg.text = String(m.text); msg.plaintext = true; }
      (data.queues[to] ||= []).push(msg);
      logMsg(msg); save(); flush(to); notify(msg);
      return ok({ ok: true, id: msg.id });
    },
    status(me) {
      const h = data.handles[me];
      return ok({ handle: me, webhook: !!h.webhook, lastWebhookStatus: h.lastWebhookStatus || null, lastWebhookAt: h.lastWebhookAt || null, email: !!h.email, lastEmailStatus: h.lastEmailStatus || null, lastEmailAt: h.lastEmailAt || null, unreadCount: (data.queues[me] || []).length, keys: !!h.keys, requireEncryption: S.requireEncryption, lastPollAt: h.lastSeen || null });
    },
    // Long-poll. cb(code, body) is called exactly once unless the returned cancel() runs first.
    poll(me, { handle, timeoutMs }, cb) {
      seen(me);
      if (handle && String(handle).replace(/^@/, '') !== me) { cb(403, { error: 'token does not match handle' }); return () => {}; }
      if (data.handles[me].status === 'blocked') { cb(403, { error: 'handle blocked by admin' }); return () => {}; }
      const q = S.suspended ? [] : (data.queues[me] || []);
      if (S.suspended && timeoutMs === 0) { cb(200, { messages: [] }); return () => {}; }
      if (q.length || timeoutMs === 0) { cb(200, { messages: q }); return () => {}; }
      const w = { cb };
      const drop = () => { waiters[me] = (waiters[me] || []).filter(x => x !== w); };
      w.timer = setTimeout(() => { drop(); cb(200, { messages: [] }); }, timeoutMs);
      (waiters[me] ||= []).push(w);
      return () => { clearTimeout(w.timer); drop(); };
    },
    ack(me, m) {
      seen(me);
      const ids = new Set(Array.isArray(m.ids) ? m.ids : []), before = (data.queues[me] || []).length;
      data.queues[me] = (data.queues[me] || []).filter(x => !ids.has(x.id));
      save();
      return ok({ ok: true, deleted: before - data.queues[me].length });
    },
    getWebhook(me) { const w = data.handles[me].webhook; let shown = null; if (w) { const x = new URL(w.url); shown = x.origin + x.pathname; } return ok({ webhook: shown }); },
    setWebhook(me, m) {
      const h = data.handles[me];
      if (m.url === null || m.url === '') { delete h.webhook; delete h.lastWebhookStatus; delete h.lastWebhookAt; save(); return ok({ ok: true, webhook: null }); }
      let url; try { url = new URL(String(m.url)); } catch { return err(400, 'invalid url'); }
      if (!/^https?:$/.test(url.protocol)) return err(400, 'url must be http(s)');
      if (!ALLOW_PRIVATE && badHost(url.hostname)) return err(400, 'private/local webhook hosts not allowed');
      const headers = {};
      for (const [k, v] of Object.entries(m.headers && typeof m.headers === 'object' ? m.headers : {})) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length < 2000) headers[k] = v;
      h.webhook = { url: url.toString(), headers }; delete h.lastWebhookStatus; delete h.lastWebhookAt; save();
      return ok({ ok: true, webhook: url.origin + url.pathname });
    },
    getEmail(me) { return ok({ email: data.handles[me].email || null }); },
    setEmail(me, m) {
      const h = data.handles[me];
      if (m.email === null || m.email === '') { delete h.email; delete h.lastEmailStatus; delete h.lastEmailAt; save(); return ok({ ok: true, email: null }); }
      const e = String(m.email).trim();
      if (!EMAIL_RE.test(e)) return err(400, 'invalid email address');
      h.email = e; delete h.lastEmailStatus; delete h.lastEmailAt; save();
      return ok({ ok: true, email: e });
    },
  };
  return relay;
}
module.exports = { createRelay };
