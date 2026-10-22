'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MG = require('../lib.js');

// ---------- A minimal hand-written MVT encoder, independent of the decoder under test ----------

function varint(v) {
  let n = BigInt(v);
  if (n < 0n) n = BigInt.asUintN(64, n); // int64 negatives take 10 bytes
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
const key = (field, wire) => varint((field << 3) | wire);
const len = (field, bytes) => [...key(field, 2), ...varint(bytes.length), ...bytes];
const str = (field, s) => len(field, [...Buffer.from(s, 'utf8')]);
const zigzag = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const command = (id, count) => (count << 3) | id;
// A point or multipoint: one MoveTo with the points as zigzag deltas.
function points(pts) {
  const out = [command(1, pts.length)];
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    out.push(zigzag(px - x), zigzag(py - y));
    [x, y] = [px, py];
  }
  return out;
}
const packed = (field, nums) => len(field, nums.flatMap((n) => varint(n)));
const value = {
  string: (s) => str(1, s),
  double: (d) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(d);
    return [...key(3, 1), ...b];
  },
  int: (v) => [...key(4, 0), ...varint(v)],
  uint: (v) => [...key(5, 0), ...varint(v)],
  sint: (v) => [...key(6, 0), ...varint(v < 0n ? -2n * v - 1n : 2n * v)],
  bool: (b) => [...key(7, 0), b ? 1 : 0],
};
function feature({ id, tags, geometry }) {
  return [
    ...(id === undefined ? [] : [...key(1, 0), ...varint(id)]),
    ...packed(2, tags),
    ...key(3, 0), 1, // type POINT
    ...(geometry ? packed(4, geometry) : []),
  ];
}
function layer({ name, keys, values, features, extent }) {
  return len(3, [
    ...key(15, 0), 2,
    ...str(1, name),
    ...features.flatMap((f) => len(2, feature(f))),
    ...keys.flatMap((k) => str(3, k)),
    ...values.flatMap((v) => len(4, v)),
    ...(extent ? [...key(5, 0), ...varint(extent)] : []),
  ]);
}

const PANO_ID = '1234567890123456'; // 16 digits, under 2^53
const BIG_ID = '28173036208963731'; // 17 digits, past 2^53: a Number would round it
const SINT_ID = '9007199254740993'; // 2^53 + 1

// keys: 0 id, 1 is_pano, 2 note, 3 compass_angle
// values: 0 PANO_ID (uint64), 1 true, 2 BIG_ID (int64), 3 false, 4 SINT_ID (sint64),
//         5 'café', 6 123.5 (double), 7 -42 (int64, 10 bytes)
const tileBytes = Uint8Array.from([
  // A layer of another name first: the decoder must skip it.
  ...layer({
    name: 'sequence', keys: ['id'], values: [value.string('seq')],
    features: [{ tags: [0, 0], geometry: points([[1, 1]]) }],
  }),
  ...layer({
    name: 'image',
    extent: 4096,
    keys: ['id', 'is_pano', 'note', 'compass_angle'],
    values: [value.uint(PANO_ID), value.bool(true), value.int(BIG_ID), value.bool(false), value.sint(BigInt(SINT_ID)),
      value.string('café'), value.double(123.5), value.int(-42)],
    features: [
      { id: 1, tags: [0, 0, 1, 1, 2, 5, 3, 6], geometry: points([[0, 0]]) }, // pano at the north-west corner
      { id: 2, tags: [0, 2, 1, 3, 3, 7], geometry: points([[2048, 2048]]) }, // non-pano at the centre
      { id: 3, tags: [0, 4, 1, 3], geometry: points([[4096, 4096], [100, 3000]]) }, // non-pano multipoint
      { id: 4, tags: [0, 0, 1, 1] }, // no geometry: not usable
    ],
  }),
]);

// Latitude of a tile row edge by the other textbook formula, 2·atan(e^y) − π/2.
const rowLat = (y, z) => ((2 * Math.atan(Math.exp(Math.PI * (1 - (2 * y) / 2 ** z))) - Math.PI / 2) * 180) / Math.PI;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('tileAt: known z14 tiles, the corners of the world, clamped at the poles', () => {
  assert.deepEqual(MG.tileAt(48.855, 2.295, 14), [8296, 5636]); // Paris, Eiffel Tower
  assert.deepEqual(MG.tileAt(41.3874, 2.1686, 14), [8290, 6119]); // Barcelona
  assert.deepEqual(MG.tileAt(0, 0, 14), [8192, 8192]);
  assert.deepEqual(MG.tileAt(-33.8568, 151.2153, 14), [15073, 9831]); // Sydney Opera House
  assert.deepEqual(MG.tileAt(89.9, -180, 14), [0, 0]);
  assert.deepEqual(MG.tileAt(-89.9, 180, 14), [16383, 16383]);
});

