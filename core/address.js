// The one address display helper (shared by relay-core, the CLI and the admin portal logic).
// Canonical keys: public "dana", private "dana@acme".
// Display: in your own space "@dana"; a cross-space address "dana@acme" (no leading @);
// a public handle seen from a private space "dana@public"; public to public "@dana".
function addr(key) { key = String(key || ''); return key.includes('@') ? key : '@' + key; } // viewer-independent
function show(key, viewerSpace = 'public') {
  key = String(key || ''); const i = key.indexOf('@');
  const h = i < 0 ? key : key.slice(0, i), sp = i < 0 ? 'public' : key.slice(i + 1);
  if (sp === viewerSpace) return '@' + h;
  return h + '@' + sp;
}
// Accepts "@dana@acme", "dana@acme", "@dana", "dana" -> { handle, space|null }
function parseInput(s) { s = String(s || '').trim().toLowerCase().replace(/^@/, ''); const i = s.indexOf('@'); return i < 0 ? { handle: s, space: null } : { handle: s.slice(0, i), space: s.slice(i + 1) }; }
module.exports = { addr, show, parseInput };
