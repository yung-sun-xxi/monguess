# MonGuess

A static GeoGuessr-style web game covering every country: `index.html`, `style.css`,
`lib.js` (pure functions), `fx.js` (animations: reels, confetti, winner screen,
loading globe), `app.js` (DOM and network), `data/places.json`. No build step.
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
- `scripts/deploy.sh` deploys the rooms Worker `monguess-rooms` (`rooms/`), then publishes
  to Cloudflare Pages project `monguess` (https://monguess.pages.dev), and refuses anything
  but a clean `master` that matches `origin/master`. Keychain: `monguess-cloudflare`,
  `monguess-cloudflare-account`. After a deploy, `node scripts/room-smoke.js
  https://monguess.pages.dev` proves the rooms are live.
- After every update, open the game in Safari for the owner without being asked: after a
  deploy, `open -a Safari https://monguess.pages.dev`; when a change waits on his by-eye
  "ok" before merge, serve the branch on port 8765 and `open -a Safari http://localhost:8765`.

## Identifiers

- GitHub `yung-sun-xxi/monguess`, private, default branch `master`.
- Google key: GCP project "Claude MCP" (`claude-mcp-19158`), Maps JavaScript API only.
- Mapillary app id `28579063211766158` (READ only). The first app, `30592537330350355`, is
  broken on Mapillary's side: valid token, yet every image read is empty or subcode 33.

## Traps

- On localhost, Google user photospheres often come back black (HTTP 429 from
  `lh3.googleusercontent.com` for tiles); Google's own imagery renders fine. Judge
  photospheres on https://monguess.pages.dev, not locally.
- Mapillary Graph `/images?bbox` search fails on boxes larger than about 0.006°
  (HTTP 500 or a 30-40 s wait, measured 2026-10-22), so places are found through z14
  vector tiles; the Graph API is used only to open one image by id.
- The friends link `#c=` is base64 of the answers (and of the scoring mode, for a classic
  game). Anyone can decode it; that is by design for a friends-only game.
- A browser smoke test of a worktree needs port 8765 free: a `scripts/play.sh` left running
  by another session holds it.
