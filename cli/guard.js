// Client guardrails: mechanical, local, model-independent. They work the same whatever model
// drives the agent, because they act on what the agent sends, not on what it was told.
// State lives in ~/.mercury-relay/<handle>.guard.json (mode 600, never leaves this computer).
'use strict';
const fs = require('fs'), path = require('path');
const DEFAULTS = {
  ackMaxChars: 220,      // a pure ack is at most this long
  loopAcks: 4,           // this many acks/repeated agreements in a row = loop; further ones are refused
  similarity: 0.8,       // word overlap at which a message counts as repeating an earlier one
  repeatMax: 1,          // how many times the same text may go to the same people within repeatWindowMs
  repeatWindowMs: 30 * 60e3,
  rateMax: 20,           // sends per space per rateWindowMs
  rateWindowMs: 10 * 60e3,
  silenceMs: 10 * 60e3,  // a conversation with no message for this long is stalled
  checkbackMs: 15 * 60e3,// automatic check-back reminder after replying without FINAL/DONE (0 = off)
  convTtlMs: 24 * 3600e3,
};
const NUM_KEYS = Object.keys(DEFAULTS);
const cfgOf = c => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries((c && c.guard) || {}).filter(([k, v]) => k in DEFAULTS && Number.isFinite(+v)).map(([k, v]) => [k, +v])) });
const words = t => new Set(String(t || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
function overlap(a, b) { const A = words(a), B = words(b); if (A.size < 3 || B.size < 3) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); }
const convKey = (space, people) => space + '|' + [...new Set(people)].sort().join(',');

function open(dir, handle) {
  const file = path.join(dir, handle.replace(/[^\w.@-]/g, '_') + '.guard.json');
  let st; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = {}; }
  st.convs ||= {}; st.sends ||= {};
  const save = () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(st), { mode: 0o600 }); };
  const prune = (cfg, now) => {
    for (const [k, v] of Object.entries(st.convs)) if (!v.events.length || now - v.events[v.events.length - 1].t > cfg.convTtlMs) delete st.convs[k];
    for (const [k, v] of Object.entries(st.sends)) { st.sends[k] = v.filter(t => now - t < Math.max(cfg.rateWindowMs, 60e3)); if (!st.sends[k].length) delete st.sends[k]; }
  };
  const conv = (space, people) => { const k = convKey(space, people); return st.convs[k] ||= { space, peers: [...new Set(people)].sort(), events: [] }; };
  // Classify a message against the conversation so far.
  const classify = (cv, text, rules, cfg) => {
    const ack = rules.isAck(text, cfg), final = rules.isFinal(text);
    const rep = !final && cv.events.slice(-cfg.loopAcks * 2).some(e => e.preview && overlap(e.preview, text) >= cfg.similarity);
    return { ack, final, rep };
  };
  const record = (cv, e) => { cv.events.push(e); if (cv.events.length > 60) cv.events.splice(0, cv.events.length - 60); };
  return { st, save, prune, conv, classify, record, file };
}
// Check an outgoing message. Returns { refuse: reason|null, autoAck, cls }.
function checkSend(g, cv, text, rules, cfg, me, now = Date.now()) {
  const cls = g.classify(cv, text, rules, cfg);
  const sent = (g.st.sends[cv.space] || []).filter(t => now - t < cfg.rateWindowMs).length;
  if (sent >= cfg.rateMax) return { refuse: `rate cap: you sent ${sent} messages in space ${cv.space} in the last ${Math.round(cfg.rateWindowMs / 60e3)} min (max ${cfg.rateMax}). Wait, or batch your updates into one message.`, cls };
  const n = rules.norm(text), same = cv.events.filter(e => e.dir === 'out' && e.norm === n && now - e.t < cfg.repeatWindowMs).length;
  if (same >= cfg.repeatMax) return { refuse: `repeat: you already sent this exact message to ${cv.peers.filter(p => p !== me).map(p => '@' + p).join(', ')} ${same} time(s) recently. Send something new, or nothing.`, cls };
  if (!cls.final && (cls.ack || cls.rep)) {
    const tail = cv.events.slice(-(cfg.loopAcks - 1));
    if (tail.length >= cfg.loopAcks - 1 && tail.every(e => e.ack || e.rep)) return { refuse: `loop: the last ${cfg.loopAcks - 1} messages in this conversation were acknowledgements or repeated agreement, and this one is too. Stop here, or send "FINAL <result>" if the work is done, or add new information.`, cls };
  }
  return { refuse: null, autoAck: cls.ack, cls };
}
module.exports = { DEFAULTS, NUM_KEYS, cfgOf, open, checkSend, overlap, convKey };
