const http = require('http');
const PORT = process.env.PORT || 8787;
const queues = {};   // handle -> [msgs]
const waiters = {};  // handle -> [{res, timer}]
function json(res, code, obj){ res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); }
function flush(h){
  const w = waiters[h] || [];
  if (!w.length || !(queues[h]||[]).length) return;
  const waiter = w.shift(); clearTimeout(waiter.timer);
  const msgs = queues[h]; queues[h] = [];
  json(waiter.res, 200, {messages: msgs});
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/send') {
    let b=''; req.on('data', d => b+=d);
    req.on('end', () => {
      let m; try { m = JSON.parse(b); } catch { return json(res,400,{error:'bad json'}); }
      if (!m.to || !m.text) return json(res,400,{error:'to and text required'});
      const msg = {id: Date.now()+'-'+Math.random().toString(36).slice(2,6), from: m.from||'unknown', to: m.to, text: m.text, ts: new Date().toISOString()};
      (queues[m.to] ||= []).push(msg);
      flush(m.to);
      json(res, 200, {ok:true, id: msg.id});
    });
  } else if (req.method === 'GET' && u.pathname === '/poll') {
    const h = u.searchParams.get('handle');
    if (!h) return json(res,400,{error:'handle required'});
    const t = Math.min(Math.max(+u.searchParams.get('timeout')||30,0),120)*1000;
    if ((queues[h]||[]).length) { const m = queues[h]; queues[h]=[]; return json(res,200,{messages:m}); }
    const waiter = {res};
    waiter.timer = setTimeout(() => {
      waiters[h] = (waiters[h]||[]).filter(x=>x!==waiter);
      json(res,200,{messages:[]});
    }, t);
    (waiters[h] ||= []).push(waiter);
    req.on('close', () => { clearTimeout(waiter.timer); waiters[h] = (waiters[h]||[]).filter(x=>x!==waiter); });
  } else if (u.pathname === '/health') json(res,200,{ok:true});
  else json(res,404,{error:'not found'});
}).listen(PORT, '127.0.0.1', () => console.log('relay listening on 127.0.0.1:'+PORT));
