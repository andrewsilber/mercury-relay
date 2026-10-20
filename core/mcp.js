'use strict';
// MCP endpoint logic (no HTTP): JSON-RPC tools + MCP Events (draft spec, webhook delivery, Standard Webhooks signing).
// A third wake channel next to email and webhook. Content-free: events and tools never carry message text, so E2E holds.
// Subscriptions live on the handle record (h.mcpSubs), so both the JSON-file and Postgres stores persist them.
const crypto = require('crypto'), dns = require('dns').promises, net = require('net');
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const EVENT = 'message.received';
const DAY = 86400e3, TTL_DEFAULT = 7 * DAY, TTL_MAX = 30 * DAY, TTL_MIN = 60e3, SUBS_MAX = 20, BODY_MAX = 256 * 1024;
const RETRY_MS = [0, 2e3, 10e3, 60e3, 300e3];
const VERIFY_CACHE_MS = 3600e3;
const WHSEC = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const rpcErr = (code, message, data) => ({ error: { code, message, ...(data ? { data } : {}) } });
const privIp = ip => { // loopback, private, link-local, CGNAT, unique-local, unspecified, IPv4-mapped private
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); if (m) ip = m[1];
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const s = ip.toLowerCase(); return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
};

function sign(secret, id, ts, body) {
  const key = Buffer.from(WHSEC.exec(secret)[1], 'base64');
  return 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

module.exports = function createMcp({ data, save, relay, allowPrivate = false, version = '0.0.0', fetchImpl = fetch, retryMs = RETRY_MS }) {
  const verified = new Map(); // principal|url -> verifiedAt
  const subsOf = me => (data.handles[me] || {}).mcpSubs || {};
  const now = () => Date.now();
  function prune(me) {
    const h = data.handles[me]; if (!h || !h.mcpSubs) return;
    let changed = false;
    for (const [id, s] of Object.entries(h.mcpSubs)) if (s.expires && Date.parse(s.expires) <= now()) { delete h.mcpSubs[id]; changed = true; }
    if (!Object.keys(h.mcpSubs).length) { delete h.mcpSubs; changed = true; }
    if (changed) save();
  }
  setInterval(() => { for (const k of Object.keys(data.handles)) if (data.handles[k].mcpSubs) prune(k); }, 10 * 60e3).unref();
  const hasSubs = me => { prune(me); return Object.keys(subsOf(me)).length > 0; };

  async function checkUrl(raw) { // HTTPS only, public addresses only, re-checked before every request
    let u; try { u = new URL(String(raw)); } catch { return 'invalid url'; }
    if (u.username || u.password) return 'credentials in url not allowed';
    if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return 'callback must be https';
    if (allowPrivate) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$|\.local$|\.internal$/i.test(host)) return 'private callback host';
    let addrs; try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch { return 'callback host does not resolve'; }
    if (!addrs.length || addrs.some(a => privIp(a.address))) return 'private callback address';
    return null;
  }
  async function post(sub, id, body) { // one signed POST; never follows redirects
    const bad = await checkUrl(sub.url); if (bad) return { ok: false, status: 0, error: bad };
    const ts = Math.floor(now() / 1000);
    try {
      const r = await fetchImpl(sub.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10e3), body,
        headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': [sub.secret, ...(sub.prevSecret && Date.parse(sub.rotateUntil) > now() ? [sub.prevSecret] : [])].map(k => sign(k, id, ts, body)).join(' '), 'x-mcp-subscription-id': sub.id } });
      const text = await r.text().catch(() => '');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text };
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
  }
  async function verifyCallback(me, sub) {
    const key = me + '|' + sub.url, t = verified.get(key);
    if (t && now() - t < VERIFY_CACHE_MS) return null;
    const challenge = crypto.randomBytes(24).toString('base64url');
    const r = await post(sub, 'msg_verification_' + crypto.randomBytes(8).toString('hex'), JSON.stringify({ type: 'verification', challenge }));
    if (!r.ok) return r.status ? 'http_' + r.status : (r.error === 'The operation was aborted due to timeout' ? 'timeout' : 'unreachable');
    let got = ''; try { got = String(JSON.parse(r.text).challenge || ''); } catch {}
    const a = Buffer.from(got), b = Buffer.from(challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'challenge_failed';
    verified.set(key, now()); if (verified.size > 5000) verified.clear();
    return null;
  }
  const subId = (me, url, name, args) => 'sub_' + crypto.createHash('sha256').update(canon([me, url, name, args])).digest('hex').slice(0, 32);
  const EVENT_DEF = {
    name: EVENT,
    description: 'A new message is waiting for this relay handle. Content-free: the payload says who it is from and how many are queued, never the text. Read and reply by running the relay client (relay poll, relay send) on your computer; it decrypts end-to-end.',
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    payloadSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'Recipient handle (this connection).' },
      from: { type: 'string', description: 'Sender handle of the latest message.' },
      ts: { type: 'string', description: 'When the latest message was queued (ISO 8601).' },
      count: { type: 'integer', description: 'Unread messages queued for this handle.' },
      encrypted: { type: 'boolean', description: 'Whether the latest message is end-to-end encrypted.' } },
      required: ['to', 'from', 'ts', 'count', 'encrypted'], additionalProperties: false },
  };
  function validArgs(a) { return a === undefined || a === null || (a && typeof a === 'object' && !Array.isArray(a) && !Object.keys(a).length); }
  async function subscribe(me, p = {}) {
    if (p.name !== EVENT) return rpcErr(-32023, 'unknown event', { kind: 'event' });
    if (!validArgs(p.arguments)) return rpcErr(-32602, 'message.received takes no arguments');
    const d = p.delivery || {};
    if (d.mode !== 'webhook') return rpcErr(-32026, 'only webhook delivery is supported', { feature: 'delivery.mode' });
    const m = WHSEC.exec(String(d.secret || '')), klen = m ? Buffer.from(m[1], 'base64').length : 0;
    if (!m || klen < 24 || klen > 64) return rpcErr(-32602, 'delivery.secret must be whsec_ + base64 of 24-64 bytes');
    const bad = await checkUrl(d.url); if (bad) return rpcErr(-32015, 'callback endpoint rejected: ' + bad, { reason: 'invalid_url' });
    const url = new URL(d.url).toString(), id = subId(me, url, EVENT, {});
    const subs = subsOf(me);
    if (!subs[id] && Object.keys(subs).length >= SUBS_MAX) return rpcErr(-32029, 'too many subscriptions for this handle (max ' + SUBS_MAX + ')');
    const fail = await verifyCallback(me, { id, url, secret: d.secret });
    if (fail) return rpcErr(-32015, 'callback verification failed', { reason: fail });
    let ttl = p.ttlMs === undefined ? TTL_DEFAULT : p.ttlMs === null ? TTL_MAX : Math.min(TTL_MAX, Math.max(TTL_MIN, +p.ttlMs || TTL_DEFAULT));
    const h = data.handles[me]; if (!h) return rpcErr(-32024, 'handle no longer exists');
    const old = (h.mcpSubs || {})[id];
    const prevSecret = old && old.secret !== d.secret ? old.secret : old && old.prevSecret;
    (h.mcpSubs ||= {})[id] = { id, name: EVENT, arguments: {}, url, secret: d.secret, ...(prevSecret && prevSecret !== d.secret ? { prevSecret, rotateUntil: new Date(now() + 10 * 60e3).toISOString() } : {}), created: old ? old.created : new Date().toISOString(), updated: new Date().toISOString(), expires: new Date(now() + ttl).toISOString() };
    save();
    return { result: { id, refreshBefore: h.mcpSubs[id].expires, cursor: null, truncated: false, deliveryStatus: { active: true, lastDeliveryAt: old && old.lastDeliveryAt || null, lastError: old && old.lastError || null } } };
  }
  function unsubscribe(me, p = {}) {
    const d = p.delivery || {}; let url; try { url = new URL(String(d.url)).toString(); } catch { return rpcErr(-32602, 'delivery.url required'); }
    if (p.name !== EVENT) return { result: {} };
    const h = data.handles[me], id = subId(me, url, EVENT, {});
    if (h && h.mcpSubs && h.mcpSubs[id]) { delete h.mcpSubs[id]; if (!Object.keys(h.mcpSubs).length) delete h.mcpSubs; save(); }
    return { result: {} };
  }
  // Delivery: one event per POST, retries with backoff, same eventId across retries, fresh timestamp+signature each attempt.
  function deliver(to, msg, count) {
    prune(to);
    const subs = Object.values(subsOf(to)); if (!subs.length) return;
    const event = { eventId: 'evt_' + crypto.randomBytes(12).toString('hex'), name: EVENT, timestamp: new Date().toISOString(), data: { to, from: msg.from, ts: msg.ts, count, encrypted: !!msg.enc }, cursor: null };
    const body = JSON.stringify(event); if (Buffer.byteLength(body) > BODY_MAX) return;
    for (const s of subs) attempt(to, s.id, event.eventId, body, 0);
  }
  function attempt(to, id, eventId, body, n) {
    const t = setTimeout(async () => {
      const h = data.handles[to], s = h && h.mcpSubs && h.mcpSubs[id]; if (!s) return;
      const r = await post(s, eventId, body);
      const x = data.handles[to], cur = x && x.mcpSubs && x.mcpSubs[id]; if (!cur) return;
      if (r.ok) { cur.lastDeliveryAt = new Date().toISOString(); delete cur.lastError; x.lastMcpAt = cur.lastDeliveryAt; x.lastMcpStatus = 'ok'; save(); return; }
      const why = r.status ? 'http ' + r.status : 'error: ' + (r.error || 'unknown');
      cur.lastError = why; x.lastMcpAt = new Date().toISOString(); x.lastMcpStatus = why; save();
      if (r.status === 410) { delete x.mcpSubs[id]; if (!Object.keys(x.mcpSubs).length) delete x.mcpSubs; save(); console.log('mcp subscription ' + id + ' for ' + to + ' gone (410); removed'); return; }
      if (r.status === 413 || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 425 && r.status !== 429)) return;
      if (n + 1 < retryMs.length) attempt(to, id, eventId, body, n + 1); else console.log('mcp event ' + eventId + ' for ' + to + ' abandoned after ' + retryMs.length + ' attempts (' + why + ')');
    }, retryMs[n] || 0);
    t.unref && t.unref();
  }

  const TOOLS = [
    { name: 'status', title: 'Relay status', description: 'Show this relay handle, its space, and how many messages are waiting. Never returns message text; read messages with the relay client (relay poll).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Relay status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'members', title: 'Space members', description: 'List the handles in this handle\'s private space: role, whether keys are published, last seen and queued count. Never returns message text.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Space members', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  ];
  function callTool(me, p = {}) {
    const out = (obj, isError) => ({ result: { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: !!isError } });
    if (p.name === 'status') { const b = relay.status(me).body; return out({ handle: b.handle, space: b.space, role: b.role, unreadCount: b.unreadCount, lastPollAt: b.lastPollAt, keys: b.keys, mcpSubscriptions: Object.keys(subsOf(me)).length }); }
    if (p.name === 'members') { const r = relay.members(me); return r.code === 200 ? out({ space: r.body.space, members: r.body.members.map(m => ({ handle: m.handle, role: m.role, keys: m.keys, lastSeen: m.lastSeen, queued: m.queued })) }) : out({ error: r.body.error }, true); }
    return rpcErr(-32602, 'unknown tool: ' + p.name);
  }
  const INSTRUCTIONS = 'agentrelay: cross-platform agent messaging. This server only wakes you and shows status; it never sees message text. When message.received fires, run the relay client on your computer (`node relay.js poll`) to read and decrypt, then reply with `node relay.js send <handle> <text>`.';
  const caps = () => ({ tools: { listChanged: false }, events: {} });
  const info = () => ({ name: 'agentrelay', title: 'agentrelay', version });
  async function rpc(me, m) {
    const id = m && m.id, isNote = m && m.id === undefined;
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: id ?? null, ...rpcErr(-32600, 'invalid request') };
    let r;
    switch (m.method) {
      case 'initialize': { const want = m.params && m.params.protocolVersion; r = { result: { protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0], capabilities: caps(), serverInfo: info(), instructions: INSTRUCTIONS } }; break; }
      case 'server/discover': r = { result: { resultType: 'complete', supportedVersions: SUPPORTED, capabilities: caps(), serverInfo: info(), instructions: INSTRUCTIONS } }; break;
      case 'ping': r = { result: {} }; break;
      case 'tools/list': r = { result: { tools: TOOLS } }; break;
      case 'tools/call': r = callTool(me, m.params); break;
      case 'events/list': r = { result: { events: [EVENT_DEF], nextCursor: null } }; break;
      case 'events/subscribe': r = await subscribe(me, m.params); break;
      case 'events/unsubscribe': r = unsubscribe(me, m.params); break;
      default: if (m.method.startsWith('notifications/')) return null; r = rpcErr(-32601, 'method not found: ' + m.method);
    }
    return isNote ? null : { jsonrpc: '2.0', id, ...r };
  }
  return { rpc, deliver, hasSubs, SUPPORTED, sign };
};
module.exports.sign = sign;
module.exports.SUPPORTED = SUPPORTED;
