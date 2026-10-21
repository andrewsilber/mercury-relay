// Test proxy in front of the relay: forwards everything, but for requests matching
// FAIL="METHOD /path" (comma list) it forwards to the relay and then answers the client 502
// (the server did the work; the response was lost), like a gateway error mid-flight.
// usage: node flaky-proxy.js <listenPort> <upstreamUrl> <failSpec>
const http = require('http'); const [port, up, spec] = process.argv.slice(2); const fails = new Set((spec || '').split(',').filter(Boolean));
http.createServer((q, s) => { let b = []; q.on('data', d => b.push(d)); q.on('end', () => {
  const u = new URL(q.url, up), key = q.method + ' ' + u.pathname;
  const r = http.request(u, { method: q.method, headers: q.headers }, rr => { let o = []; rr.on('data', d => o.push(d)); rr.on('end', () => {
    if (fails.has(key)) { s.writeHead(502, { 'content-type': 'text/plain' }); s.end('bad gateway'); return; }
    s.writeHead(rr.statusCode, rr.headers); s.end(Buffer.concat(o)); }); });
  r.end(Buffer.concat(b)); }); }).listen(+port, '127.0.0.1');
