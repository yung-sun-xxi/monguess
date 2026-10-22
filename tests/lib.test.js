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

// Points lost (5000 − points) per miss, from issue #39: classic in any country, then size-aware
// for a spread of 300 km (Japan, Russia), 69 km (the Netherlands) and 0 (Singapore).
const LOST_TABLE = [
  // km, classic, R 300, R 69 (NL), R 0 (SG)
  [10, 33, 24, 31, 33],
  [50, 165, 118, 151, 165],
  [100, 324, 233, 297, 324],
  [125, 402, 290, 369, 402],
  [300, 910, 668, 840, 910],
  [500, 1423, 1063, 1320, 1423],
  [1000, 2441, 1899, 2292, 2441],
  [2000, 3691, 3077, 3533, 3691],
];

test('scoreFor: the spread stretches the curve, points lost match the table of issue #39', () => {
  const places = require('../data/places.json');
  const nl = MG.forgivenessKm(places.NL);
  const sg = MG.forgivenessKm(places.SG);
  assert.equal(Math.round(nl), 69);
  assert.equal(sg, 0);
  for (const [km, classic, r300, r69, r0] of LOST_TABLE) {
    assert.equal(5000 - MG.scoreFor(km), classic, `classic ${km} km`);
    assert.equal(5000 - MG.scoreFor(km, 0), classic, `R 0 is classic, ${km} km`);
    assert.equal(5000 - MG.scoreFor(km, 300), r300, `R 300, ${km} km`);
    assert.equal(5000 - MG.scoreFor(km, nl), r69, `NL, ${km} km`);
    assert.equal(5000 - MG.scoreFor(km, sg), r0, `SG, ${km} km`);
  }
});

test('scoreFor: no flat zone, every kilometre closer scores more, a big country never less', () => {
  // The old rule forgave the first 300 km: 10 km and 290 km both scored 5000 in Japan.
  assert.ok(MG.scoreFor(10, 300) > MG.scoreFor(290, 300));
  assert.ok(MG.scoreFor(290, 300) < 5000);
  assert.equal(MG.scoreFor(0, 300), 5000);
  for (let km = 0; km < 3000; km += 25) {
    assert.ok(MG.scoreFor(km, 300) > MG.scoreFor(km + 25, 300), `R 300 at ${km} km`);
    assert.ok(MG.scoreFor(km, 300) >= MG.scoreFor(km), `R 300 never below classic at ${km} km`);
  }
  // 5000 · e^(−km / (1492.7 + 2·R)), exactly.
  assert.equal(MG.scoreFor(1492.7 + 2 * 150, 150), 1839); // 5000 / e
  assert.equal(MG.scoreFor(4000, 300), Math.round(5000 * Math.exp(-4000 / 2092.7)));
});

test('scoreGuess: distance, points and the bonus; classic scores with a spread of 0', () => {
  const round = { lat: 55.7558, lon: 37.6173 }; // Moscow
  const guess = { lat: 59.9343, lon: 30.3351 }; // St Petersburg, ~634 km
  const km = MG.distanceKm(round, guess);
  const size = MG.scoreGuess(round, guess, 300, 'size');
  assert.deepEqual(size, { km, points: MG.scoreFor(km, 300), bonus: MG.scoreFor(km, 300) - MG.scoreFor(km, 0) });
  assert.ok(size.bonus > 300, `bonus ${size.bonus}`);
  const classic = MG.scoreGuess(round, guess, 300, 'classic');
  assert.deepEqual(classic, { km, points: MG.scoreFor(km, 0), bonus: 0 });
  assert.ok(classic.points < size.points);
  // A mode the game does not know is the default, size-aware.
  assert.deepEqual(MG.scoreGuess(round, guess, 300, undefined), size);
});

test('sizeBonus and sizeBonusText: the points the size gave over classic, hidden under 1', () => {
  assert.equal(MG.sizeBonus(100, 300), 324 - 233);
  assert.equal(MG.sizeBonus(500, 300), 1423 - 1063);
  assert.equal(MG.sizeBonus(100, 0), 0);
  assert.equal(MG.sizeBonus(0, 300), 0);
  assert.equal(MG.sizeBonusText(91), '+91 очко за размер страны');
  assert.equal(MG.sizeBonusText(360), '+360 очков за размер страны');
  assert.equal(MG.sizeBonusText(1), '+1 очко за размер страны');
  assert.equal(MG.sizeBonusText(3), '+3 очка за размер страны');
  assert.equal(MG.sizeBonusText(1234), '+1\u00a0234 очка за размер страны');
  assert.equal(MG.sizeBonusText(0), '');
  assert.equal(MG.sizeBonusText(0.4), '');
  assert.equal(MG.sizeBonusText(-5), '');
});

