'use strict';
// Bad images (issue #45): the pure list logic in lib.js and the endpoint functions/api/bad.js
// against a fake KV namespace.
const test = require('node:test');
const assert = require('node:assert/strict');
const MG = require('../lib.js');

const load = () => import('../functions/api/bad.js');

// Real ids from the game log: a Google pano, two user photospheres (one ends in '.'), Mapillary.
const GOOGLE = '2YVYw63evOMGELy5i19RbQ';
const SPHERE = 'CAoSFkNJSE0wb2dLRUlDQWdJQ3g3Wk9VSnc.';
const SPHERE_LONG = 'CAoSLEFGMVFpcE1fR2xVaE5hNW9fYmJ6X2VfZ0hYbVFWb2tHOXZ5c1BqcXhv';
const MAPILLARY = '985165524123893';

// ---------- lib.js ----------

test('badImageKey: valid Google and Mapillary ids give "src:id"', () => {
  assert.equal(MG.badImageKey({ src: 'g', id: GOOGLE }), `g:${GOOGLE}`);
  assert.equal(MG.badImageKey({ src: 'g', id: SPHERE }), `g:${SPHERE}`);
  assert.equal(MG.badImageKey({ src: 'g', id: SPHERE_LONG }), `g:${SPHERE_LONG}`);
  assert.equal(MG.badImageKey({ src: 'm', id: MAPILLARY }), `m:${MAPILLARY}`);
  // Extra fields (a round carries lat, lon, cc, kind) do not matter.
  assert.equal(MG.badImageKey({ src: 'm', id: MAPILLARY, lat: 1, lon: 2, cc: 'KE', kind: 'mapillary' }), `m:${MAPILLARY}`);
  // The edges of the id patterns.
  assert.equal(MG.badImageKey({ src: 'g', id: 'a'.repeat(128) }), `g:${'a'.repeat(128)}`);
  assert.equal(MG.badImageKey({ src: 'm', id: '1'.repeat(20) }), `m:${'1'.repeat(20)}`);
});

test('badImageKey: anything else gives null and never throws', () => {
  const bad = {
    'null': null,
    'undefined': undefined,
    'a string': `g:${GOOGLE}`,
    'a number': 5,
    'an array': ['g', GOOGLE],
    'no src': { id: GOOGLE },
    'unknown src': { src: 'x', id: GOOGLE },
    'src from the prototype': { src: 'constructor', id: GOOGLE },
    'src upper case': { src: 'G', id: GOOGLE },
    'no id': { src: 'g' },
    'empty id': { src: 'g', id: '' },
    'id as a number': { src: 'm', id: 985165524123893 },
    'Google id over 128': { src: 'g', id: 'a'.repeat(129) },
    'Google id with a slash': { src: 'g', id: 'abc/def' },
    'Google id with a colon': { src: 'g', id: 'abc:def' },
    'Google id with a space': { src: 'g', id: 'abc def' },
    'Google id with a newline after it': { src: 'g', id: `${GOOGLE}\n` },
    'Mapillary id with letters': { src: 'm', id: '98516552412389a' },
    'Mapillary id over 20 digits': { src: 'm', id: '1'.repeat(21) },
    'Mapillary id with a newline after it': { src: 'm', id: `${MAPILLARY}\n` },
  };
  for (const [why, entry] of Object.entries(bad)) assert.equal(MG.badImageKey(entry), null, why);
});

test('parseBadList: keeps valid keys once each, in order; anything else gives []', () => {
  assert.deepEqual(
    MG.parseBadList([`g:${GOOGLE}`, 'junk', `m:${MAPILLARY}`, `g:${GOOGLE}`, 7, null, 'x:1', `m:${MAPILLARY}a`, `g:${SPHERE}`]),
    [`g:${GOOGLE}`, `m:${MAPILLARY}`, `g:${SPHERE}`],
  );
  for (const value of [null, undefined, {}, 'g:abc', 42, { length: 1, 0: `g:${GOOGLE}` }]) {
    assert.deepEqual(MG.parseBadList(value), [], JSON.stringify(value));
  }
});

