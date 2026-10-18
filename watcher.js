#!/usr/bin/env node
// Long-polls using saved config, prints the first batch of messages, acks them, exits 0.
require('./relay.js').wait(require('./relay.js').loadConf() || (console.error('Run: node relay.js init <handle>'), process.exit(2)));
