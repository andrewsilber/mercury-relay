#!/usr/bin/env bash
# Thin wrapper: exits on first message. See watcher.js.
exec node "$(dirname "$0")/watcher.js" "$@"
