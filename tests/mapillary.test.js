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

// keys: 0 id, 1 is_pano, 2 note, 3 compass_angle, 4 quality_score
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
    keys: ['id', 'is_pano', 'note', 'compass_angle', 'quality_score'],
    values: [value.uint(PANO_ID), value.bool(true), value.int(BIG_ID), value.bool(false), value.sint(BigInt(SINT_ID)),
      value.string('café'), value.double(123.5), value.int(-42)],
    features: [
      { id: 1, tags: [0, 0, 1, 1, 2, 5, 3, 6], geometry: points([[0, 0]]) }, // pano at the north-west corner
      { id: 2, tags: [0, 2, 1, 3, 3, 7], geometry: points([[2048, 2048]]) }, // non-pano at the centre
      // non-pano multipoint; its quality_score is a string, not a number
      { id: 3, tags: [0, 4, 1, 3, 4, 5], geometry: points([[4096, 4096], [100, 3000]]) },
      { id: 4, tags: [0, 0, 1, 1] }, // no geometry: not usable
    ],
  }),
]);

// A second tile for the panorama and quality cut. Every feature sits at the centre.
// keys: 0 id, 1 is_pano, 2 quality_score
// values: 0 true, 1 false, 2 0.95, 3 0.8, 4 0.79, 5 1 (all four doubles), 6.. ids 101..106 (uint)
const qualityTile = Uint8Array.from(layer({
  name: 'image',
  extent: 4096,
  keys: ['id', 'is_pano', 'quality_score'],
  values: [value.bool(true), value.bool(false), value.double(0.95), value.double(0.8), value.double(0.79), value.double(1),
    ...[101, 102, 103, 104, 105, 106].map((n) => value.uint(n))],
  features: [
    { id: 1, tags: [0, 6, 1, 0, 2, 2], geometry: points([[2048, 2048]]) }, // 101: pano, 0.95
    { id: 2, tags: [0, 7, 1, 0, 2, 3], geometry: points([[2048, 2048]]) }, // 102: pano, 0.8 exactly
    { id: 3, tags: [0, 8, 1, 0, 2, 4], geometry: points([[2048, 2048]]) }, // 103: pano, 0.79
    { id: 4, tags: [0, 9, 1, 0], geometry: points([[2048, 2048]]) }, // 104: pano, no quality_score
    { id: 5, tags: [0, 10, 1, 1, 2, 2], geometry: points([[2048, 2048]]) }, // 105: flat photo, 0.95
    { id: 6, tags: [0, 11, 1, 0, 2, 5], geometry: points([[2048, 2048]]) }, // 106: pano, 1
  ],
}));

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

test('mapillaryImages: usable images with string ids, lat/lon and quality; an empty tile gives none', () => {
  const imgs = MG.mapillaryImages(tileBytes, 14, 8296, 5636);
  // No quality_score, or one that is not a number, is null.
  assert.deepEqual(imgs.map((i) => [i.id, i.pano, i.quality]), [[PANO_ID, true, null], [BIG_ID, false, null], [SINT_ID, false, null]]);
  assert.deepEqual(MG.mapillaryImages(qualityTile, 14, 8296, 5636).map((i) => [i.id, i.pano, i.quality]), [
    ['101', true, 0.95], ['102', true, 0.8], ['103', true, 0.79], ['104', true, null], ['105', false, 0.95], ['106', true, 1],
  ]);
  const nw = MG.tilePointToLatLon(14, 8296, 5636, 0, 0, 4096);
  assert.deepEqual([imgs[0].lat, imgs[0].lon], [nw.lat, nw.lon]);
  const se = MG.tilePointToLatLon(14, 8296, 5636, 4096, 4096, 4096);
  assert.deepEqual([imgs[2].lat, imgs[2].lon], [se.lat, se.lon]); // a multipoint takes its first point
  assert.deepEqual(MG.mapillaryImages(Uint8Array.from(layer({ name: 'image', keys: [], values: [], features: [] })), 14, 0, 0), []);
  assert.deepEqual(MG.mapillaryImages(Uint8Array.from(layer({ name: 'sequence', keys: [], values: [], features: [] })), 14, 0, 0), []);
});

test('MAPILLARY_MIN_QUALITY is 0.8', () => {
  assert.equal(MG.MAPILLARY_MIN_QUALITY, 0.8);
});

