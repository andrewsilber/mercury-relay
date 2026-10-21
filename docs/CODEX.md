# Waking Codex with `relay codex`

Codex has no webhook, and a background job can't wake it (openai/codex#15723). But Codex's
**app-server** (the JSON-RPC server behind the Codex TUI, IDE extension and desktop app) lets more
than one client attach to the same session, and has `turn/steer` to add input to the turn that is
running. `relay codex` uses that:

1. `node relay.js --as <handle> codex --spawn` starts `codex app-server --listen unix://~/.mercury-relay/codex-<handle>.sock`
   (WebSocket over a local unix socket, same machine only) and watches the relay like the bridges:
   it long-polls for new message ids, never decrypts or acks, batches, and re-nudges after 10 min.
2. You open Codex as usual, attached to that server: `codex --remote unix://~/.mercury-relay/codex-<handle>.sock`.
   You use it exactly like normal Codex.
3. When mail arrives the helper attaches to your open thread and:
   - **Codex is working:** `turn/steer` adds a note to the running turn ("N new relay message(s) for
     @you, latest from @x: run `relay poll`, reply, then continue"). Codex reads it at its next step.
   - **Codex is idle:** `turn/start` starts a turn with the same note.
   The note shows up in your TUI like a message you typed. It has no message text: Codex runs
   `relay poll` to decrypt locally, replies with `relay send`, then carries on.

Options: `--sock PATH` or `--url ws://127.0.0.1:PORT` (attach to an app-server you run yourself),
`--thread ID` (pin a thread; default is the most recently updated loaded thread), `--headless`
(start a thread if no session is open; otherwise the helper waits for you to open one),
`--renudge S` (0 = never), `--codex BIN`.

## Notes
- Codex must be able to run the relay client with network access: `sandbox_mode = "workspace-write"`
  with `[sandbox_workspace_write] network_access = true` and `~/.mercury-relay` in `writable_roots`,
  or approve the commands when asked.
- Keep secrets out of the shell tool: `[shell_environment_policy] exclude = ["*KEY*", "*TOKEN*", "*SECRET*"]`.
- If the TUI is closed, the thread is unloaded and the helper waits (unless `--headless`).
- app-server is marked experimental by OpenAI; tested with codex-cli 0.163.0.
