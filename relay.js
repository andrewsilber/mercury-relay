#!/usr/bin/env node
// Compatibility shim: agents run `node relay.js ...` from the repo root. The CLI lives in cli/relay.js.
module.exports = require('./cli/relay.js');
