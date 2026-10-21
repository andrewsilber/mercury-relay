# Decision model (design, not built yet)

Some client features have to decide things about a message: whether to wake the agent now, whether a thread has reached agreement, whether to set a check-back reminder. The **decision model** makes those calls.

## Where it runs

- The decision model **always runs on the client**, because it needs plaintext. The relay never sees message content.
- It sits behind one small, swappable interface that is passed in (dependency-injected), so the rest of the client doesn't care which model is behind it.
- **Default: built-in rules.** These are deterministic and local, need no key, and make no network calls.
- **Opt-in providers:**
  - `typesafe`: Jev, called directly at TypeSafe.
  - `openrouter`: Jev or another model, called through OpenRouter.
  - `url`: a custom HTTPS endpoint.
  - `command`: a local program that reads a question on stdin and writes an answer on stdout.
- **Space policy:** a space owner can sign a policy listing which decision models members may use, for example "rules only" or "rules or Jev". Clients enforce the policy and refuse any provider it doesn't allow.

## Jev (TypeSafe "System One")

- Direct: `POST https://api.typesafe.ai/v1/systemone` with `model: "jev-latest"` (or a pinned version), a state, and typed questions (noun, choice, score).
- On OpenRouter it's listed as `typesafe/jev-1.13`.
- It's priced per input token, and very cheap.

## Self-hosters

Self-hosters choose their own model and supply their own key in the client config. The relay has no part in this.

## Hosted subscribers who want true E2E and accept Jev

Most users won't type CLI commands, so this has to work from the portal alone.

1. The subscriber turns on a toggle in the portal: "Use Jev (included)".
2. The platform uses an OpenRouter **Management API** key to mint a per-subscriber key: `POST /api/v1/keys` with a `limit` and a `limit_reset` (daily, weekly or monthly).
3. The key is **encrypted to the agent's public key** and delivered when the agent next checks in. The relay only ever holds ciphertext.
4. The client decrypts the key and calls Jev on OpenRouter **directly**. No message text touches our servers.
5. The platform tracks each key's spend and can rotate or revoke it (disable or delete it through the Management API) when a subscription ends or a key is abused.

**Rejected: a server-side proxy for Jev.** Our servers would see plaintext, which breaks E2E.

**Why OpenRouter for hosted keys:** TypeSafe direct has no key-provisioning API. Its keys are made by hand in the console and have no per-key spend cap. So hosted keys come from OpenRouter and are billed from one platform account with prepaid credits (auto top-up optional). Users who bring their own TypeSafe key can still use the `typesafe` provider.

## Agreed architecture

- **Delivery primitives are native** to the relay and client: `remind` (with cancel and snooze), `ack`, and rate limits.
- **Anything that reads content** runs in the client or in a participant plugin, meaning an agent in the space that members can see.
- **The relay stays a simple encrypted pipe** with no business logic.

See also [HOOKS.md](HOOKS.md), [HOSTED.md](HOSTED.md).
