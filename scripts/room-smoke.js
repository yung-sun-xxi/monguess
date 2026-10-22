#!/usr/bin/env node
// Smoke test of live rooms: node scripts/room-smoke.js <base-url>
// e.g. http://localhost:8788 (wrangler pages dev) or https://monguess.pages.dev.
// Checks that a bad room id gets HTTP 400 and that a room nobody created refuses a join,
// then plays a 2-round no-timer game with two simulated players in a fresh room: Ann
// creates it, Bob joins and starts (any player may), both guess each round, round 2 starts
// by itself after the results, and the final table must equal lib.js scoring of the same
// guesses. Exit 0 on pass, 1 on any failure or timeout. Needs Node 22+ for the global
// WebSocket. Every run uses fresh random room ids; an unused room expires on its own.
'use strict';
const MG = require('../lib.js');
const places = require('../data/places.json');

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/room-smoke.js <base-url>');
  process.exit(1);
}
const DEADLINE_MS = 30000;
const WAIT_MS = 10000;

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

// The rounds, carrying forgiveKm exactly as the creating browser computes it.
const ROUNDS = [
  { src: 'g', id: `smoke-${run}-1`, lat: 41.3874, lon: 2.1686, cc: 'ES' },
  { src: 'g', id: `smoke-${run}-2`, lat: -33.8688, lon: 151.2093, cc: 'AU' },
].map((r) => ({ ...r, forgiveKm: MG.forgivenessKm(places[r.cc]) }));
const GUESSES = {
  ann: [{ lat: 40.4168, lon: -3.7038 }, { lat: -37.8136, lon: 144.9631 }],
  bob: [{ lat: 48.8566, lon: 2.3522 }, { lat: -36.8485, lon: 174.7633 }],
};

function open(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(room));
    ws.name = name;
    ws.received = [];
    ws.cursor = 0;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      ws.received.push(msg);
      log(`${name} <- ${msg.type}${msg.type === 'error' ? ` ${msg.code}` : ''}${'index' in msg ? ` #${msg.index}` : ''}`);
    });
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error(`${name} could not connect to ${wsUrl(room)}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
  log(`${ws.name} -> ${msg.type}`);
}

// The next message of this type after the ones already taken from this socket.
async function next(ws, type) {
  for (let waited = 0; waited < WAIT_MS; waited += 25) {
    const i = ws.received.findIndex((m, k) => k >= ws.cursor && m.type === type);
    if (i >= 0) {
      ws.cursor = i + 1;
      return ws.received[i];
    }
    await sleep(25);
  }
  return fail(`${ws.name} got no '${type}' within ${WAIT_MS} ms; got ${JSON.stringify(ws.received.map((m) => m.type))}`);
}

async function main() {
  const bad = await fetch(`${base.replace(/\/$/, '')}/api/room/Bad-Id`);
  log(`bad id -> HTTP ${bad.status}`);
  if (bad.status !== 400) fail(`expected HTTP 400 for a bad room id, got ${bad.status}`);

  const stray = await open('Stray', roomB);
  send(stray, { type: 'join', playerId: `stray${run}`, name: 'Stray' });
  const refused = await next(stray, 'error');
  if (refused.code !== 'no-room') fail(`a join to a room nobody created got ${JSON.stringify(refused)}`);
  stray.close(1000, 'done');

  const ann = await open('Ann', roomA);
  const bob = await open('Bob', roomA);
  send(ann, { type: 'create', playerId: `ann${run}`, name: 'Ann', settings: { mode: 'none' }, rounds: ROUNDS });
  await next(ann, 'state');
  send(bob, { type: 'join', playerId: `bob${run}`, name: 'Bob' });
  const lobby = await next(bob, 'state');
  if (lobby.phase !== 'lobby' || lobby.players.length !== 2) fail(`Bob's lobby: ${JSON.stringify(lobby)}`);
  send(bob, { type: 'start' });

  const expected = { Ann: [], Bob: [] };
  let resultsAt = 0;
  for (let i = 0; i < ROUNDS.length; i++) {
    const [ra, rb] = await Promise.all([next(ann, 'round'), next(bob, 'round')]);
    if (ra.index !== i || rb.index !== i) fail(`expected round ${i}, got ${ra.index} and ${rb.index}`);
    if ('lat' in ra.place) fail(`round ${i} leaked the answer: ${JSON.stringify(ra.place)}`);
    if (i > 0) log(`round ${i + 1} started ${Date.now() - resultsAt} ms after the results`);
    for (const [ws, who] of [[ann, 'ann'], [bob, 'bob']]) {
      const g = GUESSES[who][i];
      send(ws, { type: 'guess', round: i, lat: g.lat, lon: g.lon });
      const name = who === 'ann' ? 'Ann' : 'Bob';
      expected[name].push(MG.scoreFor(MG.distanceKm(ROUNDS[i], g), ROUNDS[i].forgiveKm));
    }
    const [res] = await Promise.all([next(ann, 'results'), next(bob, 'results')]);
    resultsAt = Date.now();
    for (const g of res.guesses) log(`  round ${i + 1}: ${g.name} ${Math.round(g.km)} km -> ${g.points}`);
  }

  const [final] = await Promise.all([next(ann, 'final'), next(bob, 'final')]);
  log('final table:');
  for (const row of final.table) log(`  ${row.name}: ${row.points.join(' + ')} = ${row.total}`);
  for (const name of ['Ann', 'Bob']) {
    const row = final.table.find((r) => r.name === name);
    const want = expected[name];
    const total = want.reduce((s, x) => s + x, 0);
    if (!row || JSON.stringify(row.points) !== JSON.stringify(want) || row.total !== total) {
      fail(`${name}: expected ${JSON.stringify(want)} = ${total}, got ${JSON.stringify(row)}`);
    }
  }
  for (const ws of [ann, bob]) ws.close(1000, 'done');
  log('PASS: two players, two rounds, auto-advance, final table equals lib.js scoring');
  process.exit(0);
}

main().catch((e) => fail(e.message));
