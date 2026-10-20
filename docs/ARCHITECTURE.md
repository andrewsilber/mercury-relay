# Architecture

## relay-core (library, no HTTP)
`core/` holds everything that is relay logic: handles and spaces, routing and the permission check, queues and acks, public keys, rate limits, hooks (see [HOOKS.md](HOOKS.md)) and wake-up notification. It has no HTTP and no process concerns.
```js
const relay = createRelay({ store, policy, notifier });
relay.register({ handle, space, invite });   relay.auth(token);
relay.send(me, { to, enc | text });          relay.poll(me, timeoutMs, cb);  relay.ack(me, ids);
relay.setKeys(me, keys);  relay.getKeys(addr, viewer);  relay.createSpace(me, name);  relay.invite(...);
relay.admin.*   // state, settings, status, delete, messages
```
- **Store interface:** `load() -> data`, `save()` (batched), `saveNow()`, `flush()`. Today it is `core/store-file.js`, a JSON file with batched atomic writes. SQLite and Postgres stores implement the same interface, later with per-record writes (`putHandle`, `pushMessage`, `ack`) so they don't rewrite everything.
- **Notifier:** `{ webhook(msg, handle, record), email(msg, handle, record) }`; content-free wake-ups.
- **Policy:** limits, requireEncryption, hooks. Per relay today, per space later.

## Self-host wrapper (this repo)
`server/server.js` creates **one** core instance with the file store and puts HTTP on it: the public API in [PROTOCOL.md](../PROTOCOL.md), plus `/admin` (the operator portal). One process, one data file, one or more spaces.

## Hosted wrapper (private cloud repo)
- One process hosts **many core instances**, one per org or space, **instantiated lazily** and keyed by the request's space (from the token or address). Idle instances are evicted.
- Each instance gets a **Postgres-backed store slice** (rows scoped by space), its own policy and limits, and its own notifier config.
- **Hot spaces can be sharded out** later to dedicated processes or nodes. A routing layer maps space to node; the core code doesn't change.

## Message relay vs control plane
- **Message relay (data plane):** register/auth, send, poll/wait, ack, keys, wake-ups. It must be fast and highly available, and it only ever sees ciphertext and metadata.
- **Control plane:** users, orgs, billing, space creation, invites and roles, grants, policy editing, audit, dashboards. In the hosted version it is a separate service that writes config the relay reads. In self-host it is folded into `/admin` and the CLI.

## Dedicated relay (enterprise option)
A customer gets a dedicated relay process or cluster, in GBC's cloud or their own (BYO). It runs the same core with their own store, keys, filters and network policy, and is managed from the same control plane.
