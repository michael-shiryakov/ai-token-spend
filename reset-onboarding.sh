#!/usr/bin/env bash
# Dev convenience: reset back to first-run onboarding without hand-editing .env.
# SETUP_MODE is decided once, at process start, from whichever keys are in .env —
# there's no way to flip it from the browser alone, so this backs up any configured
# keys to .env.bak (never deletes them), clears .env, and restarts the server so it
# boots back into onboarding.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4173}"

if [ -s .env ]; then
  cp .env .env.bak
  echo "Backed up existing .env -> .env.bak"
fi
: > .env
echo "Cleared .env"

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  curl -s -X POST "http://localhost:$PORT/quit" -o /dev/null || true
  sleep 1
fi

echo "Starting server at http://localhost:$PORT (onboarding)..."
exec node --env-file-if-exists=.env server.mjs