test('pickMapillaryImage: only a panorama with quality_score >= 0.8, spread evenly; null for none', () => {
  const imgs = MG.mapillaryImages(qualityTile, 14, 8296, 5636);
  const byId = (id) => imgs.filter((i) => i.id === id);
  const c = imgs[0];
  // Eligible: 101 (0.95), 102 (0.8), 106 (1), in that order; the pick is uniform among them.
  assert.deepEqual(MG.pickMapillaryImage(imgs, () => 0), { src: 'm', id: '101', lat: c.lat, lon: c.lon, kind: 'mapillary' });
  assert.equal(MG.pickMapillaryImage(imgs, () => 0.34).id, '102');
  assert.equal(MG.pickMapillaryImage(imgs, () => 0.67).id, '106');
  assert.equal(MG.pickMapillaryImage(imgs, () => 0.999).id, '106');
  const seen = new Set();
  for (let k = 0; k < 100; k++) seen.add(MG.pickMapillaryImage(imgs, () => k / 100).id);
  assert.deepEqual([...seen].sort(), ['101', '102', '106']); // never 103 (0.79), 104 (no score), 105 (flat)

  // The cut sits exactly at 0.8: 0.79 is dropped, 0.8 is kept.
  assert.equal(MG.pickMapillaryImage(byId('103'), () => 0), null);
  assert.equal(MG.pickMapillaryImage(byId('102'), () => 0).id, '102');
  // A panorama with no quality_score is dropped.
  assert.equal(MG.pickMapillaryImage(byId('104'), () => 0), null);
  // A flat photo is never picked, however good, and with no panorama left there is no pick.
  assert.equal(MG.pickMapillaryImage(byId('105'), () => 0), null);
  assert.equal(MG.pickMapillaryImage([{ id: 'f', pano: false, quality: 1, lat: 1, lon: 2 }], () => 0), null);
  assert.equal(MG.pickMapillaryImage(imgs.filter((i) => !i.pano || i.quality < 0.8), () => 0), null);
  // The first tile: its panorama has no quality_score and the rest are flat photos.
  for (const r of [0, 0.5, 0.999]) assert.equal(MG.pickMapillaryImage(MG.mapillaryImages(tileBytes, 14, 8296, 5636), () => r), null);
  assert.equal(MG.pickMapillaryImage([]), null);
});

// ---------- z13 sequence layer + Graph lookup by image id ----------

// A z13 tile carries only a `sequence` layer: one feature per sequence, with the id of one of
// its images. Every feature here is a panorama with quality_score >= 0.8 unless its note says
// otherwise. keys: 0 id, 1 is_pano, 2 quality_score, 3 image_id
// values: 0 true, 1 false, 2 0.95, 3 0.8, 4 0.79, 5 1, 6 'seq', 7 PANO_ID (int64, decodes to a
//         Number), 8 BIG_ID (int64, decodes to a string), 9 SINT_ID (sint64), 10..14 uint 201..205,
//         15 '0.9' (a string, not a number)
const sequenceTile = Uint8Array.from(layer({
  name: 'sequence',
  extent: 4096,
  keys: ['id', 'is_pano', 'quality_score', 'image_id'],
  values: [value.bool(true), value.bool(false), value.double(0.95), value.double(0.8), value.double(0.79), value.double(1),
    value.string('seq'), value.int(PANO_ID), value.int(BIG_ID), value.sint(BigInt(SINT_ID)),
    ...[201, 202, 203, 204, 205].map((n) => value.uint(n)), value.string('0.9')],
  features: [
    { id: 1, tags: [0, 6, 1, 0, 2, 2, 3, 7], geometry: points([[10, 10]]) }, // PANO_ID, 0.95
    { id: 2, tags: [0, 6, 1, 0, 2, 3, 3, 8], geometry: points([[20, 20]]) }, // BIG_ID, 0.8 exactly
    { id: 3, tags: [0, 6, 1, 0, 2, 5, 3, 9], geometry: points([[30, 30]]) }, // SINT_ID, 1
    { id: 4, tags: [0, 6, 1, 0, 2, 4, 3, 10], geometry: points([[40, 40]]) }, // 201: 0.79, dropped
    { id: 5, tags: [0, 6, 1, 1, 2, 2, 3, 11], geometry: points([[50, 50]]) }, // 202: flat, dropped
    { id: 6, tags: [0, 6, 1, 0, 3, 12], geometry: points([[60, 60]]) }, // 203: no quality_score, dropped
    { id: 7, tags: [0, 6, 1, 0, 2, 15, 3, 13], geometry: points([[70, 70]]) }, // 204: quality is a string, dropped
    { id: 8, tags: [0, 6, 1, 0, 2, 2], geometry: points([[80, 80]]) }, // no image_id, dropped
    { id: 9, tags: [0, 6, 2, 2, 3, 14], geometry: points([[90, 90]]) }, // 205: no is_pano, dropped
  ],
}));

