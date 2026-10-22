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
