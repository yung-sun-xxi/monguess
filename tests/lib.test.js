'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MG = require('../lib.js');

const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('scoreFor: 5000 at zero, GeoGuessr curve, falls monotonically to 0', () => {
  assert.equal(MG.scoreFor(0), 5000);
  assert.equal(MG.scoreFor(100), 4676);
  assert.equal(MG.scoreFor(1492.7), 1839); // 5000 / e
  assert.equal(MG.scoreFor(20000), 0);
  for (let d = 0; d < 20000; d += 250) assert.ok(MG.scoreFor(d) >= MG.scoreFor(d + 250));
});

test('distanceKm: Barcelona to Madrid, zero, across the antimeridian', () => {
  const bcn = { lat: 41.3851, lon: 2.1734 };
  const mad = { lat: 40.4168, lon: -3.7038 };
  const d = MG.distanceKm(bcn, mad);
  assert.ok(d > 503 && d < 508, `got ${d}`);
  assert.equal(MG.distanceKm(bcn, bcn), 0);
  const across = MG.distanceKm({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 });
  assert.ok(across > 22 && across < 23, `got ${across}`);
});

test('formatKm: metres under 1 km, grouped kilometres above', () => {
  assert.equal(MG.formatKm(0.4), '400 м');
  assert.match(MG.formatKm(5275.4), /^5.275 км$/);
  assert.equal(MG.formatKm(12), '12 км');
});

test('flag: regional indicators for a country code, white flag otherwise', () => {
  assert.equal(MG.flag('ES'), '\u{1F1EA}\u{1F1F8}');
  assert.equal(MG.flag('xx'), '🏳️');
  assert.equal(MG.flag(''), '🏳️');
});

test('resolveCountry: keeps a territory Nominatim credits to its owner, trusts Nominatim otherwise', () => {
  assert.equal(MG.resolveCountry('AW', 'NL'), 'AW');
  assert.equal(MG.resolveCountry('HK', 'CN'), 'HK');
  assert.equal(MG.resolveCountry('ES', 'FR'), 'FR');
  assert.equal(MG.resolveCountry('NL', 'AW'), 'AW');
  assert.equal(MG.resolveCountry('ES', null), 'ES');
});

