#!/usr/bin/env bash
# Smoke test: local server on a temp port, two handles, send, poll, verify.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; PORT=$((20000 + RANDOM % 20000)); URL="http://127.0.0.1:$PORT"
export HOME="$TMP/home"; mkdir -p "$HOME"
unset MERCURY_RELAY_CONFIG MERCURY_RELAY_HANDLE MERCURY_RELAY_URL AGENTRELAY_CONFIG AGENTRELAY_HANDLE AGENTRELAY_URL RESEND_API_KEY
(cd "$TMP" && ADMIN_PASSWORD=smoke-admin-pw PORT=$PORT DATA_FILE="$TMP/data.json" node "$ROOT/server.js" >"$TMP/server.log" 2>&1) & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 50); do curl -sf "$URL/health" >/dev/null && break; sleep 0.1; done
R="node $ROOT/relay.js"
$R init smoke-a --url "$URL" >/dev/null
$R init smoke-b --url "$URL" >/dev/null
MSG="hello from a $RANDOM"
$R --as smoke-a send smoke-b "$MSG" >/dev/null
OUT="$($R --as smoke-b poll)"
echo "$OUT" | grep -qF "from @smoke-a" && echo "$OUT" | grep -qF "$MSG" || { echo "FAIL: poll got: $OUT"; exit 1; }
OUT2="$($R --as smoke-b poll)"
echo "$OUT2" | grep -q "no new messages" || { echo "FAIL: message not acked: $OUT2"; exit 1; }
# wait (long-poll) path
( sleep 1; $R --as smoke-b send smoke-a "pong" >/dev/null ) &
OUT3="$(timeout 20 $R --as smoke-a wait)"
echo "$OUT3" | grep -qF "pong" || { echo "FAIL: wait got: $OUT3"; exit 1; }
echo "PASS: register, send, poll, ack, wait"
# --- admin ---
fail() { echo "FAIL: $*"; exit 1; }
curl -s "$URL/admin" | grep -q "Relay admin" || fail "admin page not served"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/admin/api/state")" = 401 ] || fail "state without login not 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{"password":"nope"}' "$URL/admin/api/login")" = 401 ] || fail "wrong password accepted"
SC="$(curl -s -D - -o /dev/null -X POST -d '{"password":"smoke-admin-pw"}' "$URL/admin/api/login" | tr -d '\r' | grep -i '^set-cookie:')"
echo "$SC" | grep -q HttpOnly && echo "$SC" | grep -q Secure && echo "$SC" | grep -q SameSite=Strict || fail "cookie flags: $SC"
CK="$(echo "$SC" | grep -o 'admin_session=[a-f0-9]*')"
A() { curl -s -H "Cookie: $CK" -H 'x-admin: 1' -H 'content-type: application/json' "$@"; }
A "$URL/admin/api/state" | grep -q '"handle":"smoke-a"' || fail "state lacks handles"
A "$URL/admin/api/messages" | grep -q '"from":"smoke-a"' || fail "message log empty"
A "$URL/admin/api/messages" | grep -qF "$MSG" && fail "message text shown without toggle"
A -X POST -d '{"suspended":true}' "$URL/admin/api/settings" | grep -q '"suspended":true' || fail "suspend"
OUT="$($R --as smoke-a send smoke-b "while suspended" 2>&1 || true)"
echo "$OUT" | grep -q "relay suspended by admin" || fail "send while suspended: $OUT"
A -X POST -d '{"suspended":false}' "$URL/admin/api/settings" | grep -q '"suspended":false' || fail "resume"
$R --as smoke-a send smoke-b "after resume" >/dev/null || fail "send after resume"
$R --as smoke-b poll | grep -q "after resume" || fail "poll after resume"
A -X POST -d '{"status":"blocked"}' "$URL/admin/api/handles/smoke-b/status" | grep -q '"status":"blocked"' || fail "block"
OUT="$($R --as smoke-b send smoke-a "blocked?" 2>&1 || true)"; echo "$OUT" | grep -q "blocked by admin" || fail "blocked send: $OUT"
OUT="$($R --as smoke-a send smoke-b "to blocked" 2>&1 || true)"; echo "$OUT" | grep -q "recipient blocked" || fail "send to blocked: $OUT"
A -X POST -d '{"sendPerMinute":1}' "$URL/admin/api/settings" >/dev/null
$R init smoke-c --url "$URL" >/dev/null
$R --as smoke-c send smoke-a "c 1" >/dev/null || fail "first rate-limited send"
OUT="$($R --as smoke-c send smoke-a "c 2" 2>&1 || true)"; echo "$OUT" | grep -q "rate limit" || fail "rate limit: $OUT"
A -X DELETE "$URL/admin/api/handles/smoke-b" | grep -q '"deleted":"smoke-b"' || fail "delete"
A "$URL/admin/api/state" | grep -q '"handle":"smoke-b"' && fail "handle still listed after delete"
grep -q '"suspended":false' "$TMP/data.json" && grep -q '"sendPerMinute":1' "$TMP/data.json" || fail "settings not persisted"
echo "PASS: admin login, message log, suspend/resume, block, rate limit, delete, persistence"
