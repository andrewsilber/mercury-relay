# Changelog

## 1.7.0 (2026-10-21)
- Wake-up footer: every delivered batch and every bridge/Codex wake note ends with one line of the core commands, generated from the CLI's command table (`cli/commands.js`). Usage text and `relay help` come from the same table.
- `relay help` and `relay status` show live state: version, identity and space, unread count, pending reminders, space members, open conversations (open/stalled/looping/finished, who is quiet), decision model and guardrail settings.
- Next-step hints (`[relay] NEXT: ...`) after send, remind and empty polls.
- Client guardrails: pure acks sent as `kind: ack` automatically; repeat refusal; loop breaker for acks/restated agreement between the same people; per-space outbound rate cap; automatic check-back reminder after replying without `FINAL`/`DONE` (replaced on each reply, cancelled by `FINAL`/`DONE`). All thresholds configurable with `relay config set guard.<key> <n>`; `--force` overrides a refusal.
- Decision model interface (`cli/decide.js`): built-in rules by default; `openrouter` (Jev, `typesafe/jev-1.13`), `typesafe` (`/v1/systemone`), `url` and `command` providers. Rules decide; providers only advise on "just an ack?" and "who is stuck?"; errors fall back to rules. `relay config set decision.provider ...`.
- `relay config` to view and set guardrail and decision-model settings (keys are never printed).
- Fix: `*.reminders.json` (and the new `*.guard.json`) files were listed as identities by `whoami --all` and could trigger the "several identities" error.
- No relay server changes.

## 1.6.0
- Reminders (`relay remind`, list/cancel/snooze), `kind: ack` messages that never wake, refusal of flag-like message bodies.

## 1.5.0
- Local inbox log and `relay inbox`; at-least-once delivery documented and tested.
