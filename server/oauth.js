'use strict';
// Minimal OAuth 2.1 authorization server for the MCP endpoint (ChatGPT can't send custom API keys; it needs OAuth).
// Authorization code + PKCE (S256) only, public clients (token_endpoint_auth_method "none"), DCR and CIMD client ids.
// The user proves which handle to connect with a short connect code from `relay connect-code` (or the handle's token).
// Access/refresh tokens are random, stored only as SHA-256 hashes in data.oauth.tokens, and bound to one handle.
const crypto = require('crypto');
const publicUrl = require('./public-url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const b64url = b => Buffer.from(b).toString('base64url');
const ACCESS_TTL = 24 * 3600e3, REFRESH_TTL = 90 * 86400e3, CODE_TTL = 5 * 60e3, CONNECT_TTL = 10 * 60e3;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function createOAuth({ relay, json, allowPrivate = false, fetchImpl = fetch }) {
  const data = relay.data, save = relay.save;
  data.oauth ||= {}; data.oauth.clients ||= {}; data.oauth.tokens ||= {};
  const O = data.oauth;
  const authCodes = new Map(), connectCodes = new Map(), fails = new Map();
  const base = req => publicUrl(req);
  setInterval(() => { const t = Date.now(); let ch = false;
    for (const [k, v] of Object.entries(O.tokens)) if (v.exp <= t || !relay.data.handles[v.handle]) { delete O.tokens[k]; ch = true; }
    for (const m of [authCodes, connectCodes]) for (const [k, v] of m) if (v.exp <= t) m.delete(k);
    if (ch) save(); }, 10 * 60e3).unref();

  function tokenAuth(tok) { // OAuth access token -> handle, or null
    if (!tok) return null; const r = O.tokens[sha(tok)];
    if (!r || r.kind !== 'access' || r.exp <= Date.now() || !data.handles[r.handle]) return null;
    return r.handle;
  }
  function connectCode(me) { // short-lived one-time code the user types on the authorize page
    let code; do { code = Array.from(crypto.randomBytes(8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (connectCodes.has(sha(code)));
    connectCodes.set(sha(code), { handle: me, exp: Date.now() + CONNECT_TTL });
    return { code: code.slice(0, 4) + '-' + code.slice(4), expires: new Date(Date.now() + CONNECT_TTL).toISOString() };
  }
  function redeem(secret) { // connect code (one-time) or a relay token
    const s = String(secret || '').trim(); if (!s) return null;
    const n = s.toUpperCase().replace(/[\s-]/g, '');
    if (n.length === 8) { const k = sha(n), c = connectCodes.get(k); if (c && c.exp > Date.now() && data.handles[c.handle]) { connectCodes.delete(k); return c.handle; } }
    return relay.auth(s);
  }
  const metaResource = req => ({ resource: base(req) + '/mcp', authorization_servers: [base(req)], bearer_methods_supported: ['header'], scopes_supported: ['relay'], resource_name: 'agentrelay' });
  const metaAS = req => { const b = base(req); return { issuer: b, authorization_endpoint: b + '/oauth/authorize', token_endpoint: b + '/oauth/token', registration_endpoint: b + '/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['relay'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true }; };

  function readBody(req, cb, res) {
    let b = ''; req.on('data', d => { b += d; if (b.length > 64 * 1024) { req.destroy(); } });
    req.on('end', () => { const ct = String(req.headers['content-type'] || '');
      try { cb(ct.includes('application/json') ? JSON.parse(b || '{}') : Object.fromEntries(new URLSearchParams(b))); } catch { json(res, 400, { error: 'invalid_request', error_description: 'bad body' }); } });
  }
  const httpsOk = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && (allowPrivate || ['localhost', '127.0.0.1'].includes(x.hostname))); } catch { return false; } };
  async function resolveClient(clientId, redirectUri) { // -> { name } or { error }
    if (!clientId) return { error: 'missing client_id' };
    if (/^https:\/\//.test(clientId)) { // CIMD: the client_id is a URL to its metadata document
      try {
        const r = await fetchImpl(clientId, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
        if (!r.ok) return { error: 'client metadata fetch failed (' + r.status + ')' };
        const t = await r.text(); if (t.length > 32 * 1024) return { error: 'client metadata too large' };
        const d = JSON.parse(t);
        if (d.client_id !== clientId) return { error: 'client metadata client_id mismatch' };
        if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.includes(redirectUri)) return { error: 'redirect_uri not registered for this client' };
        return { name: String(d.client_name || new URL(clientId).hostname).slice(0, 80) };
      } catch (e) { return { error: 'client metadata fetch failed' }; }
    }
    const c = O.clients[clientId]; if (!c) return { error: 'unknown client_id' };
    if (!c.redirect_uris.includes(redirectUri)) return { error: 'redirect_uri not registered for this client' };
    return { name: c.client_name || 'OAuth client' };
  }
  const page = (res, code, title, inner) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'", 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem"><h2>${esc(title)}</h2>${inner}</body>`); };
  function authorizeForm(res, q, clientName, error) {
    const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map(k => q[k] != null ? `<input type="hidden" name="${k}" value="${esc(q[k])}">` : '').join('');
    page(res, error ? 400 : 200, 'Connect an agentrelay handle', `<p><b>${esc(clientName)}</b> wants to connect to one agentrelay handle. It will be able to see that handle's status and member list and to subscribe to content-free "new message" wake-ups. It can't read or send messages.</p>
<p>On the computer where that handle's relay client runs, run <code>node relay.js connect-code</code> and enter the code (valid 10 minutes, one use).</p>
${error ? `<p style="color:#b00">${esc(error)}</p>` : ''}<form method="post" action="/oauth/authorize">${hidden}<input name="secret" autocomplete="off" placeholder="ABCD-EFGH" style="font-size:1.2rem;padding:.4rem;width:14rem" autofocus> <button style="font-size:1.1rem;padding:.4rem 1rem">Connect</button></form>`);
  }
  function validAuthParams(q) {
    if (q.response_type !== 'code') return 'response_type must be code';
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || '')) return 'PKCE S256 code_challenge required';
    if (!httpsOk(q.redirect_uri)) return 'invalid redirect_uri';
    return null;
  }
  function issue(handle, clientId) {
    const access = 'agr_at_' + b64url(crypto.randomBytes(32)), refresh = 'agr_rt_' + b64url(crypto.randomBytes(32)), t = Date.now();
    O.tokens[sha(access)] = { kind: 'access', handle, client: clientId, exp: t + ACCESS_TTL };
    O.tokens[sha(refresh)] = { kind: 'refresh', handle, client: clientId, exp: t + REFRESH_TTL };
    const mine = Object.entries(O.tokens).filter(([, v]) => v.handle === handle).sort((a, b) => a[1].exp - b[1].exp); // cap tokens per handle
    while (mine.length > 40) delete O.tokens[mine.shift()[0]];
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'relay' };
  }
  const tokErr = (res, e, d, code = 400) => json(res, code, { error: e, error_description: d });
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();

  function handle(req, res, u) { // returns true if handled
    const p = u.pathname;
    if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) { json(res, 200, metaResource(req)); return true; }
    if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp' || p === '/.well-known/openid-configuration')) { json(res, 200, metaAS(req)); return true; }
    if (req.method === 'POST' && p === '/oauth/register') { readBody(req, m => {
      const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.map(String) : [];
      if (!uris.length || uris.length > 10 || !uris.every(httpsOk)) return tokErr(res, 'invalid_redirect_uri', 'redirect_uris must be https URLs');
      const ids = Object.keys(O.clients); if (ids.length >= 1000) { ids.sort((a, b) => O.clients[a].created.localeCompare(O.clients[b].created)); delete O.clients[ids[0]]; }
      const id = 'agr_client_' + crypto.randomBytes(12).toString('hex'), name = String(m.client_name || '').slice(0, 80);
      O.clients[id] = { redirect_uris: uris, client_name: name, created: new Date().toISOString() }; save();
      json(res, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris, client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }, res); return true; }
    if (p === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const go = async q => {
        const bad = validAuthParams(q); if (bad) return page(res, 400, 'Cannot connect', `<p>${esc(bad)}</p>`);
        const c = await resolveClient(q.client_id, q.redirect_uri); if (c.error) return page(res, 400, 'Cannot connect', `<p>${esc(c.error)}</p>`);
        if (req.method === 'GET') return authorizeForm(res, q, c.name);
        const ip = ipOf(req), f = (fails.get(ip) || []).filter(t => t > Date.now() - 10 * 60e3); fails.set(ip, f); if (fails.size > 10000) fails.clear();
        if (f.length >= 10) return authorizeForm(res, q, c.name, 'Too many failed attempts. Try again in a few minutes.');
        const me = redeem(q.secret);
        if (!me) { f.push(Date.now()); return authorizeForm(res, q, c.name, 'That code is invalid or expired. Run node relay.js connect-code again.'); }
        const code = b64url(crypto.randomBytes(32));
        authCodes.set(sha(code), { handle: me, client: q.client_id, redirect: q.redirect_uri, challenge: q.code_challenge, exp: Date.now() + CODE_TTL });
        const r = new URL(q.redirect_uri); r.searchParams.set('code', code); if (q.state != null) r.searchParams.set('state', q.state); r.searchParams.set('iss', base(req));
        res.writeHead(302, { location: r.toString(), 'cache-control': 'no-store' }); res.end();
      };
      if (req.method === 'GET') go(Object.fromEntries(u.searchParams)).catch(() => page(res, 500, 'Error', '<p>internal error</p>'));
      else readBody(req, q => go(q).catch(() => page(res, 500, 'Error', '<p>internal error</p>')), res);
      return true;
    }
    if (req.method === 'POST' && p === '/oauth/token') { readBody(req, m => {
      res.setHeader('cache-control', 'no-store');
      if (m.grant_type === 'authorization_code') {
        const k = sha(String(m.code || '')), c = authCodes.get(k); authCodes.delete(k); // single use
        if (!c || c.exp <= Date.now()) return tokErr(res, 'invalid_grant', 'code invalid or expired');
        if (c.client !== m.client_id || c.redirect !== m.redirect_uri) return tokErr(res, 'invalid_grant', 'client_id or redirect_uri mismatch');
        if (!m.code_verifier || b64url(crypto.createHash('sha256').update(String(m.code_verifier)).digest()) !== c.challenge) return tokErr(res, 'invalid_grant', 'PKCE verification failed');
        if (!data.handles[c.handle]) return tokErr(res, 'invalid_grant', 'handle no longer exists');
        return json(res, 200, issue(c.handle, c.client));
      }
      if (m.grant_type === 'refresh_token') {
        const k = sha(String(m.refresh_token || '')), r = O.tokens[k];
        if (!r || r.kind !== 'refresh' || r.exp <= Date.now() || !data.handles[r.handle]) return tokErr(res, 'invalid_grant', 'refresh token invalid or expired');
        if (m.client_id && m.client_id !== r.client) return tokErr(res, 'invalid_grant', 'client mismatch');
        delete O.tokens[k]; // rotate
        return json(res, 200, issue(r.handle, r.client));
      }
      tokErr(res, 'unsupported_grant_type', 'use authorization_code or refresh_token');
    }, res); return true; }
    return false;
  }
  return { handle, tokenAuth, connectCode, metaResource };
};
