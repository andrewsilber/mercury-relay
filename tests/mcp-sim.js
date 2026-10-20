// Simulates ChatGPT as an MCP Events client against a local relay server.
// usage: node tests/mcp-sim.js <phase1|phase2> <relayUrl> <stateFile>
// phase1: register two handles, OAuth (DCR + PKCE + connect code), initialize/discover/tools/events, subscribe (callback verified).
// phase2 (after a relay restart): send a message, check one correctly signed, content-free event arrives; refresh; unsubscribe; no more events.
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs');
const [phase, URL0, STATE] = process.argv.slice(2);
const VER = require('../package.json').version;
const fail = m => { console.error('FAIL: mcp-sim ' + m); process.exit(1); };
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const H = { 'content-type': 'application/json', 'x-relay-client': VER };
const api = async (method, p, body, tok) => { const r = await fetch(URL0 + p, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }); return { status: r.status, headers: r.headers, body: await r.text() }; };
let rid = 0;
const rpc = async (tok, method, params) => { const r = await fetch(URL0 + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', authorization: 'Bearer ' + tok }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const t = await r.text(); return t ? JSON.parse(t) : { status: r.status }; };
const verify = (secret, req, raw) => { // Standard Webhooks verification, as ChatGPT would do it
  const id = req.headers['webhook-id'], ts = req.headers['webhook-timestamp'], sigs = String(req.headers['webhook-signature'] || '').split(' ');
  if (!id || !ts || Math.abs(Date.now() / 1000 - +ts) > 300) return false;
  const exp = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  return sigs.some(s => s === 'v1,' + exp);
};
(async () => {
  const events = [], verifs = [];
  let secret = st.secret;
  
  const srv = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    if (!verify(secret, req, raw)) { res.writeHead(401); return res.end(); }
    const b = JSON.parse(raw);
    if (b.type === 'verification') { verifs.push(req.headers['x-mcp-subscription-id']); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ challenge: b.challenge })); }
    events.push({ headers: req.headers, raw, body: b }); res.writeHead(202); res.end(); }); });
  await new Promise(r => srv.listen(st.port || 0, '127.0.0.1', r)); const port = srv.address().port;
  const cb = `http://127.0.0.1:${port}/mcp-events/cb_1`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (phase === 'phase1') {
    const reg = async h => JSON.parse((await api('POST', '/register', { handle: h })).body).token;
    const dotTok = await reg('dot-sim'), senderTok = await reg('sim-sender');
    // unauthenticated -> 401 + resource metadata pointer
    const u = await fetch(URL0 + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
    if (u.status !== 401 || !/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(u.headers.get('www-authenticate') || '')) fail('401 + WWW-Authenticate');
    const prm = JSON.parse((await api('GET', '/.well-known/oauth-protected-resource')).body); if (!prm.resource.endsWith('/mcp') || !prm.authorization_servers.length) fail('protected resource metadata');
    const as = JSON.parse((await api('GET', '/.well-known/oauth-authorization-server')).body); if (!as.code_challenge_methods_supported.includes('S256') || !as.registration_endpoint) fail('AS metadata');
    // DCR
    const redirect = 'https://chatgpt.example/connector/oauth/cb';
    const client = JSON.parse((await api('POST', '/oauth/register', { redirect_uris: [redirect], client_name: 'ChatGPT (sim)' })).body); if (!client.client_id) fail('DCR');
    const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'relay', resource: URL0 + '/mcp' });
    const form = await api('GET', '/oauth/authorize?' + q); if (form.status !== 200 || !form.body.includes('connect-code')) fail('authorize page');
    const cc = JSON.parse((await api('POST', '/mcp/connect-code', {}, dotTok)).body).code; if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(cc)) fail('connect code');
    const bad = await fetch(URL0 + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), secret: 'WRONG-CODE' }) }); if (bad.status !== 400) fail('bad code accepted');
    const ok = await fetch(URL0 + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), secret: cc }) });
    const loc = new URL(ok.headers.get('location') || 'http://x/'); if (ok.status !== 302 || loc.searchParams.get('state') !== 'st8' || !loc.searchParams.get('code')) fail('authorize redirect');
    const again = await fetch(URL0 + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), secret: cc }) }); if (again.status !== 400) fail('connect code reusable');
    const tokReq = b => fetch(URL0 + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b) }).then(r => r.json());
    const badPkce = await tokReq({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: redirect, client_id: client.client_id, code_verifier: 'x'.repeat(43) }); if (badPkce.error !== 'invalid_grant') fail('bad PKCE accepted');
    // the code was consumed by the failed attempt (single use): get a fresh one
    const cc2 = JSON.parse((await api('POST', '/mcp/connect-code', {}, dotTok)).body).code;
    const ok2 = await fetch(URL0 + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), secret: cc2 }) });
    const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
    const tk = await tokReq({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier });
    if (!tk.access_token || !tk.refresh_token || tk.token_type !== 'Bearer') fail('token exchange');
    const rt = await tokReq({ grant_type: 'refresh_token', refresh_token: tk.refresh_token, client_id: client.client_id }); if (!rt.access_token) fail('refresh');
    const reuse = await tokReq({ grant_type: 'refresh_token', refresh_token: tk.refresh_token, client_id: client.client_id }); if (reuse.error !== 'invalid_grant') fail('refresh token not rotated');
    const at = rt.access_token;
    // protocol: old and new versions
    const init = await rpc(at, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sim', version: '1' } }); if (init.result.protocolVersion !== '2025-06-18') fail('initialize old version');
    const init2 = await rpc(at, 'initialize', { protocolVersion: '1999-01-01' }); if (init2.result.protocolVersion !== '2026-07-28') fail('initialize fallback version');
    const disc = await rpc(at, 'server/discover', {}); if (!disc.result.supportedVersions.includes('2026-07-28') || !disc.result.capabilities.events) fail('server/discover');
    const note = await rpc(at, 'notifications/initialized'); // notification (no id) -> 202
    const tl = await rpc(at, 'tools/list', {}); const names = tl.result.tools.map(t => t.name).sort().join(',');
    if (names !== 'members,status' || !tl.result.tools.every(t => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false && t.annotations.openWorldHint === false)) fail('tools/list + annotations');
    const stc = await rpc(at, 'tools/call', { name: 'status', arguments: {} }); if (stc.result.structuredContent.handle !== 'dot-sim') fail('status tool (OAuth principal)');
    const el = await rpc(at, 'events/list', {}); const ev = el.result.events[0]; if (ev.name !== 'message.received' || ev.delivery[0] !== 'webhook' || Object.keys(ev.payloadSchema.properties).sort().join() !== 'count,encrypted,from,to,ts') fail('events/list');
    secret = 'whsec_' + crypto.randomBytes(32).toString('base64');
    const badSec = await rpc(at, 'events/subscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: cb, secret: 'nope' } }); if (!badSec.error) fail('bad secret accepted');
    const deadCb = await rpc(at, 'events/subscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: 'http://127.0.0.1:1/x', secret } }); if (!deadCb.error || deadCb.error.code !== -32015) fail('unverifiable callback accepted');
    const sub = await rpc(at, 'events/subscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: cb, secret }, cursor: null });
    if (!sub.result || !/^sub_/.test(sub.result.id) || !sub.result.refreshBefore || verifs[0] !== sub.result.id) fail('subscribe + verification ' + JSON.stringify(sub));
    const sub2 = await rpc(at, 'events/subscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: cb, secret } }); if (sub2.result.id !== sub.result.id) fail('subscribe not idempotent');
    fs.writeFileSync(STATE, JSON.stringify({ port, secret, at, dotTok, senderTok, subId: sub.result.id }));
    console.log('PASS: MCP OAuth (DCR, PKCE, connect code, refresh rotation), initialize/discover (old+new versions), read-only tools, events/list, subscribe with verified callback');
  } else {
    const SECRET_TEXT = 'super secret plaintext ' + crypto.randomBytes(4).toString('hex');
    const s = await api('POST', '/send', { to: 'dot-sim', text: SECRET_TEXT }, st.senderTok); if (s.status !== 200) fail('send ' + s.body);
    for (let i = 0; i < 50 && !events.length; i++) await sleep(100);
    if (events.length !== 1) fail('expected 1 event after restart, got ' + events.length);
    const e = events[0];
    if (e.headers['x-mcp-subscription-id'] !== st.subId || e.headers['webhook-id'] !== e.body.eventId || e.headers['content-type'] !== 'application/json') fail('event headers');
    if (e.body.name !== 'message.received' || e.body.data.to !== 'dot-sim' || e.body.data.from !== 'sim-sender' || e.body.data.count !== 1 || e.body.data.encrypted !== false || !e.body.data.ts) fail('event body ' + e.raw);
    if (Object.keys(e.body.data).sort().join() !== 'count,encrypted,from,to,ts' || e.raw.includes('secret plaintext')) fail('event not content-free');
    // coalescing: second message before the handle polls -> no new wake
    await api('POST', '/send', { to: 'dot-sim', text: 'two' }, st.senderTok); await sleep(800); if (events.length !== 1) fail('coalescing: extra event');
    const stc = await rpc(st.at, 'tools/call', { name: 'status', arguments: {} }); if (stc.result.structuredContent.unreadCount !== 2 || JSON.stringify(stc).includes('secret plaintext')) fail('status tool');
    const un = await rpc(st.at, 'events/unsubscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: cb } }); if (!un.result) fail('unsubscribe');
    const un2 = await rpc(st.at, 'events/unsubscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: cb } }); if (!un2.result) fail('unsubscribe idempotent');
    const op = await fetch(URL0 + '/poll?timeout=0', { headers: { ...H, authorization: 'Bearer ' + st.at } }); if (op.status !== 401) fail('OAuth token accepted outside /mcp');
    const pr = await fetch(URL0 + '/poll?timeout=0', { headers: { ...H, authorization: 'Bearer ' + st.dotTok } }); if (pr.status !== 200) fail('dot poll'); // re-arms wakes
    await api('POST', '/send', { to: 'dot-sim', text: 'three' }, st.senderTok); await sleep(800); if (events.length !== 1) fail('event after unsubscribe');
    const cnt = await rpc(st.at, 'tools/call', { name: 'status', arguments: {} }); if (cnt.result.structuredContent.mcpSubscriptions !== 0) fail('subscription not removed');
    console.log('PASS: MCP event survives restart, Standard Webhooks signature, content-free payload, coalescing, unsubscribe');
  }
  srv.close(); process.exit(0);
})().catch(e => fail(e.stack));
