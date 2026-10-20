// relay-core: all relay logic, no HTTP. createRelay({ store, notifier }) -> methods returning { code, body }.
const crypto = require('crypto');
const { addr } = require('./address.js');
const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,255}$/;
const B64 = /^[A-Za-z0-9+/=]{1,200000}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const validKey = (k, len) => typeof k === 'string' && B64.test(k) && Buffer.from(k, 'base64').length === len; // SPKI DER x25519/ed25519 = 44 bytes
const validEnc = e => e && typeof e === 'object' && (e.v === 1 || e.v === 2) && validKey(e.epk, 44) && typeof e.nonce === 'string' && B64.test(e.nonce) && typeof e.ct === 'string' && B64.test(e.ct) && typeof e.sig === 'string' && B64.test(e.sig);
const RESERVED_SPACES = new Set(['public', 'admin', 'api', 'relay', 'system', 'support', 'www', 'gbc']);
const RESERVED_HANDLES = new Set(['admin', 'relay', 'system', 'support']);
const PUBLIC = 'public';
// Address grammar: "dana" (sender's space), "dana@acme" (space acme), "dana@public" == "dana". Leading @ ignored.
// Storage key: public handles are bare ("dana"), private ones "dana@acme".
const keyOf = (h, sp) => sp === PUBLIC ? h : h + '@' + sp;
function parseAddr(a, defSpace) {
  const s = String(a || '').trim().toLowerCase().replace(/^@/, '');
  const i = s.indexOf('@'); const h = i < 0 ? s : s.slice(0, i), sp = i < 0 ? defSpace : s.slice(i + 1);
  if (sp.includes('.')) return { error: 'federated addresses (handle@space.domain) are not supported yet' };
  if (!HANDLE_RE.test(h) || !HANDLE_RE.test(sp)) return { error: 'invalid address' };
  return { handle: h, space: sp, key: keyOf(h, sp) };
}
const DUR = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
// Short invite codes: 4 chars, no 0/O/1/I/L; case-insensitive. 31^4 ~ 923k codes, so redemption is rate-limited.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_INVITE_MS = 24 * 3600e3;
const FAIL_WINDOW = 10 * 60e3, FAIL_GLOBAL = 100;
// '7d', '12h', '30m', '45s' or plain seconds -> ms
const parseDur = (v, def) => { const m = /^(\d+)([smhd]?)$/.exec(String(v || '').trim()); return m ? +m[1] * (DUR[m[2]] || 1e3) : def; };
const ok = body => ({ code: 200, body });
const err = (code, error) => ({ code, body: { error } });
const ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
const badHost = hn => /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|fc|fd|fe80))/i.test(hn) || hn.endsWith('.local') || hn.endsWith('.internal');

