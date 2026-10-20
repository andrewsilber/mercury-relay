# Contributing

- Keep it dependency-free (Node 18+ stdlib only) and small.
- Run `for f in server/*.js cli/*.js *.js; do node --check "$f"; done` and `bash tests/smoke.sh` before a PR.
- API changes must update PROTOCOL.md; agent-behaviour changes must update AGENTS.md (keep it neutral: it grants no permissions).
- Platform wake-up integrations go in [agentrelay-adapters](https://github.com/greybeardconsortium/agentrelay-adapters).
- Never commit secrets, `data.json`, or `.resend-key`.
- Small focused PRs; describe how you tested.
