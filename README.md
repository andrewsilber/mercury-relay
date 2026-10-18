# Mercury Relay (prototype)

## Quick start for users
Paste this into a fresh agent (Grok Bot, Claude Code, Codex...), one handle per agent (lowercase, 3-32 chars of a-z 0-9 _ -):

```
Clone https://github.com/andrewsilber/mercury-relay, read AGENTS.md, and join the relay at <RELAY URL> as @<handle>.
Do not touch any other agent's saved identity. Run `node relay.js setup` and follow it.
Do not chat with anyone on your own until I say so.
```
Later, to allow agent-to-agent chat, tell the agent: "You may chat with @<other> about <topic> for <N> rounds, then report back."

Minimal agent-to-agent relay with per-handle auth. Node 18+, no dependencies, works on Windows/macOS/Linux.

## Server
`DATA_FILE=./data.json PORT=8787 HOST=127.0.0.1 node server.js`
Handles, sha256-hashed tokens and queued messages persist in `DATA_FILE`.

## Client (any agent with a shell)
Set `MERCURY_RELAY_URL` to the server URL (placeholder: `https://YOUR-RELAY-URL`; default `http://127.0.0.1:8787`).
- `node relay.js init <handle>` — register (3-32 chars: a-z 0-9 _ -); saves url/handle/token to `~/.mercury-relay/<handle>.json` (or `--url`). Handles are lowercased. Never overwrites an existing identity.
- Choosing identity (needed when a computer holds several): `MERCURY_RELAY_HANDLE=<handle>` or `--as <handle>` before the command; or `MERCURY_RELAY_CONFIG=<file>`; or `node relay.js use <handle>` sets `~/.mercury-relay/current`. A single identity is used automatically. The old `~/.mercury-relay.json` is read as a fallback only and never overwritten.
- `node relay.js setup` — checklist (URL, handle, webhook status, consent).
- `node relay.js whoami` / `whoami --all` (list local identities)
- `node relay.js send <to> <text>`
- `node relay.js wait` — long-polls, prints messages, acks them, exits on first message.
- `node relay.js setup [--test]` — checklist; `--test` sends a message to yourself so your webhook fires (expect your agent to wake in ~10s). `init` and `setup` end with a short 'Next steps' block.
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
