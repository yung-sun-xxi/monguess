'use strict';
// The game log endpoint (functions/api/log.js) against a fake KV namespace.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../functions/api/log.js');

// A KV namespace that records every put, or throws on put like a full Free-plan day does.
function fakeKV({ fail = false } = {}) {
  const puts = [];
  return {
    puts,
    async put(key, value) {
      if (fail) throw new Error('KV put() limit exceeded for the day.');
      puts.push([key, value]);
    },
  };
}

const post = (body) => new Request('https://monguess.pages.dev/api/log', { method: 'POST', body });

const NOW = Date.now();
const record = (over = {}) => ({ v: 1, id: 'abc123def456', startedAt: NOW, rounds: [], guesses: [], ...over });

async function send(body, kv = fakeKV()) {
  const { onRequestPost } = await load();
  const res = await onRequestPost({ request: post(body), env: { LOG: kv } });
  return { res, kv };
}

test('log: a valid record is stored as sent, under a newest-first key, with 204', async () => {
  // Indented on purpose: the text is stored as sent, not parsed and serialised again.
  const body = JSON.stringify(record({ startedAt: 1760000000000, name: 'Саша' }), null, 1);
  // A fixed startedAt needs a clock near it: the window is now − 2 days … now + 10 min.
  const realNow = Date.now;
  Date.now = () => 1760000000000 + 60000;
  try {
    const { res, kv } = await send(body);
    assert.equal(res.status, 204);
    assert.deepEqual(kv.puts, [['8239999999999-abc123def456', body]]);
  } finally {
    Date.now = realNow;
  }
});

test('log: a newer game sorts before an older one', async () => {
  const kv = fakeKV();
  await send(JSON.stringify(record({ id: 'oldgame00000', startedAt: NOW - 60000 })), kv);
  await send(JSON.stringify(record({ id: 'newgame00000', startedAt: NOW })), kv);
  const keys = kv.puts.map(([k]) => k);
  assert.equal(keys.length, 2);
  assert.deepEqual([...keys].sort(), [keys[1], keys[0]]);
});

test('log: two posts for one game land on one key, the later one wins', async () => {
  const kv = fakeKV();
  const first = JSON.stringify(record({ guesses: [] }));
  const second = JSON.stringify(record({ guesses: [{ lat: 1, lon: 2, km: 3, points: 4 }], finished: true }));
  assert.equal((await send(first, kv)).res.status, 204);
  assert.equal((await send(second, kv)).res.status, 204);
  assert.equal(kv.puts.length, 2);
  assert.equal(kv.puts[0][0], kv.puts[1][0]);
  assert.equal(kv.puts[1][1], second);
});

test('log: the edges of the accepted window and of the id pattern are stored', async () => {
  const ok = [
    record({ id: 'a'.repeat(12) }),
    record({ id: 'z9'.repeat(16) }), // 32 characters
    record({ startedAt: NOW - 2 * 86400000 + 5000 }),
    record({ startedAt: NOW + 10 * 60000 - 5000 }),
  ];
  for (const r of ok) {
    const { res, kv } = await send(JSON.stringify(r));
    assert.equal(res.status, 204, JSON.stringify(r));
    assert.equal(kv.puts.length, 1);
  }
  // Exactly 32 768 bytes is still accepted.
  const base = JSON.stringify(record({ pad: '' }));
  const exact = JSON.stringify(record({ pad: 'x'.repeat(32768 - Buffer.byteLength(base)) }));
  assert.equal(Buffer.byteLength(exact), 32768);
  assert.equal((await send(exact)).res.status, 204);
});

test('log: bad bodies get 400 and store nothing', async () => {
  const base = JSON.stringify(record({ pad: '' }));
  const tooBig = JSON.stringify(record({ pad: 'x'.repeat(32769 - Buffer.byteLength(base)) }));
  assert.equal(Buffer.byteLength(tooBig), 32769);
  // Cyrillic is two bytes per letter: under 32 768 characters, over 32 768 bytes.
  const tooBigInBytes = JSON.stringify(record({ pad: 'ж'.repeat(16400) }));
  assert.ok(tooBigInBytes.length < 32768 && Buffer.byteLength(tooBigInBytes) > 32768);
  const bad = {
    'over 32 768 bytes': tooBig,
    'over 32 768 bytes, under 32 768 characters': tooBigInBytes,
    'not JSON': '{"id": "abc123def456", ',
    'empty body': '',
    'JSON null': 'null',
    'JSON array': '[1, 2]',
    'JSON string': '"abc123def456"',
    'no id': JSON.stringify(record({ id: undefined })),
    'id too short': JSON.stringify(record({ id: 'a'.repeat(11) })),
    'id too long': JSON.stringify(record({ id: 'a'.repeat(33) })),
    'id with capitals': JSON.stringify(record({ id: 'ABC123DEF456' })),
    'id with a dash': JSON.stringify(record({ id: 'abc123-def456' })),
    'id with a newline after it': JSON.stringify(record({ id: 'abc123def456\n' })),
    'id as a number': JSON.stringify(record({ id: 123456789012 })),
    'no startedAt': JSON.stringify(record({ startedAt: undefined })),
    'startedAt as a string': JSON.stringify(record({ startedAt: String(NOW) })),
    'startedAt over 2 days old': JSON.stringify(record({ startedAt: NOW - 2 * 86400000 - 60000 })),
    'startedAt over 10 minutes ahead': JSON.stringify(record({ startedAt: NOW + 10 * 60000 + 60000 })),
    'startedAt null': JSON.stringify(record({ startedAt: null })),
  };
  for (const [why, body] of Object.entries(bad)) {
    const { res, kv } = await send(body);
    assert.equal(res.status, 400, why);
    assert.equal(kv.puts.length, 0, why);
  }
});

test('log: a failing KV put answers 503 and does not throw', async () => {
  const { res } = await send(JSON.stringify(record()), fakeKV({ fail: true }));
  assert.equal(res.status, 503);
});

test('log: a body that cannot be read answers 400 and does not throw', async () => {
  const { onRequestPost } = await load();
  const request = { text: async () => { throw new TypeError('Body has already been used'); } };
  const kv = fakeKV();
  const res = await onRequestPost({ request, env: { LOG: kv } });
  assert.equal(res.status, 400);
  assert.equal(kv.puts.length, 0);
});
