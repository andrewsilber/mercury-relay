'use strict';
// Minimal dependency-free WebSocket client (text frames) over a unix socket or TCP, for Codex app-server.
const net = require('net'), crypto = require('crypto'), { EventEmitter } = require('events');
function connect(addr) {
  const ev = new EventEmitter(); let sock, host = 'localhost', pathName = '/';
  if (addr.startsWith('unix://')) sock = net.connect({ path: addr.slice(7) });
  else { const u = new URL(addr.replace(/^ws:/, 'http:')); host = u.host; pathName = u.pathname || '/'; sock = net.connect({ host: u.hostname, port: +u.port }); }
  const key = crypto.randomBytes(16).toString('base64'); let buf = Buffer.alloc(0), open = false, frag = [];
  sock.on('connect', () => sock.write(`GET ${pathName} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  sock.on('error', e => ev.emit('error', e)); sock.on('close', () => ev.emit('close'));
  const send = (op, payload) => {
    const len = payload.length, mask = crypto.randomBytes(4); let hdr;
    if (len < 126) { hdr = Buffer.alloc(2); hdr[1] = 0x80 | len; }
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    hdr[0] = 0x80 | op; const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
    sock.write(Buffer.concat([hdr, mask, p]));
  };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!open) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; const head = buf.slice(0, i).toString(); buf = buf.slice(i + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) { ev.emit('error', new Error('websocket upgrade refused: ' + head.split('\r\n')[0])); sock.destroy(); return; }
      open = true; ev.emit('open'); }
    for (;;) {
      if (buf.length < 2) return; const op = buf[0] & 0x0f, fin = buf[0] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf[1] & 0x80) off += 4; if (buf.length < off + len) return;
      const p = buf.slice(off, off + len); buf = buf.slice(off + len);
      if (op === 9) send(10, p); else if (op === 8) { sock.end(); } else if (op === 1 || op === 2 || op === 0) { frag.push(p); if (fin) { ev.emit('message', Buffer.concat(frag).toString('utf8')); frag = []; } }
    }
  });
  ev.send = s => send(1, Buffer.from(s)); ev.close = () => { try { send(8, Buffer.alloc(0)); } catch {} sock.end(); };
  return ev;
}
module.exports = { connect };
