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

## Waiting on games: issue #20

Issue #20 (check the forgiveness-radius scoring against the game log) can start only once the
log holds 5 finished games played after the deploy of `d941d99`, so it is not `ready-for-agent`.
While it is open, the first session of the day in this repository, worktree or not, runs this
before its own task, from the main folder, where the gitignored script lives:

1. If `~/PersonalProjects/monguess/.agent/games-check.txt` already holds today's date, skip.
2. In `~/PersonalProjects/monguess`: `scripts/logs.sh 1000 --raw > .agent/log-20.jsonl &&
   node .agent/check-scoring.js .agent/log-20.jsonl 5`, then write today's date and the printed
   count to `.agent/games-check.txt`.
3. Exit 3 means fewer than 5 games: say nothing and go on with the session's task.
4. Exit 0 means enough: tell the owner first thing, put `ready-for-agent` back on #20, and offer to
   take it now. The PR that closes #20 removes this section.
