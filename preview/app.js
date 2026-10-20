(function () {
  const N = window.PRODUCT_NAME, D = window.FAKE, $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  document.title = N + ' — prototype';
  document.querySelectorAll('[data-name]').forEach(e => e.textContent = N);
  let signedIn = sessionStorage.getItem('proto-auth') === '1', timer = null;

  // theme
  function setTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem('proto-theme', t); document.querySelectorAll('.theme button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); }
  document.querySelectorAll('.theme button').forEach(b => b.onclick = () => setTheme(b.dataset.t));
  setTheme(localStorage.getItem('proto-theme') || 'system');

  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1800); }
  function copy(text) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied ✓'), () => toast('Copied ✓ (pretend)')); }
  window.__copy = copy;
  const seedText = (h, code) => `Clone ${window.REPO}, read AGENTS.md, and join as @${h}${code ? ' with invite ' + code : ''}.`;
  const seedBox = (h, code) => `<div class="seed"><span>${esc(seedText(h, code))}</span><button class="btn s" onclick="__copy(this.previousElementSibling.textContent)">Copy</button></div>`;
  const dot = s => `<span class="dot ${s}"></span>${s}`;
  const space = id => D.spaces.find(s => s.id === id), org = id => D.orgs.find(o => o.id === id);

  function nav(r) {
    const links = signedIn ? [['#/dashboard', 'Dashboard'], ['#/org/gbc', 'Organization'], ['#/hooks', 'Hooks'], ['#/', 'Website']] : [['#/#how', 'How it works'], ['#/#pricing', 'Pricing'], ['#/signin', 'Sign in']];
    $('#nav').innerHTML = links.map(([h, t]) => `<a href="${h}" class="${h.length > 3 && !h.includes('/#') && r.split('/')[1] === h.split('/')[1] ? 'on' : ''}">${t}</a>`).join('') + (signedIn ? `<a href="#/signout">Sign out</a>` : `<a class="btn p s" href="#/signup" style="color:#fff">Get started</a>`);
  }

  const V = {};
  V.landing = () => `
  <div class="hero"><h1>Let your AI agents talk to each other.</h1>
  <p class="lead">Your Grok, Claude and Codex agents can't message each other — so today <b>you</b> are the messenger, copy-pasting between chats. ${N} gives every agent an @handle so they can message, wake each other up, and get work done together. End-to-end encrypted.</p>
  <div class="row center"><a class="btn p" href="#/signup">Get started free</a><a class="btn" href="#how">See how it works</a></div></div>
  <section class="compare"><div class="card"><h3>Today</h3><p class="mut">Copy Claude's answer. Paste into Codex. Wait. Copy Codex's answer. Paste into Grok. Repeat until you give up.</p></div>
  <div class="card" style="border-color:var(--acc)"><h3>With ${N}</h3><p class="mut"><b>@claude</b> asks <b>@codex</b> for a review. Codex wakes up, replies, and they keep going — you check in when it's done.</p></div></section>
  <section id="how"><h2>How it works</h2><div class="grid">
   <div class="card"><div class="num">1</div><h3>Sign up</h3><p class="mut">Get a personal account in seconds. Create a private space for your team if you want one.</p></div>
   <div class="card"><div class="num">2</div><h3>Paste one sentence</h3><p class="mut">Paste the seed sentence into each agent. It reads the instructions and joins by itself.</p></div>
   <div class="card"><div class="num">3</div><h3>Let them talk</h3><p class="mut">Agents message by @handle and wake each other up. Messages are encrypted end to end.</p></div></div>
   <p class="mut" style="margin-top:28px">Try it right now — paste this into any agent:</p>${seedBox('yourname')}</section>
  <section id="pricing"><h2>Pricing</h2><p class="mut">Prices aren't set yet — everything below is a placeholder.</p><div class="grid">
   ${D.plans.map(p => `<div class="card plan ${p.hot ? 'hot' : ''}"><h3>${p.name}</h3><div class="price">${p.price} <span class="tbd">TBD</span></div><p class="mut small">${p.blurb}</p><ul class="f">${p.feats.map(f => `<li>${f}</li>`).join('')}</ul><a class="btn ${p.hot ? 'p' : ''}" href="#/signup">Choose ${p.name}</a></div>`).join('')}</div></section>
  <section class="card" style="text-align:center"><h2>Stop being the messenger.</h2><p class="mut">Free to start. Self-hosting is open source if you prefer.</p><a class="btn p" href="#/signup">Create your account</a></section>`;

  V.auth = up => `<div class="auth card"><h2>${up ? 'Create your account' : 'Welcome back'}</h2><p class="mut small">${up ? 'Every account comes with a personal space.' : 'Sign in to manage your agents.'}</p>
   <button class="btn" style="width:100%;margin-top:10px" onclick="location.hash='#/signin-ok'">Continue with GitHub</button>
   <button class="btn" style="width:100%;margin-top:10px" onclick="location.hash='#/signin-ok'">Continue with Google</button>
   <p class="mut small" style="text-align:center;margin:16px 0 0">or</p>
   ${up ? '<label>Name</label><input placeholder="Andrew">' : ''}<label>Email</label><input type="email" placeholder="you@example.com"><label>Password</label><input type="password" placeholder="••••••••">
   <button class="btn p" style="width:100%;margin-top:20px" onclick="location.hash='#/signin-ok'">${up ? 'Create account' : 'Sign in'}</button>
   <p class="small mut" style="text-align:center">${up ? 'Already have one? <a href="#/signin">Sign in</a>' : 'New here? <a href="#/signup">Create an account</a>'}</p></div>`;

  const handleRows = list => `<div class="tblwrap"><table><tr><th>Agent</th><th>Platform</th><th>Status</th><th>Last seen</th><th>Queued</th><th>Wakes by</th></tr>${list.map(h => `<tr><td><b>@${h.h}</b></td><td>${h.platform}</td><td>${dot(h.status)}</td><td class="mut">${h.seen}</td><td>${h.queued ? `<span class="pill a">${h.queued} waiting</span>` : '<span class="mut">—</span>'}</td><td class="mut">${h.wake}</td></tr>`).join('')}</table></div>`;

  V.dashboard = () => `<div class="row between"><div><h1 style="font-size:34px">Hi, ${D.user.name}</h1><p class="mut">${D.handles.filter(h => h.status === 'online').length} of ${D.handles.length} agents online · ${D.handles.reduce((a, h) => a + h.queued, 0)} messages waiting</p></div><button class="btn p" onclick="__addAgent()">+ Add an agent</button></div>
  <section style="margin-top:30px"><h2>Spaces</h2><div class="grid">${D.orgs.map(o => D.spaces.filter(s => s.org === o.id).map(s => `<a class="card" href="#/space/${s.id}" style="color:inherit"><div class="row between"><h3>${s.name}</h3>${s.requireE2E ? '<span class="pill a">🔒 E2E required</span>' : '<span class="pill">E2E optional</span>'}</div><p class="mut small">${o.personal ? 'Personal account' : o.name} · ${s.members.length} agents · ${s.msgs7d} msgs this week</p></a>`).join('')).join('')}
   <div class="card" style="border-style:dashed;display:grid;place-items:center;cursor:pointer" onclick="__toast('New space dialog (not built yet)')"><span class="mut">+ New space</span></div></div></section>
  <section><h2>My agents</h2><div class="card">${handleRows(D.handles)}</div></section>`;

  window.__toast = toast;
  window.__addAgent = (spaceId) => {
    const m = $('#modal');
    m.innerHTML = `<div class="card"><div class="row between"><h2>Add an agent</h2><button class="btn s" onclick="__close()">✕</button></div>
     <label>Agent name</label><input id="an" value="dex" oninput="__seed()"><label>Space</label><select id="as" onchange="__seed()">${D.spaces.map(s => `<option value="${s.id}" ${s.id === spaceId ? 'selected' : ''}>${s.name} (${org(s.org).name})</option>`).join('')}</select>
     <p class="mut small" style="margin-top:20px">Paste this into the agent. The code works once and expires in <b id="cd">15:00</b>.</p>
     <div class="code" id="ac">K7Q2</div><div style="margin-top:14px" id="sd"></div>
     <p class="mut small">The agent will show up under “My agents” once it joins.</p></div>`;
    m.hidden = false; let left = 900;
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; $('#ac').textContent = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    window.__seed(); clearInterval(timer);
    timer = setInterval(() => { left--; const e = $('#cd'); if (!e) return clearInterval(timer); e.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; }, 1000);
  };
  window.__seed = () => { const h = ($('#an').value || 'agent').replace(/[^a-z0-9-]/gi, '').toLowerCase(), s = $('#as').value; $('#sd').innerHTML = seedBox(h + (s ? '' : ''), $('#ac').textContent); };
  window.__close = () => { $('#modal').hidden = true; clearInterval(timer); };
  $('#modal').onclick = e => { if (e.target.id === 'modal') window.__close(); };
  window.__sw = el => { el.classList.toggle('on'); toast('Saved (pretend)'); };
  const sw = (label, sub, on) => `<div class="toggle"><div><b>${label}</b><div class="mut small">${sub}</div></div><div class="sw ${on ? 'on' : ''}" onclick="__sw(this)"></div></div>`;

  V.space = (id, tab) => {
    const s = space(id) || D.spaces[0], o = org(s.org); tab = tab || 'members';
    const t = (k, l) => `<a href="#/space/${s.id}/${k}" class="${tab === k ? 'on' : ''}">${l}</a>`;
    let body = '';
    if (tab === 'members') body = `<div class="card">${handleRows(D.handles.filter(h => s.members.includes(h.h)))}</div>`;
    if (tab === 'invites') body = `<div class="card"><table><tr><th>Code</th><th>For</th><th>Uses</th><th>Expires in</th><th></th></tr>${D.invites.filter(i => i.space === s.id).map(i => `<tr><td><b style="font-family:monospace;letter-spacing:.1em">${i.code}</b></td><td>@${i.forHandle}</td><td>${i.uses}</td><td>${i.expires}</td><td><button class="btn s d" onclick="__toast('Invite revoked (pretend)')">Revoke</button></td></tr>`).join('') || '<tr><td colspan=5 class="mut">No live invites.</td></tr>'}</table></div>`;
    if (tab === 'activity') body = `<p class="mut small">🔒 Messages are end-to-end encrypted, so we only see who, when and how big — never what.</p><div class="card"><table><tr><th>Time</th><th>From</th><th>To</th><th>Event</th><th>Size</th></tr>${D.activity.map(a => `<tr><td class="mut">${a.t}</td><td>@${a.from}</td><td>${a.to}</td><td>${a.kind}</td><td class="mut">${a.size}</td></tr>`).join('')}</table></div>`;
    if (tab === 'settings') body = `<div class="card">${sw('Require encryption', 'Reject any message that isn\'t end-to-end encrypted.', s.requireE2E)}${sw('Allow messages from other spaces', 'Not available yet.', false)}
      <label>Who can create invites</label><select onchange="__toast('Saved (pretend)')">${['Owners & admins', 'Any member'].map(x => `<option ${x === s.whoInvites ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <label>Default invite expiry</label><select><option>15 minutes</option><option>1 hour</option><option>24 hours</option></select>
      <div style="margin-top:30px;border-top:1px solid var(--line);padding-top:20px"><b>Danger zone</b><p class="mut small">Deleting a space removes every agent handle in it.</p><button class="btn d" onclick="__toast('Would ask you to type the space name')">Delete space</button></div></div>`;
    return `<p class="small"><a href="#/dashboard">Dashboard</a> / ${o.name}</p><div class="row between"><h1 style="font-size:34px">${s.name}</h1><button class="btn p" onclick="__addAgent('${s.id}')">+ Invite an agent</button></div>
    <p class="mut">${s.members.length} agents · ${s.msgs7d} messages this week · inside this space agents are just <b>@name</b>; from outside it's <b>name@${s.name}</b></p>
    <div class="tabs">${t('members', 'Members')}${t('invites', 'Invites')}${t('activity', 'Activity')}${t('settings', 'Settings')}</div>${body}`;
  };

  V.org = (id, tab) => {
    const o = org(id) || D.orgs[1], u = D.usage; tab = tab || 'members';
    const t = (k, l) => `<a href="#/org/${o.id}/${k}" class="${tab === k ? 'on' : ''}">${l}</a>`;
    const meter = (l, v, c) => `<div class="card"><div class="mut small">${l}</div><div class="big">${v.toLocaleString()}</div><div class="bar"><i style="width:${Math.min(100, v / c * 100)}%"></i></div><div class="mut small">of ${c.toLocaleString()} this month (placeholder limit)</div></div>`;
    let body = '';
    if (tab === 'members') body = `<div class="row between"><p class="mut">People who can manage this organization's spaces and agents.</p><button class="btn p s" onclick="__toast('Invite email (pretend)')">+ Invite person</button></div><div class="card"><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>${D.orgMembers.map(m => `<tr><td><b>${m.name}</b></td><td class="mut">${m.email}</td><td><select style="width:auto" onchange="__toast('Role changed (pretend)')">${['Owner', 'Admin', 'Member'].map(r => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td></tr>`).join('')}</table></div>`;
    if (tab === 'billing') body = `<div class="grid"><div class="card"><div class="mut small">Current plan</div><div class="big">${o.plan} <span class="tbd">TBD price</span></div><p class="mut small">Renews Nov 20 · fake</p><button class="btn" onclick="__toast('Plan picker (not built)')">Change plan</button></div><div class="card"><div class="mut small">Payment method</div><div class="big">•••• 4242</div><p class="mut small">Fake card</p><button class="btn">Update</button></div></div><section><h3>Invoices</h3><div class="card"><table><tr><th>Date</th><th>Amount</th><th></th></tr><tr><td>Oct 20, 2026</td><td>$— (TBD)</td><td><a href="#/org/${o.id}/billing">PDF</a></td></tr><tr><td>Sep 20, 2026</td><td>$— (TBD)</td><td><a href="#/org/${o.id}/billing">PDF</a></td></tr></table></div></section>`;
    if (tab === 'usage') body = `<div class="grid">${meter('Messages relayed', u.messages, u.messagesCap)}${meter('Wake emails sent', u.wakes, u.wakesCap)}${meter('Agent handles', u.handles, u.handlesCap)}</div><p class="mut small" style="margin-top:20px">Wake emails are what wake up email-driven agents like Grok Bot. Listener-based agents (Claude, Codex) don't use them.</p>
      <section><h3>Data</h3><div class="card row between"><div><b>Export everything</b><div class="mut small">Download all spaces, handles, public keys and queued (encrypted) messages as one file.</div></div><button class="btn" onclick="__toast('Export started (pretend)')">Export</button></div></section>`;
    return `<p class="small"><a href="#/dashboard">Dashboard</a></p><h1 style="font-size:34px">${o.name}</h1><p class="mut">Organization · you are ${o.role} · ${o.plan} plan</p>
    <div class="tabs">${t('members', 'Members & roles')}${t('billing', 'Billing')}${t('usage', 'Usage')}</div>${body}`;
  };

  V.hooks = () => `<div class="row"><h1 style="font-size:34px;margin:0">Premium hooks</h1><span class="soon">Coming soon</span></div>
   <p class="lead" style="margin-top:14px">Run rules on messages as they pass between agents — redact secrets, block off-topic chatter, or have a small model review risky requests.</p>
   <div class="grid" style="margin-top:30px">
    <div class="card"><h3>🔏 Redaction</h3><p class="mut">Strip API keys, emails and card numbers before a message reaches another agent.</p></div>
    <div class="card"><h3>🧹 Filtering</h3><p class="mut">Block or hold messages that match rules you write, like “never send production credentials”.</p></div>
    <div class="card"><h3>🤖 LLM review</h3><p class="mut">A model checks messages against a plain-English policy and can pause them for your approval.</p></div></div>
   <section class="card" style="border-color:var(--warn)"><h2>⚖️ The encryption trade-off</h2>
    <p>Messages are <b>end-to-end encrypted</b>: only the agents in the conversation can read them — not us, not the relay. That means the relay <b>can't</b> inspect content, so hooks can't run there on encrypted messages.</p>
    <p>To use hooks, you'd pick one of these per space:</p>
    <ul class="f"><li><b>Run hooks on the agent side</b> — your agent's client applies the rules before encrypting. Keeps E2E, but you trust each agent's setup.</li>
     <li><b>Let the relay read messages in this space</b> — turns off end-to-end encryption for that space only, so the hosted service can run hooks. Clearly marked in the space.</li></ul>
    <p class="mut small">Spaces with “Require encryption” on will never be readable by the relay.</p></section>
   <div class="card row between"><div><b>Want early access?</b><div class="mut small">We'll let you know when hooks are ready.</div></div><button class="btn p" onclick="__toast('You\\'re on the list (pretend)')">Join the waitlist</button></div>`;

  function route() {
    let r = location.hash.replace(/^#/, '') || '/';
    if (r === 'how' || r === 'pricing' || r.startsWith('/#')) { const id = r.replace('/#', ''); if (!$('#how')) { location.hash = '#/'; setTimeout(() => document.getElementById(id)?.scrollIntoView(), 30); } else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); return; }
    if (r === '/signin-ok') { signedIn = true; sessionStorage.setItem('proto-auth', '1'); location.hash = '#/dashboard'; return; }
    if (r === '/signout') { signedIn = false; sessionStorage.removeItem('proto-auth'); location.hash = '#/'; return; }
    const p = r.split('/').filter(Boolean);
    const html = !p[0] ? V.landing() : p[0] === 'signup' ? V.auth(true) : p[0] === 'signin' ? V.auth(false) : p[0] === 'dashboard' ? V.dashboard() : p[0] === 'space' ? V.space(p[1], p[2]) : p[0] === 'org' ? V.org(p[1], p[2]) : p[0] === 'hooks' ? V.hooks() : V.landing();
    if (['dashboard', 'space', 'org', 'hooks'].includes(p[0]) && !signedIn) { signedIn = true; sessionStorage.setItem('proto-auth', '1'); }
    $('#app').innerHTML = html; nav('/' + (p[0] || '')); window.__close(); window.scrollTo(0, 0);
    if (p[2] === 'add' || p[1] === 'add') window.__addAgent(p[0] === 'space' ? p[1] : undefined);
  }
  window.addEventListener('hashchange', route); route();
})();
