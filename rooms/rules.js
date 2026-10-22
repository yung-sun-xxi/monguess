'use strict';
// The rules of a live MonGuess room: a pure state machine with no I/O and no timers.
//
//   step(state, event, now) -> { state, out, alarmAt }
//
// state    the room as plain JSON (null: no room). The Durable Object stores it as is.
// event    one of the events below. now is the time in ms since the epoch.
// out      messages to send, in order: [{ to: 'all' | <playerId>, msg }]. 'all' means every
//          socket of every player in the room.
// alarmAt  when the room must be woken with { type: 'alarm' } (a countdown, the 5 s
//          auto-advance, idle expiry), or null when the room no longer exists. A returned
//          state of null after a room existed means it expired: clear its storage.
//
// Everyone in a room has equal rights; whoever created it has no extra powers.
//
// ---------------------------------------------------------------------------------------
// The protocol between a browser and a room: JSON text frames over the WebSocket
// /api/room/<id>, where <id> is 1-16 characters of [a-z0-9].
//
// A playerId is chosen by the browser (1-64 characters of [A-Za-z0-9_-]) and kept by it, so
// a page that reconnects with the same playerId is the same player, never a second one.
// The first message on a socket must be create or join; the socket then speaks for that
// playerId. Closing the socket is leaving. A player who left is shown as not connected at
// once, but a round keeps waiting for them for GRACE_MS (10 s): a reload or a short network
// drop comes back with join inside that time and still plays the round. After the grace the
// round no longer waits for them; a timer round's countdown governs either way.
//
// Browser -> room
//   { type: 'create', playerId, name, settings, rounds }
//       Makes the room; only valid on a room that does not exist yet. The creator joins.
//       settings: { mode: 'none' }                   a round ends when every connected
//                                                     player (and everyone who left less
//                                                     than GRACE_MS ago) has guessed
//              or { mode: 'timer', timerSec: 5-600 } the first guess starts timerSec
//                                                     seconds for the rest
//                 plus scoring: 'size' | 'classic', the scoring mode, kept and shown in the
//                 lobby. Missing (a page from before scoring modes) means 'size'; any other
//                 value refuses the room.
//                 plus difficulty: 1 | 2 | 3 (easy, medium, hard), the pool of countries the
//                 creator's browser drew the rounds from, kept and shown in the lobby. Missing
//                 (a page from before difficulty, which drew from every country) means 3; any
//                 other value, a number as text included, refuses the room.
//       rounds: 1-20 of { src: 'g'|'m', id, lat, lon, cc, forgiveKm }, found by the
//               creator's browser as for a solo game; forgiveKm, 0-300, is what the room
//               scores with, MG.scoreFor(km, forgiveKm): lib.js forgivenessKm(places[cc]) in a
//               size-aware room, 0 for every round in a classic one.
//   { type: 'join', playerId, name }   Enter the room, or come back to it.
//   { type: 'start' }                  Lobby only; any player.
//   { type: 'guess', round, lat, lon } round is the index the guess is for.
//
// Room -> browser
//   { type: 'state', you, phase, settings, roundsTotal, index, place, endsAt, nextAt,
//     players, table, results }
//       To one player, after create or join: everything needed to draw the room now.
//       phase: 'lobby' | 'round' | 'results' | 'final'. index: the current round (-1 in
//       the lobby). place: { src, id } during a round, else null. endsAt: the countdown's
//       end in a timer round, else null. nextAt: when the next round starts, in results.
//       results: the last 'results' message's fields in results and final, else null.
//   { type: 'players', players: [{ playerId, name, connected, guessed }] }
//       To all, when someone joins or leaves.
//   { type: 'round', index, of, place: { src, id } }
//       To all: a round starts. The answer (lat, lon, cc) is not sent until results.
//   { type: 'guessed', playerId }      To all: that player has guessed this round.
//   { type: 'countdown', endsAt }      To all: the first guess of a timer round.
//   { type: 'results', index, place: { src, id, lat, lon, cc, forgiveKm },
//     guesses: [{ playerId, name, lat, lon, km, points }], table, nextAt }
//       To all: the round is over. A player with no guess has lat, lon, km null and 0
//       points. nextAt: when the next round starts by itself (5 s), null after the last.
//   { type: 'final', table }           To all, right after the last round's results.
//   { type: 'error', code, message }   To the one player whose message was refused.
//       code: no-room, room-exists, bad-room, bad-name, bad-player, not-in-room, started,
//       not-in-round, wrong-round, bad-guess, already-guessed, bad-message.
//
// table: [{ playerId, name, connected, total, points: [per finished round] }], best total
// first, ties in join order. A player who joined late has 0 for the rounds played before.
// ---------------------------------------------------------------------------------------

