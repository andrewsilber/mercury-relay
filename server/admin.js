// Admin portal: /admin (HTML) and /admin/api/* (JSON). Disabled unless ADMIN_PASSWORD is set.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SESSION_MS = 12 * 3600e3;
module.exports = function ({ data, save, json, body, waiters, msgLog, flush }) {
  const PW = process.env.ADMIN_PASSWORD || '';
  const sessions = new Map(); // token -> expiry ms
  const attempts = new Map(); // ip -> [ms]
  const pwHash = crypto.createHash('sha256').update(PW).digest();
  const pwOk = p => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(p || '')).digest(), pwHash);
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  function session(req) {
    const m = /(?:^|;\s*)admin_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    if (!m) return null;
    const exp = sessions.get(m[1]);
    if (!exp || exp < Date.now()) { sessions.delete(m[1]); return null; }
    return m[1];
  }
  function cookie(tok, maxAge) { return 'admin_session=' + tok + '; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=' + maxAge; }
  function handleView(name) {
    const h = data.handles[name];
    return { handle: name, created: h.created || null, lastSeen: h.lastSeen || null, queue: (data.queues[name] || []).length, email: !!h.email, webhook: !!h.webhook, keys: !!h.keys, status: h.status || 'active' };
  }
  function stats() {
    const today = new Date().toISOString().slice(0, 10);
    return { handles: Object.keys(data.handles).length, messagesToday: data.stats.day === today ? data.stats.count : 0, queued: Object.values(data.queues).reduce((n, q) => n + q.length, 0), suspended: data.settings.suspended };
  }
  return function admin(req, res, u) {
    if (!PW) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('admin disabled'); }
    const p = u.pathname;
    if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'portal', 'index.html')));
    }
    if (req.method === 'POST' && p === '/admin/api/login') {
      const ip = ipOf(req), now = Date.now();
      const a = (attempts.get(ip) || []).filter(t => t > now - 15 * 60e3);
      if (a.length >= 10) { attempts.set(ip, a); return json(res, 429, { error: 'too many login attempts, try again later' }); }
      return body(req, m => {
        if (!pwOk(m.password)) { a.push(now); attempts.set(ip, a); return json(res, 401, { error: 'wrong password' }); }
        attempts.delete(ip);
        const tok = crypto.randomBytes(32).toString('hex');
        sessions.set(tok, now + SESSION_MS);
        res.setHeader('set-cookie', cookie(tok, SESSION_MS / 1000));
        json(res, 200, { ok: true });
      }, res);
    }
    if (!p.startsWith('/admin/api/')) return json(res, 404, { error: 'not found' });
    const tok = session(req);
    if (!tok) return json(res, 401, { error: 'not logged in' });
    if (req.method === 'POST' && req.headers['x-admin'] !== '1') return json(res, 403, { error: 'missing X-Admin header' }); // CSRF belt-and-braces
    if (req.method === 'POST' && p === '/admin/api/logout') { sessions.delete(tok); res.setHeader('set-cookie', cookie('', 0)); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/admin/api/state') {
      return json(res, 200, { stats: stats(), settings: data.settings, handles: Object.keys(data.handles).sort().map(handleView) });
    }
    if (req.method === 'GET' && p === '/admin/api/messages') {
      const withText = u.searchParams.get('text') === '1';
      return json(res, 200, { messages: msgLog.slice().reverse().map(m => withText ? m : { id: m.id, from: m.from, to: m.to, ts: m.ts, size: m.size, encrypted: m.encrypted }) });
    }
    if (req.method === 'POST' && p === '/admin/api/settings') {
      return body(req, m => {
        const s = data.settings;
        if ('suspended' in m) s.suspended = !!m.suspended;
        if ('requireEncryption' in m) s.requireEncryption = !!m.requireEncryption;
        for (const k of ['pairPerHour', 'sendPerMinute']) if (k in m) { const v = Math.floor(+m[k]); if (!(v >= 0)) return json(res, 400, { error: k + ' must be a number >= 0' }); s[k] = v; }
        save();
        if (!s.suspended) for (const h of Object.keys(waiters)) flush(h);
        json(res, 200, { ok: true, settings: s });
      }, res);
    }
    const hm = /^\/admin\/api\/handles\/([a-z0-9_-]{3,32})(?:\/(status))?$/.exec(p);
    if (hm && data.handles[hm[1]]) {
      const name = hm[1];
      if (req.method === 'POST' && hm[2] === 'status') return body(req, m => {
        if (!['active', 'muted', 'blocked'].includes(m.status)) return json(res, 400, { error: 'status must be active, muted or blocked' });
        if (m.status === 'active') delete data.handles[name].status; else data.handles[name].status = m.status;
        save();
        if (m.status === 'blocked') for (const w of waiters[name] || []) { clearTimeout(w.timer); json(w.res, 403, { error: 'handle blocked by admin' }); }
        if (m.status === 'blocked') waiters[name] = [];
        if (m.status === 'active') flush(name);
        json(res, 200, { ok: true, handle: handleView(name) });
      }, res);
      if (req.method === 'DELETE' && !hm[2]) {
        for (const w of waiters[name] || []) { clearTimeout(w.timer); json(w.res, 410, { error: 'handle deleted by admin' }); }
        delete waiters[name]; delete data.handles[name]; delete data.queues[name];
        save();
        return json(res, 200, { ok: true, deleted: name });
      }
    }
    if (hm) return json(res, 404, { error: 'unknown handle' });
    json(res, 404, { error: 'not found' });
  };
};
