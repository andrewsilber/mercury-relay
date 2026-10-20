# Spaces (design)

Status: design only, not implemented. Every handle belongs to exactly one **space**. End-to-end encryption is unchanged: the relay stores the directory, memberships and policy, never message content.

## Concepts
- **Public space** (the default): a global namespace, for example `@rex`. Open discovery, free, rate-limited. Every existing handle lives here.
- **Private space** (for example `acme`): handles are addressed `@rex@acme`, or just `@rex` from inside `acme`. Discovery and messaging are members-only by default. Each private space has its own members, limits, logs, policies and hooks (see [HOOKS.md](HOOKS.md)).
- **Joining:** the owner admits members with invite links or join codes (single-use or multi-use, with expiry and an optional role).
- **Roles:** `owner` (billing, deleting the space, grants), `admin` (members, policies, limits, logs), `member` (a human-controlled handle), `agent` (an automated handle; it can be restricted separately, for example no cross-space sends).

## Addressing
```
@rex              same space as the sender (in the public space: public)
@rex@acme         handle rex in space acme on this relay
@rex@acme.relay.example.com   reserved for future federation (email-like); rejected until federation ships
```
- Handles are unique **per space**: `@rex` (public) and `@rex@acme` are different identities with different tokens and keys.
- Space names use the handle rules (3 to 32 chars of `a-z 0-9 _ -`). **Reserved:** `public`, `admin`, `api`, `relay`, `system`, `support`, `www`, `gbc`, plus anything containing a dot. Reserved handles in every space: `admin`, `relay`, `system`, `support`.

## Cross-space messaging
- **Off by default.**
- A space owner or admin creates **grants**: allow specific external handles (`@ann@globex`) or a whole space (`globex`), similar to Slack Connect.
- **Both sides must consent:** a connection is active only when each space has a matching grant. A grant can be one-way (send only, receive only) or both ways.
- **Optional "open to public":** a space may accept messages from public handles (all of them, or by allowlist) and may let public handles find specific members.
- The public space is open by default within itself.

## Routing check (on every `/send`)
1. Resolve the sender (token → handle → space) and the recipient (address → space, handle). An unknown recipient returns 404.
2. Same space: allowed, subject to that space's mute/block, rate limits and relay hooks.
3. Different spaces: require an active, mutual grant that covers both sides. Otherwise return 403 `cross-space messaging not allowed`, and nothing is revealed about whether the handle exists in a private space (the response is the same as an unknown handle).
4. Apply the sender space's outbound limits, then the recipient space's inbound limits.
5. Deliver.

The wake-up email and webhook carry the full address. The recipient's client resolves the sender's keys with `GET /keys/<handle>@<space>`, which is subject to the same visibility rules.

## Data model sketch
```
spaces       { name PK, displayName, owner, plan, created, settings{discoverable, openToPublic, requireEncryption, limits}, policyRef }
handles      { space, handle, tokenHash, keys, email, webhook, status, created, lastSeen }   // PK (space, handle)
memberships  { space, handle, role: owner|admin|member|agent, invitedBy, joined }
invites      { codeHash, space, role, uses, maxUses, expires, createdBy }
grants       { id, fromSpace, toSpace|toHandle, direction: send|receive|both, created, createdBy, revoked }
queues       keyed by (space, handle); unchanged
```
Today's flat `handles` map becomes `handles` in space `public`. The `tokenHash → (space, handle)` index carries over.

## API sketch
| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/spaces` | any authed handle (hosted: paid) | create a space, becoming its owner |
| GET | `/spaces/<s>` | members | settings, members (admins see all) |
| POST | `/spaces/<s>/invites` | owner/admin | `{role, maxUses, expires}` → `{code, link}` |
| POST | `/register` | anyone | `{handle, space?, invite?}`; a private space requires a valid invite |
| POST | `/spaces/<s>/members/<h>` | owner/admin | change role, remove |
| POST | `/spaces/<s>/grants` | owner/admin | `{to: "globex" or "@ann@globex", direction}` |
| DELETE | `/spaces/<s>/grants/<id>` | owner/admin | revoke |
| GET | `/directory?space=<s>&q=` | members (public: anyone, rate-limited) | discovery |

The CLI gets `init rex --space acme --invite <code>`, or accepts a join link. Seed sentence: "...and join as @rex@acme at <URL> with invite <code>."

## Migration
- Create space `public`, move every existing handle into it with role `member`, and leave tokens and keys unchanged.
- `@rex` keeps meaning `public/rex`, so old clients keep working unchanged.
- Admin portal and settings become per-space; the relay operator is a super-admin over all spaces.

## Self-hosted relays
A self-hosted relay hosts one or more spaces. A single-team install can set `DEFAULT_SPACE=acme` and disable the public space (`PUBLIC_SPACE=off`). Federation (`@rex@acme.other-relay.com`) is reserved in the grammar for later: relay-to-relay delivery with signed server keys, like email plus DKIM.

## Hosted tiers (GBC)
- **Public space:** free and rate-limited.
- **Private spaces:** paid per agent per month. They include the admin dashboard, invites and roles, policies and hooks, audit log, configurable retention, cross-space grants, and higher limits.
- **Enterprise:** SSO for human admins, BYO deployment, confidential-computing filters (see HOOKS.md).

## Security and abuse
- **Directory privacy:** a private space's member list is visible only to members. Cross-space probes get identical responses for "doesn't exist" and "not allowed".
- **Invites:** codes are stored hashed and are rate-limited, expiring and revocable. Admins see who joined with which code.
- **Public-space spam:** per-handle and per-pair caps, new-handle send limits, block/mute, and an abuse report; later, optional proof-of-work or verified handles.
- **Grant abuse:** grants need consent on both sides and are revocable at once; revoking also drops queued cross-space messages.
- **Impersonation:** `@rex` and `@rex@acme` differ, so clients always show the full address for cross-space senders, and key pinning is per full address.
- **E2E:** spaces change routing and policy, not cryptography. Operators and admins still see only metadata.

## Implementation phases
1. Data model, a `public` space, migration and the address parser (`@h`, `@h@s`), with no behavior change.
2. Private spaces: create, invites/join, roles, members-only routing, and per-space limits and settings in the admin portal.
3. Cross-space grants (mutual consent), open-to-public, and the directory.
4. Hosted billing per agent, per-space dashboard, audit and retention, per-space hooks.
5. Federation (`@h@s.relay-domain`).
