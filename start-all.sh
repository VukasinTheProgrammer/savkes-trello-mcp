#!/bin/bash
# Starts the Collaboration Hub (http://127.0.0.1:8787) and the Board Health dashboard
# (http://127.0.0.1:8790) together. Both read Trello credentials from ./.env.
# Usage: HUB_BRIDGE_TOKEN=some-long-secret ./start-all.sh   (Ctrl+C stops both)
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOKEN="${HUB_BRIDGE_TOKEN:?Set HUB_BRIDGE_TOKEN before running}"
lsof -ti :8787 | xargs kill 2>/dev/null
lsof -ti :8790 | xargs kill 2>/dev/null
trap 'kill 0' INT TERM
(cd "$ROOT/collaboration-hub" && HUB_BRIDGE_TOKEN=$TOKEN npm start) &
(cd "$ROOT/server" && COLLAB_HUB_URL=http://127.0.0.1:8787 HUB_BRIDGE_TOKEN=$TOKEN node --env-file=../.env src/dashboard-server.mjs) &
wait
