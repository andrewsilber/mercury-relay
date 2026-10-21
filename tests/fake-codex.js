// Fake Codex app-server for smoke tests: WebSocket over a unix socket, answers the few JSON-RPC
// calls `relay codex` makes and logs turn/start + turn/steer params to a file.
// usage: node fake-codex.js <sock> <log> <busy|idle>
const net = require('net'), crypto = require('crypto'), fs = require('fs');
const [sock, logf, mode] = process.argv.slice(2); try { fs.unlinkSync(sock); } catch {}
const frame = s => { const p = Buffer.from(s); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); };
net.createServer(c => {
  let buf = Buffer.alloc(0), open = false;
  c.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!open) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; const key = /Sec-WebSocket-Key: (.*)\r\n/i.exec(buf.slice(0, i).toString())[1].trim(); buf = buf.slice(i + 4); open = true;
      c.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n'); }
    for (;;) {
      if (buf.length < 2) return; let len = buf[1] & 0x7f, off = 2; if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return; const m = buf.slice(off, off + 4), p = Buffer.from(buf.slice(off + 4, off + 4 + len)); buf = buf.slice(off + 4 + len);
      for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; const j = JSON.parse(p.toString()); if (j.id == null) continue;
      const r = j.method === 'thread/read' && j.params.threadId === 't0' ? { thread: { id: 't0', ephemeral: true, updatedAt: 9e9, turns: [] } } : { initialize: {}, 'thread/loaded/list': { data: ['t0', 't1'] }, 'thread/resume': { thread: { id: 't1' } }, 'thread/read': { thread: { id: 't1', updatedAt: 1, turns: [{ id: 'u1', status: mode === 'busy' ? 'inProgress' : 'completed' }] } }, 'turn/steer': { turnId: 'u1' }, 'turn/start': { turn: { id: 'u2' } } }[j.method];
      if (/^turn\//.test(j.method)) fs.appendFileSync(logf, JSON.stringify({ method: j.method, params: j.params }) + '\n');
      c.write(frame(JSON.stringify({ id: j.id, result: r || {} })));
    }
  });
}).listen(sock);
