// Self-host wrapper: one relay-core instance + HTTP API + /admin portal.
const http = require('http'), fs = require('fs'), path = require('path');
const { createRelay, createFileStore, createNotifier } = require('../core');
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || './data.json';
let RESEND_KEY = process.env.RESEND_API_KEY || '';
if (!RESEND_KEY) { for (const d of [process.cwd(), path.join(__dirname, '..'), __dirname]) { try { RESEND_KEY = fs.readFileSync(path.join(d, '.resend-key'), 'utf8').trim(); break; } catch {} } }

const store = createFileStore({ file: DATA_FILE, saveMs: +process.env.SAVE_MS || 200 });
const relay = createRelay({ store, notifier: createNotifier({ resendKey: RESEND_KEY, emailFrom: process.env.EMAIL_FROM || '' }) });
// Flush pending writes on deploy/restart so nothing is lost.
const flushOnExit = () => { try { relay.flushStore(); } catch (e) { console.error('final save failed: ' + e.message); } };
process.on('exit', flushOnExit);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushOnExit(); process.exit(0); });

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function body(req, cb, res) {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { json(res, 400, { error: 'bad json' }); } });
}
// Client IP: the rightmost X-Forwarded-For entry (added by the hosting proxy; leftmost entries are client-controlled).
const clientIp = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); return x.length ? x[x.length - 1] : String(req.socket.remoteAddress || ''); };
const reply = (res, r) => json(res, r.code, r.body);
const admin = require('./admin.js')({ relay, data: relay.data, save: relay.save, json, body, waiters: relay.waiters, msgLog: relay.msgLog, flush: relay.flush });

// Authenticated routes: [method, path] -> (me, msg) => result. POST handlers get the JSON body.
const AUTHED = {
  'POST /keys': (me, m) => relay.setKeys(me, m),
  'POST /send': (me, m) => relay.send(me, m),
  'GET /status': me => relay.status(me),
  'POST /spaces': (me, m) => relay.createSpace(me, m),
  'POST /ack': (me, m) => relay.ack(me, m),
  'GET /webhook': me => relay.getWebhook(me),
  'POST /webhook': (me, m) => relay.setWebhook(me, m),
  'GET /email': me => relay.getEmail(me),
  'POST /email': (me, m) => relay.setEmail(me, m),
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/admin' || u.pathname.startsWith('/admin/')) return admin(req, res, u);
  if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && u.pathname === '/register') return body(req, m => reply(res, relay.register(m, { ip: clientIp(req) })), res);
  const km = /^\/keys\/(.+)$/.exec(u.pathname);
  const bearer = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const me = relay.auth(bearer);
  if (req.method === 'GET' && km) return reply(res, relay.getKeys(decodeURIComponent(km[1]), me));
  if (req.method === 'GET' && u.pathname === '/poll') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    const timeoutMs = Math.min(Math.max(u.searchParams.has('timeout') ? +u.searchParams.get('timeout') || 0 : 30, 0), 120) * 1000;
    const cancel = relay.poll(me, { handle: u.searchParams.get('handle'), timeoutMs }, (code, b) => json(res, code, b));
    req.on('close', cancel);
    return;
  }
  const im = /^\/spaces\/([a-z0-9_-]{3,32})\/invites$/.exec(u.pathname);
  if (req.method === 'POST' && im) { if (!me) return json(res, 401, { error: 'invalid or missing token' }); return body(req, m => reply(res, relay.invite(me, im[1], m)), res); }
  const route = AUTHED[req.method + ' ' + u.pathname];
  if (route) {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    if (req.method === 'POST') return body(req, m => reply(res, route(me, m)), res);
    return reply(res, route(me));
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, HOST, () => console.log(`relay listening on ${HOST}:${PORT}, data in ${DATA_FILE}`));
