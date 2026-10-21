#!/bin/bash
# Run MonGuess locally with the keys from the macOS Keychain and open it in the browser.
# The Google key is restricted to http://localhost:8765/*, so the port is fixed.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8765
URL="http://localhost:$PORT/"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use, opening $URL"
  open "$URL"
  exit 0
fi

key() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null || true; }
export MG_MAPILLARY_TOKEN="$(key monguess-mapillary)"
export MG_GOOGLE_API_KEY="$(key monguess-google)"
if [ -z "$MG_MAPILLARY_TOKEN$MG_GOOGLE_API_KEY" ]; then
  echo "No keys in the Keychain (monguess-mapillary, monguess-google). See README." >&2
  exit 1
fi

(sleep 1 && open "$URL") &
exec python3 scripts/serve.py "$PORT"
