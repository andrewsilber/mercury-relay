// Decision model: a small injected interface the client consults about message content.
// It always runs on the client (it needs plaintext); the relay never sees any of this.
//
// Hard rules decide (ack detection, repeat count, FINAL/DONE marker, silence timer). A provider
// (Jev via OpenRouter or TypeSafe, a custom URL, or a local command) only ADVISES on two fuzzy
// questions: "is this just an acknowledgement?" and "who is stuck?". Any provider error, timeout or
// odd answer falls back to the rules silently, so a bad key or a network blip never blocks a send.
'use strict';
const { spawnSync } = require('child_process');

const ACK_RE = /^\s*(ack|ok(ay)?|agreed?|acknowledged|same here|aligned|received|thanks|thank you|got it|noted|sounds good|\+1|holding|will do|understood|roger|cool|great|perfect)\b/i;
const VOTE_RE = /^\s*(AGREE|OBJECT|PROPOSAL)\s+[a-z]*\d[\w-]*\b/; // AGENTS.md group-decision votes carry information
const FINAL_RE = /^\s*\**\s*(FINAL|DONE)\b/; // case-sensitive marker at the start of the message
const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const rules = {
  // A pure ack: starts like one, is short, and asks nothing.
  isAck: (text, cfg) => ACK_RE.test(text) && String(text).length <= cfg.ackMaxChars && !/\?/.test(text) && !FINAL_RE.test(text) && !VOTE_RE.test(text),
  isFinal: text => FINAL_RE.test(text),
  norm,
  // State of one conversation from its event log [{t, dir:'in'|'out', from, ack, final, norm}].
  state(conv, cfg, now = Date.now()) {
    const ev = conv.events || []; if (!ev.length) return 'progressing';
    if (ev.some(e => e.final) ) return 'done';
    const tail = ev.slice(-cfg.loopAcks); // only acks/agreement lately = looping
    if (tail.length >= cfg.loopAcks && tail.every(e => e.ack)) return 'looping';
    if (now - ev[ev.length - 1].t > cfg.silenceMs) return 'stalled';
    return 'progressing';
  },
  // Who has been quiet longest: participants (not me) with nothing for silenceMs.
  stuck(conv, cfg, me, now = Date.now()) {
    const last = {}; for (const p of conv.peers || []) last[p] = 0;
    for (const e of conv.events || []) if (e.dir === 'in') last[e.from] = e.t;
    const quiet = Object.keys(last).filter(p => p !== me && now - last[p] > cfg.silenceMs);
    return quiet.length && quiet.length === Object.keys(last).filter(p => p !== me).length ? 'all' : quiet[0] || 'none';
  },
};

const QUESTIONS = {
  ack: { type: 'noul', instructions: 'Is the latest message only an acknowledgement or a repeat of agreement, adding no new information and needing no reply?',
    criteria: { true: 'It just acknowledges, agrees again, or restates what was already said.', false: 'It adds new findings, a new proposal, a first vote, a question, an objection, or an answer.' } },
  stuck: peers => ({ type: 'choice', instructions: 'Who in this conversation is stuck or holding things up and should be nudged right now?',
    criteria: Object.fromEntries([['none', 'No one; work is moving or the conversation is finished.'], ...peers.map(p => [p, `Nudge @${p} only.`]), ['all', 'Everyone; the conversation is stalled.']]) }),
};

// Providers: ask(state, questions) -> Promise<answers>. All share one wire shape:
// request {model?, state, questions}, response {answers: {<q>: {noul|choice|score}}}.
function httpProvider(url, key, model, timeoutMs, extraHeaders = {}) {
  return async (state, questions) => {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}), ...extraHeaders },
        body: JSON.stringify({ ...(model ? { model } : {}), state, questions }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); if (!j || typeof j.answers !== 'object') throw new Error('no answers'); return j.answers;
    } finally { clearTimeout(t); }
  };
}
function commandProvider(cmd, timeoutMs) {
  return async (state, questions) => {
    const r = spawnSync(cmd, { shell: true, input: JSON.stringify({ state, questions }), encoding: 'utf8', timeout: timeoutMs });
    if (r.status !== 0) throw new Error('command exited ' + r.status);
    const j = JSON.parse(r.stdout); if (!j || typeof j.answers !== 'object') throw new Error('no answers'); return j.answers;
  };
}
const ENDPOINTS = { openrouter: 'https://openrouter.ai/api/alpha/decisions', typesafe: 'https://api.typesafe.ai/v1/systemone' };
const MODELS = { openrouter: 'typesafe/jev-1.13', typesafe: 'jev-latest' };
const KEY_ENV = { openrouter: 'OPENROUTER_API_KEY', typesafe: 'TYPESAFE_API_KEY' };

// Build the decider from config (dependency injection: tests and hosts can pass `provider` directly).
function createDecider(dc = {}, cfg, env = process.env, provider = null) {
  const name = env.AGENTRELAY_DECISION || dc.provider || 'rules', timeoutMs = +dc.timeoutMs || 3000;
  if (!provider && name !== 'rules') {
    if (name === 'openrouter' || name === 'typesafe') {
      const key = dc.key || env[KEY_ENV[name]];
      if (key) provider = httpProvider(dc.url || ENDPOINTS[name], key, dc.model || MODELS[name], timeoutMs, name === 'openrouter' ? { 'x-title': 'agentrelay' } : {});
    } else if (name === 'url' && dc.url) provider = httpProvider(dc.url, dc.key, dc.model, timeoutMs);
    else if (name === 'command' && dc.command) provider = commandProvider(dc.command, timeoutMs);
  }
  const used = provider ? name : 'rules';
  const advise = async (state, qs) => { if (!provider) return null; try { return await provider(state, qs); } catch { return null; } };
  return {
    name: used, configured: name, rules,
    // { ack: <hard rule verdict>, advice: <provider's opinion or null> }
    async ack(text, ctx = {}) {
      const hard = rules.isAck(text, cfg);
      const a = await advise({ recent_messages: ctx.recent || [], latest_message: String(text).slice(0, 800) }, { ack: QUESTIONS.ack });
      const n = a && a.ack && typeof a.ack.noul === 'number' ? a.ack.noul : null;
      return { ack: hard, advice: n === null ? null : n >= 0.5 };
    },
    // { state, stuck: <rules>, advice: <provider's pick or null> }
    async conversation(conv, me, now = Date.now()) {
      const state = rules.state(conv, cfg, now), stuck = rules.stuck(conv, cfg, me, now);
      let advice = null;
      if (provider && state !== 'done') {
        const peers = (conv.peers || []).filter(p => p !== me);
        const a = await advise({ participants: peers.map(p => '@' + p), seconds_since_last_message: conv.events && conv.events.length ? Math.round((now - conv.events[conv.events.length - 1].t) / 1000) : null,
          recent_messages: (conv.events || []).slice(-12).map(e => `[${Math.round((now - e.t) / 1000)}s ago] @${e.from}: ${e.preview || ''}`) }, { stuck: QUESTIONS.stuck(peers) });
        const ch = a && a.stuck && a.stuck.choice; if (typeof ch === 'string' && (ch === 'none' || ch === 'all' || peers.includes(ch))) advice = ch;
      }
      return { state, stuck, advice };
    },
  };
}
module.exports = { createDecider, rules, httpProvider, commandProvider, QUESTIONS, ENDPOINTS, MODELS, KEY_ENV };
