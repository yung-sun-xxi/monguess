#!/bin/bash
# Print the newest games from the MonGuess game log (Workers KV, written by functions/api/log.js).
#   scripts/logs.sh          the last 10 games, one block per game
#   scripts/logs.sh 30       the last 30
#   scripts/logs.sh --raw    the stored JSON records, one per line
# Token and account come from the Keychain like scripts/deploy.sh (monguess-cloudflare,
# monguess-cloudflare-account); the token needs "Workers KV Storage: Edit". The namespace id
# is read from wrangler.toml, its one home.
set -euo pipefail
cd "$(dirname "$0")/.."

count=10
raw=0
for arg in "$@"; do
  case "$arg" in
    --raw) raw=1 ;;
    *[!0-9]* | '') echo "Usage: scripts/logs.sh [N] [--raw]" >&2; exit 2 ;;
    *) count="$arg" ;;
  esac
done
if [ "$count" -lt 1 ] || [ "$count" -gt 1000 ]; then
  echo "N must be between 1 and 1000." >&2
  exit 2
fi

namespace="$(python3 -c '
import sys, tomllib
for ns in tomllib.load(open("wrangler.toml", "rb")).get("kv_namespaces", []):
    if ns.get("binding") == "LOG":
        print(ns["id"])
')"
if [ -z "$namespace" ]; then
  echo "No KV namespace with binding LOG in wrangler.toml." >&2
  exit 1
fi

key() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null || true; }
token="$(key monguess-cloudflare)"
account="$(key monguess-cloudflare-account)"
if [ -z "$token" ] || [ -z "$account" ]; then
  echo "No Cloudflare token or account ID in the Keychain (monguess-cloudflare, monguess-cloudflare-account)." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The token goes to curl through a file, so it never shows in the process list.
( umask 077; printf 'Authorization: Bearer %s\n' "$token" > "$work/auth" )
base="https://api.cloudflare.com/client/v4/accounts/$account/storage/kv/namespaces/$namespace"

# GET into a file; anything but 200 prints Cloudflare's answer and stops.
get() {
  local status
  status="$(curl -sS --max-time 30 -H @"$work/auth" -o "$2" -w '%{http_code}' "$1")"
  if [ "$status" != 200 ]; then
    echo "Cloudflare answered HTTP $status for ${1#"$base"}:" >&2
    cat "$2" >&2
    echo >&2
    exit 1
  fi
}

# Keys sort newest first (functions/api/log.js), so the first N of the list are the newest.
# The API takes 10 to 1000 keys per page.
get "$base/keys?limit=$(( count < 10 ? 10 : count ))" "$work/keys.json"
python3 - "$work/keys.json" "$count" > "$work/names" <<'PY'
import json, sys
for k in json.load(open(sys.argv[1]))["result"][: int(sys.argv[2])]:
    print(k["name"])
PY

i=0
while IFS= read -r name; do
  i=$((i + 1))
  get "$base/values/$name" "$work/value-$(printf '%04d' "$i").json"
done < "$work/names"

python3 - "$raw" "$work" <<'PY'
import glob, json, os, sys, time

raw, work = sys.argv[1] == "1", sys.argv[2]
files = sorted(glob.glob(os.path.join(work, "value-*.json")))
if not files:
    if not raw:
        print("No games in the log yet.")
    sys.exit(0)

def show(g):
    started = g.get("startedAt")
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(started / 1000)) if isinstance(started, (int, float)) else "?"
    s = g.get("settings")
    mode = "challenge link" if g.get("challenge") else (
        "sources %s, spheres %s, %s rounds" % ("+".join(s.get("sources") or []), s.get("spheres"), s.get("rounds")) if s else "no settings")
    head = [
        when,
        g.get("name") or "(no name)",
        mode,
        "built in %.1f s" % ((g.get("buildMs") or 0) / 1000),
        "finished" if g.get("finished") else "not finished",
        "total %s" % g.get("total", 0),
    ]
    print(" | ".join(head))
    guesses = g.get("guesses") or []
    for n, r in enumerate(g.get("rounds") or [], 1):
        line = "  %2d. %s/%s %s %s  %.5f, %.5f" % (
            n, r.get("src"), r.get("kind") or "?", r.get("cc"), r.get("id"), r.get("lat") or 0, r.get("lon") or 0)
        if n <= len(guesses):
            line += "  guess %.1f km, %s points" % (guesses[n - 1].get("km") or 0, guesses[n - 1].get("points"))
        else:
            line += "  no guess"
        print(line)
    for e in g.get("errors") or []:
        where = "round %s" % e["round"] if e.get("round") is not None else "start"
        print("  error (%s): %s" % (where, e.get("message")))
    print()


for path in files:
    text = open(path, encoding="utf-8").read()
    if raw:
        print(text)
        continue
    try:
        show(json.loads(text))
    except Exception:
        # Anyone can post to /api/log: a record of the wrong shape is shown, not fatal.
        print("(record of an unexpected shape) %s\n" % text[:300])
PY
