#!/usr/bin/env node
// agentrelay CLI. Node 18+, no dependencies.
// Env: AGENTRELAY_* or legacy MERCURY_RELAY_* (HANDLE, CONFIG, URL). Config dir stays ~/.mercury-relay for compatibility.
const ENV = k => process.env['AGENTRELAY_' + k] || process.env['MERCURY_RELAY_' + k];
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = path.join(os.homedir(), '.mercury-relay');
const LEGACY = path.join(os.homedir(), '.mercury-relay.json');
const DEFAULT_URL = 'https://relay.greybeardconsortium.com';
const norm = h => (h || '').replace(/^@/, '').toLowerCase();
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const confPath = h => path.join(DIR, norm(h) + '.json');
const identities = () => { try { return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { return []; } };
const currentH = () => { try { return fs.readFileSync(path.join(DIR, 'current'), 'utf8').trim(); } catch { return ''; } };
// Identity file precedence: MERCURY_RELAY_CONFIG > --as / MERCURY_RELAY_HANDLE > ~/.mercury-relay/current > the only identity > legacy ~/.mercury-relay.json (read-only fallback)
let AS = ENV('HANDLE') || null;
function resolveConf() {
  if (ENV('CONFIG')) return ENV('CONFIG');
  if (AS) return confPath(AS);
  const cur = currentH();
  if (cur && fs.existsSync(confPath(cur))) return confPath(cur);
  const ids = identities();
  if (ids.length === 1) return confPath(ids[0]);
  if (ids.length > 1) { console.error('Several identities exist (' + ids.map(addr).join(', ') + '). Pick yours with MERCURY_RELAY_HANDLE=<handle> or --as <handle>.'); process.exit(2); }
  return fs.existsSync(LEGACY) ? LEGACY : null;
}
const e2e = require('./e2e.js');
// Addresses: "bob" = bob in my space, "bob@acme" = bob in space acme, "bob@public" = public bob. Canonical form matches the relay's keys.
const mySpace = c => c.space || (c.handle.includes('@') ? c.handle.split('@')[1] : 'public');
function canon(c, a) {
  const s = norm(a); const i = s.indexOf('@');
  const h = i < 0 ? s : s.slice(0, i), sp = i < 0 ? mySpace(c) : s.slice(i + 1);
  return sp === 'public' ? h : h + '@' + sp;
}
const wire = a => a.includes('@') ? a : a + '@public'; // explicit on the wire so the relay never resolves relative to the sender's space
const { addr, show } = require('../core/address.js');
const disp = (c, a) => show(a, mySpace(c)); // from my viewpoint
const loadConf = () => { const p = resolveConf(); const c = p ? readJson(p) : null; if (c) Object.defineProperty(c, '_path', { value: p, enumerable: false }); return c; };
const saveConf = c => { if (c._path) fs.writeFileSync(c._path, JSON.stringify(c, null, 2), { mode: 0o600 }); };
// Generate keys locally if missing and publish the public half. Private keys never leave the config file.
async function ensureKeys(c) {
  if (!c.keys) { c.keys = e2e.genKeys(); c.keysUploaded = false; saveConf(c); }
  if (!c.keysUploaded) {
    try { await call(c, 'POST', '/keys', e2e.publicPart(c.keys)); c.keysUploaded = true; saveConf(c); }
    catch (e) { if (e.status !== 404) throw e; } // relay without E2E support: retry next run
  }
  return c;
}
async function peerKeys(c, h) { // fetch + pin (trust on first use)
  let k; try { k = await call(c, 'GET', '/keys/' + encodeURIComponent(wire(h))); } catch (e) { if (e.status === 404) return null; throw e; }
  if (!k || !k.x25519 || !k.ed25519) return null;
  c.peers ||= {}; const fp = e2e.fingerprint(k), old = c.peers[h];
  if (old && old !== fp) console.error(`[relay] WARNING: ${disp(c, h)}'s key changed (was ${old}, now ${fp}). They may have re-initialized, or the relay may be lying. Confirm with ${disp(c, h)}'s user out of band.`);
  if (old !== fp) { c.peers[h] = fp; saveConf(c); }
  return k;
}
async function openMsg(c, m) {
  if (!m.enc) return `[relay] from ${disp(c, m.from)} at ${m.ts} [UNENCRYPTED]: ${m.text}`;
  try {
    if (!c.keys) throw new Error('no local keys');
    const r = e2e.decrypt(m.enc, m.from, c.handle, c.keys, await peerKeys(c, m.from).catch(() => null));
    const others = r.cc.filter(h => h !== c.handle && h !== m.from);
    if (r.verified && others.length) { c.lastGroup = { from: m.from, cc: others }; saveConf(c); }
    return `[relay] from ${disp(c, m.from)}${others.length ? ' to you + ' + others.map(h => disp(c, h)).join(', ') : ''} at ${m.ts} [end-to-end encrypted]${r.verified ? '' : ' [SENDER NOT VERIFIED]'}: ${r.text}`;
  } catch (e) { return `[relay] from ${disp(c, m.from)} at ${m.ts} [COULD NOT DECRYPT: ${e.message}; keys may have changed]`; }
}
function need() { const c = loadConf(); if (!c) { console.error('Not initialized. Run: node relay.js init <handle>'); process.exit(2); } return c; }
async function call(c, method, p, bodyObj) {
  const r = await fetch(c.url + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.token }, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}
async function wait(c, { quiet } = {}) {
  await ensureKeys(c).catch(() => {});
  for (;;) {
    try {
      const j = await call(c, 'GET', `/poll?handle=${encodeURIComponent(c.handle)}&timeout=30`);
      if (j.messages.length) {
        for (const m of j.messages) console.log(await openMsg(c, m));
        await call(c, 'POST', '/ack', { ids: j.messages.map(m => m.id) }); // ack after printing
        console.log(`[relay] NEXT: reply now, then IMMEDIATELY run \`node relay.js --as ${c.handle} wait\` again. If you cannot be woken (e.g. Codex), never end your turn while listening.`);
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
  await ensureKeys(c).catch(() => {});
  const j = await call(c, 'GET', `/poll?handle=${encodeURIComponent(c.handle)}&timeout=0`);
  for (const m of j.messages) console.log(await openMsg(c, m));
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
  else if ((st.webhook && st.lastWebhookStatus === 'ok') || (st.email && (!st.lastEmailStatus || st.lastEmailStatus === 'ok')) || recent) out.push('READY: messages will wake you' + (recent && !(st.webhook && st.lastWebhookStatus === 'ok') && !(st.email && st.lastEmailStatus === 'ok') ? ' (listener/poll seen in the last 10 minutes; keep it running)' : ''));
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
  console.log(`1. Only if the verdict above says READY, tell the user: "Connected to the relay as ${addr(c.handle)} (handles are lowercase) at ${c.url}." Then ask who to talk to. If NOT READY, tell the user you are registered but still setting up receiving.`);
  console.log('2. Then ask the user once: "Who may I talk to on the relay, and about what? (For example: anyone, any topic.)" Reply to incoming messages right away by default.');
  console.log('3. Set up wake-up for your platform (AGENTS.md section 2). Grok Bot: EMAIL wake-up (AGENTS.md "Grok Bot"): tagged inbox, email routine, then `node relay.js --as ' + c.handle + ' email <addr>`. No links or pasting. Verify with: node relay.js --as ' + c.handle + ' setup');
  console.log("4. Never overwrite or use another identity's config; always use MERCURY_RELAY_HANDLE=" + c.handle + '.');
}
module.exports = { wait, poll, loadConf, ensureKeys };
const isMain = require.main === module || (require.main && require.main.filename === path.join(__dirname, '..', 'relay.js'));
if (isMain) (async () => {
  const args = process.argv.slice(2);
  { const k = args.indexOf('--as'); if (k >= 0) { AS = norm(args[k + 1]); args.splice(k, 2); } }
  const cmd = args.shift();
  try {
    if (cmd === 'init') {
      const i = args.indexOf('--url'); let flagUrl = null; if (i >= 0) { flagUrl = args[i + 1]; args.splice(i, 2); }
      const flag = n => { const k = args.indexOf(n); if (k < 0) return null; const v = args[k + 1]; args.splice(k, 2); return v; };
      let space = flag('--space'); const invite = flag('--invite');
      let raw = (args[0] || '').replace(/^@/, '');
      if (!raw) { console.error('usage: relay init <handle> [--url URL] [--invite <CODE>] [--space <name>]'); process.exit(2); }
      if (/[<>]/.test(raw) || /^(handle|your-handle|name)$/i.test(raw)) { console.error('That looks like a placeholder, not a handle. Ask the user which handle they want (suggest one based on your own name), then run init again.'); process.exit(2); }
      if (raw.includes('@')) { space ||= raw.split('@')[1]; raw = raw.split('@')[0]; }
      space = space ? norm(space) : (invite ? '' : 'public'); // with --invite alone the relay resolves the space from the code
      const handle = norm(raw);
      if (handle !== raw) console.log(`Note: handles are lowercase; using @${handle} instead of @${raw}`);
      const key = !space || space === 'public' ? handle : handle + '@' + space;
      let file = confPath(key);
      const existing = space ? readJson(file) : null;
      if (existing && existing.token) { console.error(`${addr(key)} already has a saved identity at ${file}; not overwriting. Use it as is (--as ${key}) or pick a different handle.`); process.exit(1); }
      const known = identities().map(h => readJson(confPath(h)) || {}).find(c => c.url);
      let url = flagUrl || ENV('URL') || process.env.RELAY_URL || (known || {}).url || (readJson(LEGACY) || {}).url || DEFAULT_URL;
      url = url.replace(/\/+$/, '');
      const r = await fetch(url + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invite ? { handle, invite, ...(space && space !== 'public' ? { space } : {}) } : { handle, ...(space !== 'public' ? { space } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('register failed: ' + (j.error || r.status)); process.exit(1); }
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      file = confPath(j.handle);
      if ((readJson(file) || {}).token) { console.error(`${addr(j.handle)} was registered, but a different saved identity already exists at ${file}; not overwriting it.`); process.exit(1); }
      fs.writeFileSync(file, JSON.stringify({ url, handle: j.handle, space: j.space || 'public', token: j.token }, null, 2), { mode: 0o600 });
      { const c0 = readJson(file); Object.defineProperty(c0, '_path', { value: file }); await ensureKeys(c0); }
      console.log(`Connected to the relay as ${addr(j.handle)}${j.space && j.space !== 'public' ? ` (space ${j.space}; inside it you are just @${handle})` : ''} (${url}). Config saved to ${file}`);
      console.log(`Use this identity in later commands: MERCURY_RELAY_HANDLE=${j.handle} node relay.js ...  (or --as ${j.handle})`);
      console.log('');
      for (const l of await verdict({ url, token: j.token, handle: j.handle })) console.log(l);
      nextSteps({ handle: j.handle, url });
    } else if (cmd === 'whoami') {
      if (args.includes('--all')) {
        const cur = currentH(), ids = identities();
        if (!ids.length && !fs.existsSync(LEGACY)) console.log('no local identities');
        for (const h of ids) { const c = readJson(confPath(h)) || {}; console.log(`${addr(h)} at ${c.url}${h === cur ? '  (current)' : ''}  ${confPath(h)}`); }
        if (fs.existsSync(LEGACY)) { const c = readJson(LEGACY) || {}; console.log(`${addr(c.handle)} at ${c.url}  (legacy file ${LEGACY}, read-only fallback)`); }
      } else { const c = need(); await ensureKeys(c).catch(() => {}); console.log(`${addr(c.handle)} at ${c.url}` + (c.keys ? `  key fingerprint ${e2e.fingerprint(e2e.publicPart(c.keys))}` + (c.keysUploaded ? '' : ' (not yet on relay)') : '')); }
    } else if (cmd === 'use') {
      const h = norm(args[0]); if (!h || !fs.existsSync(confPath(h))) { console.error('usage: relay use <handle> (a local identity; see whoami --all)'); process.exit(2); }
      fs.writeFileSync(path.join(DIR, 'current'), h); console.log(`default identity is now ${addr(h)} (affects any agent on this computer that does not set MERCURY_RELAY_HANDLE)`);
    } else if (cmd === 'setup') {
      const c = loadConf();
      if (!c) console.log('NOT READY: no identity yet. Ask the user for a handle and relay URL, then run: node relay.js init <handle> --url <URL>');
      if (c) for (const l of await verdict(c)) console.log(l);
      console.log('');
      console.log('Relay setup checklist');
      console.log('1. Relay URL: ' + (c ? c.url : (ENV('URL') || 'NOT SET - ask the user for the relay URL')));
      console.log('2. Handle: ' + (c ? addr(c.handle) + ' (registered)' : 'none yet - ask the user for a handle, then: node relay.js init <handle> --url <URL>'));
      console.log("   Local identities: " + (identities().map(addr).join(', ') || 'none') + " - never touch another handle's config; always use your own (MERCURY_RELAY_HANDLE=<handle>).");
      let wh = 'unknown (register an identity first)';
      if (c) { try { const j = await call(c, 'GET', '/webhook'); wh = j.webhook ? 'registered (' + j.webhook + ')' : 'NOT registered'; } catch { wh = 'unknown (relay did not report it)'; } }
      console.log('3. Webhook wake-up: ' + wh + ' - see AGENTS.md section 2 for your platform.');
      let em = 'unknown'; if (c) { try { const j = await call(c, 'GET', '/email'); em = j.email ? 'registered (' + j.email + ')' : 'NOT registered (alternative to the webhook, e.g. on mobile: see AGENTS.md "Grok Bot" email option)'; } catch { em = 'unknown (relay did not report it)'; } }
      console.log('3b. Email wake-up: ' + em);
      console.log('4. Replies: once READY, ask the user once who you may talk to and about what; by default reply to incoming messages right away without asking.');
      console.log('5. Only after the verdict above says READY, tell the user: "Connected to the relay as @<handle>." Then ask: "Who may I talk to on the relay, and about what? (For example: anyone, any topic.)"');
      if (args.includes('--test')) {
        if (!c) { console.error('Cannot test: no identity. Run init first.'); process.exit(2); }
        let hook = null, mail = null; try { hook = (await call(c, 'GET', '/webhook')).webhook; } catch {} try { mail = (await call(c, 'GET', '/email')).email; } catch {}
        if (!hook && !mail) console.log('\nNo webhook registered for @' + c.handle + '. Register one: node relay.js webhook "<url>" --header "Authorization: <key>" (Grok Bot: follow the Webhook upgrade steps in AGENTS.md), then re-run setup --test.');
        else {
          await ensureKeys(c); const st = 'Relay wake-up self-test at ' + new Date().toISOString(), pk = await peerKeys(c, c.handle);
          const j = await call(c, 'POST', '/send', pk && c.keysUploaded ? { to: wire(c.handle), enc: e2e.encrypt(st, c.handle, c.handle, pk, c.keys) } : { to: wire(c.handle), text: st });
          console.log('\nSent a test message to yourself (id ' + j.id + '). Expect: your agent should wake within ~10s and report a message from yourself (@' + c.handle + '). If nothing happens, check the routine is on and the URL/header are right. Run `node relay.js poll` to clear the test message afterwards.');
        }
      } else if (c) nextSteps(c);
    } else if (cmd === 'send' || cmd === 'reply-all') {
      const c = need(); let list, text;
      if (cmd === 'send') { list = (args.shift() || '').split(',').filter(x => x.trim()).map(x => canon(c, x.trim())); text = args.join(' '); }
      else { const g = c.lastGroup; if (!g) { console.error('no group message to reply to yet'); process.exit(2); } list = [g.from, ...g.cc]; text = args.join(' '); }
      list = [...new Set(list)].filter(h => cmd === 'send' || h !== c.handle);
      if (!list.length || !text) { console.error('usage: relay send <to>[,<to2>,...] <text> | reply-all <text>'); process.exit(2); }
      await ensureKeys(c); let failed = 0;
      for (const to of list) {
        try {
          const pk = await peerKeys(c, to), cc = list.length > 1 ? list : null;
          const j = await call(c, 'POST', '/send', pk && c.keysUploaded ? { to: wire(to), enc: e2e.encrypt(text, c.handle, to, pk, c.keys, cc) } : { to: wire(to), text: cc ? `[group: ${cc.map(h => disp(c, h)).join(', ')}] ${text}` : text });
          console.log(`sent to ${disp(c, to)} (id ${j.id})${pk && c.keysUploaded ? ' [end-to-end encrypted]' : ' [UNENCRYPTED: ' + (pk ? 'your key is not on the relay yet' : disp(c, to) + ' has no key yet') + ']'}`);
        } catch (e) { failed++; console.log(`FAILED to ${disp(c, to)}: ${e.message}`); }
      }
      if (failed) process.exit(1);
    } else if (cmd === 'space') {
      const c = need(); const sub = args.shift(), name = norm(args.shift() || '');
      const flag = n => { const k = args.indexOf(n); return k < 0 ? undefined : args[k + 1]; };
      if (!name || !['create', 'invite', 'delete'].includes(sub)) { console.error('usage: relay space create <name> | space invite <name> [--uses N] [--expires 15m] | space delete <name>'); process.exit(2); }
      if (sub === 'delete') { const d = await call(c, 'DELETE', `/spaces/${name}`); console.log(`Deleted space ${d.deleted}: removed ${d.handlesRemoved} handle(s), their queued messages and all invites.`); return; }
      const j = sub === 'create' ? await call(c, 'POST', '/spaces', { name, uses: flag('--uses'), expires: flag('--expires') }) : await call(c, 'POST', `/spaces/${name}/invites`, { uses: flag('--uses'), expires: flag('--expires') });
      if (sub === 'create') console.log(`Created space ${name} (you are its owner).`);
      console.log(`Invite code: ${j.invite}  (space ${j.space}, ${j.maxUses} use${j.maxUses > 1 ? 's' : ''}, expires ${j.expires})`);
      console.log(`Give an agent this sentence: "Clone github.com/greybeardconsortium/agentrelay-relay, read AGENTS.md, and join as @<handle> with invite ${j.invite}${c.url !== DEFAULT_URL ? ' at ' + c.url : ''}."`);
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
    } else { console.error('usage: relay init <handle> [--url URL] | whoami [--all] | use <handle> | setup | [--as <handle>] before any command | send <to>[,<to2>...] <text> | reply-all <text> | space create <name> | space invite <name> [--uses N --expires 15m] | space delete <name> | wait [--once] | poll | webhook <url> [--header "Name: value"] | webhook --clear'); process.exit(2); }
  } catch (e) { console.error('error: ' + e.message); process.exit(1); }
})();
