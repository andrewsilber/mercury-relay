#!/usr/bin/env bash
# CLI guardrails end to end against a local relay: footer, hints, help/status/config, auto-ack,
# loop breaker, repeat, rate cap, check-back reminder (set, replaced, fires, cancelled by FINAL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; TMP="$(mktemp -d)"; PORT=$((20000 + RANDOM % 20000)); URL="http://127.0.0.1:$PORT"
export HOME="$TMP/home"; mkdir -p "$HOME"
unset MERCURY_RELAY_CONFIG MERCURY_RELAY_HANDLE AGENTRELAY_CONFIG AGENTRELAY_HANDLE AGENTRELAY_NEWER_CHECK AGENTRELAY_DECISION OPENROUTER_API_KEY TYPESAFE_API_KEY RESEND_API_KEY
(cd "$TMP" && REMIND_MIN=3s REMIND_TICK=1s DATA_FILE="$TMP/d.json" PORT=$PORT node "$ROOT/server.js" >"$TMP/server.log" 2>&1) & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 50); do curl -sf "$URL/health" >/dev/null && break; sleep 0.1; done
R() { node "$ROOT/relay.js" "$@" 2>&1; }
fail() { echo "FAIL: $*"; exit 1; }
R init gda --url "$URL" >/dev/null; R init gdb --url "$URL" >/dev/null; R init gdc --url "$URL" >/dev/null
R --as gda send gdb "hello, can you check relaywake?" | grep -q "NEXT: carry on" || fail "send hint"
O="$(R --as gdb poll)"; echo "$O" | grep -q "\[relay\] commands (node .* --as gdb ...): poll | send" || fail "wake-up footer: $O"
R --as gdb poll | grep -q "Nothing to do" || fail "empty poll hint"
# local state files are never mistaken for identities
R --as gda whoami --all | grep -q "guard\|reminders" && fail "state file listed as identity"
# help/status/config from live state
R --as gdb help | grep -q "config | config set" || fail "help table"
O="$(R --as gda status)"; for p in "client $(node -p "require('$ROOT/package.json').version")" "unread: none" "reminders: none" "conversation with @gdb: open" "decision model: rules"; do echo "$O" | grep -q "$p" || fail "status missing '$p': $O"; done
R --as gda config set guard.rateMax abc >/dev/null 2>&1 && fail "non-numeric threshold accepted"
R --as gda config set decision.key secret-value | grep -q secret-value && fail "config echoed key"
R --as gda config | grep -q "decision model: rules, key set in config" || fail "config view"
R --as gda config | grep -q secret-value && fail "config printed key"
R --as gda config unset decision.key >/dev/null
# check-back: gdb was woken and replies without FINAL -> reminder; replaced on the next reply; FINAL cancels
R --as gdb config set guard.checkbackMs 4000 >/dev/null
O="$(R --as gdb send gda "checked: relaywake has no conflicts on npm")"; echo "$O" | grep -q "check-back reminder" || fail "check-back not set: $O"
ID1="$(echo "$O" | sed -n 's/.*check-back reminder \([A-Z0-9]*\) set.*/\1/p')"
O="$(R --as gdb send gda "also: the .com is parked")"; ID2="$(echo "$O" | sed -n 's/.*check-back reminder \([A-Z0-9]*\) set.*/\1/p')"
[ -n "$ID2" ] && [ "$ID1" != "$ID2" ] || fail "check-back not replaced"
R --as gdb remind list | grep -q "$ID1" && fail "old check-back not cancelled"
sleep 6; O="$(R --as gdb poll)"; echo "$O" | grep -q "REMINDER $ID2" && echo "$O" | grep -q "check-back: your conversation with @gda is still open" || fail "check-back did not fire: $O"
R --as gdb send gda "one more finding: pypi is free" >/dev/null
R --as gdb send gda "FINAL: relaywake, no conflicts" | grep -q "check-back reminder for this conversation is cancelled" || fail "FINAL hint"
[ "$(R --as gdb remind list)" = "[relay] no pending reminders" ] || fail "FINAL did not cancel check-back"
R --as gda poll >/dev/null; R --as gda status | grep -q "conversation with @gdb: finished" || fail "status after FINAL"
# auto-ack: never wakes, marked ACK; loop breaker refuses the 3rd ack-ish message in a row; FINAL passes
R --as gda config set guard.loopAcks 3 >/dev/null
R --as gdc send gda "new data: summonwire is taken on GitHub" >/dev/null; R --as gda poll >/dev/null
O="$(R --as gda send gdc "Got it, thanks")"; echo "$O" | grep -q "sent ack to @gdc" && echo "$O" | grep -q "sent as an ack" || fail "auto-ack: $O"
R --as gdc poll | grep -q "ACK (no reply needed) from @gda" || fail "auto-ack not delivered as ack"
R --as gdc send gda "Agreed." | grep -q "sent ack" || fail "2nd ack"; R --as gda poll >/dev/null
O="$(R --as gda send gdc "ACK, holding" || true)"; echo "$O" | grep -q "NOT SENT (loop" || fail "loop breaker: $O"
R --as gda send --force gdc "ACK, holding" | grep -q "sent to @gdc" || fail "--force past loop breaker"
R --as gda send gdc "FINAL: summonwire is out" | grep -q "sent to @gdc" || fail "FINAL past loop"
# repeat + rate cap (configurable)
R --as gda send gdb "please re-check the trademark search for relaywake" >/dev/null
O="$(R --as gda send gdb "please re-check the trademark search for relaywake" || true)"; echo "$O" | grep -q "NOT SENT (repeat" || fail "repeat: $O"
R --as gda config set guard.rateMax 2 >/dev/null; R --as gda config set guard.rateWindowMs 60000 >/dev/null
O="$(R --as gda send gdb "brand new topic number one" || true)"; echo "$O" | grep -q "NOT SENT (rate cap" || fail "rate cap: $O"
R --as gda config unset guard.rateMax >/dev/null; R --as gda send gdb "brand new topic number two" | grep -q "sent to" || fail "rate cap reset"
# provider error falls back to rules (unreachable custom URL)
R --as gda config set decision.provider url >/dev/null; R --as gda config set decision.url http://127.0.0.1:9/x >/dev/null
R --as gdb poll >/dev/null; R --as gdb send gda "new: domain check done" >/dev/null; R --as gda poll >/dev/null
R --as gda send gdb "Thanks" | grep -q "sent ack" || fail "provider error did not fall back to rules"
R --as gda status | grep -q "decision model: url" || fail "status shows provider"
[ "$(stat -c %a "$HOME/.mercury-relay/gda.guard.json")" = 600 ] || fail "guard state mode"
echo "PASS: wake-up footer, next-step hints, help/status/config (live state, key never printed), check-back (set, replaced, fires, cancelled by FINAL), auto-ack, loop breaker + --force + FINAL, repeat, configurable rate cap, provider error -> rules"