test('isBadImage: a found place on the list is skipped, any other is not', () => {
  const bad = new Set([`g:${GOOGLE}`, `m:${MAPILLARY}`]);
  assert.equal(MG.isBadImage({ src: 'g', id: GOOGLE, lat: 1, lon: 2, kind: 'google' }, bad), true);
  assert.equal(MG.isBadImage({ src: 'm', id: MAPILLARY, lat: 1, lon: 2, kind: 'mapillary' }, bad), true);
  // The same id under the other source is another image.
  assert.equal(MG.isBadImage({ src: 'm', id: GOOGLE }, bad), false);
  assert.equal(MG.isBadImage({ src: 'g', id: MAPILLARY }, bad), false);
  assert.equal(MG.isBadImage({ src: 'g', id: SPHERE }, bad), false);
  assert.equal(MG.isBadImage(null, bad), false);
  assert.equal(MG.isBadImage({ src: 'g', id: GOOGLE }, new Set()), false);
});

test('addBadImage: appends a new key, keeps a known one, refuses past the cap', () => {
  const list = [`g:${GOOGLE}`];
  const added = MG.addBadImage(list, `m:${MAPILLARY}`);
  assert.deepEqual(added, [`g:${GOOGLE}`, `m:${MAPILLARY}`]);
  assert.deepEqual(list, [`g:${GOOGLE}`], 'the input list is not changed');
  // A key already there: the same list back, so the caller knows not to write.
  assert.equal(MG.addBadImage(list, `g:${GOOGLE}`), list);
  // The cap: a full list takes nothing new, but a known key is still "already there".
  const full = ['m:1', 'm:2', 'm:3'];
  assert.equal(MG.addBadImage(full, 'm:4', 3), null);
  assert.equal(MG.addBadImage(full, 'm:2', 3), full);
  assert.deepEqual(MG.addBadImage(['m:1', 'm:2'], 'm:3', 3), ['m:1', 'm:2', 'm:3']);
  assert.equal(MG.BAD_MAX, 5000);
});

// ---------- functions/api/bad.js ----------

// A KV namespace holding one value per key; it can throw on get or put like a full Free-plan day.
function fakeKV(initial = {}, { failGet = false, failPut = false } = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  const gets = [];
  return {
    store,
    puts,
    gets,
    async get(key) {
      gets.push(key);
      if (failGet) throw new Error('KV get() limit exceeded for the day.');
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      if (failPut) throw new Error('KV put() limit exceeded for the day.');
      puts.push([key, value]);
      store.set(key, value);
    },
  };
}

const URL_BAD = 'https://monguess.pages.dev/api/bad';
const post = (body) => new Request(URL_BAD, { method: 'POST', body });

async function send(body, kv = fakeKV()) {
  const { onRequestPost } = await load();
  const res = await onRequestPost({ request: post(body), env: { LOG: kv } });
  return { res, kv };
}

async function list(kv) {
  const { onRequestGet } = await load();
  return onRequestGet({ request: new Request(URL_BAD), env: { LOG: kv } });
}

const stored = (kv) => JSON.parse(kv.store.get('bad-images'));

test('bad POST: a valid image is stored in one key, 204; a repeat writes nothing', async () => {
  const kv = fakeKV();
  assert.equal((await send(JSON.stringify({ src: 'g', id: GOOGLE }), kv)).res.status, 204);
  assert.equal((await send(JSON.stringify({ src: 'm', id: MAPILLARY }), kv)).res.status, 204);
  assert.deepEqual(stored(kv), [`g:${GOOGLE}`, `m:${MAPILLARY}`]);
  assert.deepEqual(kv.puts.map(([k]) => k), ['bad-images', 'bad-images']);
  // Pressed again by another player: still 204, no second write.
  assert.equal((await send(JSON.stringify({ src: 'g', id: GOOGLE }), kv)).res.status, 204);
  assert.equal(kv.puts.length, 2);
});

