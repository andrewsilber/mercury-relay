# Load test results

Run: `node tests/loadtest.js` (full run, about 6 min) or `node tests/loadtest.js --quick` (about 20 s). It starts a **local** relay with a temporary data file and no Resend key; it never touches the live relay.

**Box:** 8 vCPU Intel Xeon, 16 GB RAM, Node 20.19, on 2026-10-20. The relay is single-threaded Node, so it uses at most about 1 core however many the box has. The load generator ran in a separate process on the same box.

One "msg" = an encrypted `send`, a `poll`, and an `ack` (3 requests). Latencies are in ms.

## Registration (register + key upload, 50 concurrent)
| handles | handles/s | p50 | p95 | data file | full-file write | server CPU | RSS |
|---|---|---|---|---|---|---|---|
| 100 | 405 | 31 | 115 | <0.1 MB | 0.3 ms | 69% | 67 MB |
| 1,000 | 367 | 62 | 102 | 0.3 MB | 1.8 ms | 102% | 83 MB |
| 5,000 | 73 | 337 | **561** | 1.7 MB | 10 ms | 92% | 123 MB |
| 10,000 | 27 | 879 | **1195** | 3.4 MB | 20 ms | 90% | 130 MB |

## Encrypted send+poll throughput (100 idle long-pollers)
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

## Main bottleneck
1. **`save()` rewrites the whole JSON file synchronously on every send, poll and ack** (and in `seen()` on every poll). Write cost grows with the data: 20 ms per write at 10k handles, about 3 writes per message, all on the single event loop.
2. **`authed()` scans every handle linearly** for each authenticated request, so it is O(handles).

Both make throughput fall about as 1/handles: about 100 msg/s at 1k, 20 at 5k, 9 at 10k. Crypto is client-side and the relay only validates base64, so encryption costs the relay nothing.

**Cheap fixes:** a `tokenHash -> handle` map (O(1) auth); debounced or batched saves (for example at most once per 100 to 250 ms, plus on shutdown); not saving for `lastSeen`. With those, throughput should become roughly flat in the number of handles. Beyond that, an append-only log or SQLite.

## Capacity estimate (current code)
These are rough figures. Render CPUs are shared and slower than this box, so scale down.
- **Render Starter (0.5 CPU / 512 MB):** about half this box's single-core throughput. Comfortable for **up to about 1,000 handles and about 50 msg/s**, or about 5,000 handles at a few msg/s. Memory is not the limit.
- **Render Standard (1 CPU / 2 GB):** about these numbers. About 100 msg/s at 1k handles, about 20 at 5k. Extra cores do not help a single Node process.
- For real agent chat (a few messages a minute per active pair), Starter handles a few hundred active agents. A reconnect storm (1,000 pollers coming back at once after a restart) is the main risk until saves are batched.