test('describeScoring: the scoring mode in the words of the menu, missing is size-aware', () => {
  assert.equal(MG.describeScoring('size'), 'Подсчёт очков: с учётом размера страны');
  assert.equal(MG.describeScoring('classic'), 'Подсчёт очков: классический, как в GeoGuessr');
  assert.equal(MG.describeScoring(undefined), 'Подсчёт очков: с учётом размера страны');
});

// ---------- index.html: the scoring setting and its explanation ----------

const INDEX_HTML = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');

test('index.html: the scoring select offers size-aware (the default) and classic', () => {
  const select = INDEX_HTML.match(/<select id="scoring">([\s\S]*?)<\/select>/);
  assert.ok(select, 'no <select id="scoring">');
  const options = [...select[1].matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)]
    .map(([, value, selected, text]) => [value, Boolean(selected), text]);
  assert.deepEqual(options, [
    ['size', true, 'С учётом размера страны'],
    ['classic', false, 'Классический, как в GeoGuessr'],
  ]);
});

test('index.html: the numbers in "Что значат настройки" are what scoreFor gives for Russia and Singapore', () => {
  const places = require('../data/places.json');
  const ru = MG.forgivenessKm(places.RU);
  const sg = MG.forgivenessKm(places.SG);
  const text = INDEX_HTML.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const N = '(\\d{1,3}(?: \\d{3})*)';
  const num = (s) => Number(s.replace(/ /g, ''));
  const lost = (km, r) => 5000 - MG.scoreFor(km, r);

  const classic = [...text.matchAll(new RegExp(`Ошиблись на ${N} км — минус ${N} очк\\S* и в России, и в Сингапуре`, 'g'))];
  assert.equal(classic.length, 1, 'the classic example');
  for (const [, km, both] of classic) assert.equal(num(both), lost(num(km), 0), `classic ${km} km`);

  const size = [...text.matchAll(new RegExp(`Ошиблись на ${N} км: в России минус ${N}(?: очк\\S*)?, в Сингапуре минус ${N}`, 'g'))];
  assert.equal(size.length, 2, 'the two size-aware examples');
  for (const [, km, inRu, inSg] of size) {
    assert.equal(num(inRu), lost(num(km), ru), `Russia ${km} km`);
    assert.equal(num(inSg), lost(num(km), sg), `Singapore ${km} km`);
  }
  assert.deepEqual(size.map((m) => num(m[1])), [100, 500]);
});

// ---------- Difficulty: country pools by how well-known a country is ----------

const PLACE_CODES = Object.keys(require('../data/places.json'));

test('country tiers: every code of places.json has exactly one tier 1-3, and nothing else has one', () => {
  const listed = [1, 2, 3].flatMap((t) => MG.COUNTRY_TIERS[t]);
  assert.deepEqual(Object.keys(MG.COUNTRY_TIERS).sort(), ['1', '2', '3']);
  const seen = new Map();
  for (const cc of listed) seen.set(cc, (seen.get(cc) || 0) + 1);
  assert.deepEqual([...seen].filter(([, n]) => n !== 1), [], 'a code in two tiers or twice in one');
  assert.deepEqual(PLACE_CODES.filter((cc) => !seen.has(cc)), [], 'a code of places.json with no tier');
  assert.deepEqual(listed.filter((cc) => !PLACE_CODES.includes(cc)), [], 'a tier code absent from places.json');
  assert.deepEqual([1, 2, 3].map((t) => MG.COUNTRY_TIERS[t].length), [54, 70, 102]);
  for (const cc of PLACE_CODES) assert.ok([1, 2, 3].includes(MG.countryTier(cc)), cc);
  assert.equal(MG.countryTier('US'), 1);
  assert.equal(MG.countryTier('MT'), 2);
  assert.equal(MG.countryTier('TL'), 3);
  assert.equal(MG.countryTier('SX'), null);
  assert.equal(MG.countryTier(undefined), null);
});

