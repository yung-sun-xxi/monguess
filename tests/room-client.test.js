'use strict';
// The browser side of live rooms in lib.js: ids, the #r= link, the socket address, the
// create message and the words the lobby shows. The room itself is tests/rooms.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const MG = require('../lib.js');
const R = require('../rooms/rules.js');
const places = require('../data/places.json');

test('idFromBytes: one [a-z0-9] character per byte', () => {
  assert.equal(MG.idFromBytes([0, 9, 10, 35, 36, 71, 255]), '09az0z3');
  assert.equal(MG.idFromBytes(new Uint8Array(10)), '0000000000');
  const all = MG.idFromBytes(Uint8Array.from({ length: 256 }, (_, i) => i));
  assert.match(all, /^[a-z0-9]{256}$/);
  assert.equal(new Set(all).size, 36);
});

test('roomIdFromHash: the id of a #r= link, null for anything else', () => {
  assert.equal(MG.roomIdFromHash('#r=k3x9a0bq7z'), 'k3x9a0bq7z');
  assert.equal(MG.roomIdFromHash('#r=a'), 'a');
  assert.equal(MG.roomIdFromHash(`#r=${'a'.repeat(16)}`), 'a'.repeat(16));
  const bad = ['', '#', '#r=', '#r=ABC', '#r=abc-def', '#r=abc def', '#r=abc/x', `#r=${'a'.repeat(17)}`,
    '#c=abc', 'r=abc', '#r=abc#r=def', undefined, null, 42];
  for (const hash of bad) assert.equal(MG.roomIdFromHash(hash), null, String(hash));
});

test('roomLink: the page address plus #r=<id>, and it parses back', () => {
  assert.equal(MG.roomLink('https://monguess.pages.dev/', 'k3x9a0bq7z'), 'https://monguess.pages.dev/#r=k3x9a0bq7z');
  const url = new URL(MG.roomLink('http://localhost:8765/', 'abc123'));
  assert.equal(MG.roomIdFromHash(url.hash), 'abc123');
});

test('roomSocketUrl: wss on https, ws on http, same host, /api/room/<id>', () => {
  assert.equal(MG.roomSocketUrl({ protocol: 'https:', host: 'monguess.pages.dev' }, 'abc'), 'wss://monguess.pages.dev/api/room/abc');
  assert.equal(MG.roomSocketUrl({ protocol: 'http:', host: 'localhost:8765' }, 'abc'), 'ws://localhost:8765/api/room/abc');
});

const ROUNDS = [
  { src: 'g', id: 'pano-es', lat: 41.3874, lon: 2.1686, cc: 'ES', kind: 'google' },
  { src: 'm', id: '4471234', lat: -33.8688, lon: 151.2093, cc: 'AU', kind: 'mapillary' },
];

test('buildRoomCreate: no-timer mode, rounds carry forgiveKm and only the protocol fields', () => {
  const forgive = { ES: 120.5, AU: 300 };
  const msg = MG.buildRoomCreate({
    playerId: 'p1', name: '  Ann  ', mode: 'none', timerSec: '30', rounds: ROUNDS, forgiveKm: (cc) => forgive[cc],
  });
  assert.deepEqual(msg, {
    type: 'create',
    playerId: 'p1',
    name: 'Ann',
    settings: { mode: 'none' },
    rounds: [
      { src: 'g', id: 'pano-es', lat: 41.3874, lon: 2.1686, cc: 'ES', forgiveKm: 120.5 },
      { src: 'm', id: '4471234', lat: -33.8688, lon: 151.2093, cc: 'AU', forgiveKm: 300 },
    ],
  });
});

test('buildRoomCreate: timer mode carries its seconds as a number', () => {
  const msg = MG.buildRoomCreate({ playerId: 'p1', name: 'Ann', mode: 'timer', timerSec: '60', rounds: ROUNDS, forgiveKm: () => 0 });
  assert.deepEqual(msg.settings, { mode: 'timer', timerSec: 60 });
});

test('buildRoomCreate: the room rules accept the message as a room in the lobby', () => {
  for (const [mode, timerSec] of [['none', '30'], ['timer', '15'], ['timer', '120']]) {
    const msg = MG.buildRoomCreate({
      playerId: 'p1', name: 'Ann', mode, timerSec, rounds: ROUNDS, forgiveKm: (cc) => MG.forgivenessKm(places[cc]),
    });
    const { state, out } = R.step(null, msg, 1_800_000_000_000);
    assert.ok(state, `${mode} ${timerSec}: ${JSON.stringify(out)}`);
    assert.equal(state.phase, 'lobby');
    assert.equal(state.rounds[1].forgiveKm, 300);
    assert.equal(state.rounds[0].forgiveKm, MG.forgivenessKm(places.ES));
  }
});

test('describeRoomMode: the room mode in words', () => {
  assert.equal(MG.describeRoomMode({ mode: 'none', timerSec: null }), 'Без времени — раунд идёт, пока все не ответят');
  assert.equal(MG.describeRoomMode({ mode: 'timer', timerSec: 30 }), 'Таймер: 30 секунд после первого ответа');
  assert.equal(MG.describeRoomMode({ mode: 'timer', timerSec: 21 }), 'Таймер: 21 секунда после первого ответа');
});

