#!/usr/bin/env node
// Smoke test of live rooms: node scripts/room-smoke.js <base-url>
// e.g. http://localhost:8788 (wrangler pages dev) or https://monguess.pages.dev.
// Opens two sockets to room A and one to room B, sends from A1, and checks that A2 gets the
// message while A1 (the sender) and B1 do not. Exit 0 on pass, 1 on any failure or timeout.
// Needs Node 22+ for the global WebSocket.

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/room-smoke.js <base-url>');
  process.exit(1);
}
const DEADLINE_MS = 15000;
const QUIET_MS = 1500;

const rand = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
const run = rand();
const roomA = `smk${run}a`;
const roomB = `smk${run}b`;
const wsUrl = (room) => `${base.replace(/^http/, 'ws').replace(/\/$/, '')}/api/room/${room}`;

const log = (line) => console.log(line);
const fail = (why) => {
  log(`FAIL: ${why}`);
  process.exit(1);
};
setTimeout(() => fail(`no verdict within ${DEADLINE_MS} ms`), DEADLINE_MS).unref();

function open(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(room));
    ws.received = [];
    ws.addEventListener('message', (e) => {
      ws.received.push(String(e.data));
      log(`${name} received: ${e.data}`);
    });
    ws.addEventListener('open', () => {
      log(`${name} open: ${wsUrl(room)}`);
      resolve(ws);
    });
    ws.addEventListener('error', () => reject(new Error(`${name} could not connect to ${wsUrl(room)}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bad = await fetch(`${base.replace(/\/$/, '')}/api/room/Bad-Id`);
  log(`bad id -> HTTP ${bad.status}`);
  if (bad.status !== 400) fail(`expected HTTP 400 for a bad room id, got ${bad.status}`);

  const [a1, a2, b1] = await Promise.all([open('A1', roomA), open('A2', roomA), open('B1', roomB)]);
  const text = `hello from A1 ${run}`;
  a1.send(text);
  log(`A1 sent: ${text}`);

  for (let waited = 0; !a2.received.length && waited < 5000; waited += 50) await sleep(50);
  await sleep(QUIET_MS);

  if (a2.received.length !== 1 || a2.received[0] !== text) {
    fail(`A2 expected exactly [${JSON.stringify(text)}], got ${JSON.stringify(a2.received)}`);
  }
  if (a1.received.length) fail(`A1 got its own message back: ${JSON.stringify(a1.received)}`);
  if (b1.received.length) fail(`B1 in another room got: ${JSON.stringify(b1.received)}`);
  for (const ws of [a1, a2, b1]) ws.close(1000, 'done');
  log('PASS: A2 got the message; A1 and B1 got nothing');
  process.exit(0);
}

main().catch((e) => fail(e.message));