test('difficultyLevel: 1-3 from a number or the select text; anything else is the fallback, 3 unless given', () => {
  for (const [value, level] of [[1, 1], [2, 2], [3, 3], ['1', 1], ['2', 2], ['3', 3]]) {
    assert.equal(MG.difficultyLevel(value), level, JSON.stringify(value));
  }
  for (const value of [undefined, null, '', 0, 4, 1.5, '2.0', 'easy', true, [2], {}]) {
    assert.equal(MG.difficultyLevel(value), 3, JSON.stringify(value));
    assert.equal(MG.difficultyLevel(value, 2), 2, JSON.stringify(value));
  }
  // The menu passes fallback 2: the select's '3' must still be hard, not the fallback.
  assert.equal(MG.difficultyLevel('1', 2), 1);
  assert.equal(MG.difficultyLevel('3', 2), 3);
  assert.equal(MG.difficultyLevel('2', 3), 2);
});

test('countryPool: easy is tier 1, medium tiers 1-2, hard every code exactly as given', () => {
  const easy = MG.countryPool(PLACE_CODES, 1);
  const medium = MG.countryPool(PLACE_CODES, 2);
  assert.deepEqual([...easy].sort(), [...MG.COUNTRY_TIERS[1]].sort());
  assert.deepEqual([...medium].sort(), [...MG.COUNTRY_TIERS[1], ...MG.COUNTRY_TIERS[2]].sort());
  assert.equal(medium.length, 124);
  // Hard is today's game: no filtering at all, a code with no tier included, order kept.
  const withStranger = [...PLACE_CODES, 'ZZ'];
  assert.deepEqual(MG.countryPool(withStranger, 3), withStranger);
  assert.deepEqual(MG.countryPool(withStranger, undefined), withStranger);
  assert.deepEqual(MG.countryPool(['US', 'MT', 'TL', 'ZZ'], 1), ['US']);
  assert.deepEqual(MG.countryPool(['US', 'MT', 'TL', 'ZZ'], 2), ['US', 'MT']);
  assert.deepEqual(MG.countryPool(['US', 'MT', 'TL', 'ZZ'], '2'), ['US', 'MT']);
});

test('countryAllowed: a resolved country must be in the pool, except on hard, where anything goes', () => {
  // resolveCountry can return a code places.json does not have (SX, BQ): hard keeps it, as today.
  for (const cc of ['US', 'MT', 'TL', 'SX', 'BQ', 'ZZ']) {
    assert.equal(MG.countryAllowed(cc, 3), true, cc);
    assert.equal(MG.countryAllowed(cc, undefined), true, cc);
  }
  assert.equal(MG.countryAllowed('US', 1), true);
  assert.equal(MG.countryAllowed('MT', 1), false);
  assert.equal(MG.countryAllowed('TL', 1), false);
  assert.equal(MG.countryAllowed('SX', 1), false);
  assert.equal(MG.countryAllowed('US', 2), true);
  assert.equal(MG.countryAllowed('MT', 2), true);
  assert.equal(MG.countryAllowed('TL', 2), false);
  assert.equal(MG.countryAllowed('BQ', 2), false);
  // A border panorama found from France on easy may resolve to Andorra: not in the pool.
  assert.equal(MG.countryAllowed(MG.resolveCountry('FR', 'AD'), 1), false);
});

test('describeDifficulty: the difficulty in the words of the menu; a room from before difficulty is hard', () => {
  assert.equal(MG.describeDifficulty(1), 'Сложность: лёгкая');
  assert.equal(MG.describeDifficulty(2), 'Сложность: средняя');
  assert.equal(MG.describeDifficulty(3), 'Сложность: сложная');
  assert.equal(MG.describeDifficulty(undefined), 'Сложность: сложная');
});

test('index.html: the difficulty select offers easy, medium (the default) and hard', () => {
  const select = INDEX_HTML.match(/<select id="difficulty">([\s\S]*?)<\/select>/);
  assert.ok(select, 'no <select id="difficulty">');
  const options = [...select[1].matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)]
    .map(([, value, selected, text]) => [value, Boolean(selected), text]);
  assert.deepEqual(options, [
    ['1', false, 'Лёгкая'],
    ['2', true, 'Средняя'],
    ['3', false, 'Сложная'],
  ]);
});