const MG = require('../lib.js');

const RESULTS_MS = MG.RESULTS_MS;
const GRACE_MS = 10000;
const IDLE_MS = 3 * 60 * 60 * 1000;
const MAX_ROUNDS = 20;
const TIMER_MIN_SEC = 5;
const TIMER_MAX_SEC = 600;
const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const validPoint = (lat, lon) => isNum(lat) && Math.abs(lat) <= 90 && isNum(lon) && Math.abs(lon) <= 180;

function validRound(r) {
  return r !== null && typeof r === 'object'
    && (r.src === 'g' || r.src === 'm')
    && typeof r.id === 'string' && r.id !== '' && r.id.length <= 200
    && validPoint(r.lat, r.lon)
    && typeof r.cc === 'string' && /^[A-Z]{2}$/.test(r.cc)
    && isNum(r.forgiveKm) && r.forgiveKm >= 0 && r.forgiveKm <= MG.FORGIVE_CAP_KM;
}

function parseTiming(s) {
  if (s.mode === 'none') return { mode: 'none', timerSec: null };
  if (s.mode === 'timer' && Number.isInteger(s.timerSec)
    && s.timerSec >= TIMER_MIN_SEC && s.timerSec <= TIMER_MAX_SEC) {
    return { mode: 'timer', timerSec: s.timerSec };
  }
  return null;
}

function parseSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const timing = parseTiming(s);
  const scoring = s.scoring === undefined ? 'size' : s.scoring;
  const difficulty = s.difficulty === undefined ? 3 : s.difficulty;
  if (!timing || (scoring !== 'size' && scoring !== 'classic')) return null;
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) return null;
  return { ...timing, scoring, difficulty };
}

const error = (to, code, message) => ({ to, msg: { type: 'error', code, message } });

function table(state) {
  return Object.entries(state.players)
    .map(([playerId, p], order) => ({
      playerId, name: p.name, connected: p.connected,
      total: p.points.reduce((s, x) => s + x, 0), points: p.points.slice(), order,
    }))
    .sort((a, b) => b.total - a.total || a.order - b.order)
    .map(({ order, ...row }) => row);
}

function playersList(state) {
  return Object.entries(state.players).map(([playerId, p]) => ({
    playerId, name: p.name, connected: p.connected, guessed: Boolean(state.guesses[playerId]),
  }));
}

const hidden = (place) => ({ src: place.src, id: place.id });

function snapshot(state, playerId) {
  const inRound = state.phase === 'round';
  return {
    type: 'state',
    you: playerId,
    phase: state.phase,
    settings: { ...state.settings },
    roundsTotal: state.rounds.length,
    index: state.index,
    place: inRound ? hidden(state.rounds[state.index]) : null,
    endsAt: inRound ? state.endsAt : null,
    nextAt: state.phase === 'results' ? state.nextAt : null,
    players: playersList(state),
    table: table(state),
    results: state.lastResults,
  };
}

// Rounds finished so far: what a player joining now gets a 0 for.
const played = (state) => (state.phase === 'lobby' ? 0 : state.phase === 'round' ? state.index : state.index + 1);

function startRound(state, index, out) {
  state.phase = 'round';
  state.index = index;
  state.guesses = {};
  state.endsAt = null;
  state.nextAt = null;
  out.push({ to: 'all', msg: { type: 'round', index, of: state.rounds.length, place: hidden(state.rounds[index]) } });
}

