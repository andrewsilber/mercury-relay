// Unit tests: decision model (rules, providers, fallback) and guardrail checks. No network.
'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const D = require('../cli/decide.js'), G = require('../cli/guard.js'), CMD = require('../cli/commands.js');
const cfg = G.cfgOf({ guard: { loopAcks: 3, rateMax: 3, silenceMs: 1000 } });
(async () => {
  const R = D.rules;
  for (const t of ['ACK', 'Agreed.', 'Got it, thanks', 'ACK — holding the final call until the pass completes.', '+1']) assert(R.isAck(t, cfg), 'ack: ' + t);
  for (const t of ['Agreed? not sure', 'Findings: relaywake has a conflict', 'FINAL: relaywake', 'ok ' + 'x'.repeat(300), 'What about zibblet?', 'AGREE p3', 'OBJECT p3: too long']) assert(!R.isAck(t, cfg), 'not ack: ' + t);
  assert(R.isFinal('FINAL: a > b') && R.isFinal('DONE') && R.isFinal('**FINAL** x') && !R.isFinal('final thoughts'));
  const now = Date.now(), ev = (o) => ({ t: now, dir: 'in', from: 'b', ack: false, final: false, ...o });
  assert.equal(R.state({ events: [ev({ ack: true }), ev({ ack: true }), ev({ ack: true })] }, cfg, now), 'looping');
  assert.equal(R.state({ events: [ev({ final: true })] }, cfg, now), 'done');
  assert.equal(R.state({ events: [ev({ t: now - 5000 })] }, cfg, now), 'stalled');
  assert.equal(R.state({ events: [ev({})] }, cfg, now), 'progressing');
  assert.equal(R.stuck({ peers: ['a', 'b', 'c'], events: [ev({ from: 'b' })] }, cfg, 'a', now), 'c');
  assert.equal(R.stuck({ peers: ['a', 'b'], events: [ev({ from: 'b', t: now - 9000 })] }, cfg, 'a', now), 'all');
  // decider: rules default; injected provider advises only; errors fall back to rules
  const rd = D.createDecider({}, cfg, {}); assert.equal(rd.name, 'rules'); assert.deepEqual(await rd.ack('ACK', {}), { ack: true, advice: null });
  const yes = D.createDecider({ provider: 'url' }, cfg, {}, async () => ({ ack: { noul: 0.9 }, stuck: { choice: 'c' } }));
  assert.deepEqual(await yes.ack('Findings: new data', {}), { ack: false, advice: true }, 'provider cannot flip the hard ack rule');
  const cv = { peers: ['a', 'b', 'c'], events: [ev({ from: 'b', t: now - 5000 })] };
  assert.deepEqual(await yes.conversation(cv, 'a', now), { state: 'stalled', stuck: 'all', advice: 'c' });
  const bad = D.createDecider({ provider: 'url' }, cfg, {}, async () => { throw new Error('down'); });
  assert.deepEqual(await bad.ack('ACK', {}), { ack: true, advice: null });
  const odd = D.createDecider({ provider: 'url' }, cfg, {}, async () => ({ stuck: { choice: 'mallory' } }));
  assert.equal((await odd.conversation(cv, 'a', now)).advice, null, 'unknown handle from provider ignored');
  assert.equal(D.createDecider({ provider: 'openrouter' }, cfg, {}).name, 'rules', 'no key -> rules');
  assert.equal(D.createDecider({ provider: 'openrouter' }, cfg, { OPENROUTER_API_KEY: 'k' }).name, 'openrouter');
  assert.equal(D.createDecider({}, cfg, { AGENTRELAY_DECISION: 'typesafe', TYPESAFE_API_KEY: 'k' }).name, 'typesafe');
  // HTTP provider wire shape (openrouter/typesafe/url) against a local fake, incl. timeout fallback
  let seen = null; const srv = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { seen = { auth: q.headers.authorization, body: JSON.parse(b) }; if (seen.body.state.latest_message === 'slow') return setTimeout(() => s.end('{}'), 500); s.end(JSON.stringify({ answers: { ack: { noul: 0.1 } } })); }); }).listen(0);
  await new Promise(r => srv.on('listening', r)); const url = `http://127.0.0.1:${srv.address().port}/d`;
  const od = D.createDecider({ provider: 'openrouter', url, timeoutMs: 200 }, cfg, { OPENROUTER_API_KEY: 'sk-test' });
  assert.deepEqual(await od.ack('ACK', {}), { ack: true, advice: false });
  assert.equal(seen.auth, 'Bearer sk-test'); assert.equal(seen.body.model, 'typesafe/jev-1.13'); assert.equal(seen.body.questions.ack.type, 'noul');
  assert.deepEqual(await od.ack('slow', {}), { ack: false, advice: null }, 'timeout -> rules');
  const ts = D.createDecider({ provider: 'typesafe', url }, cfg, { TYPESAFE_API_KEY: 'ts' }); await ts.ack('x', {}); assert.equal(seen.body.model, 'jev-latest');
  srv.close();
  // command provider
  const cmdp = D.createDecider({ provider: 'command', command: `node -e 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({answers:{ack:{noul:1}}})))'` }, cfg, {});
  assert.deepEqual(await cmdp.ack('new idea', {}), { ack: false, advice: true });
  // guardrails
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), g = G.open(dir, 'a'), c = g.conv('s', ['a', 'b']);
  const send = (t, at = Date.now()) => { const r = G.checkSend(g, c, t, R, cfg, 'a', at); if (!r.refuse) { (g.st.sends.s ||= []).push(at); g.record(c, { t: at, dir: 'out', from: 'a', ack: r.cls.ack, rep: r.cls.rep, final: r.cls.final, norm: R.norm(t), preview: t }); } return r; };
  assert(send('Here are my findings on relaywake and summonwire').refuse === null);
  assert(/repeat/.test(send('Here are my findings on relaywake and summonwire!').refuse), 'identical text refused');
  g.st.sends.s = []; c.events = [];
  assert(send('ACK').autoAck); g.record(c, { t: Date.now(), dir: 'in', from: 'b', ack: true, norm: 'ack' });
  assert(/loop/.test(send('Agreed, holding').refuse), 'third ack in a row refused');
  assert(send('FINAL: relaywake').refuse === null, 'FINAL always allowed past the loop breaker');
  g.st.sends.s = [1, 2, 3].map(() => Date.now()); assert(/rate cap/.test(send('new point entirely different').refuse));
  g.st.sends.s = []; c.events = [];
  g.record(c, { t: Date.now(), dir: 'in', from: 'b', preview: 'relaywake beats summonwire and agentconfab, botparley contingency' });
  assert(g.classify(c, 'Agreed: relaywake beats summonwire and agentconfab with botparley contingency today', R, cfg).rep, 'restated agreement = repeat');
  g.save(); assert.equal((fs.statSync(g.file).mode & 0o777).toString(8), '600');
  // command table drives footer + usage
  const f = CMD.footer('bob', '/r'); assert(f.length < 260, 'footer short: ' + f.length);
  for (const c of CMD.COMMANDS.filter(c => c.core)) assert(f.includes(c.short || c.usage));
  assert(CMD.usageText().includes('config set <key> <value>'));
  console.log('PASS: decision model (rules, injected/http/command providers, advice-only, fallback on error/timeout/odd answers), guardrails (auto-ack, repeat, loop breaker, FINAL bypass, rate cap, restated agreement), command table footer/usage');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
