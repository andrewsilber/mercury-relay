#!/usr/bin/env bash
# Smoke test: local server on a temp port, two handles, send, poll, verify.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; PORT=$((20000 + RANDOM % 20000)); URL="http://127.0.0.1:$PORT"
export HOME="$TMP/home"; mkdir -p "$HOME"
# Storage backend: JSON files by default; set SMOKE_DATABASE_URL to run the same suite against Postgres (one schema per server).
RUNID="s$$_$RANDOM"
ST() { if [ -n "${SMOKE_DATABASE_URL:-}" ]; then echo "DATABASE_URL=$SMOKE_DATABASE_URL DATABASE_SCHEMA=${RUNID}_$1"; else echo "DATA_FILE=$TMP/$1.json"; fi; }
DUMP() { if [ -n "${SMOKE_DATABASE_URL:-}" ]; then DATABASE_URL="$SMOKE_DATABASE_URL" DATABASE_SCHEMA="${RUNID}_$1" node "$ROOT/server/dump-store.js"; else cat "$TMP/$1.json"; fi; }
if [ -n "${SMOKE_DATABASE_URL:-}" ]; then BACKEND=postgres; else BACKEND=json-file; fi; echo "storage backend: $BACKEND"
unset MERCURY_RELAY_CONFIG MERCURY_RELAY_HANDLE MERCURY_RELAY_URL AGENTRELAY_CONFIG AGENTRELAY_HANDLE AGENTRELAY_URL RESEND_API_KEY
(cd "$TMP" && INVITE_FAILS_PER_IP=20 ADMIN_PASSWORD=smoke-admin-pw PORT=$PORT env $(ST data) node "$ROOT/server.js" >"$TMP/server.log" 2>&1) & SRV=$!
trap 'kill $SRV $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 50); do curl -sf "$URL/health" >/dev/null && break; sleep 0.1; done
# Wrapper logs all CLI output so we can check address formatting at the end.
printf '#!/usr/bin/env bash\nnode "%s/relay.js" "$@" 2>&1 | tee -a "%s/cli-output.log"; exit ${PIPESTATUS[0]}\n' "$ROOT" "$TMP" > "$TMP/r.sh"; chmod +x "$TMP/r.sh"
R="$TMP/r.sh"
export AGENTRELAY_NEWER_CHECK=0 # most tests send without reading first; the newer-message check is tested explicitly below
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
sleep 0.5; DUMP data | grep -qF "$SECRET" && efail "plaintext found in relay data file"
DUMP data | grep -q '"priv"' && efail "private key on relay"
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
# reply-all records the replied-to id inside the signed envelope; newer-message check blocks stale sends
GID="$($R --as smoke-g poll 2>&1; true)"
$R --as smoke-a send smoke-b,smoke-g "round two" >/dev/null
GP="$($R --as smoke-g poll)"; RID="$(echo "$GP" | sed -nE 's/.*\(id ([0-9a-f-]+)\).*round two.*/\1/p')"; [ -n "$RID" ] || efail "poll output lacks id: $GP"
$R --as smoke-b send smoke-g "crossed message" >/dev/null
set +e; NO="$(AGENTRELAY_NEWER_CHECK=1 $R --as smoke-g reply-all "stale reply")"; NRC=$?; set -e
[ "$NRC" = 3 ] && echo "$NO" | grep -q "NEWER MESSAGES ARRIVED" && echo "$NO" | grep -q "crossed message" || efail "newer-message check: rc=$NRC $NO"
$R --as smoke-a poll | grep -q "stale reply" && efail "stale reply was sent"
AGENTRELAY_NEWER_CHECK=1 $R --as smoke-g reply-all "fresh reply" >/dev/null || efail "reply-all after re-read"
$R --as smoke-a poll | grep -q "re $RID) \[end-to-end encrypted\]: fresh reply" || efail "re id not shown to recipient"
$R --as smoke-b poll >/dev/null
$R --as smoke-a send smoke-g "unread for g" >/dev/null
AGENTRELAY_NEWER_CHECK=1 $R --as smoke-g send --force smoke-a "forced" | grep -q "sent to" || efail "--force"
$R --as smoke-a send --re abc-123 smoke-g "explicit re" >/dev/null; $R --as smoke-g poll | grep -q "re abc-123).*explicit re" || efail "--re"
echo "PASS: e2e keys, encrypt/decrypt, no plaintext on relay, sender verification, legacy plaintext flagged, group reply-all with signed re, newer-message check, --force, --re"
# --- spaces ---
sfail() { echo "FAIL: $*"; exit 1; }
SC1="$($R --as smoke-a space create acme)"; CODE="$(echo "$SC1" | sed -n 's/^Invite code: \([A-Z0-9]\{4\}\) .*/\1/p')"; [ -n "$CODE" ] || sfail "space create: $SC1"
echo "$CODE" | grep -q '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]\{4\}$' || sfail "code alphabet: $CODE"
echo "$SC1" | grep -q "join as @<handle> with invite $CODE" || sfail "seed sentence: $SC1"
OUT="$($R --as smoke-a space create admin 2>&1 || true)"; echo "$OUT" | grep -q reserved || sfail "reserved space: $OUT"
OUT="$($R init eve --invite ZZZZ 2>&1 || true)"; echo "$OUT" | grep -q "invalid or expired invite" || sfail "bad invite: $OUT"
LC="$(echo "$CODE" | tr 'A-Z' 'a-z')"
$R init dana --invite "$LC" | grep -q "space acme" || sfail "join dana (short code, no --space, lowercase)"
$R init bob@acme --invite "$CODE" >/dev/null || sfail "join bob (--space form)"
# use count + expiry
C1="$($R --as smoke-a space invite acme | sed -n 's/^Invite code: \([A-Z0-9]\{4\}\) .*/\1/p')"
$R init uno --invite "$C1" >/dev/null || sfail "single-use invite"
OUT="$($R init dos --invite "$C1" 2>&1 || true)"; echo "$OUT" | grep -q "invalid or expired" || sfail "invite reused: $OUT"
C2="$($R --as smoke-a space invite acme --expires 1s | sed -n 's/^Invite code: \([A-Z0-9]\{4\}\) .*/\1/p')"; sleep 1.5
OUT="$($R init tres --invite "$C2" 2>&1 || true)"; echo "$OUT" | grep -q "invalid or expired" || sfail "expired invite accepted: $OUT"
OUT="$($R --as smoke-a space invite acme --expires 48h 2>&1 || true)"; echo "$OUT" | grep -q "24h" || sfail "expiry cap: $OUT"
# brute-force lockout (separate client IP via X-Forwarded-For)
for i in $(seq 20); do curl -s -H 'x-forwarded-for: 10.66.0.1' -d '{"handle":"brute","invite":"ZZZZ"}' "$URL/register" >/dev/null; done
OUT="$(curl -s -H 'x-forwarded-for: 10.66.0.1' -d "{\"handle\":\"brute\",\"invite\":\"$CODE\"}" "$URL/register")"; echo "$OUT" | grep -q "too many failed invite attempts" || sfail "no lockout: $OUT"
curl -s -H 'x-forwarded-for: 6.6.6.6, 10.66.0.1' -d '{"handle":"brute2","invite":"ZZZZ"}' "$URL/register" | grep -q "too many failed" || sfail "lockout bypassed via spoofed leftmost XFF"
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
$R --as dana@acme send bob "queued one" >/dev/null
OUT="$($R --as dana@acme members)"; echo "$OUT" | grep -q "@bob  joined (keys published)  1 queued" || sfail "members queued count: $OUT"
$R --as bob@acme poll >/dev/null
OUT="$($R --as dana@acme members)"; echo "$OUT" | grep -q "@bob  joined (keys published)" && echo "$OUT" | grep -q "@dana" || sfail "members: $OUT"
$R --as smoke-a members acme | grep -q "bob@acme" || sfail "owner members view"
OUT="$($R --as dana members 2>&1 || true)"; echo "$OUT" | grep -q "no member list" || sfail "public members: $OUT"
OUT="$($R --as smoke-g members acme 2>&1 || true)"; echo "$OUT" | grep -q "only members" || sfail "outsider members: $OUT"
sleep 0.5; DUMP data | grep -qF "$SM" && sfail "space plaintext in data file"
# queue limits: separate relay with short TTL and small cap
QP=$((PORT + 2)); QU="http://127.0.0.1:$QP"
(cd "$TMP" && MSG_TTL=2s QUEUE_MAX=3 PORT=$QP env $(ST q) node "$ROOT/server.js" >/dev/null 2>&1) & SRV3=$!
for i in $(seq 50); do curl -sf "$QU/health" >/dev/null && break; sleep 0.1; done
curl -s "$QU/health" | grep -q '"queueMax":3' && curl -s "$QU/health" | grep -q '"msgTtlSeconds":2' || { kill $SRV3; sfail "limits not in /health"; }
$R init qqa --url "$QU" >/dev/null; $R init qqb --url "$QU" >/dev/null; $R init qqc --url "$QU" >/dev/null
for i in 1 2 3; do $R --as qqa send qqb "m$i" >/dev/null || { kill $SRV3; sfail "send under cap"; }; done
OUT="$($R --as qqa send qqb,qqc "over" 2>&1 || true)"
echo "$OUT" | grep -q "FAILED to @qqb: recipient queue full" && echo "$OUT" | grep -q "sent to @qqc" || { kill $SRV3; sfail "queue cap / per-recipient report: $OUT"; }
sleep 3
OUT="$($R --as qqb poll)"; echo "$OUT" | grep -q "no new messages" || { kill $SRV3; sfail "messages did not expire: $OUT"; }
kill $SRV3
echo "PASS: queue cap (429 per recipient), message TTL expiry, limits in /health"
# wake-up coalescing + daily email cap (fake Resend + webhook receiver)
RP=$((PORT + 3)); WP=$((PORT + 4)); WU="http://127.0.0.1:$WP"
node -e 'const fs=require("fs");require("http").createServer((q,r)=>{let b="";q.on("data",c=>b+=c).on("end",()=>{fs.appendFileSync(process.argv[2],q.url+" "+(q.headers.authorization||"-")+" "+b+"\n");if(q.url==="/email"&&fs.existsSync(process.argv[3])){r.statusCode=500;return r.end("down")}r.end("{}")})}).listen(+process.argv[1],"127.0.0.1")' "$RP" "$TMP/hits.log" "$TMP/email-down" & RCV=$!
(cd "$TMP" && WEBHOOK_ALLOW_PRIVATE=1 WAKE_MIN_INTERVAL=8s EMAIL_DAILY_MAX=1 RESEND_API_KEY=test EMAIL_FROM=relay@test.invalid RESEND_API_URL="http://127.0.0.1:$RP/email" PORT=$WP env $(ST w) node "$ROOT/server.js" >/dev/null 2>&1) & SRV4=$!
for i in $(seq 50); do curl -sf "$WU/health" >/dev/null && break; sleep 0.1; done
touch "$TMP/hits.log"
$R init wka --url "$WU" >/dev/null; $R init wkb --url "$WU" >/dev/null
$R --as wkb wake --email wkb@test.invalid --webhook "http://127.0.0.1:$RP/hook" --webhook-key k1 --mode both | grep -q "wake mode: both" || sfail "wake cmd"
for i in 1 2 3; do $R --as wka send wkb "w$i" >/dev/null; done; sleep 0.5
[ "$(grep -c '^/hook' "$TMP/hits.log")" = 1 ] && [ "$(grep -c '^/email' "$TMP/hits.log")" = 1 ] || sfail "wakes not coalesced: $(cat "$TMP/hits.log")"
$R --as wkb poll >/dev/null
$R --as wka send wkb "w4" >/dev/null; $R --as wka send wkb "w5" >/dev/null; sleep 0.5
[ "$(grep -c '^/hook' "$TMP/hits.log")" = 1 ] || sfail "min interval not enforced"
for i in $(seq 100); do [ "$(grep -c '^/hook' "$TMP/hits.log")" = 2 ] && break; sleep 0.1; done
[ "$(grep -c '^/hook' "$TMP/hits.log")" = 2 ] || sfail "deferred wake missing: $(cat "$TMP/hits.log")"
grep '^/hook' "$TMP/hits.log" | tail -1 | grep -q '"count":2' || sfail "wake count: $(tail -1 "$TMP/hits.log")"
[ "$(grep -c '^/email' "$TMP/hits.log")" = 1 ] || sfail "daily email cap not enforced"
H="$(curl -s "$WU/health")"; echo "$H" | grep -q '"emailsToday":1' && echo "$H" | grep -q '"emailsSkippedToday":1' || sfail "health email stats: $H"
grep '^/email' "$TMP/hits.log" | grep -q 'Relay: message for @wkb' || sfail "email subject: $(grep '^/email' "$TMP/hits.log")"
grep '^/hook' "$TMP/hits.log" | head -1 | grep -q '^/hook k1 ' || sfail "webhook key header"
grep '^/hook' "$TMP/hits.log" | grep -q 'w[0-9]' && sfail "webhook payload contains message text"
kill $SRV4
# wake mode email-then-webhook: webhook only when email can't be sent
FP=$((PORT + 5)); FU="http://127.0.0.1:$FP"; : > "$TMP/hits.log"
(cd "$TMP" && WEBHOOK_ALLOW_PRIVATE=1 WAKE_MIN_INTERVAL=0 EMAIL_DAILY_MAX=2 RESEND_API_KEY=test EMAIL_FROM=relay@test.invalid RESEND_API_URL="http://127.0.0.1:$RP/email" PORT=$FP env $(ST f) node "$ROOT/server.js" >/dev/null 2>&1) & SRV5=$!
for i in $(seq 50); do curl -sf "$FU/health" >/dev/null && break; sleep 0.1; done
$R init fba --url "$FU" >/dev/null; $R init fbb --url "$FU" >/dev/null
$R --as fbb wake --email fbb@test.invalid --webhook "http://127.0.0.1:$RP/hook" --webhook-key k2 | grep -q "wake mode: email-then-webhook" || sfail "default wake mode"
cnt() { grep -c "^/$1" "$TMP/hits.log" || true; }
$R --as fba send fbb "e1" >/dev/null; sleep 0.5; [ "$(cnt email)" = 1 ] && [ "$(cnt hook)" = 0 ] || sfail "email ok should not fire webhook: $(cat "$TMP/hits.log")"
$R --as fbb poll >/dev/null; touch "$TMP/email-down"
$R --as fba send fbb "e2" >/dev/null; sleep 0.5; [ "$(cnt email)" = 2 ] && [ "$(cnt hook)" = 1 ] || sfail "resend failure fallback: $(cat "$TMP/hits.log")"
$R --as fbb poll >/dev/null; rm -f "$TMP/email-down"
$R --as fba send fbb "e3" >/dev/null; sleep 0.5; [ "$(cnt email)" = 2 ] && [ "$(cnt hook)" = 2 ] || sfail "daily cap fallback: $(cat "$TMP/hits.log")"
kill $SRV5
# real-time wakes: default interval 0 (immediate after a poll) + one retry if unacknowledged
GP=$((PORT + 6)); GU="http://127.0.0.1:$GP"; : > "$TMP/hits.log"
(cd "$TMP" && WEBHOOK_ALLOW_PRIVATE=1 WAKE_RETRY=3s PORT=$GP env $(ST g) node "$ROOT/server.js" >/dev/null 2>&1) & SRV6=$!
for i in $(seq 50); do curl -sf "$GU/health" >/dev/null && break; sleep 0.1; done
curl -s "$GU/health" | grep -q '"wakeMinIntervalSeconds":0' || sfail "default WAKE_MIN_INTERVAL not 0"
$R init rta --url "$GU" >/dev/null; $R init rtb --url "$GU" >/dev/null
$R --as rtb wake --webhook "http://127.0.0.1:$RP/hook" >/dev/null
$R --as rta send rtb "r1" >/dev/null; sleep 0.3; [ "$(cnt hook)" = 1 ] || sfail "first wake"
$R --as rtb poll >/dev/null
$R --as rta send rtb "r2" >/dev/null; sleep 0.3; [ "$(cnt hook)" = 2 ] || sfail "no immediate wake after poll: $(cat "$TMP/hits.log")"
$R --as rta send rtb "r3" >/dev/null; sleep 0.3; [ "$(cnt hook)" = 2 ] || sfail "not coalesced while wake pending"
sleep 3.5; [ "$(cnt hook)" = 3 ] || sfail "no retry wake: $(cat "$TMP/hits.log")"
sleep 3.5; [ "$(cnt hook)" = 3 ] || sfail "retried more than once"
kill $SRV6 $RCV
echo "PASS: real-time wakes (immediate after poll, coalesced while pending, one retry after WAKE_RETRY)"
echo "PASS: wake mode email-then-webhook (email ok -> no webhook; Resend failure -> webhook; cap -> webhook)"
echo "PASS: wake coalescing (pending until poll, min interval, deferred wake with count), daily email cap, email stats"
# migration of an old (pre-spaces) data file
MP=$((PORT + 1)); OT=deadbeef$RANDOM; OH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$OT")"
LH="$(node -e 'console.log(require("crypto").createHash("sha256").update("legacy-0123456789ab").digest("hex"))')"
echo "{\"handles\":{\"oldie\":{\"tokenHash\":\"$OH\",\"created\":\"2026-01-01T00:00:00Z\"}},\"queues\":{\"oldie\":[]},\"spaces\":{\"legacy\":{\"created\":\"2026-01-01T00:00:00Z\",\"owner\":null,\"invites\":{\"$LH\":{\"uses\":0,\"maxUses\":5,\"expires\":\"2099-01-01T00:00:00Z\",\"role\":\"member\"}}}}}" > "$TMP/old.json"
if [ -n "${SMOKE_DATABASE_URL:-}" ]; then DATABASE_URL="$SMOKE_DATABASE_URL" DATABASE_SCHEMA="${RUNID}_old" node "$ROOT/server/migrate-file-to-pg.js" "$TMP/old.json" >/dev/null || sfail "migrate-file-to-pg"; fi
(cd "$TMP" && PORT=$MP env $(ST old) node "$ROOT/server.js" >/dev/null 2>&1) & SRV2=$!
for i in $(seq 50); do curl -sf "http://127.0.0.1:$MP/health" >/dev/null && break; sleep 0.1; done
curl -s -H "authorization: Bearer $OT" "http://127.0.0.1:$MP/status" | grep -q '"space":"public"' || { kill $SRV2; sfail "migration status"; }
curl -s -H "authorization: Bearer $OT" -d '{"to":"oldie","text":"still works"}' "http://127.0.0.1:$MP/send" | grep -q '"ok":true' || { kill $SRV2; sfail "migrated send"; }
curl -s -d '{"handle":"lena","invite":"legacy-0123456789ab"}' "http://127.0.0.1:$MP/register" | grep -q '"handle":"lena@legacy"' || { kill $SRV2; sfail "old long invite code"; }
kill $SRV2; sleep 0.3; DUMP old | grep -q '"space":"public"' || sfail "migration not persisted"
echo "PASS: spaces create/invite/join, short codes (no --space, case-insensitive, single use, expiry, cap, brute-force lockout, legacy long code), intra-space encrypted, cross-space rejected, public unaffected, private keys hidden, migration"
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
OUT="$($R init '<handle>' 2>&1 || true)"; echo "$OUT" | grep -q "placeholder" || fail "CLI accepted placeholder handle: $OUT"
curl -s -d '{"handle":"<handle>"}' "$URL/register" | grep -q "must be 3-32" || fail "relay accepted <handle>"
INV="$(A "$URL/admin/api/invites")"; echo "$INV" | grep -q '"space":"acme"' && echo "$INV" | grep -q '"code":"[A-Z2-9]\{4\}"' && echo "$INV" | grep -q '"usesLeft"' || fail "invite list: $INV"
RC="$($R --as smoke-a space invite acme | sed -n 's/^Invite code: \([A-Z0-9]\{4\}\) .*/\1/p')"
RID="$(A "$URL/admin/api/invites" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const x=JSON.parse(d).invites.find(i=>i.code===process.argv[1]);console.log(x?x.id:"")})' "$RC")"
A -X DELETE "$URL/admin/api/spaces/acme/invites/$RID" | grep -q '"revoked"' || fail "revoke invite"
OUT="$($R init revoked1 --invite "$RC" 2>&1 || true)"; echo "$OUT" | grep -q "invalid or expired" || fail "revoked invite still works: $OUT"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/admin/api/invites")" = 401 ] || fail "invite list without login"
# admin login lockout keyed on rightmost XFF (spoofed leftmost entries must not reset it)
for i in $(seq 10); do curl -s -o /dev/null -H "x-forwarded-for: 1.2.3.$i, 10.77.0.1" -d '{"password":"nope"}' "$URL/admin/api/login"; done
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-forwarded-for: 9.9.9.9, 10.77.0.1' -d '{"password":"nope"}' "$URL/admin/api/login")" = 429 ] || fail "admin login lockout bypassed via XFF"
# space deletion
DC="$($R --as smoke-a space create doomed | sed -n 's/^Invite code: \([A-Z0-9]\{4\}\) .*/\1/p')"
$R init zed --invite "$DC" >/dev/null || fail "join doomed"
$R --as smoke-a space invite doomed >/dev/null
OUT="$($R --as zed@doomed space delete doomed 2>&1 || true)"; echo "$OUT" | grep -q "only the space owner" || fail "non-owner delete: $OUT"
$R --as smoke-a space delete doomed | grep -q "removed 1 handle" || fail "owner delete"
ZT="$(node -e 'console.log(require(process.argv[1]).token)' "$HOME/.mercury-relay/zed@doomed.json")"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $ZT" "$URL/status")" = 401 ] || fail "deleted member token still works"
A "$URL/admin/api/invites" | grep -q '"space":"doomed"' && fail "invites survived delete"
OUT="$($R init zed2 --invite "$DC" 2>&1 || true)"; echo "$OUT" | grep -q "invalid or expired" || fail "deleted space invite still works"
$R --as smoke-a space create doomed >/dev/null || fail "name not reusable"
A -X DELETE "$URL/admin/api/spaces/doomed" | grep -q '"handlesRemoved":0' || fail "admin delete space"
A -X DELETE "$URL/admin/api/spaces/public" | grep -q "cannot be deleted" || fail "public deletable"
A -X POST -d '{"name":"globex"}' "$URL/admin/api/spaces" | grep -q '"invite":"[A-Z2-9]\{4\}"' || fail "admin create space"
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
sleep 0.5; D="$(DUMP data)"; echo "$D" | grep -q '"suspended":false' && echo "$D" | grep -q '"sendPerMinute":1' || fail "settings not persisted"
A "$URL/admin/api/storage" | grep -q "\"backend\":\"$BACKEND\"" || fail "storage info"
A "$URL/admin/api/storage" | grep -q '"max":1000' || fail "message log cap not reported"
grep -q "dana@acme" "$TMP/cli-output.log" || { echo "FAIL: output log not captured"; exit 1; }
grep -E '@[a-z0-9_-]+@' "$TMP/cli-output.log" && { echo "FAIL: CLI printed a double-@ address (above)"; exit 1; }
echo "PASS: no double-@ addresses in CLI output"
echo "PASS: admin login, message log, suspend/resume, block, rate limit, delete, persistence"
