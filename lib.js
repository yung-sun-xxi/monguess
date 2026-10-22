// Pure functions of MonGuess: scoring, geometry, country fix-ups, the friends link, the game log
// record and the browser side of live rooms.
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

  // A miss of km in a country whose places spread forgiveKm from its centre (forgivenessKm).
  // Nothing is subtracted: a big country's curve just decays slower, so every kilometre closer
  // still scores more. forgiveKm 0 is GeoGuessr's own curve, the classic scoring mode.
  const scoreFor = (km, forgiveKm = 0) =>
    Math.round(MAX_POINTS * Math.exp(-km / (SCORE_SCALE_KM + 2 * forgiveKm)));

  // The two scoring modes of the new-game window. Anything else, a missing mode included (an
  // older page, link or room), is the default, size-aware.
  const scoringMode = (scoring) => (scoring === 'classic' ? 'classic' : 'size');

  // What the size of the country gave over classic scoring for the same miss.
  const sizeBonus = (km, forgiveKm) => scoreFor(km, forgiveKm) - scoreFor(km, 0);

  // A guess of a solo game (or a friends link) scored: forgiveKm is the round's country spread,
  // which classic scoring ignores.
  function scoreGuess(round, guess, forgiveKm, scoring) {
    const km = distanceKm(round, guess);
    const spread = scoringMode(scoring) === 'classic' ? 0 : forgiveKm;
    return { km, points: scoreFor(km, spread), bonus: sizeBonus(km, spread) };
  }

  const FORGIVE_CAP_KM = 300;

  // How spread out a country's places are: the median distance from them to their centroid,
  // at most 300 km. scoreFor stretches its curve by it in size-aware scoring. The centroid is
  // the mean of unit vectors, not of degrees, so a country across the antimeridian (Fiji) is
  // not centred on the other side of the planet.
  function forgivenessKm(list) {
    if (!list || list.length < 2) return 0;
    const rad = (d) => (d * Math.PI) / 180;
    let x = 0, y = 0, z = 0;
    for (const [lat, lon] of list) {
      x += Math.cos(rad(lat)) * Math.cos(rad(lon));
      y += Math.cos(rad(lat)) * Math.sin(rad(lon));
      z += Math.sin(rad(lat));
    }
    const deg = (r) => (r * 180) / Math.PI;
    const centre = { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
    const d = list.map(([lat, lon]) => distanceKm({ lat, lon }, centre)).sort((a, b) => a - b);
    const mid = d.length >> 1;
    const median = d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
    return Math.min(median, FORGIVE_CAP_KM);
  }

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

  // ---------- Difficulty: which countries a game draws from ----------
  // A country's tier is how well-known it is to an ordinary player, not its size or how hard
  // its imagery is: 1 easy (the countries a GeoGuessr regular sees all the time), 2 medium,
  // 3 hard (microstates, small islands, overseas territories, rarely-heard-of countries).
  // Every code of data/places.json has exactly one tier (tests/lib.test.js checks it).
  // Pools are cumulative: easy is tier 1, medium tiers 1-2, hard everything.
  const tierList = (codes) => codes.trim().split(/\s+/);
  const COUNTRY_TIERS = {
    1: tierList(`
      US CA MX BR AR CL CO PE GB IE FR ES PT IT DE NL BE CH AT PL CZ HU RO HR GR SE NO
      FI DK IS RU UA TR IL AE SA EG MA ZA KE NG JP KR CN TW IN TH VN ID PH MY SG AU NZ`),
    2: tierList(`
      CU DO JM PR CR PA GT VE EC BO PY UY SK SI RS BA ME MK AL BG EE LV LT BY MD LU MT
      CY GE AM AZ KZ UZ MN PK BD LK NP KH LA MM HK KP IR IQ JO LB SY KW QA OM YE AF TN
      DZ LY SD ET TZ UG RW GH SN CI CM MZ ZW MG NA BW`),
    3: tierList(`
      AD AG AO AQ AS AW AX BB BF BH BI BJ BM BN BS BT BZ CD CF CG CK CV CW DJ DM EH ER
      FJ FK FM FO GA GD GF GI GL GM GN GP GQ GS GU GW GY HN HT IM KG KI KM KN KY LC LI
      LR LS MC MH ML MO MP MQ MR MU MV MW NC NE NI PF PG PS PW RE SB SC SJ SL SM SO SR
      SS ST SV SZ TC TD TG TJ TL TM TO TT TV VA VC VI VU WS XK YT ZM`),
  };
  const TIER_OF = new Map(Object.entries(COUNTRY_TIERS).flatMap(([t, codes]) => codes.map((cc) => [cc, Number(t)])));

  // A country code's tier, 1-3; null for a code with none (one resolveCountry made up: SX, BQ).
  const countryTier = (cc) => TIER_OF.get(cc) ?? null;

  const HARD = 3;
  const DIFFICULTY_TEXT = { 1: 'лёгкая', 2: 'средняя', 3: 'сложная' };

  // A difficulty, 1-3, from a number or the select's text. Anything else is fallback: hard by
  // default, because a game, room or log record from before difficulty drew from every country.
  function difficultyLevel(value, fallback = HARD) {
    if (value === 1 || value === 2 || value === 3) return value;
    if (value === '1' || value === '2' || value === '3') return Number(value);
    return fallback;
  }

  // Whether a round whose imagery resolved to cc may stay in a game of this difficulty. Hard
  // filters nothing at all, a code with no tier included: exactly the game before difficulty.
  function countryAllowed(cc, difficulty) {
    const level = difficultyLevel(difficulty);
    if (level === HARD) return true;
    const tier = countryTier(cc);
    return tier !== null && tier <= level;
  }

  // The codes a game of this difficulty draws its countries from, in the order given.
  const countryPool = (codes, difficulty) => codes.filter((cc) => countryAllowed(cc, difficulty));

  // A difficulty in the words of the menu, for the lobby.
  const describeDifficulty = (difficulty) => `Сложность: ${DIFFICULTY_TEXT[difficultyLevel(difficulty)]}`;

  // The friends link: the rounds as URL-safe base64 of [src, id, lat, lon, cc] tuples. A classic
  // game puts the string 'c' before them; a size-aware one stays the plain list, exactly the
  // link of the time before scoring modes, so either kind of page opens it.
  const CLASSIC_MARK = 'c';
  function encodeChallenge(rounds, scoring) {
    const compact = rounds.map((r) => [r.src, r.id, +r.lat.toFixed(6), +r.lon.toFixed(6), r.cc]);
    const list = scoringMode(scoring) === 'classic' ? [CLASSIC_MARK, ...compact] : compact;
    return btoa(JSON.stringify(list)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // { scoring, rounds }, or null for anything that is not a well-formed link: a truncated or
  // hand-edited one must not reach the game as NaN scores or a TypeError.
  function decodeChallenge(str) {
    try {
      let list = JSON.parse(atob(str.replace(/-/g, '+').replace(/_/g, '/')));
      if (!Array.isArray(list)) return null;
      let scoring = 'size';
      if (list[0] === CLASSIC_MARK) {
        scoring = 'classic';
        list = list.slice(1);
      }
      if (!list.length) return null;
      const rounds = list.map(([src, id, lat, lon, cc]) => ({ src, id: String(id ?? ''), lat, lon, cc }));
      const valid = (r) => (r.src === 'g' || r.src === 'm') && r.id !== ''
        && Number.isFinite(r.lat) && Math.abs(r.lat) <= 90
        && Number.isFinite(r.lon) && Math.abs(r.lon) <= 180
        && typeof r.cc === 'string' && /^[A-Z]{2}$/.test(r.cc);
      return rounds.every(valid) ? { scoring, rounds } : null;
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

  const NAME_REQUIRED = 'Введите имя, чтобы начать игру.';

  // A game starts only with a name: '' when there is one, otherwise the message to show.
  function nameError(raw) {
    return cleanName(raw) ? '' : NAME_REQUIRED;
  }

  // The text of "Скопировать результат". rounds is [{ cc, points }]; without a name the text
  // is exactly what the game copied before names existed.
  function formatResult({ name, total, max, rounds, url }) {
    const who = cleanName(name);
    const head = who ? `🌍 MonGuess · ${who}` : '🌍 MonGuess';
    const lines = rounds.map((r) => `${flag(r.cc)} ${r.points.toLocaleString('ru')}`);
    return `${head}: ${total.toLocaleString('ru')} из ${max.toLocaleString('ru')}\n${lines.join('  ')}\nСыграй те же места: ${url}`;
  }

  const LOG_KINDS = ['google', 'sphere', 'mapillary'];

  // The record app.js posts to /api/log, one per game. Rounds keep how the imagery was found
  // (kind: Google's own, a person's photosphere, Mapillary); a friends link does not carry it,
  // so its rounds have kind null, and its settings were the friend's, so settings are null.
  // scoring is the game's scoring mode, 'size' or 'classic', in every record: a friends link and
  // a room carry theirs. settings.difficulty is 1-3; settings without one are hard (3).
  // A room game carries its room id in room (null otherwise). A room reveals its places one
  // round at a time, so its rounds are only the ones played so far; roundsTotal, the room's
  // count, decides whether it was played to the end. Without it the rounds are the whole game.
  // Only the fields listed here leave the browser.
  function buildLogRecord({ id, startedAt, buildMs, name, settings, challenge, scoring, rounds, guesses, errors, room, roundsTotal }) {
    rounds = rounds || [];
    guesses = guesses || [];
    return {
      v: 1,
      id,
      startedAt,
      buildMs,
      name: cleanName(name),
      settings: challenge || !settings
        ? null
        : {
          sources: settings.sources, spheres: settings.spheres, rounds: settings.rounds,
          difficulty: difficultyLevel(settings.difficulty),
        },
      challenge: Boolean(challenge),
      scoring: scoringMode(scoring),
      rounds: rounds.map((r) => ({
        src: r.src, id: r.id, cc: r.cc, lat: r.lat, lon: r.lon,
        kind: LOG_KINDS.includes(r.kind) ? r.kind : null,
      })),
      guesses: guesses.map((g) => ({ lat: g.lat, lon: g.lon, km: g.km, points: g.points })),
      total: guesses.reduce((s, g) => s + g.points, 0),
      finished: rounds.length > 0 && guesses.length >= Math.max(rounds.length, roundsTotal || 0),
      errors: (errors || []).map((e) => ({ round: e.round, message: String(e.message) })),
      room: room || null,
    };
  }

  // The Russian plural of a count: 1 раунд, 2 раунда, 5 раундов, 11 раундов, 21 раунд.
  function pluralRu(n, one, few, many) {
    const d = n % 10;
    const dd = n % 100;
    if (d === 1 && dd !== 11) return one;
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
    return many;
  }

  // The line under a round's distance: what the country's size added. '' (the line is hidden)
  // when that is under 1 point, which is always the case in classic scoring.
  function sizeBonusText(bonus) {
    if (!(bonus >= 1)) return '';
    return `+${bonus.toLocaleString('ru')} ${pluralRu(bonus, 'очко', 'очка', 'очков')} за размер страны`;
  }

  // ---------- Live rooms: the browser side (the room itself is rooms/rules.js) ----------

  // What the room server accepts as a room id.
  const ROOM_ID = /^[a-z0-9]{1,16}$/;

  // One [a-z0-9] character per random byte: a room id or a playerId.
  function idFromBytes(bytes) {
    return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  }

  // The room id of a '#r=<id>' address, or null for anything else, a malformed id included.
  function roomIdFromHash(hash) {
    if (typeof hash !== 'string' || !hash.startsWith('#r=')) return null;
    const id = hash.slice(3);
    return ROOM_ID.test(id) ? id : null;
  }

  // base: the page address without a hash (origin + pathname).
  const roomLink = (base, id) => `${base}#r=${id}`;

  // The room's WebSocket on the page's own host; loc is window.location or alike.
  const roomSocketUrl = (loc, id) => `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/room/${id}`;

  // The first message of the browser that makes a room. mode and timerSec come from the menu
  // selects ('none' | 'timer', seconds as text), scoring from the scoring select ('size' |
  // 'classic'), difficulty 1-3 as the menu search has it (missing: hard); forgiveKm(cc) is the
  // round's country spread, which the room scores with. A classic room sends 0 for every round:
  // the room itself scores both modes the same way. Rounds keep only the fields the protocol names.
  function buildRoomCreate({ playerId, name, mode, timerSec, scoring, difficulty, rounds, forgiveKm }) {
    const classic = scoringMode(scoring) === 'classic';
    const timing = mode === 'timer' ? { mode: 'timer', timerSec: Number(timerSec) } : { mode: 'none' };
    return {
      type: 'create',
      playerId,
      name: cleanName(name),
      settings: { ...timing, scoring: scoringMode(scoring), difficulty: difficultyLevel(difficulty) },
      rounds: rounds.map((r) => ({
        src: r.src, id: r.id, lat: r.lat, lon: r.lon, cc: r.cc, forgiveKm: classic ? 0 : forgiveKm(r.cc),
      })),
    };
  }

  // The room's settings (as the room sends them) in the words of the menu.
  function describeRoomMode(settings) {
    if (settings.mode !== 'timer') return 'Без времени — раунд идёт, пока все не ответят';
    const n = settings.timerSec;
    return `Таймер: ${n} ${pluralRu(n, 'секунда', 'секунды', 'секунд')} после первого ответа`;
  }

  // A scoring mode in the words of the menu, for the lobby. A room from before scoring modes has
  // none: it is size-aware.
  function describeScoring(scoring) {
    return scoringMode(scoring) === 'classic'
      ? 'Подсчёт очков: классический, как в GeoGuessr'
      : 'Подсчёт очков: с учётом размера страны';
  }

  // "Ответили 2 из 3" while a room round waits. Only connected players count: someone who
  // left is not waited for (the room does not wait for them either).
  function guessedStatus(players) {
    const here = players.filter((p) => p.connected);
    return `Ответили ${here.filter((p) => p.guessed).length} из ${here.length}`;
  }

  // Whole seconds from now to a room deadline (endsAt, nextAt), rounded up; 0 once it passed.
  const secondsLeft = (at, now) => Math.max(0, Math.ceil((at - now) / 1000));

  // The pause on the results screen before the next round starts by itself, in a room
  // (rooms/rules.js) and in a solo game alike.
  const RESULTS_MS = 5000;

  // The countdown under a round's results to the deadline at: "Следующий раунд через 3…",
  // then "Следующий раунд…" once it passed.
  function nextRoundText(at, now) {
    const left = secondsLeft(at, now);
    return left ? `Следующий раунд через ${left}…` : 'Следующий раунд…';
  }

  // The rows of a round's results table, from the room's 'results' message: every player of
  // the table in its order (best total first), with their guess (lat, lon null without one),
  // its distance in words, this round's points and the running total. you: the player whose
  // screen this is.
  function roomResultRows({ guesses, table }, you) {
    const byId = new Map(guesses.map((g) => [g.playerId, g]));
    return table.map((row) => {
      const g = byId.get(row.playerId);
      const has = Boolean(g) && g.lat !== null;
      return {
        playerId: row.playerId,
        name: row.name,
        lat: has ? g.lat : null,
        lon: has ? g.lon : null,
        distance: has ? formatKm(g.km) : 'нет ответа',
        points: g ? g.points : 0,
        total: row.total,
        you: row.playerId === you,
      };
    });
  }

  // The room's final table: place (equal totals share one, then the count goes on: 1, 2, 2, 4),
  // name, points per round and total, in the table's order.
  function roomFinalRows(table, you) {
    let place = 0;
    return table.map((row, i) => {
      if (i === 0 || row.total !== table[i - 1].total) place = i + 1;
      return { place, name: row.name, points: row.points.slice(), total: row.total, you: row.playerId === you };
    });
  }

  // A round this good gets confetti in a solo game, where nobody else can win the round.
  const NEAR_PERFECT = 4900;

  // Who won a room round: every player with the round's best points. Nobody when the best is 0.
  function roundWinners(guesses) {
    const best = Math.max(0, ...guesses.map((g) => g.points));
    return best > 0 ? guesses.filter((g) => g.points === best).map((g) => g.playerId) : [];
  }

  // Who won the room: every player with the best total, as { name, total }. Nobody when it is 0.
  function gameWinners(table) {
    const best = Math.max(0, ...table.map((row) => row.total));
    return best > 0 ? table.filter((row) => row.total === best).map(({ name, total }) => ({ name, total })) : [];
  }

  // Names for one line of text: "Аня", "Аня и Миша", "Аня, Миша и Лена".
  function joinNames(names) {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
  }

  // ---------- The moon on the home banner ----------
  // The banner's moon shows today's real phase: the moon's age as a share of the lunar month,
  // 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. Counted from a known new moon over
  // the mean synodic month, so it may be off by about a day.
  const SYNODIC_DAYS = 29.530588853;
  const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
  function moonAge(ms) {
    const months = (ms - NEW_MOON_MS) / 86400000 / SYNODIC_DAYS;
    return ((months % 1) + 1) % 1;
  }

  // SVG path of the lit part of a moon of radius r centred at (c, c), as seen from the northern
  // hemisphere: one half of the disc (right while waxing, left while waning) closed by the
  // terminator, a half ellipse that bulges towards the lit side once the moon is past a quarter.
  function moonPath(age, c, r) {
    const rx = Math.abs(Math.cos(2 * Math.PI * age)) * r;
    const waxing = age < 0.5;
    const crescent = waxing ? age < 0.25 : age > 0.75;
    const limb = waxing ? 1 : 0;
    const sweep = waxing === crescent ? 0 : 1;
    const n = (x) => +x.toFixed(2);
    return `M${n(c)} ${n(c - r)}A${n(r)} ${n(r)} 0 0 ${limb} ${n(c)} ${n(c + r)}` +
      `A${n(rx)} ${n(r)} 0 0 ${sweep} ${n(c)} ${n(c - r)}Z`;
  }

  // The loading globe's dots: every city of places snapped to a step-degree grid, one dot per
  // occupied cell, as [lat, lon] pairs. Continents show through where the game has places.
  function globeCells(places, step = 4) {
    const seen = new Set();
    const cells = [];
    for (const list of Object.values(places)) {
      for (const [lat, lon] of list) {
        const cell = [Math.round(lat / step) * step, Math.round(lon / step) * step];
        const key = cell.join();
        if (!seen.has(key)) {
          seen.add(key);
          cells.push(cell);
        }
      }
    }
    return cells;
  }

  // A playerId as the room server accepts it (rooms/rules.js).
  const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

  // The browser remembers its seat in each room it entered, so a reload or a reopened link
  // comes back as the same player: localStorage[roomSeatKey(id)] = roomSeatText(seat).
  const roomSeatKey = (id) => `mg-room:${id}`;

  const roomSeatText = ({ playerId, name }) => JSON.stringify({ playerId, name: cleanName(name) });

  // The stored text back as { playerId, name }, or null for anything the room would refuse
  // (a broken playerId, no name) or that is not a seat at all: such a seat is forgotten.
  function parseRoomSeat(text) {
    let seat;
    try {
      seat = JSON.parse(text);
    } catch {
      return null;
    }
    if (!seat || typeof seat !== 'object') return null;
    const name = cleanName(seat.name);
    if (typeof seat.playerId !== 'string' || !PLAYER_ID.test(seat.playerId) || !name) return null;
    return { playerId: seat.playerId, name };
  }

  // How long to wait before reconnect attempt number attempt (0, 1, ...) after the room's
  // socket dropped: 1, 2, 4, 8 s, then every 10 s, and null once the waits would pass
  // 2 minutes in all: then the connection counts as lost.
  const RECONNECT_FIRST_MS = [1000, 2000, 4000, 8000];
  const RECONNECT_EVERY_MS = 10000;
  const RECONNECT_LIMIT_MS = 120000;
  function reconnectDelay(attempt) {
    const delay = (i) => (i < RECONNECT_FIRST_MS.length ? RECONNECT_FIRST_MS[i] : RECONNECT_EVERY_MS);
    let waited = 0;
    for (let i = 0; i <= attempt; i++) {
      waited += delay(i);
      if (waited > RECONNECT_LIMIT_MS) return null;
    }
    return delay(attempt);
  }

  // ---------- Mapillary vector tiles ----------
  // Mapillary's image search is unusable for boxes over ~600 m, so images are found through its
  // vector tiles: Mapbox Vector Tiles (protobuf), decoded here by hand without dependencies.

  // The slippy-map tile [x, y] at zoom z that holds the point (Web Mercator).
  function tileAt(lat, lon, z) {
    const n = 2 ** z;
    const clamp = (v) => Math.max(0, Math.min(n - 1, Math.floor(v)));
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return [clamp(((lon + 180) / 360) * n), clamp(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
  }

  // The up to 8 tiles around [x, y]: x wraps at the antimeridian, rows past the poles are skipped.
  function tileNeighbours(x, y, z) {
    const n = 2 ** z;
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && y + dy >= 0 && y + dy < n) out.push([(x + dx + n) % n, y + dy]);
      }
    }
    return out;
  }

  // A point inside tile [x, y] at zoom z, in tile units 0..extent, as { lat, lon }.
  function tilePointToLatLon(z, x, y, px, py, extent) {
    const n = 2 ** z;
    const lon = ((x + px / extent) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) / Math.PI;
    return { lat, lon };
  }

  const utf8 = new TextDecoder();

  // A minimal protobuf reader over a Uint8Array.
  function pbReader(buf, pos = 0, end = buf.length) {
    const r = {
      pos,
      end,
      // Exact up to 2^53, which covers every tag, length, count and geometry value.
      varint() {
        let v = 0;
        let mul = 1;
        let b;
        do {
          b = buf[r.pos++];
          v += (b & 0x7f) * mul;
          mul *= 128;
        } while (b & 0x80);
        return v;
      },
      bigVarint() {
        let v = 0n;
        let shift = 0n;
        let b;
        do {
          b = buf[r.pos++];
          v |= BigInt(b & 0x7f) << shift;
          shift += 7n;
        } while (b & 0x80);
        return v;
      },
      sub() {
        const len = r.varint();
        r.pos += len;
        return pbReader(buf, r.pos - len, r.pos);
      },
      skip(wire) {
        if (wire === 0) r.varint();
        else if (wire === 1) r.pos += 8;
        else if (wire === 2) r.pos += r.varint();
        else if (wire === 5) r.pos += 4;
        else throw new Error(`protobuf: wire type ${wire}`);
      },
      str() {
        const len = r.varint();
        r.pos += len;
        return utf8.decode(buf.subarray(r.pos - len, r.pos));
      },
      f32() {
        r.pos += 4;
        return new DataView(buf.buffer, buf.byteOffset + r.pos - 4, 4).getFloat32(0, true);
      },
      f64() {
        r.pos += 8;
        return new DataView(buf.buffer, buf.byteOffset + r.pos - 8, 8).getFloat64(0, true);
      },
    };
    return r;
  }

  // A 64-bit integer as a Number while that is exact, else as its decimal string.
  const int64 = (v) => (v >= -BigInt(Number.MAX_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v));

  function mvtValue(r) {
    let v = null;
    while (r.pos < r.end) {
      const tag = r.varint();
      const field = tag >> 3;
      if (field === 1) v = r.str();
      else if (field === 2) v = r.f32();
      else if (field === 3) v = r.f64();
      else if (field === 4) v = int64(BigInt.asIntN(64, r.bigVarint()));
      else if (field === 5) v = int64(r.bigVarint());
      else if (field === 6) { const u = r.bigVarint(); v = int64((u >> 1n) ^ -(u & 1n)); }
      else if (field === 7) v = r.varint() !== 0;
      else r.skip(tag & 7);
    }
    return v;
  }

  // The points of an MVT geometry, in tile units: the MoveTo/LineTo vertices, ClosePath ignored.
  function mvtPoints(r) {
    const pts = [];
    let px = 0;
    let py = 0;
    const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
    while (r.pos < r.end) {
      const cmd = r.varint();
      const id = cmd & 7;
      const count = Math.floor(cmd / 8);
      if (id === 7) continue;
      for (let i = 0; i < count; i++) {
        px += zz(r.varint());
        py += zz(r.varint());
        pts.push([px, py]);
      }
    }
    return pts;
  }

  // One layer of a vector tile: { extent, features: [{ id, props, points }] }, or null when the
  // tile has no layer of that name. A feature's id is a decimal string (it may pass 2^53).
  function decodeMvtLayer(bytes, name) {
    const tile = pbReader(bytes);
    while (tile.pos < tile.end) {
      const tag = tile.varint();
      if (tag >> 3 !== 3 || (tag & 7) !== 2) { tile.skip(tag & 7); continue; }
      const r = tile.sub();
      let layerName = null;
      let extent = 4096;
      const keys = [];
      const values = [];
      const raw = [];
      while (r.pos < r.end) {
        const t = r.varint();
        const field = t >> 3;
        if (field === 1) layerName = r.str();
        else if (field === 2) raw.push(r.sub());
        else if (field === 3) keys.push(r.str());
        else if (field === 4) values.push(mvtValue(r.sub()));
        else if (field === 5) extent = r.varint();
        else r.skip(t & 7);
      }
      if (layerName !== name) continue;
      const features = raw.map((f) => {
        const feature = { id: null, props: {}, points: [] };
        while (f.pos < f.end) {
          const t = f.varint();
          const field = t >> 3;
          if (field === 1) feature.id = String(f.bigVarint());
          else if (field === 2) {
            const s = f.sub();
            while (s.pos < s.end) {
              const k = s.varint();
              feature.props[keys[k]] = values[s.varint()];
            }
          } else if (field === 4) feature.points = mvtPoints(f.sub());
          else f.skip(t & 7);
        }
        return feature;
      });
      return { extent, features };
    }
    return null;
  }

  // The lowest Mapillary quality_score a round may use; under it the images are mostly junk.
  const MAPILLARY_MIN_QUALITY = 0.8;

  // Image ids worth a Graph lookup from a z13 tile's `sequence` layer, the only layer it has:
  // one id per panorama sequence whose own quality_score is >= MAPILLARY_MIN_QUALITY, as an exact
  // decimal string (the decoder gives a Number under 2^53 and a string past it). The sequence's
  // score is not its image's, so mapillaryGraphPlace checks the image again.
  function mapillarySequenceCandidates(bytes) {
    const layer = decodeMvtLayer(bytes, 'sequence');
    if (!layer) return [];
    return layer.features
      .filter((f) => f.props.is_pano === true && typeof f.props.quality_score === 'number'
        && f.props.quality_score >= MAPILLARY_MIN_QUALITY && f.props.image_id != null)
      .map((f) => String(f.props.image_id));
  }

  // A round place from the Graph answer for one image
  // (https://graph.mapillary.com/{id}?fields=id,is_pano,geometry,quality_score), or null when the
  // image is not a panorama, scores under MAPILLARY_MIN_QUALITY, has no Point geometry or no
  // decimal id. The position is the image's own: geometry.coordinates, which are [lon, lat].
  function mapillaryGraphPlace(json) {
    if (!json || json.is_pano !== true) return null;
    if (typeof json.quality_score !== 'number' || !(json.quality_score >= MAPILLARY_MIN_QUALITY)) return null;
    const id = json.id == null ? '' : String(json.id);
    if (!/^[0-9]+$/.test(id)) return null;
    const g = json.geometry;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) return null;
    const [lon, lat] = g.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { src: 'm', id, lat, lon, kind: 'mapillary' };
  }

  // The id of the round after `index` when that round is Mapillary, else null (the last round,
  // or a Google one next). The game loads it ahead in a hidden viewer while the current round is
  // played, so the next round starts without a black screen.
  function prewarmId(rounds, index) {
    const next = rounds[index + 1];
    return next && next.src === 'm' ? next.id : null;
  }

  const api = {
    MAX_POINTS, FORGIVE_CAP_KM, flag, shuffle, pickPlace, randomPointNear, distanceKm, scoreFor, forgivenessKm,
    scoringMode, sizeBonus, scoreGuess, sizeBonusText, describeScoring,
    COUNTRY_TIERS, countryTier, difficultyLevel, countryAllowed, countryPool, describeDifficulty,
    formatKm, resolveCountry, encodeChallenge, decodeChallenge, cleanName, nameError, formatResult, buildLogRecord,
    pluralRu, idFromBytes, roomIdFromHash, roomLink, roomSocketUrl, buildRoomCreate, describeRoomMode,
    guessedStatus, secondsLeft, RESULTS_MS, nextRoundText, roomResultRows, roomFinalRows, roomSeatKey, roomSeatText,
    NEAR_PERFECT, roundWinners, gameWinners, joinNames, globeCells, moonAge, moonPath,
    parseRoomSeat, reconnectDelay, tileAt, tileNeighbours, tilePointToLatLon, decodeMvtLayer,
    MAPILLARY_MIN_QUALITY, mapillarySequenceCandidates, mapillaryGraphPlace, prewarmId,
  };

  // ---------- Bad images ----------
  // Any player can hide the current round's image for good ("Плохая картинка"): the game posts
  // { src, id } to /api/bad, functions/api/bad.js keeps every hidden image in one KV value,
  // a JSON list of "src:id" keys, and the place search skips whatever is on it.

  const BAD_MAX = 5000;
  // Google: a 22-character pano id, or a user photosphere's longer one (it may end in '.').
  // Mapillary: a decimal image id.
  const BAD_ID = { g: /^[A-Za-z0-9_.-]{1,128}$/, m: /^[0-9]{1,20}$/ };

  // "src:id" for a valid { src, id } (a round or a found place will do), null for anything else.
  function badImageKey(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const { src, id } = entry;
    if (src !== 'g' && src !== 'm') return null;
    if (typeof id !== 'string' || !BAD_ID[src].test(id)) return null;
    return `${src}:${id}`;
  }

  // The stored list (parsed JSON) as valid keys, each once, in order; [] for anything not a list.
  function parseBadList(value) {
    if (!Array.isArray(value)) return [];
    const keys = new Set();
    for (const v of value) {
      if (typeof v !== 'string') continue;
      const at = v.indexOf(':');
      const key = badImageKey({ src: v.slice(0, at), id: v.slice(at + 1) });
      if (at > 0 && key === v) keys.add(key);
    }
    return [...keys];
  }

  // true when a found place is on the set of bad keys.
  function isBadImage(found, bad) {
    const key = badImageKey(found);
    return key !== null && bad.has(key);
  }

  // The list with key added at the end; the same list when the key is already on it;
  // null when the list is full. The list passed in is never changed.
  function addBadImage(list, key, max = BAD_MAX) {
    if (list.includes(key)) return list;
    if (list.length >= max) return null;
    return [...list, key];
  }

  Object.assign(api, { BAD_MAX, badImageKey, parseBadList, isBadImage, addBadImage });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.MG = api;
})();