test('bad GET: one KV read of one key, the list as JSON with a short cache', async () => {
  const kv = fakeKV();
  const empty = await list(kv);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
  await send(JSON.stringify({ src: 'g', id: SPHERE }), kv);
  kv.gets.length = 0;
  const res = await list(kv);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [`g:${SPHERE}`]);
  assert.deepEqual(kv.gets, ['bad-images']);
  assert.match(res.headers.get('Content-Type'), /^application\/json/);
  assert.match(res.headers.get('Cache-Control'), /max-age=60\b/);
});

test('bad POST: bad bodies get 400 and store nothing', async () => {
  const bad = {
    'not JSON': '{"src": "g", ',
    'empty body': '',
    'JSON null': 'null',
    'JSON array': JSON.stringify(['g', GOOGLE]),
    'unknown src': JSON.stringify({ src: 'x', id: GOOGLE }),
    'Google id with a slash': JSON.stringify({ src: 'g', id: 'a/b' }),
    'Mapillary id with letters': JSON.stringify({ src: 'm', id: 'abc' }),
    'over 1024 bytes': JSON.stringify({ src: 'g', id: GOOGLE, pad: 'x'.repeat(1024) }),
    // Cyrillic is two bytes per letter: under 1024 characters, over 1024 bytes.
    'over 1024 bytes, under 1024 characters': JSON.stringify({ src: 'g', id: GOOGLE, pad: 'ж'.repeat(500) }),
  };
  for (const [why, body] of Object.entries(bad)) {
    const { res, kv } = await send(body);
    assert.equal(res.status, 400, why);
    assert.equal(kv.puts.length, 0, why);
  }
  // Exactly 1024 bytes is still accepted.
  const base = JSON.stringify({ src: 'g', id: GOOGLE, pad: '' });
  const exact = JSON.stringify({ src: 'g', id: GOOGLE, pad: 'x'.repeat(1024 - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), 1024);
  assert.equal((await send(exact)).res.status, 204);
});

test('bad POST: a full list refuses a new image with 507 and keeps what it has', async () => {
  const full = JSON.stringify(Array.from({ length: MG.BAD_MAX }, (_, i) => `m:${i + 1}`));
  const kv = fakeKV({ 'bad-images': full });
  assert.equal((await send(JSON.stringify({ src: 'g', id: GOOGLE }), kv)).res.status, 507);
  assert.equal(kv.puts.length, 0);
  // One already on it is still a success.
  assert.equal((await send(JSON.stringify({ src: 'm', id: '7' }), kv)).res.status, 204);
});

test('bad POST: a stored value that is not a list is never overwritten', async () => {
  const kv = fakeKV({ 'bad-images': '{"oops' });
  assert.equal((await send(JSON.stringify({ src: 'g', id: GOOGLE }), kv)).res.status, 503);
  assert.equal(kv.puts.length, 0);
  assert.equal(kv.store.get('bad-images'), '{"oops');
});

test('bad: failing KV answers 503 and does not throw', async () => {
  const body = JSON.stringify({ src: 'g', id: GOOGLE });
  assert.equal((await send(body, fakeKV({}, { failGet: true }))).res.status, 503);
  assert.equal((await send(body, fakeKV({}, { failPut: true }))).res.status, 503);
  assert.equal((await list(fakeKV({}, { failGet: true }))).status, 503);
});

test('bad POST: a body that cannot be read answers 400 and does not throw', async () => {
  const { onRequestPost } = await load();
  const request = { text: async () => { throw new TypeError('Body has already been used'); } };
  const kv = fakeKV();
  const res = await onRequestPost({ request, env: { LOG: kv } });
  assert.equal(res.status, 400);
  assert.equal(kv.puts.length, 0);
});