function endRound(state, now, out) {
  const place = state.rounds[state.index];
  const guesses = Object.entries(state.players).map(([playerId, p]) => {
    const g = state.guesses[playerId];
    const points = g ? g.points : 0;
    p.points.push(points);
    return { playerId, name: p.name, lat: g ? g.lat : null, lon: g ? g.lon : null, km: g ? g.km : null, points };
  });
  const last = state.index === state.rounds.length - 1;
  state.phase = last ? 'final' : 'results';
  state.endsAt = null;
  state.nextAt = last ? null : now + RESULTS_MS;
  const results = { index: state.index, place: { ...place }, guesses, table: table(state), nextAt: state.nextAt };
  state.lastResults = results;
  out.push({ to: 'all', msg: { type: 'results', ...results } });
  if (last) out.push({ to: 'all', msg: { type: 'final', table: table(state) } });
}

// When a player who left stops being waited for. leftAt is absent in rooms stored before it.
const graceEnd = (p) => (typeof p.leftAt === 'number' ? p.leftAt + GRACE_MS : null);

// A round ends when every player it waits for has guessed: the connected ones and those who
// left less than GRACE_MS ago. Nobody to wait for ends nothing: an empty room waits for its
// players (or for idle expiry).
function maybeEndRound(state, now, out) {
  if (state.phase !== 'round') return;
  const waited = Object.entries(state.players).filter(([, p]) => p.connected || (graceEnd(p) !== null && now < graceEnd(p)));
  if (waited.length && waited.every(([id]) => state.guesses[id])) endRound(state, now, out);
}

function create(event, now) {
  const out = [];
  const name = MG.cleanName(event.name);
  const settings = parseSettings(event.settings);
  const rounds = event.rounds;
  if (!name) return { state: null, out: [error(event.playerId, 'bad-name', 'A name is required.')] };
  if (!settings) return { state: null, out: [error(event.playerId, 'bad-room', 'Bad settings.')] };
  if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > MAX_ROUNDS || !rounds.every(validRound)) {
    return { state: null, out: [error(event.playerId, 'bad-room', 'Bad rounds.')] };
  }
  const state = {
    v: 1,
    settings,
    rounds: rounds.map(({ src, id, lat, lon, cc, forgiveKm }) => ({ src, id, lat, lon, cc, forgiveKm })),
    phase: 'lobby',
    index: -1,
    players: { [event.playerId]: { name, connected: true, points: [] } },
    guesses: {},
    endsAt: null,
    nextAt: null,
    lastResults: null,
    lastActivity: now,
  };
  out.push({ to: event.playerId, msg: snapshot(state, event.playerId) });
  out.push({ to: 'all', msg: { type: 'players', players: playersList(state) } });
  return { state, out };
}

function join(state, event, out) {
  const name = MG.cleanName(event.name);
  if (!name) return out.push(error(event.playerId, 'bad-name', 'A name is required.'));
  // Nobody is added to a finished game: the newcomer only sees the final table.
  if (state.phase === 'final' && !state.players[event.playerId]) {
    return out.push({ to: event.playerId, msg: snapshot(state, event.playerId) });
  }
  const known = state.players[event.playerId];
  if (known) {
    known.name = name;
    known.connected = true;
  } else {
    state.players[event.playerId] = { name, connected: true, points: new Array(played(state)).fill(0) };
  }
  out.push({ to: event.playerId, msg: snapshot(state, event.playerId) });
  out.push({ to: 'all', msg: { type: 'players', players: playersList(state) } });
}

