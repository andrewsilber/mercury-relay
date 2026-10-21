// Simulates Claude Code as the MCP host of the agentrelay channel (stdio), against a local relay.
// usage: node tests/channel-sim.js <relayCliWrapper> <receiverHandle> <senderHandle>
// Checks: legacy handshake (2026-07-28 request -> earlier revision), claude/channel capability, push of a relay message as
// notifications/claude/channel with meta, ack after push, reply via relay_send (re + newer-message check), restart without duplicates.
'use strict';
const { spawn, spawnSync } = require('child_process'), path = require('path');
const [CLI, RECV, SEND] = process.argv.slice(2);
const RELAY = path.join(__dirname, '..', 'relay.js');
const fail = m => { console.error('FAIL: channel-sim ' + m); process.exit(1); };
const cli = (...a) => { const r = spawnSync(CLI, a, { encoding: 'utf8', env: { ...process.env, AGENTRELAY_NEWER_CHECK: '0' } }); return r.stdout + r.stderr; };
function host() {
  const p = spawn(process.execPath, [RELAY, '--as', RECV, 'channel'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENTRELAY_NEWER_CHECK: '' } });
  const msgs = [], waiters = []; let buf = '', err = '', id = 0;
  p.stderr.on('data', d => err += d);
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { fail('non-JSON on stdout: ' + l); } msgs.push(m); waiters.splice(0).forEach(w => w()); } });
  const next = (pred, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const chk = () => { const k = msgs.findIndex(pred); if (k >= 0) return res(msgs.splice(k, 1)[0]); if (Date.now() - t0 > ms) return rej(new Error('timeout; stderr: ' + err)); waiters.push(chk); setTimeout(chk, 200); }; chk(); });
  const req = (method, params) => { const i = ++id; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); return next(m => m.id === i); };
  const note = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { p, req, note, next, msgs, err: () => err };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let h = host();
  const init = await h.req('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'claude-code-sim', version: '0' } });
  const r = init.result || fail('initialize: ' + JSON.stringify(init));
  if (r.protocolVersion === '2026-07-28' || !/^20\d\d-\d\d-\d\d$/.test(r.protocolVersion)) fail('protocol version ' + r.protocolVersion);
  if (!r.capabilities.experimental || !r.capabilities.experimental['claude/channel'] || !r.capabilities.tools) fail('capabilities');
  if (!/UNTRUSTED/.test(r.instructions) || !r.instructions.includes('@' + RECV)) fail('instructions');
  h.note('notifications/initialized', {});
  const tl = await h.req('tools/list', {}); const names = tl.result.tools.map(t => t.name);
  for (const n of ['relay_send', 'relay_reply_all', 'relay_recent']) if (!names.includes(n)) fail('tool missing ' + n);
  await sleep(500);
  const text = 'channel ping ' + Date.now();
  cli('--as', SEND, 'send', RECV, text);
  const ev = await h.next(m => m.method === 'notifications/claude/channel');
  const { content, meta } = ev.params;
  if (!content.includes(text) || meta.from !== '@' + SEND || !meta.msg_id || meta.encrypted !== 'yes' || meta.verified !== 'yes') fail('event ' + JSON.stringify(ev.params));
  if (Object.keys(meta).some(k => !/^[A-Za-z0-9_]+$/.test(k))) fail('meta key not an identifier');
  await sleep(500);
  if (!/no new messages/.test(cli('--as', RECV, 'poll'))) fail('message not acked after push');
  // reply through the tool, with re
  const rep = await h.req('tools/call', { name: 'relay_send', arguments: { to: SEND, text: 'channel pong', re: meta.msg_id } });
  if (rep.result.isError || !/sent to @/.test(rep.result.content[0].text)) fail('relay_send: ' + JSON.stringify(rep));
  const got = cli('--as', SEND, 'poll'); if (!got.includes('channel pong') || !got.includes('re ' + meta.msg_id)) fail('reply not received: ' + got);
  // restart: a message sent while the channel is down is pushed exactly once after reconnect
  h.p.kill(); await sleep(300);
  cli('--as', SEND, 'send', RECV, 'while down');
  h = host(); await h.req('initialize', { protocolVersion: '2025-06-18', capabilities: {} }); h.note('notifications/initialized', {});
  const ev2 = await h.next(m => m.method === 'notifications/claude/channel'); if (!ev2.params.content.includes('while down')) fail('after restart');
  await sleep(1500); if (h.msgs.some(m => m.method === 'notifications/claude/channel')) fail('duplicate push');
  const rec = await h.req('tools/call', { name: 'relay_recent', arguments: {} }); if (!rec.result.content[0].text.includes('while down')) fail('relay_recent');
  h.p.kill();
  console.log('PASS: Claude Code channel (legacy handshake, push + meta, ack after push, relay_send reply with re, restart without duplicates)');
  process.exit(0);
})().catch(e => fail(e.message));
