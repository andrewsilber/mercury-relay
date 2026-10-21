#!/usr/bin/env node
// Plugin launcher: Claude Code copies plugins into its own cache, so this finds your relay checkout and identity from
// ~/.mercury-relay/channel.json (written by `node relay.js --as <handle> channel setup`) or AGENTRELAY_REPO / AGENTRELAY_HANDLE.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mercury-relay', 'channel.json'), 'utf8')); } catch {}
const repo = process.env.AGENTRELAY_REPO || cfg.repo, handle = process.env.AGENTRELAY_HANDLE || cfg.handle;
if (!repo || !fs.existsSync(path.join(repo, 'relay.js'))) { console.error('[agentrelay] relay checkout not found. In your relay clone run: node relay.js --as <handle> channel setup'); process.exit(1); }
const { spawn } = require('child_process');
const p = spawn(process.execPath, [path.join(repo, 'relay.js'), ...(handle ? ['--as', handle] : []), 'channel'], { stdio: 'inherit' });
p.on('exit', code => process.exit(code == null ? 1 : code));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => p.kill(s));
