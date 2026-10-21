// Pure functions of MonGuess: scoring, geometry, country fix-ups and the friends link.
// No DOM and no network here, so Node runs these under tests (scripts/verify.sh);
// the browser gets the same object as window.MG.
(function () {
  'use strict';

  const MAX_POINTS = 5000;
  // GeoGuessr's world-map curve: 5000 · e^(−d / 1492 km).
  const SCORE_SCALE_KM = 1492.7;

  function flag(cc) {
    if (!/^[A-Z]{2}$/.test(cc)) return '🏳️';
    return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // A city weighted by √population: capitals come up more often, small towns still appear.
  function pickPlace(list) {
    const weights = list.map((p) => Math.sqrt(p[2]));
    let r = Math.random() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  // A point 1–40 km from a city, closer more often: both towns and countryside come up.
  function randomPointNear(list) {
    const [lat, lon] = pickPlace(list);
    const km = 1 + Math.random() * Math.random() * 40;
    const bearing = Math.random() * 2 * Math.PI;
    const dLat = (km / 111.32) * Math.cos(bearing);
    const dLon = (km / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.1))) * Math.sin(bearing);
    return [Math.max(-85, Math.min(85, lat + dLat)), ((lon + dLon + 540) % 360) - 180];
  }

  function distanceKm(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  const scoreFor = (km) => Math.round(MAX_POINTS * Math.exp(-km / SCORE_SCALE_KM));

  function formatKm(km) {
    if (km < 1) return `${Math.round(km * 1000)} м`;
    return `${Math.round(km).toLocaleString('ru')} км`;
  }

  // Nominatim names an overseas territory after its owner: Aruba is NL to it, Hong Kong is CN.
  // When the imagery was found in such a territory, keep the territory itself.
  const TERRITORY_OWNER = {
    AS: 'US', GU: 'US', MP: 'US', PR: 'US', VI: 'US',
    AW: 'NL', CW: 'NL', SX: 'NL', BQ: 'NL',
    GF: 'FR', GP: 'FR', MQ: 'FR', RE: 'FR', YT: 'FR', NC: 'FR', PF: 'FR', PM: 'FR', WF: 'FR', BL: 'FR', MF: 'FR',
    AX: 'FI', SJ: 'NO', HK: 'CN', MO: 'CN', GL: 'DK', FO: 'DK',
  };

  function resolveCountry(target, found) {
    if (!found) return target;
    return TERRITORY_OWNER[target] === found ? target : found;
  }

  // The friends link: the rounds as URL-safe base64 of [src, id, lat, lon, cc] tuples.
  function encodeChallenge(rounds) {
    const compact = rounds.map((r) => [r.src, r.id, +r.lat.toFixed(6), +r.lon.toFixed(6), r.cc]);
    return btoa(JSON.stringify(compact)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Null for anything that is not a well-formed link: a truncated or hand-edited one must
  // not reach the game as NaN scores or a TypeError.
  function decodeChallenge(str) {
    try {
      const list = JSON.parse(atob(str.replace(/-/g, '+').replace(/_/g, '/')));
      if (!Array.isArray(list) || !list.length) return null;
      const rounds = list.map(([src, id, lat, lon, cc]) => ({ src, id: String(id ?? ''), lat, lon, cc }));
      const valid = (r) => (r.src === 'g' || r.src === 'm') && r.id !== ''
        && Number.isFinite(r.lat) && Math.abs(r.lat) <= 90
        && Number.isFinite(r.lon) && Math.abs(r.lon) <= 180
        && typeof r.cc === 'string' && /^[A-Z]{2}$/.test(r.cc);
      return rounds.every(valid) ? rounds : null;
    } catch {
      return null;
    }
  }

  const NAME_MAX = 20;

  // The player's name as typed: trimmed, at most 20 characters, whitespace only is no name.
  // Cut by code points, so an emoji or a surrogate pair is never split in half.
  function cleanName(raw) {
    if (typeof raw !== 'string') return '';
    return [...raw.trim()].slice(0, NAME_MAX).join('').trim();
  }

  // The text of "Скопировать результат". rounds is [{ cc, points }]; without a name the text
  // is exactly what the game copied before names existed.
  function formatResult({ name, total, max, rounds, url }) {
    const who = cleanName(name);
    const head = who ? `🌍 MonGuess · ${who}` : '🌍 MonGuess';
    const lines = rounds.map((r) => `${flag(r.cc)} ${r.points.toLocaleString('ru')}`);
    return `${head}: ${total.toLocaleString('ru')} из ${max.toLocaleString('ru')}\n${lines.join('  ')}\nСыграй те же места: ${url}`;
  }

  const api = {
    MAX_POINTS, flag, shuffle, pickPlace, randomPointNear, distanceKm, scoreFor, formatKm,
    resolveCountry, encodeChallenge, decodeChallenge, cleanName, formatResult,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.MG = api;
})();
