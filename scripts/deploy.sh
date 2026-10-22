#!/bin/bash
# Publish MonGuess: first the live-rooms Worker monguess-rooms (rooms/), then the site on
# Cloudflare Pages, whose Durable Object binding points at that Worker. The keys come from
# the macOS Keychain and are written only into the uploaded copy of config.js, never into
# the repository. Keychain items: monguess-mapillary, monguess-google, monguess-cloudflare
# (API token with "Cloudflare Pages: Edit", "Workers KV Storage: Edit" for the game log
# bound in wrangler.toml, and "Workers Scripts: Edit" for the rooms Worker and its Durable
# Object) and monguess-cloudflare-account (account ID; the token cannot list accounts, so
# wrangler needs it explicitly).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=monguess
WRANGLER=wrangler@4.151.3

# Only a clean master that matches origin goes live: a branch deployed from here would
# silently become the site.
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != master ] || [ -n "$(git status --porcelain)" ]; then
  echo "Deploy only from a clean master checkout (now on '$branch'$([ -n "$(git status --porcelain)" ] && echo ", with uncommitted changes"))." >&2
  exit 1
fi
git fetch -q origin master
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ]; then
  echo "Local master differs from origin/master: pull or push first." >&2
  exit 1
fi

key() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null || true; }
export CLOUDFLARE_API_TOKEN="$(key monguess-cloudflare)"
export CLOUDFLARE_ACCOUNT_ID="$(key monguess-cloudflare-account)"
if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "No Cloudflare token or account ID in the Keychain (monguess-cloudflare, monguess-cloudflare-account)." >&2
  exit 1
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cp index.html style.css lib.js fx.js app.js "$out"/
cp -R data "$out"/
MG_MAPILLARY_TOKEN="$(key monguess-mapillary)" MG_GOOGLE_API_KEY="$(key monguess-google)" python3 - "$out/config.js" <<'PY'
import json, os, sys
config = {"mapillaryToken": os.environ["MG_MAPILLARY_TOKEN"], "googleApiKey": os.environ["MG_GOOGLE_API_KEY"]}
open(sys.argv[1], "w").write("window.MG_CONFIG = %s;\n" % json.dumps(config))
PY

# The rooms Worker goes first: the Pages Function /api/room/<id> binds to its Room class.
(cd rooms && npx --yes "$WRANGLER" deploy)

# Without --force, wrangler 4.151 delegates creating a Pages project to Workers and fails;
# once the project exists, later commands run against Pages directly.
npx --yes "$WRANGLER" pages project list 2>/dev/null | grep -qw "$PROJECT" \
  || npx --yes "$WRANGLER" pages project create "$PROJECT" --production-branch master --force
npx --yes "$WRANGLER" pages deploy "$out" --project-name "$PROJECT" --branch master
