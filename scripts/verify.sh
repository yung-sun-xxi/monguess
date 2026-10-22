#!/bin/bash
# The one build-and-test recipe for MonGuess. Exit 0 means green. README, CI and the
# agent instructions call this script; none of them repeat its commands.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== syntax"
for f in lib.js fx.js app.js functions/api/log.js "functions/api/room/[id].js" rooms/index.js rooms/rules.js scripts/room-smoke.js scripts/mutate.js; do
  node --check "$f"
done
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' scripts/serve.py
for f in scripts/deploy.sh scripts/play.sh scripts/verify.sh scripts/logs.sh; do bash -n "$f"; done
echo "ok: lib.js fx.js app.js functions/api/log.js functions/api/room/[id].js rooms/index.js rooms/rules.js room-smoke.js mutate.js serve.py deploy.sh play.sh verify.sh logs.sh"

echo "== unit tests"
node --test tests/*.test.js

echo "verify: green"
