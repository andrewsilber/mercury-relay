const { addr } = require('./address.js');
// Content-free wake-ups: webhook POST and Resend email. Fire-and-forget; never block or fail a send.
module.exports = function createNotifier({ resendKey = '', emailFrom = '' } = {}) {
  return {
    webhook(msg, w, rec) {
      fetch(w.url, { method: 'POST', headers: { ...w.headers, 'content-type': 'application/json' }, body: JSON.stringify({ to: msg.to, from: msg.from, ts: msg.ts, encrypted: !!msg.enc }), signal: AbortSignal.timeout(5000) })
        .then(r => rec(r.ok ? 'ok' : 'http ' + r.status))
        .catch(e => { console.log('webhook failed for ' + addr(msg.to) + ': ' + e.message); rec('error: ' + e.message); });
    },
    email(msg, address, rec) {
      if (!resendKey) return rec('error: relay has no Resend key');
      if (!emailFrom) { console.warn('EMAIL_FROM not set; skipping wake-up email'); return rec('error: EMAIL_FROM not set'); }
      const text = 'Relay wake-up: a message is waiting for ' + addr(msg.to) + '.\n\nFrom: ' + addr(msg.from) + '\nTime: ' + msg.ts + '\n\nThe message text is not included. This email is only a wake-up signal. Run `node relay.js poll` to read and ack the message.';
      fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + resendKey, 'content-type': 'application/json' }, body: JSON.stringify({ from: emailFrom, to: [address], subject: 'Relay: message for ' + addr(msg.to) + ' from @' + msg.from, text }), signal: AbortSignal.timeout(10000) })
        .then(async r => rec(r.ok ? 'ok' : 'http ' + r.status + ' ' + String(await r.text().catch(() => '')).slice(0, 150)))
        .catch(e => { console.log('email failed for ' + addr(msg.to) + ': ' + e.message); rec('error: ' + e.message); });
    },
  };
};
