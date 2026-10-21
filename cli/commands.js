// The one command table. Usage text, `relay help`, and the footer on every wake-up note are all
// generated from it, so they can never drift from what the CLI actually accepts.
'use strict';
const COMMANDS = [
  // core: shown in the wake-up footer
  { name: 'poll', core: true, usage: 'poll', desc: 'read and acknowledge new messages' },
  { name: 'send', core: true, usage: 'send <to>[,<to2>...] [--re <id>] [--file <path>]... [--ack] [--force] <text>', short: 'send <to> --re <id> "<text>"', desc: 'send a message (pure acks go out as --ack automatically; start with FINAL or DONE when the work is finished)' },
  { name: 'reply-all', core: true, usage: 'reply-all [--file <path>]... [--force] <text>', short: 'reply-all "<text>"', desc: 'reply to everyone on the last group message' },
  { name: 'remind', core: true, usage: 'remind <@h|@me> in <10m|2h|1d> [--every 5m] <text> | remind <@h|@me> at <ISO> <text> | remind list | remind cancel <id> | remind snooze <id> <10m>', short: 'remind @me in 10m "<text>"', desc: 'scheduled message; list, cancel, snooze' },
  { name: 'status', core: true, usage: 'status', desc: 'unread, reminders, open conversations, spaces, version' },
  { name: 'help', core: true, usage: 'help', desc: 'all commands, with your current state' },
  // the rest
  { name: 'inbox', usage: 'inbox [--last N] [--since MIN]', desc: 'messages already received on this computer' },
  { name: 'wait', usage: 'wait [--once]', desc: 'block until a message arrives (only where you cannot be woken)' },
  { name: 'members', usage: 'members [space]', desc: 'members of a space' },
  { name: 'space', usage: 'space create <name> | space invite <name> [--name <handle> [--require-name]] [--uses N] [--expires 15m] | space delete <name>', desc: 'manage spaces you own' },
  { name: 'config', usage: 'config | config set <key> <value> | config unset <key>', desc: 'guardrail thresholds and decision model (keys: ' + 'guard.*, decision.*)' },
  { name: 'init', usage: 'init <handle> [--url URL] [--invite <CODE>] [--space <name>]', desc: 'register an identity' },
  { name: 'whoami', usage: 'whoami [--all]', desc: 'this identity and key fingerprint' },
  { name: 'use', usage: 'use <handle>', desc: 'default identity on this computer' },
  { name: 'setup', usage: 'setup [--test]', desc: 'wake-up readiness check' },
  { name: 'wake', usage: 'wake [--email A] [--webhook URL --webhook-key K] [--mode email-then-webhook|both]', desc: 'configure wake-ups' },
  { name: 'webhook', usage: 'webhook <url> [--header "Name: value"]... | webhook --clear', desc: 'webhook wake-up' },
  { name: 'email', usage: 'email <address> | email --clear', desc: 'email wake-up' },
  { name: 'connect-code', usage: 'connect-code', desc: 'one-time code for an MCP client (e.g. a ChatGPT dot)' },
  { name: 'channel', usage: 'channel [setup [--project]]', desc: 'Claude Code channel MCP server' },
  { name: 'bridge', usage: 'bridge openclaw [--url U] [--agent A] | bridge hermes [--url U] [--route R] | bridge webhook <localUrl> [--header H] [--body JSON]', desc: 'forward content-free wake-ups to a local agent' },
  { name: 'codex', usage: 'codex [--sock P] [--spawn] [--thread ID]', desc: 'wake a running Codex session' },
];
const byName = Object.fromEntries(COMMANDS.map(c => [c.name, c]));
const prefix = (repo, handle) => `node ${repo ? require('path').join(repo, 'relay.js') : 'relay.js'} --as ${handle}`;
// One line, short enough for every wake-up note.
function footer(handle, repo) {
  return `[relay] commands (${prefix(repo, handle)} ...): ` + COMMANDS.filter(c => c.core).map(c => c.short || c.usage).join(' | ');
}
function usageText() { return 'usage: relay [--as <handle>] <command>\n' + COMMANDS.map(c => '  ' + c.usage).join('\n'); }
function helpText() { return COMMANDS.map(c => `  ${c.usage}\n      ${c.desc}`).join('\n'); }
module.exports = { COMMANDS, byName, footer, usageText, helpText };
