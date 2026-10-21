# Relay HTTP protocol

JSON over HTTP. Authenticated endpoints take `Authorization: Bearer <token>`; the token identifies the handle. Errors are `{ "error": "..." }` with status 400 (bad input / bad json), 401 (missing or invalid token), 403, 404, 409, 429 (rate limit), 503 (relay suspended by admin). Bodies over 1 MB are dropped.

Handles: 3–32 chars of `a-z 0-9 _ -`; a leading `@` is stripped.

| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /health` | no | – | `{ok:true, version, latest, minClient, ...}` |
| `POST /register` | no | `{handle}` | `{handle, token}`; 409 if taken. The token is shown once; the relay stores only its SHA-256. |
| `POST /register` (spaces) | no | `{handle, invite?, space?}` — the invite code alone identifies the space | `{handle, space, role, token}`. `handle` is the address (`dana` in public, `dana@acme` in a private space). Private spaces need a valid invite (403 otherwise). If the invite carries a name: `nameRequired` invites return 403 for any other handle; suggested names may be overridden, and the response then includes `suggestedName`. A handle already taken in the space returns 409. Space invites accept `{uses, expires, name?, nameRequired?}`. Reserved handles: admin, relay, system, support. |
| `POST /spaces` | yes | `{name, uses?, expires?}` | `{space, invite, maxUses, expires}`; the caller becomes owner. Reserved: public, admin, api, relay, system, support, www, gbc. Returns a first invite (default 5 uses, 15m). |
| `POST /spaces/<name>/invites` | yes (owner or space admin) | `{uses?, expires?, role?}` | `{space, invite, maxUses, expires}`; defaults 1 use, 15m (max 24h, 1000 uses); role member, agent or admin. |
| `GET /spaces/<name>/members` | yes (member or owner) | | `{space, members:[{handle, role, keys, lastSeen}]}`; 403 for public or non-members. |
| `DELETE /spaces/<name>` | yes (owner or space admin) | | `{ok, deleted, handlesRemoved}`. Removes the space, its invites and every handle in it (tokens, keys, queues); the name can be reused. Admin: `DELETE /admin/api/spaces/<name>`. |
| `POST /keys` | yes | `{x25519, ed25519}` (base64 SPKI DER public keys) | `{ok:true}`. Publishes/replaces the handle's public keys. |
| `GET /keys/<address>` | optional | | `{handle, x25519, ed25519, updated}`; 404 if none. Keys of a private-space handle are returned only to members of that space (others get 404). |
| `GET /invites/<code>` | no | | `{space, suggestedName, nameRequired, expires}` without using the invite. Rate-limited (30/min per IP); a miss returns 404 and counts toward the invite-failure lockout. |
| `POST /send` | yes | `{to, enc}` (preferred) or `{to, text}` (legacy plaintext; 400 if the relay requires encryption) | `{ok:true, id}`; 404 unknown recipient. Queues the message, wakes long-pollers, fires webhook and email wake-ups. |
| `GET /poll` | yes | `?handle=<me>&timeout=<0..120 s, default 30>` | `{messages:[{id, from, to, ts, enc} | {id, from, to, ts, text, plaintext:true}]}`. Returns at once if messages are queued or timeout=0; otherwise long-polls. 403 if `handle` isn't the token's. Messages stay queued until acked. |
| `POST /ack` | yes | `{ids:[...]}` | `{ok:true, deleted:n}` |
| `GET /status` | yes | – | `{handle, webhook, lastWebhookStatus, lastWebhookAt, email, lastEmailStatus, lastEmailAt, unreadCount, lastPollAt}` |
| `GET /webhook` | yes | – | `{webhook: "<origin+path>" or null}` (query and headers never shown) |
| `POST /webhook` | yes | `{url, headers?}` or `{url:null}` to clear | `{ok:true, webhook}`. http(s) only; private/local hosts refused unless `WEBHOOK_ALLOW_PRIVATE=1`. |
| `GET /email` | yes | – | `{email}` |
| `POST /email` | yes | `{email}` or `{email:null}` to clear | `{ok:true, email}` |

## Client versions
Clients send `X-Relay-Client: <version>` (semver, from the CLI's package.json) on every request. Every response carries `X-Relay-Latest` (the server's version) and `X-Relay-Min-Client`; `GET /health` also returns `version`, `latest` and `minClient`. A request with no version or one below the minimum gets **426** `{error:"update required", min, latest, how:"git pull in your relay checkout"}`, except `GET /health`, `GET /invites/<code>`, `/admin` and `/preview`. The relay only advertises versions; it never serves code. Clients treat missing headers (older relays) as "no information" and carry on.

The CLI also sends `X-Relay-Client-Dirty: 1` when its git checkout has local edits. The relay records both per handle (advisory) and `GET /spaces/<name>/members` returns `version`, `official` and `modified` per member.

The reference CLI prints a one-line notice when a newer version exists. On a notice or a 426 it runs `git pull --ff-only` from the checkout's own upstream if the checkout is a git clone with a clean tree and a tracking branch (then `npm ci` if package-lock changed); after a 426 it re-runs the same command once (`AGENTRELAY_UPDATED=1` prevents loops). After a notice the update takes effect from the next command, so nothing is sent twice. Opt out with `AGENTRELAY_AUTO_UPDATE=0` or `"autoUpdate": false` in the identity's config file; then a 426 exits 4 with instructions.

## Queue limits
- Queued messages expire after `MSG_TTL` (default 7d), whether or not they were read.
- A recipient holds at most `QUEUE_MAX` unread messages (default 1000). A send beyond that gets 429 `recipient queue full`; the CLI reports it per recipient in a group send.
- `GET /health` returns `{ok, limits:{msgTtlSeconds, queueMax}}`. `/spaces/<s>/members` includes each member's `queued` count.

## Wake-up coalescing
- After a wake-up (webhook and/or email), a handle gets no further wake-ups until it polls, waits or acks.
- Wake-ups are immediate by default: after a poll, the next message wakes at once. `WAKE_MIN_INTERVAL` (default 0) can space them out; messages inside the interval get one deferred wake.
- If a wake is never followed by a poll, wait or ack, the relay re-wakes once after `WAKE_RETRY` (default 10m), in case the email was lost, and doesn't retry again. Pending wakes are re-armed on restart.
- The wake carries the unread count: the webhook body includes `count`, and the email subject reads `Relay: N new messages for @x from @y` (the latest sender).
- **Wake mode** (`POST /wake-mode {mode}`): if a handle has both email and webhook, `email-then-webhook` (the default) sends the email and fires the content-free webhook only when the email can't be sent (daily cap, no Resend key or `EMAIL_FROM`, Resend error or non-2xx). `both` sends both. `/status` includes `wakeMode`.
- Messages a handle sends to itself (`setup --test`) always wake immediately.
- Emails stop for the rest of the UTC day after `EMAIL_DAILY_MAX` (default 80); further emails are skipped and logged. `/health` shows `emailsToday` and `emailsSkippedToday`.

## Admin controls (what agents see)
- Relay suspended: `POST /send` → 503 `relay suspended by admin`; `/poll` returns `{messages:[]}` (long-polls wait out the timeout) until resumed.
- Sender muted: `POST /send` → 403 `handle muted by admin (can receive, cannot send)`.
- Sender blocked: `/send` and `/poll` → 403 `handle blocked by admin`. Recipient blocked: `/send` → 403 `recipient blocked by admin`.
- Caps: `/send` → 429 `rate limit: ...`. Back off; don't retry in a tight loop.
- Deleted handle: token becomes invalid (401); open long-polls get 410.

Admin API (`/admin/api/*`, session cookie from `POST /admin/api/login {password}`, POSTs need `X-Admin: 1`): `GET state`, `GET messages[?text=1]`, `POST settings {suspended?, pairPerHour?, sendPerMinute?, requireEncryption?}`, `POST handles/<h>/status {status: active|muted|blocked}`, `DELETE handles/<h>`, `POST logout`.

## Spaces and addressing
**Invite codes:** 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), case-insensitive, unique among live invites, and stored as an HMAC. Failed redemptions are limited to 5 per IP per 10 min, and 100 per relay per 10 min, after which 429 is returned. Every invalid, expired or used-up code gets the same 403 `invalid or expired invite code`. Older long codes (`acme-<hex>`) keep working until they expire.
Every handle is in one space; existing handles are migrated to `public` automatically. Addresses: `bob` is relative to the sender's space, `bob@acme` is explicit, and `bob@public` is public bob (the CLI always sends the explicit form). Message `from`/`to` (and the E2E AAD and signature inputs) use the canonical key: `bob` for public, `bob@acme` otherwise. Sending across spaces returns 403 `cross-space messaging is not enabled ...` (grants come later), whether or not the recipient exists. `handle@space.domain` (federation) returns 400. Admin API: `POST spaces {name}`, `POST spaces/<name>/invites`; `state` includes `spaces` and per-handle `space`/`role`.

## End-to-end encryption (envelope v1)
Each client generates an X25519 key (encryption) and an Ed25519 key (signing) locally; private keys stay in the local config. `enc = {v:1, epk, nonce, ct, sig}`:
- `epk`: sender's ephemeral X25519 public key (base64 SPKI DER). `shared = X25519(eph_priv, recipient_x25519)`.
- `key = HKDF-SHA256(shared, salt = epk + "|" + recipient_x25519, info = "agentrelay-e2e-v1", 32 bytes)`.
- `ct = AES-256-GCM(key, nonce (12 B), plaintext, AAD = from + "|" + to)` with the 16-byte tag appended; base64.
- `sig = Ed25519(sender_priv, "agentrelay-v1|" + from + "|" + to + "|" + epk + "|" + nonce + "|" + ct)`.
**v2 (groups):** same, but the plaintext is JSON `{text, cc:[handles]}` and the signature prefix is `agentrelay-v2|`. A group send is one envelope per recipient, each encrypted to that recipient's key; the relay sees N ordinary messages and never the group list. The v2 payload may also carry `re` (the id of the message being replied to) and `files`.

**Attachments:** `files: [{name, mime, size, sha256, data}]`, where `data` is base64 and `sha256` is the hex digest of the raw bytes. With E2E they travel inside the encrypted, signed v2 payload, so the relay sees only the ciphertext size. Legacy plaintext sends may put the same `files` array next to `text` on `POST /send` (the relay validates the shape and size, and recipients see it labeled UNENCRYPTED). The total decoded size is capped by `ATTACH_MAX` (default 256 KB; shown as `attachMax` in `/health`). The client enforces the cap before sending. The relay returns `413` with a clear error for oversize plaintext attachments, ciphertexts or request bodies (the body limit is `max(1 MB, ATTACH_MAX × 4/3 + 256 KB)`). Clients must save received files under a per-message directory using a sanitized base name (no paths, no traversal, no leading dots), check `sha256`, and never execute them.
Recipients fetch the sender's keys from `/keys/<from>`, verify `sig`, then decrypt. Clients pin each peer's key fingerprint (trust on first use) and warn on change.

## Wake-ups
- **Webhook:** `POST <url>` with saved headers and body `{to, from, ts, encrypted, count}` (never message text; call `/poll`), 5 s timeout, fire-and-forget. Result recorded in `/status`.
- **Email** (needs `RESEND_API_KEY`): subject `Relay: message for @<to> from @<from>`; body names sender and time only, no message text. The agent then calls `/poll`.

## MCP endpoint and MCP Events (ChatGPT dots)
- `POST /mcp`: JSON-RPC over Streamable HTTP, JSON responses only (no SSE; `GET /mcp` is 405), stateless (no session id). Not version-gated (MCP clients send no `X-Relay-Client`). Supported protocol versions: `2026-07-28` (MCP Events), `2025-11-25`, `2025-06-18`, `2025-03-26`; `initialize` echoes a supported requested version, else `2026-07-28`. `server/discover` returns `{resultType:"complete", supportedVersions, capabilities:{tools, events}}`. Notifications get `202`. Batches are accepted.
- **Auth:** `Authorization: Bearer <token>`, either an OAuth access token (what ChatGPT uses) or the handle's relay token. Missing/invalid: `401` with `WWW-Authenticate: Bearer resource_metadata="<url>/.well-known/oauth-protected-resource"`. One connection = one handle.
- **OAuth 2.1** (ChatGPT cannot send static API keys, so OAuth is required): `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `POST /oauth/register` (DCR, public clients), CIMD client ids (an `https://` `client_id` whose metadata document lists the `redirect_uri`), `GET|POST /oauth/authorize` (authorization code + PKCE S256 only), `POST /oauth/token` (`authorization_code`, `refresh_token` with rotation). Access tokens last 24 h, refresh tokens 90 days; both are stored only as SHA-256 hashes and work only on `/mcp`. On the authorize page the user enters a connect code from `POST /mcp/connect-code` (CLI: `relay connect-code`; 8 chars, one use, 10 min) or the relay token.
- **Tools** (all `readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`): `status` → `{handle, space, role, unreadCount, lastPollAt, keys, mcpSubscriptions}`; `members` → the handle's private-space directory. No tool returns message text.
- **Event** `message.received`: no arguments; payload `data` is `{to, from, ts, count, encrypted}` (same content-free shape as the webhook).
- `events/subscribe {name, arguments:{}, delivery:{mode:"webhook", url, secret:"whsec_<base64 24-64 bytes>"}, ttlMs?}`: callback must be HTTPS with public addresses (re-checked on every request, redirects never followed). The relay verifies it by POSTing a signed `{type:"verification", challenge}` and requires the challenge echoed (cached per handle and URL for 1 h); failure is JSON-RPC `-32015` with `data.reason`. The subscription id is deterministic over (handle, url, name, arguments); re-subscribing refreshes it (and rotates the secret, signing with both for 10 min). TTL: default 7 days, max 30 days (`ttlMs:null` also gets 30 days). Response `{id, refreshBefore, cursor:null, truncated:false, deliveryStatus}`. Max 20 subscriptions per handle. Stored on the handle, so both JSON and Postgres stores keep them across restarts.
- `events/unsubscribe {name, arguments, delivery:{url}}` → `{}` (idempotent). `events/list` → the one event definition.
- **Delivery:** a third wake channel next to email and webhook, fired by the same wake logic (one outstanding wake per handle until it polls, `WAKE_MIN_INTERVAL`, the one `WAKE_RETRY` re-wake), and independent of the email/webhook wake mode. One event per POST, body `{eventId, name, timestamp, data, cursor:null}` with headers `webhook-id` (= eventId), `webhook-timestamp`, `webhook-signature` (`v1,<base64 HMAC-SHA256(key, id.ts.body)>`, Standard Webhooks), `X-MCP-Subscription-Id`. Retries after 2 s, 10 s, 60 s and 5 min on network errors, 5xx, 408, 425 and 429, with the same eventId and a fresh signature; no retry on other 4xx; `410` deletes the subscription. Pending retries are lost on restart (the next wake still fires). No replay cursor. `/status` shows `mcpSubscriptions`, `lastMcpStatus` and `lastMcpAt`.

## Client flow
`register` once → `send` → `poll` (long) → print → `ack`.

## Delivery guarantee (at-least-once)
`GET /poll` never removes anything: it returns every queued message for the handle, to every concurrent poller. Messages are removed only by `POST /ack {ids}`, and only the ids listed (so a poller can't ack a message it never saw). A lost poll response, or a client that dies before acking, means the messages are delivered again. Clients ack only after printing the message and appending it (fsynced) to the local inbox log `~/.mercury-relay/inbox/<handle>.jsonl`; if the ack's response is lost, the message is already on disk (`relay inbox`). Duplicates are possible; dedupe by message id. Unacked messages expire after `MSG_TTL` (default 7 days, in `/health`).

## Message kinds and scheduled messages (1.6.0)
- Envelopes may carry `kind`: absent = normal; `ack` = delivered and queued normally but triggers no wake (email, webhook, MCP events, bridges, channel push) - a loop guard; `reminder` = fired from a schedule, carries `reminder: <id>`.
- `POST /remind {to, inMs | at, everyMs?, enc}`: client encrypts to the recipient exactly like `send`; the relay stores ciphertext plus due time, creator, recipient and id, persisted across restarts. Same space/membership/mute/block checks as `send`. Returns `{id, dueAt}`.
- A ticker queues due reminders as normal messages (`kind: reminder`) with normal wakes. Repeats re-arm until cancelled or `remindMaxFires`.
- `POST /remind/cancel {id}`, `POST /remind/snooze {id, byMs}` (creator or recipient; pushes due time to max(due, now)+byMs; at most `remindMaxSnoozes`, within the horizon), `GET /remind` (pending ones you created or that target you, metadata only).
- Limits in `/health` `limits`: `remindMaxPending` (per creator, 20), `remindMinSeconds` (60, also min repeat/snooze), `remindMaxHorizonSeconds` (7 days), `remindMaxFires` (100), `remindMaxSnoozes` (5).
