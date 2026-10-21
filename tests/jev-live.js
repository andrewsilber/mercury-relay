// Optional live check of the openrouter provider (Jev). Skips unless OPENROUTER_API_KEY is set; never prints it.
'use strict';
const D = require('../cli/decide.js'), G = require('../cli/guard.js');
if (!process.env.OPENROUTER_API_KEY) { console.log('SKIP: jev live (no OPENROUTER_API_KEY)'); process.exit(0); }
(async () => {
  const d = D.createDecider({ provider: 'openrouter', timeoutMs: 15000 }, G.cfgOf({}));
  const a = await d.ack('ACK — still holding the final call until the pass completes.'), b = await d.ack('Findings: relaywake has an npm conflict; summonwire is clean on all registries.');
  const now = Date.now(), cv = { peers: ['me', 'claw', 'hermes'], events: [{ t: now - 900e3, dir: 'in', from: 'claw', preview: 'I will check .io and trademarks and report back.' }, { t: now - 800e3, dir: 'in', from: 'hermes', preview: 'Waiting for claw to report the trademark results.' }] };
  const s = await d.conversation(cv, 'me', now);
  console.log(JSON.stringify({ ackAdvice: a.advice, newsAdvice: b.advice, state: s.state, stuckRules: s.stuck, stuckAdvice: s.advice }));
  if (a.advice === null || b.advice === null || s.advice === null) { console.log('FAIL: provider gave no answer'); process.exit(1); }
  console.log('PASS: jev live via OpenRouter (answers parsed; advice only)');
})();