test('tileNeighbours: 8 around, x wraps at the antimeridian, rows past the poles skipped', () => {
  const last = 2 ** 14 - 1;
  const sorted = (a) => a.map(String).sort();
  assert.deepEqual(sorted(MG.tileNeighbours(8296, 5636, 14)), sorted([
    [8295, 5635], [8296, 5635], [8297, 5635], [8295, 5636], [8297, 5636], [8295, 5637], [8296, 5637], [8297, 5637],
  ]));
  assert.deepEqual(sorted(MG.tileNeighbours(0, 100, 14)), sorted([
    [last, 99], [0, 99], [1, 99], [last, 100], [1, 100], [last, 101], [0, 101], [1, 101],
  ]));
  assert.deepEqual(sorted(MG.tileNeighbours(last, 100, 14)), sorted([
    [last - 1, 99], [last, 99], [0, 99], [last - 1, 100], [0, 100], [last - 1, 101], [last, 101], [0, 101],
  ]));
  assert.deepEqual(sorted(MG.tileNeighbours(5, 0, 14)), sorted([[4, 0], [6, 0], [4, 1], [5, 1], [6, 1]]));
  assert.deepEqual(sorted(MG.tileNeighbours(5, last, 14)), sorted([[4, last], [6, last], [4, last - 1], [5, last - 1], [6, last - 1]]));
});

test('tilePointToLatLon: corners and centre of a tile, the world corner, and back through tileAt', () => {
  const nw = MG.tilePointToLatLon(14, 8296, 5636, 0, 0, 4096);
  near(nw.lon, (8296 / 16384) * 360 - 180);
  near(nw.lat, rowLat(5636, 14));
  const se = MG.tilePointToLatLon(14, 8296, 5636, 4096, 4096, 4096);
  near(se.lon, (8297 / 16384) * 360 - 180);
  near(se.lat, rowLat(5637, 14));
  const c = MG.tilePointToLatLon(14, 8296, 5636, 2048, 2048, 4096);
  near(c.lon, (8296.5 / 16384) * 360 - 180);
  near(c.lat, rowLat(5636.5, 14));
  assert.deepEqual(MG.tileAt(c.lat, c.lon, 14), [8296, 5636]);
  const world = MG.tilePointToLatLon(0, 0, 0, 0, 0, 4096);
  near(world.lon, -180);
  near(world.lat, 85.0511287798066);
  // Extent only scales the point: 512 of 512 is the same place as 4096 of 4096.
  assert.deepEqual(MG.tilePointToLatLon(14, 8296, 5636, 512, 512, 512), se);
});

test('decodeMvtLayer: the named layer only, every value type, exact 64-bit ids, zigzag geometry', () => {
  assert.equal(MG.decodeMvtLayer(tileBytes, 'nope'), null);
  assert.equal(MG.decodeMvtLayer(new Uint8Array(0), 'image'), null);
  const seq = MG.decodeMvtLayer(tileBytes, 'sequence');
  assert.equal(seq.extent, 4096); // the default when a layer gives none
  assert.deepEqual(seq.features[0].props, { id: 'seq' });

  const { extent, features } = MG.decodeMvtLayer(tileBytes, 'image');
  assert.equal(extent, 4096);
  assert.equal(features.length, 4);
  assert.deepEqual(features.map((f) => f.id), ['1', '2', '3', '4']);
  assert.deepEqual(features[0].props, { id: Number(PANO_ID), is_pano: true, note: 'café', compass_angle: 123.5 });
  assert.equal(String(features[0].props.id), PANO_ID);
  assert.equal(features[1].props.id, BIG_ID); // past 2^53: kept as the exact decimal string
  assert.equal(features[1].props.compass_angle, -42);
  assert.equal(features[2].props.id, SINT_ID);
  assert.deepEqual(features[0].points, [[0, 0]]);
  assert.deepEqual(features[1].points, [[2048, 2048]]);
  assert.deepEqual(features[2].points, [[4096, 4096], [100, 3000]]);
  assert.deepEqual(features[3].points, []);
});

test('mapillaryImages: usable images with string ids and lat/lon; an empty tile gives none', () => {
  const imgs = MG.mapillaryImages(tileBytes, 14, 8296, 5636);
  assert.deepEqual(imgs.map((i) => [i.id, i.pano]), [[PANO_ID, true], [BIG_ID, false], [SINT_ID, false]]);
  const nw = MG.tilePointToLatLon(14, 8296, 5636, 0, 0, 4096);
  assert.deepEqual([imgs[0].lat, imgs[0].lon], [nw.lat, nw.lon]);
  const se = MG.tilePointToLatLon(14, 8296, 5636, 4096, 4096, 4096);
  assert.deepEqual([imgs[2].lat, imgs[2].lon], [se.lat, se.lon]); // a multipoint takes its first point
  assert.deepEqual(MG.mapillaryImages(Uint8Array.from(layer({ name: 'image', keys: [], values: [], features: [] })), 14, 0, 0), []);
  assert.deepEqual(MG.mapillaryImages(Uint8Array.from(layer({ name: 'sequence', keys: [], values: [], features: [] })), 14, 0, 0), []);
});

test('pickMapillaryImage: a panorama when there is one, else any image, null for none', () => {
  const imgs = MG.mapillaryImages(tileBytes, 14, 8296, 5636);
  for (const r of [0, 0.5, 0.999]) {
    const got = MG.pickMapillaryImage(imgs, () => r);
    assert.deepEqual(got, { src: 'm', id: PANO_ID, lat: imgs[0].lat, lon: imgs[0].lon, kind: 'mapillary' });
  }
  const plain = imgs.filter((i) => !i.pano);
  assert.equal(MG.pickMapillaryImage(plain, () => 0).id, BIG_ID);
  assert.equal(MG.pickMapillaryImage(plain, () => 0.999).id, SINT_ID);
  assert.equal(MG.pickMapillaryImage([]), null);
});