function createRelay({ store, notifier, limits = {} }) {
  const L = { adminLogMax: Math.max(1, Math.floor(+limits.adminLogMax || 1000)), wakeRetryMs: limits.wakeRetryMs ?? 10 * 60e3, wakeMinIntervalMs: limits.wakeMinIntervalMs ?? 0, emailDailyMax: limits.emailDailyMax ?? 80, msgTtlMs: limits.msgTtlMs || 7 * 86400e3, queueMax: limits.queueMax || 1000, inviteFailsPerIp: limits.inviteFailsPerIp || 5 };
  const FAIL_PER_IP = L.inviteFailsPerIp;
  const data = store.load();
  data.handles ||= {}; data.queues ||= {};
  data.settings ||= {}; const S = data.settings;
  S.suspended = !!S.suspended; S.pairPerHour = +S.pairPerHour || 0; S.sendPerMinute = +S.sendPerMinute || 0; S.requireEncryption = !!S.requireEncryption;
  data.stats ||= { day: '', count: 0 };
  // Spaces: migrate legacy data (every existing handle -> public space).
  data.spaces ||= {}; data.spaces[PUBLIC] ||= { created: new Date().toISOString(), owner: null };
  for (const [k, h] of Object.entries(data.handles)) if (!h.space) { const i = k.indexOf('@'); h.space = i < 0 ? PUBLIC : k.slice(i + 1); h.role ||= 'member'; }
  const spaceOf = me => (data.handles[me] || {}).space || PUBLIC;
  const canManage = (me, sp) => sp !== PUBLIC && data.spaces[sp] && (data.spaces[sp].owner === me || (spaceOf(me) === sp && ['owner', 'admin'].includes(data.handles[me].role)));
  data.inviteSecret ||= crypto.randomBytes(32).toString('hex'); // HMAC key so 4-char codes can't be reversed from the data file
  const normCode = c => String(c || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const codeHashes = c => { const n = normCode(c), raw = String(c || '').trim(); // short codes (HMAC) and legacy long codes (sha256 of the code as issued)
    return n.length === 4 ? [crypto.createHmac('sha256', data.inviteSecret).update(n).digest('hex')] : [sha(raw), sha(raw.toLowerCase())]; };
  const live = inv => inv && inv.uses < inv.maxUses && Date.parse(inv.expires) > Date.now();
  function findInvite(code, onlySpace) {
    const hs = codeHashes(code);
    for (const [name, sp] of Object.entries(data.spaces)) {
      if (onlySpace && name !== onlySpace) continue;
      for (const h of hs) if (live((sp.invites || {})[h])) return { space: name, inv: sp.invites[h] };
    }
    return null;
  }
  function pruneInvites() { for (const sp of Object.values(data.spaces)) for (const [h, inv] of Object.entries(sp.invites || {})) if (!live(inv)) delete sp.invites[h]; }
  function newInvite(sp, by, { uses, expires, role } = {}, defUses = 1) {
    const ms = /^(\d+)([smhd])$/.exec(String(expires || '15m')); if (!ms) return err(400, 'expires must look like 30s, 15m, 12h or 1d');
    const ttl = +ms[1] * DUR[ms[2]]; if (!(ttl >= 1e3 && ttl <= MAX_INVITE_MS)) return err(400, 'expires must be between 1s and 24h');
    const maxUses = Math.floor(+uses || defUses); if (!(maxUses >= 1 && maxUses <= 1000)) return err(400, 'uses must be 1-1000');
    if (role && !['member', 'agent', 'admin'].includes(role)) return err(400, 'role must be member, agent or admin');
    pruneInvites();
    let code;
    for (let i = 0; i < 50; i++) { code = Array.from(crypto.randomBytes(4), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); if (!findInvite(code)) break; code = null; } // unique among live invites
    if (!code) return err(503, 'could not allocate an invite code, try again');
    const exp = new Date(Date.now() + ttl).toISOString();
    (data.spaces[sp].invites ||= {})[codeHashes(code)[0]] = { uses: 0, maxUses, expires: exp, role: role || 'member', by, created: new Date().toISOString(), code }; // plaintext kept for the admin list only (short-lived, admin-only)
    save();
    return ok({ space: sp, invite: code, maxUses, expires: exp });
  }
  // Brute-force protection for invite redemption: per-IP and global failure windows.
  const fails = new Map(); let globalFails = [];
  function inviteLocked(ip) {
    const now = Date.now(); globalFails = globalFails.filter(t => t > now - FAIL_WINDOW);
    const f = (fails.get(ip) || []).filter(t => t > now - FAIL_WINDOW); fails.set(ip, f);
    if (f.length >= FAIL_PER_IP) return err(429, 'too many failed invite attempts from your address; try again in ' + Math.ceil((f[0] + FAIL_WINDOW - now) / 60e3) + ' min');
    if (globalFails.length >= FAIL_GLOBAL) return err(429, 'too many failed invite attempts on this relay; try again in a few minutes');
    return null;
  }
  const inviteFailed = ip => { const now = Date.now(); (fails.get(ip) || fails.set(ip, []).get(ip)).push(now); globalFails.push(now); if (fails.size > 10000) fails.clear(); };
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
  function expire(h) { // drop queued messages older than MSG_TTL
    const q = data.queues[h]; if (!q || !q.length) return;
    const cut = Date.now() - L.msgTtlMs, n = q.length;
    if (Date.parse(q[0].ts) >= cut) return;
    data.queues[h] = q.filter(m => Date.parse(m.ts) >= cut); if (data.queues[h].length !== n) save();
  }
  setInterval(() => { for (const h of Object.keys(data.queues)) expire(h); }, Math.min(60e3, Math.max(1e3, L.msgTtlMs / 2))).unref();
  const seen = h => { const x = data.handles[h]; if (x) { x.lastSeen = new Date().toISOString(); seenDirty = true; if (x.wakePending) { x.wakePending = false; save(); } clearTimeout(retryTimers[h]); delete retryTimers[h]; } }; // any poll/wait/ack re-arms wake-ups

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
    if (S.pairPerHour > 0 && st2.length >= S.pairPerHour) return err(429, 'rate limit: max ' + S.pairPerHour + ' messages per hour between ' + addr(me) + ' and ' + addr(to));
    st1.push(now); st2.push(now);
    return null;
  }
  function logMsg(msg) {
    msgLog.push({ id: msg.id, from: msg.from, to: msg.to, ts: msg.ts, encrypted: !!msg.enc, size: msg.enc ? Buffer.byteLength(msg.enc.ct, 'base64') - 16 : Buffer.byteLength(msg.text), text: msg.enc ? '(end-to-end encrypted)' : msg.text });
    while (msgLog.length > L.adminLogMax) msgLog.shift();
    const day = msg.ts.slice(0, 10);
    if (data.stats.day !== day) data.stats = { day, count: 0 };
    data.stats.count++;
  }
  // Wake-up coalescing: one wake per handle until it polls again, and at most one per WAKE_MIN_INTERVAL.
  // Messages arriving during the interval get a single deferred wake. Self-tests (from === to) bypass coalescing.
  data.emailStats ||= { day: '', sent: 0, skipped: 0 };
  const today = () => new Date().toISOString().slice(0, 10);
  const emailDay = () => { if (data.emailStats.day !== today()) data.emailStats = { day: today(), sent: 0, skipped: 0 }; return data.emailStats; };
  const wakeTimers = {};
  const retryTimers = {};
  for (const h of Object.values(data.handles)) delete h.wakePending; // timers don't survive restarts; re-arm everyone
  function fireWake(to, msg, isRetry) {
    const h = data.handles[to]; if (!h) return;
    const count = (data.queues[to] || []).length; if (!count) return;
    h.wakePending = true; h.lastWakeAt = new Date().toISOString(); save();
    clearTimeout(retryTimers[to]); delete retryTimers[to];
    if (!isRetry && L.wakeRetryMs > 0) { // one safety re-wake if this wake is never followed by a poll (e.g. lost email)
      retryTimers[to] = setTimeout(() => { delete retryTimers[to]; const x = data.handles[to]; if (x && x.wakePending) { console.log('re-waking ' + to + ' (previous wake unacknowledged)'); fireWake(to, msg, true); } }, L.wakeRetryMs);
      retryTimers[to].unref && retryTimers[to].unref();
    }
    const rec = kind => st => { const x = data.handles[to]; if (x) { x['last' + kind + 'At'] = new Date().toISOString(); x['last' + kind + 'Status'] = st; save(); } };
    const info = { count };
    const mode = h.wakeMode || 'email-then-webhook';
    const hook = () => h.webhook && notifier.webhook(msg, h.webhook, rec('Webhook'), info);
    const fallback = h.email && h.webhook && mode === 'email-then-webhook'; // webhook only if the email can't go out
    if (h.webhook && !fallback) hook();
    if (h.email) {
      const recEmail = st => { rec('Email')(st); if (fallback && st !== 'ok') { console.log(`email wake for ${to} failed (${st}); using webhook fallback`); hook(); } };
      const es = emailDay();
      if (es.sent >= L.emailDailyMax) { es.skipped++; save(); console.log(`email wake for ${to} skipped: daily cap ${L.emailDailyMax} reached`); recEmail('skipped: relay daily email cap reached'); }
      else { if (notifier.canEmail) { es.sent++; save(); } notifier.email(msg, h.email, recEmail, info); }
    }
  }
  function notify(msg) {
    const to = msg.to, h = data.handles[to]; if (!h || (!h.webhook && !h.email)) return;
    if (msg.from === to) return fireWake(to, msg);
    if (h.wakePending || wakeTimers[to]) return;
    const wait = (h.lastWakeAt ? Date.parse(h.lastWakeAt) + L.wakeMinIntervalMs : 0) - Date.now();
    if (wait <= 0) return fireWake(to, msg);
    wakeTimers[to] = setTimeout(() => { delete wakeTimers[to]; const x = data.handles[to]; if (x && !x.wakePending) fireWake(to, msg); }, wait);
    wakeTimers[to].unref && wakeTimers[to].unref();
  }
  const relay = {
    limits: L, emailStats: () => emailDay(), data, waiters, msgLog, flush, save, flushStore, auth,
    register(m, { ip = '' } = {}) {
      const raw = String(m.handle || '').trim().toLowerCase().replace(/^@/, '');
      const at = raw.indexOf('@'), handle = at < 0 ? raw : raw.slice(0, at);
      let space = String(m.space || (at < 0 ? '' : raw.slice(at + 1))).toLowerCase();
      if (!HANDLE_RE.test(handle)) return err(400, 'handle must be 3-32 chars of a-z, 0-9, _ or -');
      if (RESERVED_HANDLES.has(handle)) return err(400, 'handle @' + handle + ' is reserved');
      let inv = null, role = 'member';
      if (m.invite || (space && space !== PUBLIC)) {
        const lock = inviteLocked(ip); if (lock) return lock;
        const f = m.invite && findInvite(m.invite, space && space !== PUBLIC ? space : null); // the code alone identifies the space
        if (!f || f.space === PUBLIC) { inviteFailed(ip); return err(403, 'invalid or expired invite code (ask the space owner for a new one)'); }
        space = f.space; inv = f.inv; role = inv.role;
      }
      space ||= PUBLIC;
      const key = keyOf(handle, space);
      if (data.handles[key]) return err(409, 'handle taken');
      if (inv) inv.uses++;
      const token = crypto.randomBytes(32).toString('hex');
      data.handles[key] = { tokenHash: sha(token), created: new Date().toISOString(), space, role };
      data.queues[key] = [];
      tokenIndex.set(data.handles[key].tokenHash, key); indexedCount++;
      save();
      return ok({ handle: key, space, role, token });
    },
    createSpace(me, m) {
      const name = String(m.name || '').trim().toLowerCase();
      if (!HANDLE_RE.test(name)) return err(400, 'space name must be 3-32 chars of a-z, 0-9, _ or -');
      if (RESERVED_SPACES.has(name)) return err(400, 'space name ' + name + ' is reserved');
      if (data.spaces[name]) return err(409, 'space taken');
      data.spaces[name] = { created: new Date().toISOString(), owner: me, invites: {} };
      return newInvite(name, me, { uses: m.uses, expires: m.expires }, 5);
    },
    invite(me, name, m) {
      if (!data.spaces[name] || !canManage(me, name)) return err(403, 'only the space owner or a space admin can create invites');
      return newInvite(name, me, m);
    },
    createInviteAsOperator(name, m) { return data.spaces[name] && name !== PUBLIC ? newInvite(name, 'operator', m) : err(404, 'unknown space'); },
    deleteSpace(name, me) { // me = handle (owner/space admin) or null for the operator
      if (name === PUBLIC) return err(400, 'the public space cannot be deleted');
      if (!data.spaces[name]) return err(404, 'unknown space');
      if (me !== null && !canManage(me, name)) return err(403, 'only the space owner or a space admin can delete the space');
      const members = Object.keys(data.handles).filter(k => data.handles[k].space === name);
      for (const k of members) {
        for (const w of waiters[k] || []) { clearTimeout(w.timer); w.cb(410, { error: 'space deleted' }); }
        delete waiters[k]; tokenIndex.delete(data.handles[k].tokenHash); delete data.handles[k]; delete data.queues[k]; indexedCount--;
      }
      delete data.spaces[name]; save();
      return ok({ ok: true, deleted: name, handlesRemoved: members.length });
    },
    members(me, name) { // members-only directory of a private space
      name = String(name || spaceOf(me)).toLowerCase();
      if (name === PUBLIC) return err(403, 'the public space has no member list');
      if (!data.spaces[name] || (spaceOf(me) !== name && data.spaces[name].owner !== me)) return err(403, 'only members of a space can list its members');
      const list = Object.entries(data.handles).filter(([, h]) => h.space === name).map(([k, h]) => ({ handle: k, role: h.role || 'member', keys: !!h.keys, lastSeen: h.lastSeen || null, queued: (data.queues[k] || []).length }));
      return ok({ space: name, members: list.sort((a, b) => a.handle.localeCompare(b.handle)) });
    },
    listInvites() { // admin only: live invites
      pruneInvites(); const out = [];
      for (const [space, sp] of Object.entries(data.spaces)) for (const [id, inv] of Object.entries(sp.invites || {})) out.push({ id: id.slice(0, 16), space, code: inv.code || null, usesLeft: inv.maxUses - inv.uses, maxUses: inv.maxUses, expires: inv.expires, created: inv.created || null, role: inv.role, by: inv.by || null });
      return out.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    },
    revokeInvite(space, id) {
      const sp = data.spaces[space]; const k = sp && Object.keys(sp.invites || {}).find(h => h.slice(0, 16) === id);
      if (!k) return err(404, 'unknown invite'); delete sp.invites[k]; save(); return ok({ ok: true, revoked: id });
    },
    findInviteSpace(code) { const f = findInvite(code); return f ? f.space : null; },
    createSpaceAsOperator(m) { const r = relay.createSpace('operator', m); if (r.code === 200) data.spaces[r.body.space].owner = null; return r; },
    getKeys(addr, viewer) { // private-space keys are visible only to members of that space
      const a = parseAddr(addr, viewer ? spaceOf(viewer) : PUBLIC), h = a.key && data.handles[a.key];
      if (!h || !h.keys || (h.space !== PUBLIC && (!viewer || spaceOf(viewer) !== h.space))) return err(404, 'no keys for handle');
      return ok({ handle: a.key, ...h.keys });
    },
    setKeys(me, m) {
      if (!validKey(m.x25519, 44) || !validKey(m.ed25519, 44)) return err(400, 'x25519 and ed25519 must be base64 SPKI DER public keys');
      data.handles[me].keys = { x25519: m.x25519, ed25519: m.ed25519, updated: new Date().toISOString() }; save();
      return ok({ ok: true });
    },
    send(me, m) {
      const enc = m.enc;
      if (!m.to || (!m.text && !enc)) return err(400, 'to and text (or enc) required');
      const a = parseAddr(m.to, spaceOf(me)); if (a.error) return err(400, a.error);
      const to = a.key, mySpace = spaceOf(me);
      if (a.space !== mySpace) return err(403, `cross-space messaging is not enabled (you are in ${mySpace}, ${addr(a.key)} is in ${a.space}); space-to-space grants are coming later`);
      if (enc && !validEnc(enc)) return err(400, 'invalid encrypted envelope');
      if (!enc && S.requireEncryption) return err(400, 'this relay requires end-to-end encryption; update the CLI (git pull) and retry');
      if (!data.handles[to]) return err(404, 'unknown recipient');
      expire(to); if ((data.queues[to] || []).length >= L.queueMax) return err(429, 'recipient queue full (' + L.queueMax + ' unread messages); try again later');
      const deny = checkSend(me, to); if (deny) return deny;
      const msg = { id: Date.now() + '-' + crypto.randomBytes(3).toString('hex'), from: me, to, ts: new Date().toISOString() };
      if (enc) msg.enc = { v: enc.v, epk: enc.epk, nonce: enc.nonce, ct: enc.ct, sig: enc.sig }; else { msg.text = String(m.text); msg.plaintext = true; }
      (data.queues[to] ||= []).push(msg);
      logMsg(msg); save(); flush(to); notify(msg);
      return ok({ ok: true, id: msg.id });
    },
    status(me) {
      const h = data.handles[me];
      return ok({ wakeMode: data.handles[me].email && data.handles[me].webhook ? (data.handles[me].wakeMode || 'email-then-webhook') : null, handle: me, space: spaceOf(me), role: data.handles[me].role || 'member', webhook: !!h.webhook, lastWebhookStatus: h.lastWebhookStatus || null, lastWebhookAt: h.lastWebhookAt || null, email: !!h.email, lastEmailStatus: h.lastEmailStatus || null, lastEmailAt: h.lastEmailAt || null, unreadCount: (data.queues[me] || []).length, keys: !!h.keys, requireEncryption: S.requireEncryption, lastPollAt: h.lastSeen || null });
    },
    // Long-poll. cb(code, body) is called exactly once unless the returned cancel() runs first.
    poll(me, { handle, timeoutMs }, cb) {
      seen(me); expire(me);
      if (handle && String(handle).toLowerCase().replace(/^@/, '').replace(/@public$/, '') !== me) { cb(403, { error: 'token does not match handle' }); return () => {}; }
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
    setWakeMode(me, m) {
      if (!['email-then-webhook', 'both'].includes(m.mode)) return err(400, "mode must be 'email-then-webhook' or 'both'");
      data.handles[me].wakeMode = m.mode; save(); return ok({ ok: true, wakeMode: m.mode });
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
module.exports = { createRelay, parseAddr, keyOf, RESERVED_SPACES, RESERVED_HANDLES };
