#!/usr/bin/env node
// Load test: starts a LOCAL relay (temp data file, no Resend key) and measures registration,
// encrypted send+poll throughput with idle long-pollers, data file growth and server CPU/RSS.
// Never touches the live relay. Usage: node tests/loadtest.js [--quick]
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const e2e = require('../cli/e2e.js');
const QUICK = process.argv.includes('--quick');
const STAGES = QUICK ? [100, 1000] : [100, 1000, 5000, 10000];
const CONC = QUICK ? [1, 10, 50] : [1, 5, 10, 25, 50, 100];
const POLLERS = QUICK ? [100] : [100, 1000];
const PHASE_MS = QUICK ? 3000 : 6000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-load-')), DATA = path.join(TMP, 'data.json');
const PORT = 30000 + Math.floor(Math.random() * 20000);
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
function req(method, p, body, token) {
  return new Promise((resolve) => {
    const t0 = performance.now(), b = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, agent, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(b ? { 'content-length': Buffer.byteLength(b) } : {}) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ ok: res.statusCode < 300, code: res.statusCode, j, ms: performance.now() - t0 }); });
    });
    r.on('error', e => resolve({ ok: false, code: 0, j: { error: e.message }, ms: performance.now() - t0 }));
    r.setTimeout(130000, () => r.destroy(new Error('timeout')));
    if (b) r.write(b); r.end();
  });
}
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f1 = x => Math.round(x * 10) / 10;
let srv, clk = os.constants ? 100 : 100; // USER_HZ
function procStat() { try { const s = fs.readFileSync(`/proc/${srv.pid}/stat`, 'utf8').split(') ')[1].split(' '); const rss = +fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]; return { cpu: (+s[11] + +s[12]) / clk, rssMB: rss / 1024 }; } catch { return { cpu: 0, rssMB: 0 }; } }
async function measure(fn) { const a = procStat(), t = performance.now(); const r = await fn(); const b = procStat(), wall = (performance.now() - t) / 1000; return { ...r, wall, cpuPct: f1((b.cpu - a.cpu) / wall * 100), rssMB: f1(b.rssMB) }; }
function writeCost() { // time to serialize + write the current data file (what save() does on every mutation)
  const d = JSON.parse(fs.readFileSync(DATA, 'utf8')), f = path.join(TMP, 'probe.json'); const t = performance.now();
  for (let i = 0; i < 5; i++) { fs.writeFileSync(f + '.tmp', JSON.stringify(d)); fs.renameSync(f + '.tmp', f); }
  return f1((performance.now() - t) / 5);
}
async function pool(n, conc, fn) { let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < n) await fn(i++); })); }
const users = [];
async function register(target) {
  const start = users.length, lat = []; let err = 0;
  const r = await measure(() => pool(target - start, 50, async () => {
    const h = 'u' + users.length.toString(36) + Math.random().toString(36).slice(2, 6), keys = e2e.genKeys();
    const a = await req('POST', '/register', { handle: h }); lat.push(a.ms); if (!a.ok) { if (!err) console.error('register error', a.code, JSON.stringify(a.j)); return err++; }
    const b = await req('POST', '/keys', e2e.publicPart(keys), a.j.token); lat.push(b.ms); if (!b.ok) err++;
    users.push({ h, token: a.j.token, keys, pub: e2e.publicPart(keys) });
  }));
  await new Promise(r => setTimeout(r, 400)); // let the batched save land
  return { handles: target, perSec: f1((target - start) / r.wall), p50: f1(pct(lat, 50)), p95: f1(pct(lat, 95)), errors: err, fileMB: f1(fs.statSync(DATA).size / 1e6), writeMs: writeCost(), cpuPct: r.cpuPct, rssMB: r.rssMB };
}
async function throughput(conc, nPollers) {
  const pollers = users.slice(0, nPollers); let stop = false; const live = [];
  for (const p of pollers) live.push((async () => { while (!stop) await req('GET', `/poll?handle=${p.h}&timeout=60`, null, p.token); })());
  await new Promise(r => setTimeout(r, 1500)); // let long-polls park
  const workers = users.slice(nPollers); const sl = [], pl = []; let n = 0, err = 0;
  const r = await measure(async () => {
    const end = Date.now() + PHASE_MS;
    await Promise.all(Array.from({ length: conc }, async (_, w) => {
      while (Date.now() < end) {
        const a = workers[Math.floor(Math.random() * workers.length)], b = workers[Math.floor(Math.random() * workers.length)];
        const s = await req('POST', '/send', { to: b.h, enc: e2e.encrypt('load test message ' + n, a.h, b.h, b.pub, a.keys) }, a.token); sl.push(s.ms); if (!s.ok) { err++; continue; }
        const p = await req('GET', `/poll?handle=${b.h}&timeout=0`, null, b.token); pl.push(p.ms); if (!p.ok) { err++; continue; }
        const ids = (p.j.messages || []).map(m => m.id); if (ids.length) { const k = await req('POST', '/ack', { ids }, b.token); if (!k.ok) err++; }
        n++;
      }
    }));
  });
  stop = true;
  return { conc, pollers: nPollers, msgsPerSec: f1(n / r.wall), sendP50: f1(pct(sl, 50)), sendP95: f1(pct(sl, 95)), sendP99: f1(pct(sl, 99)), pollP95: f1(pct(pl, 95)), errRate: f1(err / Math.max(1, n + err) * 100), cpuPct: r.cpuPct, rssMB: r.rssMB, _live: live };
}
(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE: DATA }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if ((await req('GET', '/health')).ok) break; await new Promise(r => setTimeout(r, 100)); }
  if (!(await req('GET', '/health')).ok) { console.error('local relay did not start (port in use?); rerun'); srv.kill(); process.exit(1); }
  console.log(`box: ${os.cpus().length} vCPU (${os.cpus()[0].model}), ${Math.round(os.totalmem() / 1e9)} GB RAM, node ${process.version}; relay pid ${srv.pid} on 127.0.0.1:${PORT}`);
  const lingering = [];
  for (const N of STAGES) {
    const g = await register(N); console.log('REGISTER', JSON.stringify(g));
    if (N < 1000 && !QUICK) continue;
    for (const M of POLLERS) {
      if (M >= N) continue;
      for (const c of CONC) {
        const t = await throughput(c, M); lingering.push(...t._live); delete t._live;
        console.log('THROUGHPUT', JSON.stringify({ handles: N, ...t }));
        if (t.sendP95 > 2000 || t.errRate > 20) break; // far past degradation; skip higher concurrency
      }
    }
  }
  console.log('final data file', f1(fs.statSync(DATA).size / 1e6), 'MB; write cost', writeCost(), 'ms');
  srv.kill(); agent.destroy(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(0);
})();
