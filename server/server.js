const publicUrl = require('./public-url');
// Self-host wrapper: one relay-core instance + HTTP API + /admin portal.
const http = require('http'), fs = require('fs'), path = require('path');
const { createRelay, createFileStore, createPgStore, createNotifier } = require('../core');
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || './data.json';
let RESEND_KEY = process.env.RESEND_API_KEY || '';
if (!RESEND_KEY) { for (const d of [process.cwd(), path.join(__dirname, '..'), __dirname]) { try { RESEND_KEY = fs.readFileSync(path.join(d, '.resend-key'), 'utf8').trim(); break; } catch {} } }

const DATABASE_URL = process.env.DATABASE_URL || '';
const store = DATABASE_URL ? createPgStore({ url: DATABASE_URL, schema: process.env.DATABASE_SCHEMA || 'public', saveMs: +process.env.SAVE_MS || 200 }) : createFileStore({ file: DATA_FILE, saveMs: +process.env.SAVE_MS || 200 });
(async () => { await store.init();
const parseSize = v => { const m = /^(\d+)\s*([kKmM]?)[bB]?$/.exec(String(v || '').trim()); return m ? +m[1] * ({ k: 1024, m: 1048576 }[m[2].toLowerCase()] || 1) : 0; };
const parseDur = v => { const m = /^(\d+)([smhd]?)$/.exec(String(v || '').trim()); return m ? +m[1] * ({ s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] || 1e3) : 0; };
const limits = { attachMax: parseSize(process.env.ATTACH_MAX) || 256 * 1024, adminLogMax: +process.env.ADMIN_LOG_MAX || 1000, msgTtlMs: parseDur(process.env.MSG_TTL) || 7 * 86400e3, queueMax: +process.env.QUEUE_MAX || 1000, inviteFailsPerIp: +process.env.INVITE_FAILS_PER_IP || 5, wakeMinIntervalMs: process.env.WAKE_MIN_INTERVAL ? parseDur(process.env.WAKE_MIN_INTERVAL) : 0, wakeRetryMs: process.env.WAKE_RETRY ? parseDur(process.env.WAKE_RETRY) : 10 * 60e3, emailDailyMax: process.env.EMAIL_DAILY_MAX !== undefined ? +process.env.EMAIL_DAILY_MAX : 80 };
const OFFICIAL_PREVIOUS = ['1.0.0']; // earlier official client releases, still shown as official
limits.serverVersion = require('../package.json').version; limits.knownClientVersions = [...new Set(String((process.env.KNOWN_CLIENT_VERSIONS ?? '') + ',' + OFFICIAL_PREVIOUS.join(',')).split(',').map(v => v.trim()).filter(Boolean))];
const relay = createRelay({ store, limits, notifier: createNotifier({ resendKey: RESEND_KEY, emailFrom: process.env.EMAIL_FROM || '', ...(process.env.RESEND_API_URL ? { resendUrl: process.env.RESEND_API_URL } : {}) }) });
const backup = DATABASE_URL ? { enabled: false, reason: 'postgres: use your provider\'s backups plus GET /admin/api/export' } : require('./backup.js')({ getData: () => relay.data, dir: process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(DATA_FILE)), 'backups'), intervalMs: process.env.BACKUP_INTERVAL != null && process.env.BACKUP_INTERVAL !== '' ? parseDur(process.env.BACKUP_INTERVAL) : 6 * 3600e3, keep: Math.max(1, +process.env.BACKUP_KEEP || 14), firstDelayMs: +process.env.BACKUP_FIRST_DELAY_MS || 60e3 });
// Flush pending writes on deploy/restart so nothing is lost.
const flushOnExit = () => { try { relay.flushStore(); } catch (e) { console.error('final save failed: ' + e.message); } };
process.on('exit', flushOnExit); // sync path (file store); Postgres writes are drained in the signal handler below
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushOnExit(); Promise.race([store.close(), new Promise(r => setTimeout(r, 8000))]).catch(e => console.error('final save failed: ' + e.message)).finally(() => process.exit(0)); });

