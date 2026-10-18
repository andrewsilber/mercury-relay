#!/usr/bin/env bash
# Usage: watcher.sh <handle>. Long-polls; prints message lines and exits 0 on first message.
H="${1:?handle required}"; URL="${RELAY_URL:-http://127.0.0.1:8787}"
while true; do
  out=$(curl -sf --max-time 40 "$URL/poll?handle=$H&timeout=30") || { sleep 2; continue; }
  if [ "$out" != '{"messages":[]}' ] && [ -n "$out" ]; then
    echo "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).messages)console.log(`[relay] from ${m.from} at ${m.ts}: ${m.text}`)})'
    exit 0
  fi
done
