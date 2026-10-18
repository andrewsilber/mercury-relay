#!/usr/bin/env node
// Mercury relay CLI. Node 18+, no dependencies.
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = path.join(os.homedir(), '.mercury-relay');
const LEGACY = path.join(os.homedir(), '.mercury-relay.json');
const DEFAULT_URL = 'http://127.0.0.1:8787';
const norm = h => (h || '').replace(/^@/, '').toLowerCase();
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const confPath = h => path.join(DIR, norm(h) + '.json');
const identities = () => { try { return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { return []; } };
const currentH = () => { try { return fs.readFileSync(path.join(DIR, 'current'), 'utf8').trim(); } catch { return ''; } };
// Identity file precedence: MERCURY_RELAY_CONFIG > --as / MERCURY_RELAY_HANDLE > ~/.mercury-relay/current > the only identity > legacy ~/.mercury-relay.json (read-only fallback)
let AS = process.env.MERCURY_RELAY_HANDLE || null;
function resolveConf() {
  if (process.env.MERCURY_RELAY_CONFIG) return process.env.MERCURY_RELAY_CONFIG;
  if (AS) return confPath(AS);
  const cur = currentH();
  if (cur && fs.existsSync(confPath(cur))) return confPath(cur);
  const ids = identities();
  if (ids.length === 1) return confPath(ids[0]);
  if (ids.length > 1) { console.error('Several identities exist (' + ids.map(i => '@' + i).join(', ') + '). Pick yours with MERCURY_RELAY_HANDLE=<handle> or --as <handle>.'); process.exit(2); }
  return fs.existsSync(LEGACY) ? LEGACY : null;
}
const loadConf = () => { const p = resolveConf(); return p ? readJson(p) : null; };
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
// One-line verdict: can this agent actually notice replies?
async function verdict(c) {
  let st = null; try { st = await call(c, 'GET', '/status'); } catch {}
  const out = [];
  const recent = st && st.lastPollAt && Date.now() - Date.parse(st.lastPollAt) < 10 * 60 * 1000;
  if (!st) out.push('NOT READY: could not reach the relay /status (is the relay updated and the URL right?). Ask the user.');
  else if ((st.webhook && st.lastWebhookStatus === 'ok') || (st.email && st.lastEmailStatus === 'ok') || recent) out.push('READY: messages will wake you' + (recent && !(st.webhook && st.lastWebhookStatus === 'ok') && !(st.email && st.lastEmailStatus === 'ok') ? ' (listener/poll seen in the last 10 minutes; keep it running)' : ''));
  else {
    let step;
    if (st.email && st.lastEmailStatus) step = 'your wake-up email delivery failed (' + st.lastEmailStatus + '). Check the address and re-register it, then run `node relay.js setup --test`';
    else if (st.email) step = 'your wake-up email is registered but untested. Run `node relay.js setup --test` and confirm you wake up';
    else if (st.webhook && st.lastWebhookStatus) step = 'your webhook delivery failed (' + st.lastWebhookStatus + '). Re-check the routine URL/key and re-register it, then run `node relay.js setup --test`';
    else if (st.webhook) step = 'your webhook is registered but untested. Run `node relay.js setup --test` and confirm you wake up';
    else step = 'Grok Bot: set up the EMAIL wake-up (AGENTS.md "Grok Bot": tagged inbox + email routine + `relay.js email <addr>`), no links needed. Claude Code/Codex/others: run `node relay.js wait` in the background';
    out.push('NOT READY: you can send but will not notice replies. Do this now: ' + step + '. Then run setup again.');
  }
  if (st && st.unreadCount) out.push('unread messages waiting: ' + st.unreadCount + ' (run `node relay.js poll` to read them)');
  return out;
}
function nextSteps(c) {
  console.log('');
  console.log('Next steps (for the agent):');
  console.log(`1. Only if the verdict above says READY, tell the user: "Connected to Mercury as @${c.handle} (handles are lowercase) at ${c.url}." Then ask who to talk to. If NOT READY, tell the user you are registered but still setting up receiving.`);
  console.log('2. Ask for explicit consent before chatting on your own: which person, what topic, how many rounds. Until then only show incoming messages.');
  console.log('3. Set up wake-up for your platform (AGENTS.md section 2). Grok Bot: EMAIL wake-up (AGENTS.md "Grok Bot"): tagged inbox, email routine, then `node relay.js --as ' + c.handle + ' email <addr>`. No links or pasting. Verify with: node relay.js --as ' + c.handle + ' setup');
  console.log("4. Never overwrite or use another identity's config; always use MERCURY_RELAY_HANDLE=" + c.handle + '.');
}
module.exports = { wait, poll, loadConf };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  { const k = args.indexOf('--as'); if (k >= 0) { AS = norm(args[k + 1]); args.splice(k, 2); } }
  const cmd = args.shift();
  try {
    if (cmd === 'init') {
      const i = args.indexOf('--url'); let flagUrl = null; if (i >= 0) { flagUrl = args[i + 1]; args.splice(i, 2); }
      const raw = (args[0] || '').replace(/^@/, '');
      if (!raw) { console.error('usage: relay init <handle> [--url URL]'); process.exit(2); }
      const handle = norm(raw);
      if (handle !== raw) console.log(`Note: handles are lowercase; using @${handle} instead of @${raw}`);
      const file = confPath(handle);
      const existing = readJson(file);
      if (existing && existing.token) { console.error(`@${handle} already has a saved identity at ${file}; not overwriting. Use it as is (MERCURY_RELAY_HANDLE=${handle}) or pick a different handle.`); process.exit(1); }
      const known = identities().map(h => readJson(confPath(h)) || {}).find(c => c.url);
      let url = flagUrl || process.env.MERCURY_RELAY_URL || process.env.RELAY_URL || (known || {}).url || (readJson(LEGACY) || {}).url || DEFAULT_URL;
      url = url.replace(/\/+$/, '');
      const r = await fetch(url + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('register failed: ' + (j.error || r.status)); process.exit(1); }
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ url, handle: j.handle, token: j.token }, null, 2), { mode: 0o600 });
      console.log(`Connected to Mercury relay as @${j.handle} (${url}). Config saved to ${file}`);
      console.log(`Use this identity in later commands: MERCURY_RELAY_HANDLE=${j.handle} node relay.js ...  (or --as ${j.handle})`);
      console.log('');
      for (const l of await verdict({ url, token: j.token, handle: j.handle })) console.log(l);
      nextSteps({ handle: j.handle, url });
    } else if (cmd === 'whoami') {
      if (args.includes('--all')) {
        const cur = currentH(), ids = identities();
        if (!ids.length && !fs.existsSync(LEGACY)) console.log('no local identities');
        for (const h of ids) { const c = readJson(confPath(h)) || {}; console.log(`@${h} at ${c.url}${h === cur ? '  (current)' : ''}  ${confPath(h)}`); }
        if (fs.existsSync(LEGACY)) { const c = readJson(LEGACY) || {}; console.log(`@${c.handle} at ${c.url}  (legacy file ${LEGACY}, read-only fallback)`); }
      } else { const c = need(); console.log(`@${c.handle} at ${c.url}`); }
    } else if (cmd === 'use') {
      const h = norm(args[0]); if (!h || !fs.existsSync(confPath(h))) { console.error('usage: relay use <handle> (a local identity; see whoami --all)'); process.exit(2); }
      fs.writeFileSync(path.join(DIR, 'current'), h); console.log(`default identity is now @${h} (affects any agent on this computer that does not set MERCURY_RELAY_HANDLE)`);
    } else if (cmd === 'setup') {
      const c = loadConf();
      if (!c) console.log('NOT READY: no identity yet. Ask the user for a handle and relay URL, then run: node relay.js init <handle> --url <URL>');
      if (c) for (const l of await verdict(c)) console.log(l);
      console.log('');
      console.log('Mercury setup checklist');
      console.log('1. Relay URL: ' + (c ? c.url : (process.env.MERCURY_RELAY_URL || 'NOT SET - ask the user for the relay URL')));
      console.log('2. Handle: ' + (c ? '@' + c.handle + ' (registered)' : 'none yet - ask the user for a handle, then: node relay.js init <handle> --url <URL>'));
      console.log("   Local identities: " + (identities().map(h => '@' + h).join(', ') || 'none') + " - never touch another handle's config; always use your own (MERCURY_RELAY_HANDLE=<handle>).");
      let wh = 'unknown (register an identity first)';
      if (c) { try { const j = await call(c, 'GET', '/webhook'); wh = j.webhook ? 'registered (' + j.webhook + ')' : 'NOT registered'; } catch { wh = 'unknown (relay did not report it)'; } }
      console.log('3. Webhook wake-up: ' + wh + ' - see AGENTS.md section 2 for your platform.');
      let em = 'unknown'; if (c) { try { const j = await call(c, 'GET', '/email'); em = j.email ? 'registered (' + j.email + ')' : 'NOT registered (alternative to the webhook, e.g. on mobile: see AGENTS.md "Grok Bot" email option)'; } catch { em = 'unknown (relay did not report it)'; } }
      console.log('3b. Email wake-up: ' + em);
      console.log('4. Consent: do NOT reply to anyone on your own until the user explicitly approves (person, topic, rounds). Until then, show incoming messages to the user.');
      console.log('5. Only after the verdict above says READY, tell the user: "Connected to Mercury as @<handle>. Who should I talk to?"');
      if (args.includes('--test')) {
        if (!c) { console.error('Cannot test: no identity. Run init first.'); process.exit(2); }
        let hook = null, mail = null; try { hook = (await call(c, 'GET', '/webhook')).webhook; } catch {} try { mail = (await call(c, 'GET', '/email')).email; } catch {}
        if (!hook && !mail) console.log('\nNo webhook registered for @' + c.handle + '. Register one: node relay.js webhook "<url>" --header "Authorization: <key>" (Grok Bot: follow the Webhook upgrade steps in AGENTS.md), then re-run setup --test.');
        else {
          const j = await call(c, 'POST', '/send', { to: c.handle, text: 'Mercury webhook self-test at ' + new Date().toISOString() });
          console.log('\nSent a test message to yourself (id ' + j.id + '). Expect: your agent should wake within ~10s and report a message from yourself (@' + c.handle + '). If nothing happens, check the routine is on and the URL/header are right. Run `node relay.js poll` to clear the test message afterwards.');
        }
      } else if (c) nextSteps(c);
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
      if (url === null) { console.error('usage: relay webhook <url> [--header "Name: value"]... | webhook --clear | email <address> | email --clear'); process.exit(2); }
      const j = await call(c, 'POST', '/webhook', url === '' ? { url: null } : { url, headers });
      console.log(j.webhook ? `webhook set: ${j.webhook}` : 'webhook cleared');
    } else if (cmd === 'email') {
      const c = need(); const a = args[0];
      if (!a) { console.error('usage: relay email <address> | email --clear'); process.exit(2); }
      const j = await call(c, 'POST', '/email', a === '--clear' ? { email: null } : { email: a });
      console.log(j.email ? `wake-up email set: ${j.email}` : 'wake-up email cleared');
    } else { console.error('usage: relay init <handle> [--url URL] | whoami [--all] | use <handle> | setup | [--as <handle>] before any command | send <to> <text> | wait [--once] | poll | webhook <url> [--header "Name: value"] | webhook --clear'); process.exit(2); }
  } catch (e) { console.error('error: ' + e.message); process.exit(1); }
})();
