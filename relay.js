#!/usr/bin/env node
// Mercury relay CLI. Node 18+, no dependencies.
const fs = require('fs'), os = require('os'), path = require('path');
const CONF = process.env.MERCURY_RELAY_CONFIG || path.join(os.homedir(), '.mercury-relay.json');
const DEFAULT_URL = 'http://127.0.0.1:8787';
const loadConf = () => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return null; } };
function need() { const c = loadConf(); if (!c) { console.error('Not initialized. Run: node relay.js init <handle>'); process.exit(2); } return c; }
async function call(c, method, p, bodyObj) {
  const r = await fetch(c.url + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.token }, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}
const fmt = m => `[relay] from @${m.from} at ${m.ts}: ${m.text}`;
async function wait(c, { quiet } = {}) {
  for (;;) {
    try {
      const j = await call(c, 'GET', `/poll?handle=${encodeURIComponent(c.handle)}&timeout=30`);
      if (j.messages.length) {
        for (const m of j.messages) console.log(fmt(m));
        await call(c, 'POST', '/ack', { ids: j.messages.map(m => m.id) }); // ack after printing
        return;
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) { console.error('auth error: ' + e.message); process.exit(1); }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
// Non-blocking: print + ack pending messages and return immediately. Returns count.
async function poll(c) {
  const j = await call(c, 'GET', `/poll?handle=${encodeURIComponent(c.handle)}&timeout=0`);
  for (const m of j.messages) console.log(fmt(m));
  if (j.messages.length) await call(c, 'POST', '/ack', { ids: j.messages.map(m => m.id) });
  else console.log('[relay] no new messages');
  return j.messages.length;
}
module.exports = { wait, poll, loadConf };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  try {
    if (cmd === 'init') {
      let url = process.env.MERCURY_RELAY_URL || process.env.RELAY_URL || (loadConf() || {}).url || DEFAULT_URL;
      const i = args.indexOf('--url'); if (i >= 0) { url = args[i + 1]; args.splice(i, 2); }
      const handle = (args[0] || '').replace(/^@/, '');
      if (!handle) { console.error('usage: relay init <handle> [--url URL]'); process.exit(2); }
      url = url.replace(/\/+$/, '');
      const r = await fetch(url + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('register failed: ' + (j.error || r.status)); process.exit(1); }
      fs.writeFileSync(CONF, JSON.stringify({ url, handle: j.handle, token: j.token }, null, 2), { mode: 0o600 });
      console.log(`Connected to Mercury relay as @${j.handle} (${url}). Config saved to ${CONF}`);
    } else if (cmd === 'whoami') {
      const c = need(); console.log(`@${c.handle} at ${c.url}`);
    } else if (cmd === 'send') {
      const c = need(); const to = (args.shift() || '').replace(/^@/, ''); const text = args.join(' ');
      if (!to || !text) { console.error('usage: relay send <to> <text>'); process.exit(2); }
      const j = await call(c, 'POST', '/send', { to, text }); console.log(`sent to @${to} (id ${j.id})`);
    } else if (cmd === 'wait') {
      if (args.includes('--once')) await poll(need()); else await wait(need());
    } else if (cmd === 'poll') {
      await poll(need());
    } else if (cmd === 'webhook') {
      const c = need(); const headers = {}; let url = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--header') { const h = args[++i] || ''; const k = h.indexOf(':'); if (k < 1) { console.error('--header needs "Name: value"'); process.exit(2); } headers[h.slice(0, k).trim()] = h.slice(k + 1).trim(); }
        else if (args[i] === '--clear') url = '';
        else url = args[i];
      }
      if (url === null) { console.error('usage: relay webhook <url> [--header "Name: value"]... | webhook --clear'); process.exit(2); }
      const j = await call(c, 'POST', '/webhook', url === '' ? { url: null } : { url, headers });
      console.log(j.webhook ? `webhook set: ${j.webhook}` : 'webhook cleared');
    } else { console.error('usage: relay init <handle> [--url URL] | whoami | send <to> <text> | wait [--once] | poll | webhook <url> [--header "Name: value"] | webhook --clear'); process.exit(2); }
  } catch (e) { console.error('error: ' + e.message); process.exit(1); }
})();
