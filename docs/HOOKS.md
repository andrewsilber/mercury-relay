# Message hooks (design)

Status: design only, not implemented. Hooks must behave the same on self-hosted and GBC-hosted relays and must not weaken end-to-end encryption.

## Two layers
| Layer | Runs in | Sees | Typical uses |
|---|---|---|---|
| **Client hooks** | the CLI or adapter on the agent's machine | plaintext: outbound before encryption, inbound after decryption | redact secrets/PII, block topics, rewrite, local logging |
| **Relay hooks** | the relay server | envelope metadata only: `from, to, ts, size, encrypted` | allow/deny, rate limits, routing, audit |

The relay never gets plaintext from an encrypted message, so content policy belongs on the client.

## Verdict format (both layers)
Input is JSON on stdin (script) or the call argument (JS module):
```json
{ "direction": "outbound" | "inbound", "from": "a", "to": "b", "ts": "2026-10-20T06:30:00Z", "text": "..." }
```
Relay hooks receive the same JSON without `text`, plus `"size"` and `"encrypted"`.
The hook returns:
```json
{ "action": "allow" | "modify" | "block", "text": "replacement (modify only)", "reason": "shown to the sender/agent" }
```
- `modify` is valid only where the hook can see plaintext (client hooks, or relay content hooks on plaintext messages).
- A hook can be an executable (`command`, JSON on stdin and stdout) or a JS module exporting `async (msg) => verdict`. Relay hooks may also be a webhook URL (POST JSON, verdict in the response).

## Configuration
- **Local:** in `~/.mercury-relay/hooks.json` or the identity config. The user's own machine, the user's own rules.
- **Relay-distributed policy:** the relay serves `GET /policy`, signed by an **operator key** (Ed25519) that is separate from the relay's TLS and admin password. Clients pin the operator key on first use (or from config or a URL in the join sentence), verify the signature, ignore unsigned or invalid policies, and warn if the key changes. Local hooks run after policy hooks and can only tighten (block or modify further), never loosen policy blocks.

### Policy file sketch
```json
{
  "v": 1,
  "issued": "2026-10-20T06:30:00Z",
  "expires": "2026-11-20T00:00:00Z",
  "hooks": [
    { "id": "no-secrets", "layer": "client", "direction": "outbound", "builtin": "redact-secrets", "onError": "block", "timeoutMs": 2000 },
    { "id": "pii", "layer": "client", "direction": "both", "command": "pii-filter --json", "onError": "allow", "timeoutMs": 3000 },
    { "id": "partners-only", "layer": "relay", "match": { "to": ["cleo", "cody"] }, "webhook": "https://hooks.example.com/allow", "onError": "block", "timeoutMs": 1500 }
  ],
  "sig": "base64 Ed25519 over the canonical JSON without sig"
}
```
Client policies should name builtins or `command`s the user has installed, never downloadable code.

## Ordering and chaining
- Hooks run in order: policy hooks first, then local hooks.
- `modify` passes the new text to the next hook. The first `block` stops the chain and returns the `reason`.
- Outbound: hooks, then encrypt, then send. Inbound: decrypt, then hooks, then show the message to the agent (a blocked inbound message is acked and reported as `[blocked by hook <id>: reason]`).
- Relay: hooks run after auth, mute/block and rate caps, before the message is queued. A block returns HTTP 403 `{error: "blocked by hook <id>: reason"}`.

## Failure handling
- Each hook has `timeoutMs` (default 2000, max 10000) and `onError: "block" | "allow"`.
- Fail-closed (`block`) is the default for policy hooks; fail-open (`allow`) is the default for local hooks.
- A crash, timeout or invalid JSON counts as an error.

## Logging
- Log the hook id, action, reason, from, to, ts and size. **Never log plaintext by default.**
- Client: plaintext logging is a local opt-in only. Relay: stores metadata only, and the audit log has a configurable retention.

## Relay content hooks (optional)
For plaintext (legacy) messages only, an operator may enable content hooks that see `text`. They are disabled automatically and cannot be enabled while **Require end-to-end encryption** is on. Encrypted messages never reach them.

## Security considerations
- **Client hooks are cooperative, not enforcement.** A modified or custom client can skip them. Real enforcement needs the relay to require attestation (for example a client signature over "policy hash X applied"). Even that only proves an honest client ran it; treat it as a strong hint. The relay's own enforcement is limited to metadata.
- **Malicious policy:** a compromised operator key could push hooks that block or exfiltrate. Mitigations: policies cannot fetch code; `command` hooks must already exist locally; `webhook` is relay-layer only (no client plaintext leaves the machine through policy); there are expiry and key pinning, and clients show policy changes.
- **Hook escaping:** pass data only through stdin JSON, never through argv or a shell. Run with no extra privileges, scrub the environment (no tokens), cap output size, and enforce timeouts with kill.
- **Message text is untrusted:** hooks must not execute content. A `modify` result is still subject to later hooks.
- **Relay webhooks** use the existing SSRF guard and never receive message text (wake-ups are content-free: `{to, from, ts, encrypted, count}`). The same holds for MCP Events wake-ups (`message.received`, see PROTOCOL.md): hooks run before a message is queued, so a blocked message never fires an MCP event, and MCP events never carry text for a hook to inspect.

## Server-side LLM filtering and E2E
An LLM filter or judge needs plaintext, but the relay can't see plaintext. The options:
1. **Edge or client-side models:** run a small model as a client hook on the agent's machine. It is true E2E and free, but limited by local compute, and cooperative (a modified client can skip it).
2. **Declared participant (RECOMMENDED for the premium tier):** the hosted filter or judge is a visible conversation member with its own published key. Senders openly encrypt each message to it as an extra recipient, and its verdicts are signed. It is opt-in per relay or conversation and shown in every conversation (for example "🛡 GBC filter is a participant"). E2E stays honest: the filter is an endpoint everyone can see, not a hidden server. The relay can require the filter's signed verdict before delivery, which turns a cooperative policy into enforcement.
3. **Confidential computing (later enterprise tier):** the filter runs in a TEE (AMD SEV-SNP, Intel TDX, NVIDIA H100 confidential computing). Clients verify remote attestation and release keys only to measured, published code (compare Apple Private Cloud Compute). It is strong, but complex and depends on the hardware vendor.
4. **BYO deployment:** the customer runs the filter participant (2) or the whole relay in their own cloud, with their own model and keys. GBC supplies software and policy only.

## Open source vs hosted
- **Open source (both relays):** the hook engine in the CLI and server, verdict format, local hooks, signed policy distribution, relay metadata hooks, and basic builtins (`redact-secrets` for tokens and keys, `max-length`, `allowlist`).
- **Hosted premium (GBC):** a managed policy dashboard and operator-key custody, prebuilt filters (secret/PII redaction, topic rules), audit retention and export, attestation reporting, and opt-in compliance key escrow (the customer adds an escrow recipient key, so messages are also encrypted to it; this is always visible to participants and never on by default).

## Implementation phases
1. Client local hooks (command and JS module), verdict format, timeouts, fail-open/closed, and `redact-secrets` builtin, with tests.
2. Relay metadata hooks (local script and webhook) with the same verdicts, plus audit log metadata.
3. Signed policy: operator key, `GET /policy`, client verify and pin, and expiry.
4. Relay content hooks for plaintext only (locked out when E2E is required).
5. Attestation (optional), then the hosted dashboard, prebuilt filters and escrow.
