# MonGuess

A static GeoGuessr-style web game covering every country: `index.html`, `style.css`,
`lib.js` (pure functions), `app.js` (DOM and network), `data/places.json`. No build step.
The process, branch rules and commit format come from `~/PersonalProjects/CLAUDE.md`;
this file holds only what is true of this repository.

## Check

```bash
scripts/verify.sh
```

Syntax of every file plus `node --test tests/*.test.js`. Exit 0 is green and the whole
authority to merge; CI (`.github/workflows/ci.yml`) runs the same script on Ubuntu.

## Run and deploy

- `scripts/play.sh` serves the main folder on http://localhost:8765 with `config.js`
  built from the Keychain (`monguess-mapillary`, `monguess-google`). The port is fixed:
  the Google key allows only `http://localhost:8765/*` and `https://monguess.pages.dev/*`.
  A session can serve a worktree the same way through `.claude/launch.json` (gitignored;
  a copy lives in the main folder) and the app's preview tools.
- `scripts/deploy.sh` publishes to Cloudflare Pages project `monguess`
  (https://monguess.pages.dev) and refuses anything but a clean `master` that matches
  `origin/master`. Keychain: `monguess-cloudflare`, `monguess-cloudflare-account`.
- After every update, open the game in Safari for the owner without being asked: after a
  deploy, `open -a Safari https://monguess.pages.dev`; when a change waits on his by-eye
  "ok" before merge, serve the branch on port 8765 and `open -a Safari http://localhost:8765`.

## Identifiers

- GitHub `yung-sun-xxi/monguess`, private, default branch `master`.
- Google key: GCP project "Claude MCP" (`claude-mcp-19158`), Maps JavaScript API only.
- Mapillary app id `30592537330350355`.

## Traps

- On localhost, Google user photospheres often come back black (HTTP 429 from
  `lh3.googleusercontent.com` for tiles); Google's own imagery renders fine. Judge
  photospheres on https://monguess.pages.dev, not locally.
- The Mapillary Graph API returns `{"data":[]}` for this app since 2026-10-19 (see
  issue #1 and the menu note). "Только Google" is first in the source list for that
  reason; re-test before planning around Mapillary.
- The friends link `#c=` is base64 of the answers. Anyone can decode it; that is by design
  for a friends-only game.
- A browser smoke test of a worktree needs port 8765 free: a `scripts/play.sh` left running
  by another session holds it.