const BODY_MAX = () => Math.max(1e6, Math.ceil(relay.limits.attachMax * 4 / 3) + 256 * 1024); // base64 attachments + envelope/JSON overhead
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function body(req, cb, res) {
  let b = '', over = false; const max = BODY_MAX();
  req.on('data', d => { if (over) return; b += d; if (b.length > max) { over = true; b = ''; json(res, 413, { error: `message too large: request body exceeds ${Math.round(max / 1024)} KB (attachments are limited to ${Math.round(relay.limits.attachMax / 1024)} KB, ATTACH_MAX)` }); req.resume(); } });
  req.on('end', () => { if (over) return; try { cb(JSON.parse(b || '{}')); } catch { json(res, 400, { error: 'bad json' }); } });
}
// Client IP: the rightmost X-Forwarded-For entry (added by the hosting proxy; leftmost entries are client-controlled).
const clientIp = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); return x.length ? x[x.length - 1] : String(req.socket.remoteAddress || ''); };
const reply = (res, r) => json(res, r.code, r.body);
// Client version negotiation: every response carries X-Relay-Latest / X-Relay-Min-Client; old or unversioned CLIs get 426.
const LATEST = require('../package.json').version;
const vcmpPre = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
// Default floor: the oldest client this server's protocol still supports. Bump it only for breaking client changes
// (minor releases like 1.1.0 stay compatible with 1.0.x). CLIENT_MIN_VERSION overrides.
const COMPAT_FLOOR = '1.0.0';
const MIN_DEFAULT = vcmpPre(COMPAT_FLOOR, LATEST) <= 0 ? COMPAT_FLOOR : LATEST;
const MIN_CLIENT = /^\d+\.\d+\.\d+$/.test(process.env.CLIENT_MIN_VERSION || '') ? process.env.CLIENT_MIN_VERSION : MIN_DEFAULT;
const vcmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const clientTooOld = v => !/^\d+\.\d+\.\d+/.test(v || '') || vcmp(String(v).match(/^\d+\.\d+\.\d+/)[0], MIN_CLIENT) < 0;
const oauth = require('./oauth.js')({ relay, json, allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === '1' });
// MCP endpoint (Streamable HTTP, JSON responses only, stateless). Auth: OAuth access token (ChatGPT) or the handle's relay token.
function mcpHttp(req, res) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'use POST (JSON-RPC); this server does not offer an SSE stream' })); }
  const tok = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const me = oauth.tokenAuth(tok) || relay.auth(tok);
  if (!me) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${publicUrl(req)}/.well-known/oauth-protected-resource"` }); return res.end(JSON.stringify({ error: 'invalid or missing token' })); }
  if (relay.data.handles[me].status === 'blocked') return json(res, 403, { error: 'handle blocked by admin' });
  body(req, async m => {
    try {
      const out = Array.isArray(m) ? (await Promise.all(m.map(x => relay.mcp.rpc(me, x)))).filter(Boolean) : await relay.mcp.rpc(me, m);
      if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
      json(res, 200, out);
    } catch (e) { console.error('mcp error: ' + e.message); json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }); }
  }, res);
}
const admin = require('./admin.js')({ relay, data: relay.data, save: relay.save, json, body, waiters: relay.waiters, msgLog: relay.msgLog, flush: relay.flush, store, backup });

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
  'POST /wake-mode': (me, m) => relay.setWakeMode(me, m),
  'POST /mcp/connect-code': me => ({ code: 200, body: oauth.connectCode(me) }),
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('X-Relay-Latest', LATEST); res.setHeader('X-Relay-Min-Client', MIN_CLIENT);
  if (u.pathname === '/admin' || u.pathname.startsWith('/admin/')) return admin(req, res, u);
  if (req.method === 'GET' && (u.pathname === '/preview' || u.pathname.startsWith('/preview/'))) { // static visual prototype, no auth
    if (u.pathname === '/preview') { res.writeHead(302, { Location: '/preview/' }); return res.end(); }
    const root = path.join(__dirname, '..', 'preview'), f = path.normalize(path.join(root, decodeURIComponent(u.pathname.slice(9)) || 'index.html'));
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
    if (!f.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    return fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store' }); res.end(b); });
  }
  if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, clientRepo: require('./client-repo'), version: LATEST, latest: LATEST, minClient: MIN_CLIENT, publicUrl: publicUrl(req), attachMax: relay.limits.attachMax, limits: { msgTtlSeconds: relay.limits.msgTtlMs / 1000, queueMax: relay.limits.queueMax, wakeMinIntervalSeconds: relay.limits.wakeMinIntervalMs / 1000, wakeRetrySeconds: relay.limits.wakeRetryMs / 1000, emailDailyMax: relay.limits.emailDailyMax }, knownClientVersions: [LATEST, ...limits.knownClientVersions.filter(v => v !== LATEST)], emailsToday: relay.emailStats().sent, emailsSkippedToday: relay.emailStats().skipped });
  if (u.pathname === '/mcp') return mcpHttp(req, res); // MCP clients (ChatGPT) don't send X-Relay-Client
  if ((u.pathname.startsWith('/.well-known/') || u.pathname.startsWith('/oauth/')) && oauth.handle(req, res, u)) return;
  if (!(req.method === 'GET' && /^\/invites\//.test(u.pathname)) && clientTooOld(req.headers['x-relay-client'])) return json(res, 426, { error: 'update required', min: MIN_CLIENT, latest: LATEST, how: 'git pull in your relay checkout' });
  if (req.method === 'POST' && u.pathname === '/register') return body(req, m => reply(res, relay.register(m, { ip: clientIp(req) })), res);
  const ivm = /^\/invites\/([^/]{1,64})$/.exec(u.pathname);
  if (req.method === 'GET' && ivm) return reply(res, relay.lookupInvite(decodeURIComponent(ivm[1]), { ip: clientIp(req) }));
  const km = /^\/keys\/(.+)$/.exec(u.pathname);
  const bearer = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const me = relay.auth(bearer);
  if (me) relay.noteClient(me, req.headers['x-relay-client'], req.headers['x-relay-client-dirty'] === '1');
  if (req.method === 'GET' && km) return reply(res, relay.getKeys(decodeURIComponent(km[1]), me));
  if (req.method === 'GET' && u.pathname === '/poll') {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    const timeoutMs = Math.min(Math.max(u.searchParams.has('timeout') ? +u.searchParams.get('timeout') || 0 : 30, 0), 120) * 1000;
    const cancel = relay.poll(me, { handle: u.searchParams.get('handle'), timeoutMs }, (code, b) => json(res, code, b));
    req.on('close', cancel);
    return;
  }
  const mm = /^\/spaces\/([a-z0-9_-]{3,32})\/members$/.exec(u.pathname);
  if (req.method === 'GET' && mm) { if (!me) return json(res, 401, { error: 'invalid or missing token' }); return reply(res, relay.members(me, mm[1])); }
  const dm = /^\/spaces\/([a-z0-9_-]{3,32})$/.exec(u.pathname);
  if (req.method === 'DELETE' && dm) { if (!me) return json(res, 401, { error: 'invalid or missing token' }); return reply(res, relay.deleteSpace(dm[1], me)); }
  const im = /^\/spaces\/([a-z0-9_-]{3,32})\/invites$/.exec(u.pathname);
  if (req.method === 'POST' && im) { if (!me) return json(res, 401, { error: 'invalid or missing token' }); return body(req, m => reply(res, relay.invite(me, im[1], m)), res); }
  const route = AUTHED[req.method + ' ' + u.pathname];
  if (route) {
    if (!me) return json(res, 401, { error: 'invalid or missing token' });
    if (req.method === 'POST') return body(req, m => reply(res, route(me, m)), res);
    return reply(res, route(me));
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, HOST, () => console.log(`relay listening on ${HOST}:${PORT}, storage: ${DATABASE_URL ? 'postgres (schema ' + store.schema + ')' : 'json file ' + DATA_FILE}`));
})().catch(e => { console.error('startup failed: ' + e.message); process.exit(1); });
