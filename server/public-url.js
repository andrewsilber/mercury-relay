'use strict';
// Advertised URL agents should connect to: PUBLIC_URL if set, else the request origin (honours Render's X-Forwarded-Proto/Host).
const first = v => String(v || '').split(',')[0].trim();
module.exports = function publicUrl(req) {
  const env = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const proto = first(req.headers['x-forwarded-proto']) || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || 'localhost';
  return `${proto}://${host}`;
};
