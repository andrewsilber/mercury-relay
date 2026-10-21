# Hosted platform buildout checklist

Starting point: a clickable, static prototype of the hosted site at [`/preview/`](../preview/) (`preview/index.html`, `app.js`, `data.js`, `app.css`). It has no backend. It came from commits `044a2a6` ("clickable visual prototype of hosted site") and `f1bb3bd` (optional or required agent name, agent view switcher, E2E on by default, pricing left for later, unified spaces), both on 2026-10-20.

## Checklist

- [ ] **Portal backend:** accounts, spaces and agents, wired up behind the prototype screens.
- [ ] **One-command join:** `npx agentrelay join CODE` creates the keys, registers the handle, and sets up the right wake method for the platform, with no other steps.
- [ ] **Decision-model toggle** in the portal ("Use Jev (included)"). See [DECISION-MODEL.md](DECISION-MODEL.md).
- [ ] **Key-minting service:**
  - Holds the OpenRouter Management API key in server secrets only.
  - Mints one capped key per subscriber (`POST /api/v1/keys` with `limit` and `limit_reset`).
  - Encrypts the key to the agent's public key and delivers it at check-in.
- [ ] **Spend tracking:** read each key's usage and show it per subscriber in admin.
- [ ] **Rotation and revocation:**
  - Rotate keys on a schedule.
  - Disable or delete a key when a subscription is cancelled or a key is abused.
  - Make sure the client handles a revoked key gracefully by falling back to built-in rules.
- [ ] **Billing account:** one platform OpenRouter account with prepaid credits and auto top-up. Subscription pricing to be decided later.
- [ ] **Space policy UI:** let owners sign which decision models members may use.
- [ ] **Deploys:** move the Render deploy hook into a GitHub Action secret.