test('challenge link: round trip, URL-safe alphabet, coordinates to 6 decimals', () => {
  const rounds = [
    { src: 'g', id: 'CAoSLEFGMVFpcE', lat: 41.3851234567, lon: 2.1734, cc: 'ES' },
    { src: 'm', id: '1234567890', lat: -33.9, lon: 151.2, cc: 'AU' },
  ];
  const link = MG.encodeChallenge(rounds);
  assert.match(link, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(MG.decodeChallenge(link), [
    { src: 'g', id: 'CAoSLEFGMVFpcE', lat: 41.385123, lon: 2.1734, cc: 'ES' },
    { src: 'm', id: '1234567890', lat: -33.9, lon: 151.2, cc: 'AU' },
  ]);
});

test('decodeChallenge: null for anything that is not a well-formed link', () => {
  const bad = [
    'not base64!',
    enc({}),
    enc([]),
    enc([['g', 'id', 999, 0, 'ES']]),
    enc([['g', 'id', 0, 181, 'ES']]),
    enc([['x', 'id', 1, 1, 'ES']]),
    enc([['g', 'id', '41', '2', 'ES']]),
    enc([['g', '', 1, 1, 'ES']]),
    enc([['g', 'id', 1, 1, 'es']]),
    enc([['g', 'id', 1, 1]]),
    enc([42]),
    enc([['g', 'ok', 1, 1, 'ES'], ['g', 'bad', null, 1, 'ES']]),
  ];
  for (const link of bad) assert.equal(MG.decodeChallenge(link), null, link);
});

test('randomPointNear: 1–40 km from a city, within the map', () => {
  const city = [[41.3851, 2.1734, 1600000]];
  for (let i = 0; i < 2000; i++) {
    const [lat, lon] = MG.randomPointNear(city);
    const d = MG.distanceKm({ lat: city[0][0], lon: city[0][1] }, { lat, lon });
    assert.ok(d >= 0.9 && d <= 41, `distance ${d}`);
  }
  for (let i = 0; i < 500; i++) {
    const [lat, lon] = MG.randomPointNear([[84.9, 179.95, 100]]);
    assert.ok(lat <= 85 && lat >= -85 && lon >= -180 && lon <= 180, `point ${lat}, ${lon}`);
  }
});

test('pickPlace and shuffle: members of the list, same elements', () => {
  const list = [[1, 1, 10], [2, 2, 1000], [3, 3, 0]];
  for (let i = 0; i < 200; i++) assert.ok(list.includes(MG.pickPlace(list)));
  const shuffled = MG.shuffle(list);
  assert.equal(shuffled.length, list.length);
  assert.deepEqual([...shuffled].sort(), [...list].sort());
});

test('cleanName: trims, cuts to 20 characters by code point, whitespace only is no name', () => {
  assert.equal(MG.cleanName('  Саша  '), 'Саша');
  assert.equal(MG.cleanName('\t\n  '), '');
  assert.equal(MG.cleanName(''), '');
  assert.equal(MG.cleanName('Александр Степаненков'), 'Александр Степаненко'); // 21 → 20
  assert.equal(MG.cleanName('a'.repeat(25)), 'a'.repeat(20));
  assert.equal(MG.cleanName('a'.repeat(20)), 'a'.repeat(20));
  // 19 letters, then a space at position 20: cut, then trimmed again.
  assert.equal(MG.cleanName(`${'b'.repeat(19)} tail`), 'b'.repeat(19));
  // Leading spaces do not eat into the 20: trimmed before the cut.
  assert.equal(MG.cleanName(`   ${'c'.repeat(25)}`), 'c'.repeat(20));
  // An emoji is one character, not two UTF-16 halves: it is never split.
  assert.equal(MG.cleanName('😀'.repeat(25)), '😀'.repeat(20));
  assert.equal(MG.cleanName(null), '');
  assert.equal(MG.cleanName(undefined), '');
  assert.equal(MG.cleanName(42), '');
});

const RESULT_GAME = {
  total: 18400,
  max: 25000,
  rounds: [
    { cc: 'ES', points: 4676 },
    { cc: 'KE', points: 5000 },
    { cc: 'BR', points: 0 },
    { cc: 'JP', points: 3724 },
    { cc: 'xx', points: 5000 },
  ],
  url: 'https://monguess.pages.dev/#c=abc',
};
// Byte for byte the text resultText() in app.js built before names existed;
//   is the group separator toLocaleString('ru') produces.
const RESULT_TAIL = '\n\u{1F1EA}\u{1F1F8} 4 676  \u{1F1F0}\u{1F1EA} 5 000  \u{1F1E7}\u{1F1F7} 0  '
  + '\u{1F1EF}\u{1F1F5} 3 724  🏳️ 5 000\nСыграй те же места: https://monguess.pages.dev/#c=abc';
const RESULT_NO_NAME = '🌍 MonGuess: 18 400 из 25 000' + RESULT_TAIL;

test('formatResult: without a name, exactly the old text', () => {
  assert.equal(MG.formatResult({ ...RESULT_GAME }), RESULT_NO_NAME);
  assert.equal(MG.formatResult({ ...RESULT_GAME, name: '' }), RESULT_NO_NAME);
});

test('formatResult: a name goes into the first line, the rest is unchanged', () => {
  assert.equal(MG.formatResult({ ...RESULT_GAME, name: 'Саша' }),
    '🌍 MonGuess · Саша: 18 400 из 25 000' + RESULT_TAIL);
  assert.equal(MG.formatResult({ ...RESULT_GAME, name: '  Саша ' }),
    '🌍 MonGuess · Саша: 18 400 из 25 000' + RESULT_TAIL);
});

test('formatResult: whitespace only is no name, an over-long name is cut to 20', () => {
  assert.equal(MG.formatResult({ ...RESULT_GAME, name: '   \t ' }), RESULT_NO_NAME);
  assert.equal(MG.formatResult({ ...RESULT_GAME, name: 'Александр Степаненков' }),
    '🌍 MonGuess · Александр Степаненко: 18 400 из 25 000' + RESULT_TAIL);
});

// ---------- buildLogRecord: the record app.js posts to /api/log ----------

const LOG_ROUNDS = [
  { src: 'g', id: 'CAoSLEFGMVFpcE', lat: 41.3851, lon: 2.1734, cc: 'ES', kind: 'google' },
  { src: 'g', id: 'AF1QipNx', lat: -1.29, lon: 36.82, cc: 'KE', kind: 'sphere' },
  { src: 'm', id: '1234567890', lat: -33.9, lon: 151.2, cc: 'AU', kind: 'mapillary' },
];
const LOG_GUESSES = [
  { lat: 40.4168, lon: -3.7038, km: 505.1, points: 3561 },
  { lat: -1.3, lon: 36.8, km: 2.4, points: 4992 },
  { lat: -37.8, lon: 144.9, km: 713.6, points: 3092 },
];
const LOG_GAME = {
  id: 'abc123def456', startedAt: 1760000000000, buildMs: 12345, name: 'Саша',
  settings: { sources: ['g', 'm'], spheres: 'walk', rounds: 3 }, challenge: false,
  rounds: LOG_ROUNDS, guesses: LOG_GUESSES, errors: [],
};

test('buildLogRecord: a finished game with a name, every field', () => {
  assert.deepEqual(MG.buildLogRecord({ ...LOG_GAME }), {
    v: 1,
    id: 'abc123def456',
    startedAt: 1760000000000,
    buildMs: 12345,
    name: 'Саша',
    settings: { sources: ['g', 'm'], spheres: 'walk', rounds: 3 },
    challenge: false,
    rounds: [
      { src: 'g', id: 'CAoSLEFGMVFpcE', cc: 'ES', lat: 41.3851, lon: 2.1734, kind: 'google' },
      { src: 'g', id: 'AF1QipNx', cc: 'KE', lat: -1.29, lon: 36.82, kind: 'sphere' },
      { src: 'm', id: '1234567890', cc: 'AU', lat: -33.9, lon: 151.2, kind: 'mapillary' },
    ],
    guesses: [
      { lat: 40.4168, lon: -3.7038, km: 505.1, points: 3561 },
      { lat: -1.3, lon: 36.8, km: 2.4, points: 4992 },
      { lat: -37.8, lon: 144.9, km: 713.6, points: 3092 },
    ],
    total: 11645,
    finished: true,
    errors: [],
  });
});

test('buildLogRecord: the name is cleaned, none or whitespace only is an empty string', () => {
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, name: '  Саша  ' }).name, 'Саша');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, name: 'Александр Степаненков' }).name, 'Александр Степаненко');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, name: '' }).name, '');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, name: ' \t ' }).name, '');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, name: undefined }).name, '');
});