function guess(state, event, now, out) {
  const id = event.playerId;
  if (state.phase !== 'round') return out.push(error(id, 'not-in-round', 'No round is being played.'));
  if (event.round !== state.index) return out.push(error(id, 'wrong-round', 'That round is over.'));
  if (state.guesses[id]) return out.push(error(id, 'already-guessed', 'Already guessed this round.'));
  if (!validPoint(event.lat, event.lon)) return out.push(error(id, 'bad-guess', 'Bad coordinates.'));
  const place = state.rounds[state.index];
  const km = MG.distanceKm(place, { lat: event.lat, lon: event.lon });
  state.guesses[id] = { lat: event.lat, lon: event.lon, km, points: MG.scoreFor(km, place.forgiveKm) };
  out.push({ to: 'all', msg: { type: 'guessed', playerId: id } });
  if (state.settings.mode === 'timer' && state.endsAt === null) {
    state.endsAt = now + state.settings.timerSec * 1000;
    out.push({ to: 'all', msg: { type: 'countdown', endsAt: state.endsAt } });
  }
  maybeEndRound(state, now, out);
}

function alarm(state, now, out) {
  if (state.phase === 'round' && state.endsAt !== null && now >= state.endsAt) endRound(state, now, out);
  else if (state.phase === 'round') maybeEndRound(state, now, out); // a grace may have run out
  else if (state.phase === 'results' && now >= state.nextAt) startRound(state, state.index + 1, out);
  if (now >= state.lastActivity + IDLE_MS) return null;
  return state;
}

function nextAlarm(state, now) {
  let at = state.lastActivity + IDLE_MS;
  if (state.phase === 'round' && state.endsAt !== null) at = Math.min(at, state.endsAt);
  if (state.phase === 'round') {
    for (const p of Object.values(state.players)) {
      const end = graceEnd(p);
      if (!p.connected && end !== null && end > now) at = Math.min(at, end);
    }
  }
  if (state.phase === 'results') at = Math.min(at, state.nextAt);
  return at;
}

const CLIENT_EVENTS = ['create', 'join', 'start', 'guess'];

function step(prev, event, now) {
  const out = [];
  const type = event && event.type;
  const id = event && event.playerId;
  if (type === 'alarm') {
    if (!prev) return { state: null, out, alarmAt: null };
    const state = alarm(structuredClone(prev), now, out);
    return { state, out, alarmAt: state ? nextAlarm(state, now) : null };
  }
  if (type === 'leave') {
    if (!prev || !prev.players[id]) return { state: prev, out, alarmAt: prev ? nextAlarm(prev, now) : null };
    const state = structuredClone(prev);
    state.players[id].connected = false;
    state.players[id].leftAt = now;
    out.push({ to: 'all', msg: { type: 'players', players: playersList(state) } });
    maybeEndRound(state, now, out);
    return { state, out, alarmAt: nextAlarm(state, now) };
  }
  if (typeof id !== 'string' || !PLAYER_ID.test(id)) {
    return { state: prev, out: [error(id, 'bad-player', 'Bad playerId.')], alarmAt: prev ? nextAlarm(prev, now) : null };
  }
  if (!CLIENT_EVENTS.includes(type)) {
    return { state: prev, out: [error(id, 'bad-message', 'Unknown message type.')], alarmAt: prev ? nextAlarm(prev, now) : null };
  }
  if (type === 'create') {
    if (prev) return { state: prev, out: [error(id, 'room-exists', 'This room already exists.')], alarmAt: nextAlarm(prev, now) };
    const made = create(event, now);
    return { ...made, alarmAt: made.state ? nextAlarm(made.state, now) : null };
  }
  if (!prev) return { state: null, out: [error(id, 'no-room', 'This room does not exist.')], alarmAt: null };

  const state = structuredClone(prev);
  state.lastActivity = now;
  if (type === 'join') join(state, event, out);
  else if (!state.players[id]) out.push(error(id, 'not-in-room', 'Join the room first.'));
  else if (type === 'start') {
    if (state.phase !== 'lobby') out.push(error(id, 'started', 'The game has already started.'));
    else startRound(state, 0, out);
  } else if (type === 'guess') guess(state, event, now, out);
  return { state, out, alarmAt: nextAlarm(state, now) };
}

module.exports = { step, RESULTS_MS, IDLE_MS, MAX_ROUNDS, GRACE_MS };