test('mapillarySequenceCandidates: image ids of panorama sequences with quality_score >= 0.8, as exact decimal strings', () => {
  assert.deepEqual(MG.mapillarySequenceCandidates(sequenceTile), [PANO_ID, BIG_ID, SINT_ID]);
  // The decoder hands PANO_ID back as a Number and BIG_ID as a string; both come out as strings.
  const decoded = MG.decodeMvtLayer(sequenceTile, 'sequence').features;
  assert.equal(typeof decoded[0].props.image_id, 'number');
  assert.equal(typeof decoded[1].props.image_id, 'string');
  // No sequence layer (a z14 tile has `image`), an empty layer, or no bytes: no candidates.
  assert.deepEqual(MG.mapillarySequenceCandidates(tileBytes.slice(layer({
    name: 'sequence', keys: ['id'], values: [value.string('seq')],
    features: [{ tags: [0, 0], geometry: points([[1, 1]]) }],
  }).length)), []);
  assert.deepEqual(MG.mapillarySequenceCandidates(Uint8Array.from(layer({ name: 'sequence', keys: [], values: [], features: [] }))), []);
  assert.deepEqual(MG.mapillarySequenceCandidates(new Uint8Array(0)), []);
});

// A Graph answer for one image, as https://graph.mapillary.com/{id}?fields=id,is_pano,geometry,quality_score gives it.
const graphImage = (over = {}) => ({
  id: '989706182335379', is_pano: true, geometry: { type: 'Point', coordinates: [2.2953544, 48.8433791] }, quality_score: 0.862,
  ...over,
});

test('mapillaryGraphPlace: a panorama with quality_score >= 0.8 becomes a round place at its Graph geometry', () => {
  // coordinates are [lon, lat]; the place takes them exactly, the right way round.
  assert.deepEqual(MG.mapillaryGraphPlace(graphImage()),
    { src: 'm', id: '989706182335379', lat: 48.8433791, lon: 2.2953544, kind: 'mapillary' });
  assert.deepEqual(MG.mapillaryGraphPlace(graphImage({ geometry: { type: 'Point', coordinates: [-4.123, 40.5] } })),
    { src: 'm', id: '989706182335379', lat: 40.5, lon: -4.123, kind: 'mapillary' });
  // The cut sits exactly at 0.8, as for the sequence.
  assert.equal(MG.mapillaryGraphPlace(graphImage({ quality_score: 0.8 })).id, '989706182335379');
  assert.equal(MG.mapillaryGraphPlace(graphImage({ quality_score: 1 })).id, '989706182335379');
  assert.equal(MG.mapillaryGraphPlace(graphImage({ quality_score: 0.799 })), null);
  // The image's own score decides, not the sequence's: seen live, sequence 0.86, image 0.809 / 0.787.
  assert.equal(MG.mapillaryGraphPlace(graphImage({ quality_score: 0.787 })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ quality_score: undefined })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ quality_score: '0.9' })), null);
  // A flat photo, or an answer that does not say it is a panorama, is never a place.
  assert.equal(MG.mapillaryGraphPlace(graphImage({ is_pano: false })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ is_pano: undefined })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ is_pano: 'true' })), null);
  // No usable Point geometry: no place.
  assert.equal(MG.mapillaryGraphPlace(graphImage({ geometry: undefined })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ geometry: { type: 'Point', coordinates: [2.29] } })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ geometry: { type: 'Point', coordinates: ['2.29', '48.8'] } })), null);
  // An id the bad-image list could not hold, an error answer, or nothing at all: no place.
  assert.equal(MG.mapillaryGraphPlace(graphImage({ id: undefined })), null);
  assert.equal(MG.mapillaryGraphPlace(graphImage({ id: 'abc' })), null);
  assert.equal(MG.mapillaryGraphPlace({ error: { message: 'Unsupported get request', code: 100 } }), null);
  assert.equal(MG.mapillaryGraphPlace(null), null);
  assert.equal(MG.mapillaryGraphPlace(undefined), null);
  // The place passes the bad-image key rule.
  assert.equal(MG.badImageKey(MG.mapillaryGraphPlace(graphImage())), 'm:989706182335379');
});
