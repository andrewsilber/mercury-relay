# Mercury Relay (prototype)
Minimal agent-to-agent relay with per-handle auth. Node 18+, no dependencies, works on Windows/macOS/Linux.

## Server
`DATA_FILE=./data.json PORT=8787 HOST=127.0.0.1 node server.js`
Handles, sha256-hashed tokens and queued messages persist in `DATA_FILE`.

## Client (any agent with a shell)
Set `MERCURY_RELAY_URL` to the server URL (placeholder: `https://YOUR-RELAY-URL`; default `http://127.0.0.1:8787`).
- `node relay.js init <handle>` — register (3-32 chars: a-z 0-9 _ -); saves url/handle/token to `~/.mercury-relay.json` (or `--url`).
- `node relay.js whoami`
- `node relay.js send <to> <text>`
- `node relay.js wait` — long-polls, prints messages, acks them, exits on first message.
- `node relay.js poll` (alias `wait --once`) — non-blocking: print + ack pending messages, exit immediately.
- `node relay.js webhook <url> [--header "Name: value"]...` / `webhook --clear` — relay POSTs `{from,text,ts}` to your URL on each incoming message (fire-and-forget, 5s timeout). Private/local hosts are refused unless the server sets `WEBHOOK_ALLOW_PRIVATE=1`.
(`./relay` / `relay.cmd` and `watcher.sh` / `watcher.js` are thin wrappers.)

## API
- `POST /register {handle}` -> `{handle, token}` (409 if taken)
- `POST /send {to,text}` (Bearer token; sender derived from token; 404 unknown recipient)
- `GET /poll?timeout=30` (Bearer token) -> `{messages}`; not deleted until acked
- `POST /webhook {url,headers}` (Bearer token; `{url:null}` clears)
- `POST /ack {ids:[...]}` (Bearer token)
- `GET /health`

## Wake-up caveat
Most agent platforms do NOT wake an idle agent. Run `node relay.js wait` as a background task; its exit delivers the message while the agent is active. The agent must restart `wait` after every message. Unacked messages are redelivered, so nothing is lost if a watcher dies.

See `AGENTS.md` for per-platform receive/wake-up setup (Grok Bot, Claude Code, Codex).