test('buildLogRecord: a challenge game has no settings and no kind', () => {
  // Rounds decoded from a friends link carry no kind; settings were the friend's, not ours.
  const fromLink = LOG_ROUNDS.map(({ src, id, lat, lon, cc }) => ({ src, id, lat, lon, cc }));
  const rec = MG.buildLogRecord({
    ...LOG_GAME, challenge: true, buildMs: 0, settings: { sources: ['g'], spheres: 'any', rounds: 3 }, rounds: fromLink,
  });
  assert.equal(rec.challenge, true);
  assert.equal(rec.settings, null);
  assert.equal(rec.buildMs, 0);
  assert.deepEqual(rec.rounds.map((r) => r.kind), [null, null, null]);
  assert.deepEqual(rec.rounds[0], { src: 'g', id: 'CAoSLEFGMVFpcE', cc: 'ES', lat: 41.3851, lon: 2.1734, kind: null });
  // A kind outside the three known ones is unknown too.
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, rounds: [{ ...LOG_ROUNDS[0], kind: 'indoor' }] }).rounds[0].kind, null);
});

test('buildLogRecord: mid-game, fewer guesses than rounds, is not finished', () => {
  const rec = MG.buildLogRecord({ ...LOG_GAME, guesses: LOG_GUESSES.slice(0, 1) });
  assert.equal(rec.finished, false);
  assert.equal(rec.total, 3561);
  assert.equal(rec.guesses.length, 1);
  assert.equal(rec.rounds.length, 3);
  const started = MG.buildLogRecord({ ...LOG_GAME, guesses: [] });
  assert.equal(started.finished, false);
  assert.equal(started.total, 0);
  // A build that failed has no rounds at all: not finished either.
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, rounds: [], guesses: [] }).finished, false);
});

test('buildLogRecord: errors are carried through, extra fields are dropped', () => {
  const errors = [
    { round: null, message: 'Не удалось найти достаточно мест. Попробуйте ещё раз.' },
    { round: 2, message: 'UNKNOWN_ERROR', stack: 'at showPanorama' },
  ];
  const rec = MG.buildLogRecord({
    ...LOG_GAME,
    rounds: [{ ...LOG_ROUNDS[0], extra: 'x' }],
    guesses: [{ ...LOG_GUESSES[0], extra: 'x' }],
    errors,
  });
  assert.deepEqual(rec.errors, [
    { round: null, message: 'Не удалось найти достаточно мест. Попробуйте ещё раз.' },
    { round: 2, message: 'UNKNOWN_ERROR' },
  ]);
  assert.deepEqual(Object.keys(rec.rounds[0]), ['src', 'id', 'cc', 'lat', 'lon', 'kind']);
  assert.deepEqual(Object.keys(rec.guesses[0]), ['lat', 'lon', 'km', 'points']);
  assert.deepEqual(MG.buildLogRecord({ ...LOG_GAME, errors: undefined }).errors, []);
});
