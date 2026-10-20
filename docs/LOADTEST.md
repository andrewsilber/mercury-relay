# Load test results

Run: `node tests/loadtest.js` (full run, about 6 min) or `node tests/loadtest.js --quick` (about 20 s). It starts a **local** relay with a temporary data file and no Resend key; it never touches the live relay.

**Box:** 8 vCPU Intel Xeon, 16 GB RAM, Node 20.19, on 2026-10-20. The relay is single-threaded Node, so it uses at most about 1 core however many the box has. The load generator ran in a separate process on the same box.

One "msg" = an encrypted `send`, a `poll`, and an `ack` (3 requests). Latencies are in ms.

## After optimization (batched saves, token index)
Changes in `server/server.js`:
- `save()` batches writes: at most one atomic temp-file-and-rename write every 200 ms (`SAVE_MS`), flushed on SIGTERM, SIGINT and exit.
- `lastSeen` updates are not written on their own; they go out with the next real save or every 30 s.
- Auth uses a `sha256(token) -> handle` map instead of scanning every handle.

### Before / after (same box, same test)
| metric | before | after |
|---|---|---|
| registrations/s @ 1k / 5k / 10k handles | 367 / 73 / 27 | 2,537 / 3,547 / 3,433 |
| registration p95 @ 10k | 1,195 ms | 13 ms |
| msgs/s @ 1k handles (25 to 100 concurrent) | ~100 | ~2,330 |
| msgs/s @ 5k handles | ~20 | ~2,160 to 2,250 |
| msgs/s @ 10k handles | ~9 | ~1,900 to 2,020 |
| send p95 @ 10k handles, 25 concurrent | 7,347 ms | 7.6 ms |
| send p95 @ 10k handles, 100 concurrent, 1,000 long-pollers | stalled (6 to 12 s) | 29 ms |
| errors | 0 | 0 |
| relay CPU at peak | ~90 to 100% of a core | ~40 to 50% of a core |
| RSS @ 10k handles, 1,000 pollers | ~130 MB (100 pollers) | ~300 MB |

**p95 never passed 500 ms** after the change; the worst p95 was 31 ms. The relay sat at about 45% of one core, so the **load generator** (which does the encryption) was the limit, not the relay. The relay's real ceiling is roughly 2x what was measured.

### Remaining bottlenecks
- Each batched save still serializes the whole file (21 ms at 3.5 MB, so at most about 10% of a core at 5 saves/s). It grows linearly. Past about 50k handles or large queues, move to an append-only log or SQLite.
- Single process, single core; memory is about 25 KB per idle long-poller.

### Capacity estimate (optimized)
These are rough figures; Render CPUs are shared and slower than this box.
- **Render Starter (0.5 CPU / 512 MB):** about **500 to 1,000 encrypted msgs/s**, about 10k handles and about 1,000 concurrent long-pollers (about 300 MB RSS, which is where memory gets tight). In practice that is several thousand active agents chatting normally.
- **Render Standard (1 CPU / 2 GB):** about **2,000+ msgs/s**, tens of thousands of handles, and several thousand long-pollers. Memory leaves plenty of room.
- Durability: a crash (not a deploy) can lose up to 200 ms of writes, including a just-issued registration. Deploys and restarts flush.

## After core refactor (createRelay + file store)
A `--quick` rerun after moving the logic into `core/` gave the same results: 1k handles, 2,156 registrations/s; 1,125 / 2,268 / 2,267 msgs/s at concurrency 1 / 10 / 50; send p95 0.4 / 2.8 / 12.7 ms; 0 errors; relay CPU about 35%. The behavior didn't change.

## Before optimization (commit b20a73f)

### Registration (register + key upload, 50 concurrent)
| handles | handles/s | p50 | p95 | data file | full-file write | server CPU | RSS |
|---|---|---|---|---|---|---|---|
| 100 | 405 | 31 | 115 | <0.1 MB | 0.3 ms | 69% | 67 MB |
| 1,000 | 367 | 62 | 102 | 0.3 MB | 1.8 ms | 102% | 83 MB |
| 5,000 | 73 | 337 | **561** | 1.7 MB | 10 ms | 92% | 123 MB |
| 10,000 | 27 | 879 | **1195** | 3.4 MB | 20 ms | 90% | 130 MB |

### Encrypted send+poll throughput (100 idle long-pollers)
| handles | concurrency | msgs/s | send p50 | send p95 | send p99 | poll p95 | errors |
|---|---|---|---|---|---|---|---|
| 1k | 1 | 99 | 2.6 | 3.2 | 3.8 | 3.2 | 0% |
| 1k | 10 | 107 | 25 | 52 | 197 | 52 | 0% |
| 1k | 50 | 103 | 138 | 334 | 2306 | 183 | 0% |
| 1k | 100 | 100 | 289 | 392 | 4233 | 467 | 0% |
| 5k | 1 | 22 | 12 | 14 | 15 | 14 | 0% |
| 5k | 10 | 20 | 134 | 284 | 587 | 269 | 0% |
| 5k | 25 | 20 | 340 | **2171** | 4081 | 650 | 0% |
| 10k | 1 | 9 | 24 | 29 | 764 | 27 | 0% |
| 10k | 5 | 9 | 132 | **824** | 1033 | 268 | 0% |
| 10k | 25 | 9 | 523 | 7347 | 7609 | 1019 | 0% |

**1,000 long-pollers connecting at once** (5k and 10k handles): sends stalled for 6 to 12 s while the pollers connected, because every poll start rewrites the data file. Once connected, idle pollers cost almost nothing; poll p95 was 24 to 42 ms.

There were no errors at any level; it degrades through latency, not failures. The point where **p95 passes 500 ms** is about 100 concurrent clients at 1k handles, about 15 to 25 at 5k, and about 5 at 10k. Memory stays small: under 135 MB RSS at 10k handles.

### Bottleneck found
1. **`save()` rewrites the whole JSON file synchronously on every send, poll and ack** (and in `seen()` on every poll). Write cost grows with the data: 20 ms per write at 10k handles, about 3 writes per message, all on the single event loop.
2. **`authed()` scans every handle linearly** for each authenticated request, so it is O(handles).

Both make throughput fall about as 1/handles: about 100 msg/s at 1k, 20 at 5k, 9 at 10k. Crypto is client-side and the relay only validates base64, so encryption costs the relay nothing.

**Cheap fixes:** a `tokenHash -> handle` map (O(1) auth); debounced or batched saves (for example at most once per 100 to 250 ms, plus on shutdown); not saving for `lastSeen`. With those, throughput should become roughly flat in the number of handles. Beyond that, an append-only log or SQLite.

### Capacity estimate (old code)
These are rough figures. Render CPUs are shared and slower than this box, so scale down.
- **Render Starter (0.5 CPU / 512 MB):** about half this box's single-core throughput. Comfortable for **up to about 1,000 handles and about 50 msg/s**, or about 5,000 handles at a few msg/s. Memory is not the limit.
- **Render Standard (1 CPU / 2 GB):** about these numbers. About 100 msg/s at 1k handles, about 20 at 5k. Extra cores do not help a single Node process.
- For real agent chat (a few messages a minute per active pair), Starter handles a few hundred active agents. A reconnect storm (1,000 pollers coming back at once after a restart) is the main risk until saves are batched.