test('index.html: the counts in "Что значат настройки" for each difficulty are the tier sizes', () => {
  const text = INDEX_HTML.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const easy = text.match(/<b>Лёгкая<\/b> — (\d+) /);
  const medium = text.match(/<b>Средняя<\/b> — плюс ещё (\d+) [^,]*, всего (\d+)/);
  assert.ok(easy && medium, 'the easy and medium lines');
  assert.equal(Number(easy[1]), MG.COUNTRY_TIERS[1].length);
  assert.equal(Number(medium[1]), MG.COUNTRY_TIERS[2].length);
  assert.equal(Number(medium[2]), MG.COUNTRY_TIERS[1].length + MG.COUNTRY_TIERS[2].length);
  assert.match(text, /<b>Сложная<\/b> — все 219 стран/);
});

test('forgivenessKm: 0 without places or with one, capped at 300 km, small for a small country', () => {
  const places = require('../data/places.json');
  assert.equal(MG.forgivenessKm(undefined), 0);
  assert.equal(MG.forgivenessKm([]), 0);
  assert.equal(MG.forgivenessKm([[50.85, 4.35, 1000]]), 0);
  assert.equal(MG.forgivenessKm(places.RU), 300);
  const be = MG.forgivenessKm(places.BE);
  assert.ok(be > 20 && be < 150, `BE got ${be}`);
});

test('forgivenessKm: a country across the antimeridian keeps a small radius', () => {
  // 1° of longitude apart on the equator, ~111 km: each point is ~55 km from the centroid.
  const r = MG.forgivenessKm([[0, 179.5, 1], [0, -179.5, 1]]);
  assert.ok(r > 50 && r < 60, `got ${r}`);
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

const LINK_ROUNDS = [
  { src: 'g', id: 'CAoSLEFGMVFpcE', lat: 41.3851234567, lon: 2.1734, cc: 'ES' },
  { src: 'm', id: '1234567890', lat: -33.9, lon: 151.2, cc: 'AU' },
];
const LINK_DECODED = [
  { src: 'g', id: 'CAoSLEFGMVFpcE', lat: 41.385123, lon: 2.1734, cc: 'ES' },
  { src: 'm', id: '1234567890', lat: -33.9, lon: 151.2, cc: 'AU' },
];

test('challenge link: round trip, URL-safe alphabet, coordinates to 6 decimals', () => {
  const link = MG.encodeChallenge(LINK_ROUNDS, 'size');
  assert.match(link, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(MG.decodeChallenge(link), { scoring: 'size', rounds: LINK_DECODED });
});

test('challenge link: a link in the format before scoring modes opens size-aware', () => {
  // Exactly what encodeChallenge produced before #39: a plain array of tuples.
  const old = enc([['g', 'CAoSLEFGMVFpcE', 41.385123, 2.1734, 'ES'], ['m', '1234567890', -33.9, 151.2, 'AU']]);
  assert.deepEqual(MG.decodeChallenge(old), { scoring: 'size', rounds: LINK_DECODED });
  // A size-aware link is still that format, so a page from before #39 opens it too.
  assert.equal(MG.encodeChallenge(LINK_ROUNDS, 'size'), old);
  assert.equal(MG.encodeChallenge(LINK_ROUNDS), old);
});

test('challenge link: a classic link carries its mode', () => {
  const link = MG.encodeChallenge(LINK_ROUNDS, 'classic');
  assert.match(link, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(link, MG.encodeChallenge(LINK_ROUNDS, 'size'));
  assert.deepEqual(MG.decodeChallenge(link), { scoring: 'classic', rounds: LINK_DECODED });
});

test('challenge link: difficulty does not touch it, an easy game round-trips exactly as before', () => {
  // The link carries the places themselves, so the pool they were drawn from does not matter.
  const easy = LINK_ROUNDS.filter((r) => MG.countryAllowed(r.cc, 1));
  assert.equal(easy.length, LINK_ROUNDS.length, 'ES and AU are both easy countries');
  const tagged = easy.map((r) => ({ ...r, difficulty: 1 }));
  for (const scoring of ['size', 'classic']) {
    assert.equal(MG.encodeChallenge(tagged, scoring), MG.encodeChallenge(LINK_ROUNDS, scoring), scoring);
    assert.deepEqual(MG.decodeChallenge(MG.encodeChallenge(tagged, scoring)), { scoring, rounds: LINK_DECODED });
  }
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
    // A mode marker with no rounds, an unknown marker, a marker twice, a marker not first.
    enc(['c']),
    enc(['x', ['g', 'id', 1, 1, 'ES']]),
    enc(['classic', ['g', 'id', 1, 1, 'ES']]),
    enc(['c', 'c', ['g', 'id', 1, 1, 'ES']]),
    enc([['g', 'id', 1, 1, 'ES'], 'c']),
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
  settings: { sources: ['g', 'm'], spheres: 'walk', rounds: 3, difficulty: 2 }, challenge: false, scoring: 'size',
  rounds: LOG_ROUNDS, guesses: LOG_GUESSES, errors: [],
};

test('buildLogRecord: a finished game with a name, every field', () => {
  assert.deepEqual(MG.buildLogRecord({ ...LOG_GAME }), {
    v: 1,
    id: 'abc123def456',
    startedAt: 1760000000000,
    buildMs: 12345,
    name: 'Саша',
    settings: { sources: ['g', 'm'], spheres: 'walk', rounds: 3, difficulty: 2 },
    challenge: false,
    scoring: 'size',
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
    room: null,
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

test('buildLogRecord: a room game is marked with its room id and is not a challenge', () => {
  const rec = MG.buildLogRecord({ ...LOG_GAME, settings: null, challenge: false, room: 'k3x9a0bq7z', roundsTotal: 3 });
  assert.equal(rec.room, 'k3x9a0bq7z');
  assert.equal(rec.challenge, false);
  assert.equal(rec.settings, null);
  assert.equal(rec.finished, true);
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, room: '' }).room, null);
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, room: undefined }).room, null);
});

test('buildLogRecord: a room game is finished only when every round of the room was played', () => {
  // A room reveals its places one by one: two played of three is not finished, even though
  // every revealed round has its guess.
  const two = { ...LOG_GAME, room: 'abc', rounds: LOG_ROUNDS.slice(0, 2), guesses: LOG_GUESSES.slice(0, 2) };
  assert.equal(MG.buildLogRecord({ ...two, roundsTotal: 3 }).finished, false);
  assert.equal(MG.buildLogRecord({ ...two, roundsTotal: 2 }).finished, true);
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, room: 'abc', rounds: [], guesses: [], roundsTotal: 3 }).finished, false);
  // Without roundsTotal (a solo game) the rounds themselves are the whole game, as before.
  assert.equal(MG.buildLogRecord(two).finished, true);
  assert.equal(Object.keys(MG.buildLogRecord({ ...two, roundsTotal: 3 })).includes('roundsTotal'), false);
});

