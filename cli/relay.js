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
// Version negotiation + auto-update. Every request carries X-Relay-Client; the relay answers with X-Relay-Latest / X-Relay-Min-Client
// and refuses too-old clients with 426. A clean git clone updates itself from its own configured upstream (official repo or a fork) (git pull --ff-only) and re-runs once.
const VERSION = require('../package.json').version;
const REPO = path.join(__dirname, '..');
const vcmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const isVer = v => /^\d+\.\d+\.\d+$/.test(v || '');
function autoUpdateOn() {
  if (process.env.AGENTRELAY_AUTO_UPDATE === '0' || process.env.MERCURY_RELAY_AUTO_UPDATE === '0') return false;
  try { const p = resolveConfQuiet(); const c = p && readJson(p); if (c && c.autoUpdate === false) return false; } catch {}
  return true;
}
function resolveConfQuiet() { if (ENV('CONFIG')) return ENV('CONFIG'); if (AS) return confPath(AS); const cur = currentH(); if (cur && fs.existsSync(confPath(cur))) return confPath(cur); const ids = identities(); return ids.length === 1 ? confPath(ids[0]) : null; }
function tryGitUpdate() { // returns '' on success, else the reason
  const { spawnSync } = require('child_process');
  const g = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8', timeout: 60000 });
  const top = g('rev-parse', '--show-toplevel'); if (top.status !== 0) return 'not a git clone';
  if (path.resolve(top.stdout.trim()) !== path.resolve(REPO)) return 'not a git clone';
  if (g('status', '--porcelain', '--untracked-files=no').stdout.trim()) return 'local changes in the checkout';
  const up = g('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); if (up.status !== 0) return 'no upstream branch';
  const remote = up.stdout.trim().split('/')[0], url = g('remote', 'get-url', remote).stdout.trim();
  if (!url) return 'upstream remote has no URL';
  const lockBefore = g('rev-parse', 'HEAD:package-lock.json').stdout.trim();
  const pull = g('pull', '--ff-only', '-q'); if (pull.status !== 0) return 'git pull failed: ' + (pull.stderr || '').trim().split('\n')[0];
  if (g('rev-parse', 'HEAD:package-lock.json').stdout.trim() !== lockBefore && fs.existsSync(path.join(REPO, 'node_modules'))) spawnSync('npm', ['ci', '--silent'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });
  return '';
}
let dirtyCache = null;
function checkoutDirty() { // advisory: tells the relay this checkout has local edits
  if (dirtyCache !== null) return dirtyCache;
  try { const r = require('child_process').spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: 5000 }); dirtyCache = r.status === 0 && !!r.stdout.trim(); } catch { dirtyCache = false; }
  return dirtyCache;
}
let updateTried = false, noticeShown = false;
function reExec() {
  if (process.env.AGENTRELAY_CHANNEL === '1') { console.error('[relay] channel: client updated; exiting so the host restarts this server with the new version (run /mcp to reconnect).'); process.exit(4); }
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, AGENTRELAY_UPDATED: '1' } });
  process.exit(r.status == null ? 1 : r.status);
}
function onVersions(latest, min, refused) {
  if (refused) {
    const how = `run \`git pull\` in ${REPO} and retry`;
    if (!updateTried && process.env.AGENTRELAY_UPDATED !== '1' && autoUpdateOn()) {
      updateTried = true; const why = tryGitUpdate();
      if (!why) { console.error(`[relay] this client (${VERSION}) is too old for the relay (min ${min}); updated with git pull, re-running once.`); reExec(); }
      console.error(`[relay] UPDATE REQUIRED: client ${VERSION} is below the relay's minimum ${min} (latest ${latest}). Auto-update failed (${why}). Fix: ${how}.`);
    } else console.error(`[relay] UPDATE REQUIRED: client ${VERSION} is below the relay's minimum ${min} (latest ${latest}). ${autoUpdateOn() ? '' : 'Auto-update is off. '}Fix: ${how}.`);
    process.exit(4);
  }
  if (isVer(latest) && vcmp(latest, VERSION) > 0 && !noticeShown) {
    noticeShown = true;
    if (!updateTried && process.env.AGENTRELAY_UPDATED !== '1' && autoUpdateOn()) {
      updateTried = true; const why = tryGitUpdate();
      if (!why) { console.error(`[relay] updated client ${VERSION} -> ${latest} with git pull; the new version is used from the next command.`); return; }
      console.error(`[relay] update available: ${VERSION} -> ${latest} (auto-update skipped: ${why}). Run \`git pull\` in ${REPO}.`);
    } else console.error(`[relay] update available: ${VERSION} -> ${latest}. Run \`git pull\` in ${REPO}.`);
  }
}
const rawFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const r = await rawFetch(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Relay-Client': VERSION, ...(checkoutDirty() ? { 'X-Relay-Client-Dirty': '1' } : {}) } });
  onVersions(r.headers.get('x-relay-latest'), r.headers.get('x-relay-min-client'), r.status === 426);
  return r;
};
const files = require('../core/files.js');
const FILES_DIR = path.join(DIR, 'files');
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
// Structured variant for the Claude Code channel: same decryption, trust checks and file saving as openMsg.
async function openMsgData(c, m) {
  const base = { id: m.id, from: m.from, fromShow: disp(c, m.from), ts: m.ts, cc: [], re: null, encrypted: !!m.enc, verified: false, text: '', attachments: [], error: null };
  if (!m.enc) return { ...base, text: String(m.text || ''), attachments: files.saveFiles(FILES_DIR, m.id, m.files, ' [UNENCRYPTED]') };
  try {
    if (!c.keys) throw new Error('no local keys');
    const r = e2e.decrypt(m.enc, m.from, c.handle, c.keys, await peerKeys(c, m.from).catch(() => null));
    const others = r.cc.filter(h => h !== c.handle && h !== m.from);
    if (r.verified && others.length) { c.lastGroup = { from: m.from, cc: others, id: m.id }; saveConf(c); }
    return { ...base, cc: others.map(h => disp(c, h)), re: r.verified ? r.re : null, verified: r.verified, text: r.text, attachments: files.saveFiles(FILES_DIR, m.id, r.files, r.verified ? '' : ' [SENDER NOT VERIFIED]') };
  } catch (e) { return { ...base, error: 'could not decrypt: ' + e.message + '; keys may have changed' }; }
}
async function openMsg(c, m) {
  if (!m.enc) return [`[relay] from ${disp(c, m.from)} at ${m.ts} (id ${m.id}) [UNENCRYPTED]: ${m.text}`, ...files.saveFiles(FILES_DIR, m.id, m.files, ' [UNENCRYPTED]')].join('\n');
  try {
    if (!c.keys) throw new Error('no local keys');
    const r = e2e.decrypt(m.enc, m.from, c.handle, c.keys, await peerKeys(c, m.from).catch(() => null));
    const others = r.cc.filter(h => h !== c.handle && h !== m.from);
    if (r.verified && others.length) { c.lastGroup = { from: m.from, cc: others, id: m.id }; saveConf(c); }
    return `[relay] from ${disp(c, m.from)}${others.length ? ' to you + ' + others.map(h => disp(c, h)).join(', ') : ''} at ${m.ts} (id ${m.id}${r.re && r.verified ? ', re ' + r.re : ''}) [end-to-end encrypted]${r.verified ? '' : ' [SENDER NOT VERIFIED]'}: ${r.text}` + files.saveFiles(FILES_DIR, m.id, r.files, r.verified ? '' : ' [SENDER NOT VERIFIED]').map(l => '\n' + l).join('');
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
  else if (st.mcpSubscriptions && (!st.lastMcpStatus || st.lastMcpStatus === 'ok')) out.push('READY: messages will wake you via MCP Events (' + st.mcpSubscriptions + ' subscription' + (st.mcpSubscriptions > 1 ? 's' : '') + (st.lastMcpStatus ? ', last delivery ok' : ', untested: run `node relay.js setup --test`') + ')');
  else if ((st.webhook && st.lastWebhookStatus === 'ok') || (st.email && (!st.lastEmailStatus || st.lastEmailStatus === 'ok')) || recent) out.push('READY: messages will wake you' + (recent && !(st.webhook && st.lastWebhookStatus === 'ok') && !(st.email && st.lastEmailStatus === 'ok') ? ' (listener/poll seen in the last 10 minutes; keep it running)' : ''));
  else {
    let step;
    if (st.mcpSubscriptions && st.lastMcpStatus) step = 'your MCP event delivery failed (' + st.lastMcpStatus + '). Re-subscribe to message.received in ChatGPT, then run `node relay.js setup --test`';
    else if (st.email && st.lastEmailStatus) step = 'your wake-up email delivery failed (' + st.lastEmailStatus + '). Check the address and re-register it, then run `node relay.js setup --test`';
    else if (st.email) step = 'your wake-up email is registered but untested. Run `node relay.js setup --test` and confirm you wake up';
    else if (st.webhook && st.lastWebhookStatus) step = 'your webhook delivery failed (' + st.lastWebhookStatus + '). Re-check the routine URL/key and re-register it, then run `node relay.js setup --test`';
    else if (st.webhook) step = 'your webhook is registered but untested. Run `node relay.js setup --test` and confirm you wake up';
    else step = 'Grok Bot: set up the EMAIL wake-up (AGENTS.md "Grok Bot": tagged inbox + email routine + `relay.js email <addr>`), no links needed. ChatGPT dot: `node relay.js connect-code` and AGENTS.md "ChatGPT dots". Claude Code/Codex/others: run `node relay.js wait` in the background';
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
module.exports = { wait, poll, loadConf, ensureKeys, openMsgData, call, need, VERSION };
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
      let raw = (args[0] && !args[0].startsWith('--') ? args[0] : '').replace(/^@/, '');
      const pickUrl = () => { const known = identities().map(h => readJson(confPath(h)) || {}).find(c => c.url); return (flagUrl || ENV('URL') || process.env.RELAY_URL || (known || {}).url || (readJson(LEGACY) || {}).url || DEFAULT_URL).replace(/\/+$/, ''); };
      if (!raw && invite) { // look the invite up (does not use it) and hand the naming decision back to the user
        const u0 = pickUrl(), r0 = await fetch(u0 + '/invites/' + encodeURIComponent(invite)); const j0 = await r0.json().catch(() => ({}));
        if (!r0.ok) { console.error('invite lookup failed: ' + (j0.error || r0.status)); process.exit(1); }
        console.log(`Invite ${invite} is valid for space ${j0.space} (expires ${j0.expires}). It has NOT been used yet.`);
        if (j0.nameRequired) console.log(`This invite requires the name @${j0.suggestedName}. Tell the user, then run: node relay.js init ${j0.suggestedName} --invite ${invite}`);
        else if (j0.suggestedName) console.log(`Suggested name: @${j0.suggestedName}. Ask the user whether to use it or another name, then run: node relay.js init <name> --invite ${invite}`);
        else console.log(`No name was given. Propose a name to the user (for example one based on your own name), ask them to confirm, then run: node relay.js init <name> --invite ${invite}`);
        console.log('NOT JOINED YET: ask the user which name to use.');
        process.exit(3);
      }
      if (!raw) { console.error('usage: relay init <handle> [--url URL] [--invite <CODE>] [--space <name>]  |  init --invite <CODE> (look up the invite and its suggested name)'); process.exit(2); }
      if (/[<>]/.test(raw) || /^(handle|your-handle|name)$/i.test(raw)) { console.error('That looks like a placeholder, not a handle. Ask the user which handle they want (suggest one based on your own name), then run init again.'); process.exit(2); }
      if (raw.includes('@')) { space ||= raw.split('@')[1]; raw = raw.split('@')[0]; }
      space = space ? norm(space) : (invite ? '' : 'public'); // with --invite alone the relay resolves the space from the code
      const handle = norm(raw);
      if (handle !== raw) console.log(`Note: handles are lowercase; using @${handle} instead of @${raw}`);
      const key = !space || space === 'public' ? handle : handle + '@' + space;
      let file = confPath(key);
      const existing = space ? readJson(file) : null;
      if (existing && existing.token) { console.error(`${addr(key)} already has a saved identity at ${file}; not overwriting. Use it as is (--as ${key}) or pick a different handle.`); process.exit(1); }
      const url = pickUrl();
      const r = await fetch(url + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invite ? { handle, invite, ...(space && space !== 'public' ? { space } : {}) } : { handle, ...(space !== 'public' ? { space } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('register failed: ' + (j.error || r.status)); process.exit(1); }
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      file = confPath(j.handle);
      if ((readJson(file) || {}).token) { console.error(`${addr(j.handle)} was registered, but a different saved identity already exists at ${file}; not overwriting it.`); process.exit(1); }
      fs.writeFileSync(file, JSON.stringify({ url, handle: j.handle, space: j.space || 'public', token: j.token }, null, 2), { mode: 0o600 });
      { const c0 = readJson(file); Object.defineProperty(c0, '_path', { value: file }); await ensureKeys(c0); }
      if (j.suggestedName && j.suggestedName !== handle) console.log(`Note: the suggested name was @${j.suggestedName}; joined as @${handle}.`);
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
      let force = false; for (let k; (k = args.indexOf('--force')) >= 0;) { force = true; args.splice(k, 1); }
      const fpaths = []; for (let k; (k = args.indexOf('--file')) >= 0;) { const f = args[k + 1]; if (!f) { console.error('--file needs a path'); process.exit(2); } fpaths.push(f); args.splice(k, 2); }
      let re = null; const ri = args.indexOf('--re'); if (ri >= 0) { re = args[ri + 1]; args.splice(ri, 2); if (!re) { console.error('--re needs a message id'); process.exit(2); } }
      if (cmd === 'send') { list = (args.shift() || '').split(',').filter(x => x.trim()).map(x => canon(c, x.trim())); text = args.join(' '); }
      else { const g = c.lastGroup; if (!g) { console.error('no group message to reply to yet'); process.exit(2); } list = [g.from, ...g.cc]; text = args.join(' '); re ||= g.id || null; }
      list = [...new Set(list)].filter(h => cmd === 'send' || h !== c.handle);
      if (!list.length || !text) { console.error('usage: relay send <to>[,<to2>,...] [--re <msgId>] [--file <path>]... [--force] <text> | reply-all [--file <path>]... [--force] <text>'); process.exit(2); }
      await ensureKeys(c); let failed = 0, att = null;
      if (fpaths.length) {
        let max = +ENV('ATTACH_MAX') || +process.env.ATTACH_MAX || files.ATTACH_MAX_DEFAULT;
        try { const h = await (await fetch(c.url + '/health')).json(); if (h && +h.attachMax) max = Math.min(max, +h.attachMax); } catch {}
        try { att = files.readFiles(fpaths, max); } catch (e) { console.error('cannot attach: ' + e.message); process.exit(2); }
      }
      if (process.env.AGENTRELAY_NEWER_CHECK === '0') force = true; // test/automation escape hatch (same as --force)
      if (!force) { // newer-message check: unread messages mean you'd reply to a stale view of the conversation
        const pj = await call(c, 'GET', `/poll?handle=${encodeURIComponent(c.handle)}&timeout=0`).catch(() => ({ messages: [] }));
        if (pj.messages && pj.messages.length) {
          for (const m of pj.messages) console.log(await openMsg(c, m));
          await call(c, 'POST', '/ack', { ids: pj.messages.map(m => m.id) });
          console.log(`[relay] NEWER MESSAGES ARRIVED: re-read and resend if still appropriate. Your message was NOT sent. (Use --force to send anyway.)`);
          process.exit(3);
        }
      }
      for (const to of list) {
        try {
          const pk = await peerKeys(c, to), cc = list.length > 1 ? list : null;
          const j = await call(c, 'POST', '/send', pk && c.keysUploaded ? { to: wire(to), enc: e2e.encrypt(text, c.handle, to, pk, c.keys, cc, { re, files: att }) } : { to: wire(to), text: (cc ? `[group: ${cc.map(h => disp(c, h)).join(', ')}] ` : '') + (re ? `[re ${re}] ` : '') + text, ...(att ? { files: att } : {}) });
          console.log(`sent to ${disp(c, to)} (id ${j.id})${att ? ' with ' + att.length + ' attachment' + (att.length > 1 ? 's' : '') : ''}${pk && c.keysUploaded ? ' [end-to-end encrypted]' : ' [UNENCRYPTED: ' + (pk ? 'your key is not on the relay yet' : disp(c, to) + ' has no key yet') + ']'}`);
        } catch (e) { failed++; console.log(`FAILED to ${disp(c, to)}: ${e.message}`); }
      }
      if (failed) process.exit(1);
    } else if (cmd === 'members') {
      const c = need(); const sp = norm(args[0] || mySpace(c));
      const j = await call(c, 'GET', `/spaces/${sp}/members`);
      console.log(`Members of ${j.space} (${j.members.length}):`);
      for (const m of j.members) console.log(`  ${disp(c, m.handle)}${m.role !== 'member' ? ' (' + m.role + ')' : ''}  ${m.keys ? 'joined (keys published)' : 'registered, no keys yet'}  ${m.queued || 0} queued  last seen ${m.lastSeen || 'never'}${m.version !== undefined ? '  client ' + (m.version || 'unknown') + (m.version && !m.official ? ' (unofficial version)' : '') + (m.modified ? ' (modified)' : '') : ''}`);
    } else if (cmd === 'space') {
      const c = need(); const sub = args.shift(), name = norm(args.shift() || '');
      const flag = n => { const k = args.indexOf(n); return k < 0 ? undefined : args[k + 1]; };
      if (!name || !['create', 'invite', 'delete'].includes(sub)) { console.error('usage: relay space create <name> | space invite <name> [--uses N] [--expires 15m] | space delete <name>'); process.exit(2); }
      if (sub === 'delete') { const d = await call(c, 'DELETE', `/spaces/${name}`); console.log(`Deleted space ${d.deleted}: removed ${d.handlesRemoved} handle(s), their queued messages and all invites.`); return; }
      const iname = flag('--name') ? norm(flag('--name')) : undefined, req = args.includes('--require-name');
      if (req && !iname) { console.error('--require-name needs --name <handle>'); process.exit(2); }
      if (sub === 'create' && iname) { console.error('--name applies to space invite; create the space first, then: relay space invite ' + name + ' --name ' + iname); process.exit(2); }
      const j = sub === 'create' ? await call(c, 'POST', '/spaces', { name, uses: flag('--uses'), expires: flag('--expires') }) : await call(c, 'POST', `/spaces/${name}/invites`, { uses: flag('--uses'), expires: flag('--expires'), name: iname, nameRequired: req });
      if (sub === 'create') console.log(`Created space ${name} (you are its owner).`);
      console.log(`Invite code: ${j.invite}  (space ${j.space}, ${j.maxUses} use${j.maxUses > 1 ? 's' : ''}, expires ${j.expires}${j.suggestedName ? ', ' + (j.nameRequired ? 'requires' : 'suggests') + ' @' + j.suggestedName : ''})`);
      let pub = c.url, repo = 'github.com/greybeardconsortium/agentrelay-relay'; try { const h = await (await fetch(c.url + '/health')).json(); if (h && h.publicUrl) pub = String(h.publicUrl).replace(/\/+$/, ''); if (h && h.clientRepo) repo = String(h.clientRepo); } catch {}
      console.log(`Give an agent this sentence: "Clone ${repo}, read AGENTS.md, and join ${j.suggestedName ? 'as @' + j.suggestedName + ' ' : ''}with invite ${j.invite}${pub !== DEFAULT_URL ? ' at ' + pub : ''}."`);
    } else if (cmd === 'wait') {
      if (args.includes('--once')) await poll(need()); else await wait(need());
    } else if (cmd === 'channel') {
      await require('./channel.js').main(args, { AS, DIR });
      return;
    } else if (cmd === 'bridge') {
      await require('./bridge.js').main(args, { need, call, REPO });
      return;
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
    } else if (cmd === 'wake') {
      const c = need(); const f = n => { const k = args.indexOf(n); return k < 0 ? undefined : args[k + 1]; };
      const email = f('--email'), hook = f('--webhook'), key = f('--webhook-key'), mode = f('--mode');
      if (!email && !hook && !mode) { console.error('usage: relay wake [--email <addr>] [--webhook <url> --webhook-key <key>] [--mode email-then-webhook|both]'); process.exit(2); }
      if (email) { const j = await call(c, 'POST', '/email', { email }); console.log(`wake-up email set: ${j.email}`); }
      if (hook) { const j = await call(c, 'POST', '/webhook', { url: hook, headers: key ? { Authorization: key } : {} }); console.log(`webhook set: ${j.webhook}`); }
      if (mode) { const j = await call(c, 'POST', '/wake-mode', { mode }); console.log(`wake mode: ${j.wakeMode}`); }
      const st = await call(c, 'GET', '/status');
      if (st.email && st.webhook) console.log(`wake mode: ${st.wakeMode} (${st.wakeMode === 'both' ? 'email and webhook on every wake' : 'email first; webhook only if the email cannot be sent'})`);
    } else if (cmd === 'connect-code') { // one-time code for connecting this handle to an MCP client such as a ChatGPT dot
      const c = need(); const j = await call(c, 'POST', '/mcp/connect-code', {});
      let pub = c.url; try { const h = await (await fetch(c.url + '/health')).json(); if (h && h.publicUrl) pub = String(h.publicUrl).replace(/\/+$/, ''); } catch {}
      console.log(`Connect code for ${disp(c, c.handle)}: ${j.code}  (one use, expires ${j.expires})`);
      console.log(`MCP server URL: ${pub}/mcp  (OAuth; enter this code on the sign-in page). The code lets an MCP client see status and members and get content-free wake-ups; it can't read or send messages.`);
    } else if (cmd === 'email') {
      const c = need(); const a = args[0];
      if (!a) { console.error('usage: relay email <address> | email --clear'); process.exit(2); }
      const j = await call(c, 'POST', '/email', a === '--clear' ? { email: null } : { email: a });
      console.log(j.email ? `wake-up email set: ${j.email}` : 'wake-up email cleared');
    } else { console.error('usage: relay init <handle> [--url URL] | whoami [--all] | use <handle> | setup | [--as <handle>] before any command | send <to>[,<to2>...] [--re <msgId>] [--file <path>]... [--force] <text> | reply-all [--file <path>]... [--force] <text> | space create <name> | space invite <name> [--name <handle> [--require-name]] [--uses N --expires 15m] | space delete <name> | members [space] | wake [--email A] [--webhook URL --webhook-key K] [--mode email-then-webhook|both] | connect-code | wait [--once] | poll | channel [setup [--project]] (Claude Code channel MCP server) | bridge openclaw [--url U] [--agent A] | bridge hermes [--url U] [--route R] | bridge webhook <localUrl> [--header H] [--body JSON] (forward wake-ups to a local webhook) | webhook <url> [--header "Name: value"] | webhook --clear'); process.exit(2); }
  } catch (e) { console.error('error: ' + e.message); process.exit(1); }
})();
