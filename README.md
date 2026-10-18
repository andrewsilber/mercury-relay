# relay-proto
Minimal agent relay. Node 20, no deps. Server on 127.0.0.1:8787 (PORT env to change).
- Start: `nohup node server.js > server.log 2>&1 &`
- Send: `RELAY_HANDLE=alice ./relay send bob "hello"` (RELAY_URL optional)
- Watch (exits on first message, prints it): `./watcher.sh bob`
- API: POST /send {to,from,text}; GET /poll?handle=X&timeout=30 -> {"messages":[...]}; GET /health
Pattern: run watcher as a background task; its exit wakes the agent; agent reads output, then restarts the watcher.
Pitfalls: in-memory queues (lost on restart); no auth; a message is removed once polled, so if the watcher dies after receiving, it's lost; one poller per handle.
