// End-to-end encryption for agentrelay. Node built-in crypto only.
// Envelope v1: ephemeral X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM; sender signs with Ed25519.
const crypto = require('crypto');
const b64 = b => Buffer.from(b).toString('base64');
const pubDer = k => b64(k.export({ type: 'spki', format: 'der' }));
const privDer = k => b64(k.export({ type: 'pkcs8', format: 'der' }));
const pubKey = s => crypto.createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' });
const privKey = s => crypto.createPrivateKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'pkcs8' });
function genKeys() {
  const x = crypto.generateKeyPairSync('x25519'), e = crypto.generateKeyPairSync('ed25519');
  return { x25519: { pub: pubDer(x.publicKey), priv: privDer(x.privateKey) }, ed25519: { pub: pubDer(e.publicKey), priv: privDer(e.privateKey) } };
}
const publicPart = k => ({ x25519: k.x25519.pub, ed25519: k.ed25519.pub });
const fingerprint = p => crypto.createHash('sha256').update(p.x25519 + '|' + p.ed25519).digest('hex').slice(0, 32).match(/.{4}/g).join(' ');
const kdf = (shared, epk, rpk) => Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(epk + '|' + rpk), 'agentrelay-e2e-v1', 32));
const sigInput = (from, to, e) => Buffer.from(['agentrelay-v1', from, to, e.epk, e.nonce, e.ct].join('|'));
function encrypt(text, from, to, recipPub, senderKeys) {
  const eph = crypto.generateKeyPairSync('x25519'), epk = pubDer(eph.publicKey);
  const key = kdf(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey(recipPub.x25519) }), epk, recipPub.x25519);
  const nonce = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(from + '|' + to));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  const e = { v: 1, epk, nonce: b64(nonce), ct: b64(ct) };
  e.sig = b64(crypto.sign(null, sigInput(from, to, e), privKey(senderKeys.ed25519.priv)));
  return e;
}
// Returns { text, verified }. Throws if decryption fails.
function decrypt(e, from, to, myKeys, senderPub) {
  const verified = !!senderPub && crypto.verify(null, sigInput(from, to, e), pubKey(senderPub.ed25519), Buffer.from(e.sig || '', 'base64'));
  const key = kdf(crypto.diffieHellman({ privateKey: privKey(myKeys.x25519.priv), publicKey: pubKey(e.epk) }), e.epk, myKeys.x25519.pub);
  const raw = Buffer.from(e.ct, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'base64'));
  d.setAAD(Buffer.from(from + '|' + to)); d.setAuthTag(raw.subarray(raw.length - 16));
  return { text: Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'), verified };
}
module.exports = { genKeys, publicPart, fingerprint, encrypt, decrypt };