test('pluralRu: Russian plural forms by the last digits', () => {
  const r = (n) => `${n} ${MG.pluralRu(n, 'раунд', 'раунда', 'раундов')}`;
  assert.deepEqual([1, 2, 4, 5, 10, 11, 12, 14, 20, 21, 22, 25, 101, 111, 112, 0].map(r), [
    '1 раунд', '2 раунда', '4 раунда', '5 раундов', '10 раундов', '11 раундов', '12 раундов', '14 раундов',
    '20 раундов', '21 раунд', '22 раунда', '25 раундов', '101 раунд', '111 раундов', '112 раундов', '0 раундов',
  ]);
});

// ---------- The room's rounds, results and final table on screen (#25) ----------

test('guessedStatus: "Ответили N из M" counts connected players only', () => {
  const p = (playerId, connected, guessed) => ({ playerId, name: playerId, connected, guessed });
  assert.equal(MG.guessedStatus([p('a', true, true), p('b', true, true), p('c', true, false)]), 'Ответили 2 из 3');
  assert.equal(MG.guessedStatus([p('a', true, false), p('b', true, false)]), 'Ответили 0 из 2');
  // Someone who left counts neither as answered nor as waited for, guessed or not.
  assert.equal(MG.guessedStatus([p('a', true, true), p('b', false, true), p('c', false, false), p('d', true, false)]),
    'Ответили 1 из 2');
  assert.equal(MG.guessedStatus([]), 'Ответили 0 из 0');
});

test('secondsLeft: whole seconds to a deadline, rounded up, never below 0', () => {
  const at = 1_800_000_030_000;
  assert.equal(MG.secondsLeft(at, at - 30_000), 30);
  assert.equal(MG.secondsLeft(at, at - 29_001), 30);
  assert.equal(MG.secondsLeft(at, at - 29_000), 29);
  assert.equal(MG.secondsLeft(at, at - 1), 1);
  assert.equal(MG.secondsLeft(at, at), 0);
  assert.equal(MG.secondsLeft(at, at + 5_000), 0);
});

// A real results message: the room rules play one round of three players, Cat never guesses.
function playedResults() {
  const t = 1_800_000_000_000;
  const rounds = [
    { src: 'g', id: 'r1', lat: 41.3874, lon: 2.1686, cc: 'ES', forgiveKm: 0 },
    { src: 'g', id: 'r2', lat: -33.8688, lon: 151.2093, cc: 'AU', forgiveKm: 0 },
  ];
  let s = R.step(null, { type: 'create', playerId: 'ann', name: 'Ann', settings: { mode: 'timer', timerSec: 10 }, rounds }, t).state;
  s = R.step(s, { type: 'join', playerId: 'bob', name: 'Bob' }, t).state;
  s = R.step(s, { type: 'join', playerId: 'cat', name: 'Cat' }, t).state;
  s = R.step(s, { type: 'start', playerId: 'ann' }, t).state;
  s = R.step(s, { type: 'guess', playerId: 'ann', round: 0, lat: 40.4168, lon: -3.7038 }, t).state;
  s = R.step(s, { type: 'guess', playerId: 'bob', round: 0, lat: 41.39, lon: 2.17 }, t + 1000).state;
  const { out } = R.step(s, { type: 'alarm' }, t + 10_000);
  return out.find((o) => o.msg.type === 'results').msg;
}

test('roomResultRows: one row per player in table order, the guess, its points and the total', () => {
  const results = playedResults();
  const rows = MG.roomResultRows(results, 'ann');
  assert.deepEqual(rows.map((r) => r.name), ['Bob', 'Ann', 'Cat']);
  const [bob, ann, cat] = rows;
  assert.equal(bob.you, false);
  assert.equal(ann.you, true);
  assert.equal(cat.you, false);
  const g = (id) => results.guesses.find((x) => x.playerId === id);
  assert.deepEqual(ann, {
    playerId: 'ann', name: 'Ann', lat: 40.4168, lon: -3.7038,
    distance: MG.formatKm(g('ann').km), points: g('ann').points, total: g('ann').points, you: true,
  });
  assert.equal(ann.distance, '505 км');
  assert.equal(bob.points, g('bob').points);
  assert.ok(bob.points > ann.points);
  // No guess: no point on the map, no distance, 0 points.
  assert.deepEqual(cat, { playerId: 'cat', name: 'Cat', lat: null, lon: null, distance: 'нет ответа', points: 0, total: 0, you: false });
});

test('roomResultRows: the total is the running one, not this round only', () => {
  const results = {
    guesses: [
      { playerId: 'a', name: 'A', lat: 1, lon: 2, km: 0.4, points: 5000 },
      { playerId: 'b', name: 'B', lat: 3, lon: 4, km: 1500, points: 1800 },
    ],
    table: [
      { playerId: 'b', name: 'B', connected: true, total: 9000, points: [4000, 3200, 1800] },
      { playerId: 'a', name: 'A', connected: false, total: 7000, points: [1000, 1000, 5000] },
    ],
  };
  const rows = MG.roomResultRows(results, 'zzz');
  assert.deepEqual(rows.map((r) => [r.name, r.distance, r.points, r.total, r.you]),
    [['B', '1\u00a0500 км', 1800, 9000, false], ['A', '400 м', 5000, 7000, false]]);
});

