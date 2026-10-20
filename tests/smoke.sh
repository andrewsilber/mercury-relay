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
# Wrapper logs all CLI output so we can check address formatting at the end.
printf '#!/usr/bin/env bash\nnode "%s/relay.js" "$@" 2>&1 | tee -a "%s/cli-output.log"; exit ${PIPESTATUS[0]}\n' "$ROOT" "$TMP" > "$TMP/r.sh"; chmod +x "$TMP/r.sh"
R="$TMP/r.sh"
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
# --- end-to-end encryption ---
efail() { echo "FAIL: $*"; exit 1; }
SECRET="e2e secret $RANDOM$RANDOM"
SO="$($R --as smoke-a send smoke-b "$SECRET")"; echo "$SO" | grep -q "end-to-end encrypted" || efail "send not encrypted: $SO"
sleep 0.5; grep -qF "$SECRET" "$TMP/data.json" && efail "plaintext found in relay data file"
grep -q '"priv"' "$TMP/data.json" && efail "private key on relay"
curl -sf "$URL/keys/smoke-a" | grep -q '"ed25519"' || efail "GET /keys"
OUT="$($R --as smoke-b poll)"; echo "$OUT" | grep -qF "$SECRET" || efail "decrypt: $OUT"
echo "$OUT" | grep -qE "NOT VERIFIED|UNENCRYPTED|COULD NOT" && efail "verify: $OUT"
# legacy handle without keys: plaintext still delivered, flagged
TOK="$(curl -s -X POST -d '{"handle":"smoke-old"}' "$URL/register" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')"
curl -s -H "authorization: Bearer $TOK" -d '{"to":"smoke-a","text":"legacy hi"}' "$URL/send" | grep -q '"ok":true' || efail "legacy plaintext send"
$R --as smoke-a poll | grep -q "UNENCRYPTED.*legacy hi" || efail "plaintext not flagged"
# tampered signature -> not verified (forged sender)
cp "$HOME/.mercury-relay/smoke-a.json" "$TMP/a.bak"
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.keys.ed25519=require("'"$ROOT"'/cli/e2e.js").genKeys().ed25519;require("fs").writeFileSync(f,JSON.stringify(c))' "$HOME/.mercury-relay/smoke-a.json"
$R --as smoke-a send smoke-b "forged" >/dev/null
$R --as smoke-b poll | grep -q "SENDER NOT VERIFIED" || efail "forged signature accepted"
cp "$TMP/a.bak" "$HOME/.mercury-relay/smoke-a.json"
# group send + reply-all
$R init smoke-g --url "$URL" >/dev/null
GO="$($R --as smoke-a send @smoke-b,smoke-g "group hi")"; [ "$(echo "$GO" | grep -c 'end-to-end encrypted')" = 2 ] || efail "group send: $GO"
$R --as smoke-g poll | grep -q "from @smoke-a to you + @smoke-b .*group hi" || efail "group poll lacks cc"
$R --as smoke-b poll >/dev/null
$R --as smoke-g reply-all "ack all" | grep -c "sent to" | grep -q 2 || efail "reply-all"
$R --as smoke-a poll | grep -q "from @smoke-g to you + @smoke-b .*ack all" || efail "reply-all at a"
$R --as smoke-b poll | grep -q "ack all" || efail "reply-all at b"
echo "PASS: e2e keys, encrypt/decrypt, no plaintext on relay, sender verification, legacy plaintext flagged"
# --- spaces ---
sfail() { echo "FAIL: $*"; exit 1; }
SC1="$($R --as smoke-a space create acme)"; CODE="$(echo "$SC1" | grep -o 'acme-[a-f0-9]*' | head -1)"; [ -n "$CODE" ] || sfail "space create: $SC1"
OUT="$($R --as smoke-a space create admin 2>&1 || true)"; echo "$OUT" | grep -q reserved || sfail "reserved space: $OUT"
OUT="$($R init eve --space acme --invite acme-bogus 2>&1 || true)"; echo "$OUT" | grep -q "valid invite" || sfail "bad invite: $OUT"
$R init dana --space acme --invite "$CODE" | grep -q "space acme" || sfail "join dana"
$R init bob@acme --invite "$CODE" >/dev/null || sfail "join bob"
$R init dana --url "$URL" >/dev/null || sfail "public dana (per-space uniqueness)"
SM="space secret $RANDOM"
$R --as dana@acme send bob "$SM" | grep -q "end-to-end encrypted" || sfail "intra-space send"
OUT="$($R --as bob@acme poll)"; echo "$OUT" | grep -q "from @dana .*$SM" || sfail "intra-space poll: $OUT"
OUT="$($R --as dana@acme send smoke-a@public "hi" 2>&1 || true)"; echo "$OUT" | grep -q "cross-space" || sfail "cross-space from acme: $OUT"
OUT="$($R --as smoke-a send dana@acme "hi" 2>&1 || true)"; echo "$OUT" | grep -q "cross-space" || sfail "cross-space from public: $OUT"
$R --as smoke-a send dana "public dana" >/dev/null && $R --as dana poll | grep -q "public dana" || sfail "public unaffected"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/keys/dana@acme")" = 404 ] || sfail "private keys visible to outsiders"
OUT="$($R --as bob@acme space invite acme 2>&1 || true)"; echo "$OUT" | grep -q "only the space owner" || sfail "member invite: $OUT"
$R --as smoke-a space invite acme --uses 2 --expires 1d | grep -q "2 uses" || sfail "owner invite"
sleep 0.5; grep -qF "$SM" "$TMP/data.json" && sfail "space plaintext in data file"
# migration of an old (pre-spaces) data file
MP=$((PORT + 1)); OT=deadbeef$RANDOM; OH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$OT")"
echo "{\"handles\":{\"oldie\":{\"tokenHash\":\"$OH\",\"created\":\"2026-01-01T00:00:00Z\"}},\"queues\":{\"oldie\":[]}}" > "$TMP/old.json"
(cd "$TMP" && PORT=$MP DATA_FILE="$TMP/old.json" node "$ROOT/server.js" >/dev/null 2>&1) & SRV2=$!
for i in $(seq 50); do curl -sf "http://127.0.0.1:$MP/health" >/dev/null && break; sleep 0.1; done
curl -s -H "authorization: Bearer $OT" "http://127.0.0.1:$MP/status" | grep -q '"space":"public"' || { kill $SRV2; sfail "migration status"; }
curl -s -H "authorization: Bearer $OT" -d '{"to":"oldie","text":"still works"}' "http://127.0.0.1:$MP/send" | grep -q '"ok":true' || { kill $SRV2; sfail "migrated send"; }
kill $SRV2; sleep 0.3; grep -q '"space":"public"' "$TMP/old.json" || sfail "migration not persisted"
echo "PASS: spaces create/invite/join, intra-space encrypted, cross-space rejected, public unaffected, private keys hidden, migration"
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
A "$URL/admin/api/state" | grep -q '"space":"acme"' || fail "state lacks space column"
A -X POST -d '{"name":"globex"}' "$URL/admin/api/spaces" | grep -q '"invite":"globex-' || fail "admin create space"
A "$URL/admin/api/messages" | grep -q '"from":"smoke-a"' || fail "message log empty"
A "$URL/admin/api/messages" | grep -qF "$MSG" && fail "message text shown without toggle"
A "$URL/admin/api/messages?text=1" | grep -qF "$SECRET" && fail "admin log shows e2e plaintext"
A -X POST -d '{"requireEncryption":true}' "$URL/admin/api/settings" >/dev/null
curl -s -H "authorization: Bearer $TOK" -d '{"to":"smoke-a","text":"plain"}' "$URL/send" | grep -q "requires end-to-end" || fail "requireEncryption not enforced"
$R --as smoke-a send smoke-b "enc ok" >/dev/null || fail "encrypted send under requireEncryption"
$R --as smoke-b poll | grep -q "enc ok" || fail "poll under requireEncryption"
A -X POST -d '{"requireEncryption":false}' "$URL/admin/api/settings" >/dev/null
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
sleep 0.5; grep -q '"suspended":false' "$TMP/data.json" && grep -q '"sendPerMinute":1' "$TMP/data.json" || fail "settings not persisted"
grep -q "dana@acme" "$TMP/cli-output.log" || { echo "FAIL: output log not captured"; exit 1; }
grep -E '@[a-z0-9_-]+@' "$TMP/cli-output.log" && { echo "FAIL: CLI printed a double-@ address (above)"; exit 1; }
echo "PASS: no double-@ addresses in CLI output"
echo "PASS: admin login, message log, suspend/resume, block, rate limit, delete, persistence"