test('buildLogRecord: every record says how it was scored, a friends link and a room included', () => {
  assert.equal(MG.buildLogRecord({ ...LOG_GAME }).scoring, 'size');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, scoring: 'classic' }).scoring, 'classic');
  // A friends link has no settings of its own, but its mode came with the link.
  const link = MG.buildLogRecord({ ...LOG_GAME, challenge: true, settings: null, scoring: 'classic' });
  assert.equal(link.settings, null);
  assert.equal(link.scoring, 'classic');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, settings: null, room: 'abc', scoring: 'classic' }).scoring, 'classic');
  // Anything else is the default, size-aware: the field is never missing.
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, scoring: undefined }).scoring, 'size');
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, scoring: 'flat' }).scoring, 'size');
});

test('buildLogRecord: the settings carry the difficulty; settings without one are hard, as before', () => {
  for (const difficulty of [1, 2, 3]) {
    const rec = MG.buildLogRecord({ ...LOG_GAME, settings: { ...LOG_GAME.settings, difficulty } });
    assert.deepEqual(rec.settings, { sources: ['g', 'm'], spheres: 'walk', rounds: 3, difficulty });
  }
  const { difficulty, ...older } = LOG_GAME.settings;
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, settings: older }).settings.difficulty, 3);
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, settings: { ...older, difficulty: 'easy' } }).settings.difficulty, 3);
  // A friends link still has no settings at all.
  assert.equal(MG.buildLogRecord({ ...LOG_GAME, challenge: true }).settings, null);
});

const NAME_REQUIRED = 'Введите имя, чтобы начать игру.';

test('nameError: a name is required before a game starts', () => {
  assert.equal(MG.nameError('Саша'), '');
  assert.equal(MG.nameError('  Саша '), '');
  // Over-long is fine: cleanName cuts it to 20.
  assert.equal(MG.nameError('a'.repeat(25)), '');
  assert.equal(MG.nameError(''), NAME_REQUIRED);
  assert.equal(MG.nameError('   \t\n '), NAME_REQUIRED);
  assert.equal(MG.nameError(null), NAME_REQUIRED);
  assert.equal(MG.nameError(undefined), NAME_REQUIRED);
});