test('roomFinalRows: place, name, points per round, total; ties share a place', () => {
  const table = [
    { playerId: 'a', name: 'A', connected: true, total: 9000, points: [5000, 4000] },
    { playerId: 'b', name: 'B', connected: true, total: 7000, points: [3000, 4000] },
    { playerId: 'c', name: 'C', connected: false, total: 7000, points: [7000, 0] },
    { playerId: 'd', name: 'D', connected: true, total: 100, points: [0, 100] },
  ];
  assert.deepEqual(MG.roomFinalRows(table, 'c'), [
    { place: 1, name: 'A', points: [5000, 4000], total: 9000, you: false },
    { place: 2, name: 'B', points: [3000, 4000], total: 7000, you: false },
    { place: 2, name: 'C', points: [7000, 0], total: 7000, you: true },
    { place: 4, name: 'D', points: [0, 100], total: 100, you: false },
  ]);
  assert.deepEqual(MG.roomFinalRows([], 'a'), []);
});

test('roomSeatKey: one localStorage key per room', () => {
  assert.equal(MG.roomSeatKey('k3x9a0bq7z'), 'mg-room:k3x9a0bq7z');
  assert.notEqual(MG.roomSeatKey('a'), MG.roomSeatKey('b'));
});

test('roomSeatText and parseRoomSeat: a seat survives the round trip, the name cleaned', () => {
  const text = MG.roomSeatText({ playerId: 'ab12_-XY', name: '  Боб  ', extra: 1 });
  assert.deepEqual(JSON.parse(text), { playerId: 'ab12_-XY', name: 'Боб' });
  assert.deepEqual(MG.parseRoomSeat(text), { playerId: 'ab12_-XY', name: 'Боб' });
  assert.deepEqual(MG.parseRoomSeat(JSON.stringify({ playerId: 'p'.repeat(64), name: 'A', more: true })),
    { playerId: 'p'.repeat(64), name: 'A' });
});

test('parseRoomSeat: null for anything the room would refuse or that is not a seat', () => {
  const bad = [
    null, undefined, '', 'not json', '42', 'null', '[]', '"seat"',
    JSON.stringify({ name: 'Ann' }),
    JSON.stringify({ playerId: 'p1' }),
    JSON.stringify({ playerId: 'p1', name: '   ' }),
    JSON.stringify({ playerId: 'p1', name: 42 }),
    JSON.stringify({ playerId: '', name: 'Ann' }),
    JSON.stringify({ playerId: 'p 1', name: 'Ann' }),
    JSON.stringify({ playerId: 'p'.repeat(65), name: 'Ann' }),
    JSON.stringify({ playerId: 7, name: 'Ann' }),
  ];
  for (const text of bad) assert.equal(MG.parseRoomSeat(text), null, String(text));
});

test('parseRoomSeat: a stored seat joins back into the same place of a running room', () => {
  const rounds = ROUNDS.map((r) => ({ src: r.src, id: r.id, lat: r.lat, lon: r.lon, cc: r.cc, forgiveKm: 0 }));
  let s = R.step(null, { type: 'create', playerId: 'ann', name: 'Ann', settings: { mode: 'none' }, rounds }, 0).state;
  s = R.step(s, { type: 'join', playerId: 'bob0bob0bob0bob0', name: 'Bob' }, 1).state;
  s = R.step(s, { type: 'start', playerId: 'ann' }, 2).state;
  s = R.step(s, { type: 'guess', playerId: 'bob0bob0bob0bob0', round: 0, lat: 41, lon: 2 }, 3).state;
  s = R.step(s, { type: 'leave', playerId: 'bob0bob0bob0bob0' }, 4).state;
  const seat = MG.parseRoomSeat(MG.roomSeatText({ playerId: 'bob0bob0bob0bob0', name: 'Bob' }));
  const back = R.step(s, { type: 'join', ...seat }, 5);
  const snap = back.out.find((o) => o.msg.type === 'state').msg;
  assert.equal(snap.players.length, 2);
  assert.deepEqual(snap.players.find((p) => p.playerId === seat.playerId), {
    playerId: 'bob0bob0bob0bob0', name: 'Bob', connected: true, guessed: true,
  });
});

test('reconnectDelay: 1, 2, 4, 8 s, then every 10 s, giving up after about 2 minutes', () => {
  const delays = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const d = MG.reconnectDelay(attempt);
    if (d === null) break;
    delays.push(d);
  }
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 10000]);
  assert.ok(delays.slice(4).every((d) => d === 10000), JSON.stringify(delays));
  assert.equal(delays.length, 14);
  assert.equal(delays.reduce((s, d) => s + d, 0), 115000);
  assert.equal(MG.reconnectDelay(14), null);
  assert.equal(MG.reconnectDelay(1000), null);
});
