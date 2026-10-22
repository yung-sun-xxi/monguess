'use strict';
// The live-room rules (rooms/rules.js) driven with fake time: no network, no real timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../rooms/rules.js');
const MG = require('../lib.js');

const T0 = 1_800_000_000_000;

const PLACES = [
  { src: 'g', id: 'paris-pano', lat: 48.8566, lon: 2.3522, cc: 'FR', forgiveKm: 200 },
  { src: 'm', id: '4471234', lat: 35.6762, lon: 139.6503, cc: 'JP', forgiveKm: 150 },
  { src: 'g', id: 'lima-pano', lat: -12.0464, lon: -77.0428, cc: 'PE', forgiveKm: 250 },
];

// A room plus a clock. tick() moves time forward and fires the alarm the way the Durable
// Object would: at alarmAt, as often as the rules ask for it.
class Sim {
  constructor() {
    this.state = null;
    this.now = T0;
    this.alarmAt = null;
    this.log = [];
  }

  send(event) {
    const r = R.step(this.state, event, this.now);
    this.state = r.state;
    this.alarmAt = r.alarmAt;
    this.out = r.out;
    this.log.push(...r.out);
    return r.out;
  }

  tick(ms) {
    const target = this.now + ms;
    while (this.alarmAt != null && this.alarmAt <= target) {
      this.now = this.alarmAt;
      this.send({ type: 'alarm' });
      // An alarm that asks to be woken again at once would spin the Durable Object.
      assert.ok(this.alarmAt == null || this.alarmAt > this.now, `alarm at ${this.now} asked for ${this.alarmAt}`);
    }
    this.now = target;
  }

  // Messages of one type sent since the log was last cleared.
  sent(type) {
    return this.log.filter((o) => o.msg.type === type);
  }

  clear() {
    this.log = [];
  }
}

function room({ mode = 'none', timerSec, places = PLACES, players = ['a', 'b'] } = {}) {
  const sim = new Sim();
  const settings = mode === 'timer' ? { mode, timerSec } : { mode };
  const [first, ...rest] = players;
  sim.send({ type: 'create', playerId: first, name: `P-${first}`, settings, rounds: places });
  for (const p of rest) sim.send({ type: 'join', playerId: p, name: `P-${p}` });
  sim.clear();
  return sim;
}

const guess = (sim, playerId, lat = 48, lon = 2, round = sim.state.index) =>
  sim.send({ type: 'guess', playerId, round, lat, lon });

const tableOf = (msg) => Object.fromEntries(msg.table.map((r) => [r.playerId, r.points]));
const errors = (out) => out.filter((o) => o.msg.type === 'error');

test('create: the first create makes the room with its creator in the lobby', () => {
  const sim = new Sim();
  const out = sim.send({ type: 'create', playerId: 'a', name: '  Ann  ', settings: { mode: 'none' }, rounds: PLACES });
  assert.equal(sim.state.phase, 'lobby');
  assert.deepEqual(Object.keys(sim.state.players), ['a']);
  assert.equal(sim.state.players.a.name, 'Ann');
  const snap = out.find((o) => o.msg.type === 'state');
  assert.equal(snap.to, 'a');
  assert.equal(snap.msg.you, 'a');
  assert.equal(snap.msg.roundsTotal, 3);
  assert.equal(snap.msg.phase, 'lobby');
});

test('a room that was never created answers every message with an error and stays uncreated', () => {
  for (const event of [
    { type: 'join', playerId: 'b', name: 'Bob' },
    { type: 'start', playerId: 'b' },
    { type: 'guess', playerId: 'b', round: 0, lat: 0, lon: 0 },
  ]) {
    const sim = new Sim();
    const out = sim.send(event);
    assert.equal(sim.state, null, event.type);
    assert.equal(sim.alarmAt, null, event.type);
    assert.equal(out.length, 1, event.type);
    assert.equal(out[0].to, 'b');
    assert.equal(out[0].msg.type, 'error');
    assert.equal(out[0].msg.code, 'no-room');
  }
});

test('create on a room that exists is an error and changes nothing', () => {
  const sim = room();
  const before = JSON.stringify(sim.state);
  const out = sim.send({ type: 'create', playerId: 'c', name: 'Cy', settings: { mode: 'none' }, rounds: PLACES });
  assert.equal(errors(out)[0].msg.code, 'room-exists');
  assert.equal(JSON.stringify(sim.state), before);
});

test('create rejects bad rounds, settings and names', () => {
  const bad = [
    { settings: { mode: 'none' }, rounds: [] },
    { settings: { mode: 'none' }, rounds: [{ ...PLACES[0], lat: 91 }] },
    { settings: { mode: 'none' }, rounds: [{ ...PLACES[0], cc: 'fr' }] },
    { settings: { mode: 'none' }, rounds: [{ ...PLACES[0], forgiveKm: -1 }] },
    { settings: { mode: 'none' }, rounds: [{ ...PLACES[0], src: 'x' }] },
    { settings: { mode: 'sometimes' }, rounds: PLACES },
    { settings: { mode: 'timer' }, rounds: PLACES },
    { settings: { mode: 'timer', timerSec: 1 }, rounds: PLACES },
    { settings: { mode: 'none' }, rounds: PLACES, name: '   ' },
  ];
  for (const b of bad) {
    const sim = new Sim();
    const out = sim.send({ type: 'create', playerId: 'a', name: 'Ann', ...b });
    assert.equal(sim.state, null, JSON.stringify(b));
    assert.equal(errors(out).length, 1, JSON.stringify(b));
  }
});

test('join with a known playerId does not add a second player', () => {
  const sim = room();
  sim.send({ type: 'leave', playerId: 'b' });
  assert.equal(sim.state.players.b.connected, false);
  const out = sim.send({ type: 'join', playerId: 'b', name: 'Bobby' });
  assert.deepEqual(Object.keys(sim.state.players), ['a', 'b']);
  assert.equal(sim.state.players.b.connected, true);
  assert.equal(sim.state.players.b.name, 'Bobby');
  const players = out.find((o) => o.msg.type === 'players');
  assert.equal(players.to, 'all');
  assert.equal(players.msg.players.length, 2);
});

test('a player who comes back mid-game with the same playerId keeps their points', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a', 48.85, 2.35);
  sim.send({ type: 'leave', playerId: 'b' });
  sim.tick(R.GRACE_MS); // b is not waited for after the grace: the round ends
  sim.send({ type: 'join', playerId: 'a', name: 'Ann' });
  assert.deepEqual(Object.keys(sim.state.players), ['a', 'b']);
  assert.deepEqual(sim.state.players.a.points, [5000]);
  sim.send({ type: 'join', playerId: 'b', name: 'Bob' });
  assert.deepEqual(sim.state.players.b.points, [0]);
});

test('any player can start, not only the creator; the round hides the answer', () => {
  const sim = room();
  const out = sim.send({ type: 'start', playerId: 'b' });
  assert.equal(sim.state.phase, 'round');
  const round = out.find((o) => o.msg.type === 'round');
  assert.equal(round.to, 'all');
  assert.equal(round.msg.index, 0);
  assert.equal(round.msg.of, 3);
  assert.deepEqual(round.msg.place, { src: 'g', id: 'paris-pano' });
  assert.equal(errors(sim.send({ type: 'start', playerId: 'a' }))[0].msg.code, 'started');
});

test('a stranger cannot start the game', () => {
  const sim = room();
  const out = sim.send({ type: 'start', playerId: 'zed' });
  assert.equal(sim.state.phase, 'lobby');
  assert.equal(errors(out)[0].msg.code, 'not-in-room');
});

test('no timer: the round waits for every connected player', () => {
  const sim = room({ players: ['a', 'b', 'c'] });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  guess(sim, 'b');
  assert.equal(sim.sent('results').length, 0);
  assert.equal(sim.sent('guessed').length, 2);
  sim.tick(60 * 60 * 1000 - 1);
  assert.equal(sim.sent('results').length, 0, 'no timer means no time limit');
  guess(sim, 'c');
  assert.equal(sim.sent('results').length, 1);
  assert.equal(sim.state.phase, 'results');
});

test('no timer: a player who closed the page is not waited for after the grace and scores 0', () => {
  const sim = room({ players: ['a', 'b', 'c'] });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.send({ type: 'leave', playerId: 'c' });
  assert.equal(sim.sent('results').length, 0);
  guess(sim, 'b');
  sim.tick(R.GRACE_MS);
  const [results] = sim.sent('results');
  assert.ok(results, 'the round ended without c');
  const c = results.msg.guesses.find((g) => g.playerId === 'c');
  assert.deepEqual([c.lat, c.lon, c.km, c.points], [null, null, null, 0]);
  assert.deepEqual(tableOf(results.msg).c, [0]);
});

test('no timer: the last unguessed player gone for good is waited for exactly GRACE_MS', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.tick(3000);
  sim.send({ type: 'leave', playerId: 'b' });
  const [players] = sim.sent('players');
  assert.equal(players.msg.players.find((p) => p.playerId === 'b').connected, false, 'shown as away at once');
  assert.equal(R.GRACE_MS, 10000);
  assert.equal(sim.alarmAt, T0 + 3000 + R.GRACE_MS, 'woken when the grace ends');
  sim.tick(R.GRACE_MS - 1);
  assert.equal(sim.sent('results').length, 0, 'still waiting within the grace');
  sim.tick(1);
  const [results] = sim.sent('results');
  assert.ok(results, 'the round ended when the grace ran out');
  assert.equal(results.msg.guesses.find((g) => g.playerId === 'b').points, 0);
});

test('no timer: a reload within the grace keeps the round open and the guess after rejoin counts', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.send({ type: 'leave', playerId: 'b' });
  assert.equal(sim.sent('results').length, 0, 'a reload does not end the round');
  sim.tick(2000);
  sim.send({ type: 'join', playerId: 'b', name: 'P-b' });
  sim.tick(60000);
  assert.equal(sim.sent('results').length, 0, 'back within the grace: waited for as before');
  guess(sim, 'b', 48.85, 2.35);
  const [results] = sim.sent('results');
  assert.ok(results);
  assert.ok(results.msg.guesses.find((g) => g.playerId === 'b').points > 0);
});

test('a player who left and came back is waited for again in the next round', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.send({ type: 'leave', playerId: 'b' });
  sim.tick(R.GRACE_MS);
  assert.equal(sim.sent('results').length, 1);
  sim.send({ type: 'join', playerId: 'b', name: 'P-b' });
  sim.tick(R.RESULTS_MS);
  guess(sim, 'a');
  sim.tick(R.GRACE_MS * 10);
  assert.equal(sim.sent('results').length, 1, 'round 2 waits for b');
  guess(sim, 'b');
  assert.equal(sim.sent('results').length, 2);
});

test('timer: a leave never ends a timer round early within the grace; the countdown still governs', () => {
  const sim = room({ mode: 'timer', timerSec: 30 });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  const endsAt = sim.state.endsAt;
  sim.tick(6000);
  sim.send({ type: 'leave', playerId: 'b' });
  assert.equal(sim.sent('results').length, 0, 'not ended by the leave');
  sim.tick(R.GRACE_MS - 1);
  assert.equal(sim.sent('results').length, 0, 'not ended within the grace');
  sim.send({ type: 'join', playerId: 'b', name: 'P-b' });
  assert.equal(sim.state.endsAt, endsAt, 'the countdown goes on');
  sim.tick(endsAt - sim.now - 1);
  assert.equal(sim.sent('results').length, 0);
  sim.tick(1);
  assert.equal(sim.sent('results').length, 1, 'the countdown ended the round');
});

test('timer: a player gone for good stops being waited for when the grace ends, before the countdown', () => {
  const sim = room({ mode: 'timer', timerSec: 60 });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.send({ type: 'leave', playerId: 'b' });
  sim.tick(R.GRACE_MS);
  assert.equal(sim.sent('results').length, 1);
  assert.ok(sim.now < T0 + 60000);
});

test('a round with nobody connected does not end by itself', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  sim.send({ type: 'leave', playerId: 'a' });
  sim.send({ type: 'leave', playerId: 'b' });
  assert.equal(sim.sent('results').length, 0);
  assert.equal(sim.state.phase, 'round');
});

test('timer: the first guess starts X seconds for the rest; late players score 0', () => {
  const sim = room({ mode: 'timer', timerSec: 30, players: ['a', 'b', 'c'] });
  sim.send({ type: 'start', playerId: 'a' });
  const startAlarm = sim.alarmAt;
  sim.tick(7000);
  assert.equal(sim.alarmAt, startAlarm, 'no countdown before the first guess');
  guess(sim, 'a', 48.8, 2.3);
  const [cd] = sim.sent('countdown');
  assert.equal(cd.to, 'all');
  assert.equal(cd.msg.endsAt, T0 + 7000 + 30000);
  assert.equal(sim.alarmAt, T0 + 37000);
  guess(sim, 'b', 40, 3);
  assert.equal(sim.sent('countdown').length, 1, 'a second guess does not restart it');
  sim.tick(29999);
  assert.equal(sim.sent('results').length, 0);
  sim.tick(1);
  const [results] = sim.sent('results');
  assert.ok(results, 'the countdown ended the round');
  assert.equal(results.msg.guesses.find((g) => g.playerId === 'c').points, 0);
  assert.ok(results.msg.guesses.find((g) => g.playerId === 'a').points > 0);
  assert.deepEqual(tableOf(results.msg).c, [0]);
});

test('timer: everyone guessing ends the round before the countdown runs out', () => {
  const sim = room({ mode: 'timer', timerSec: 30 });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.tick(1000);
  guess(sim, 'b');
  assert.equal(sim.sent('results').length, 1);
  sim.tick(30000);
  assert.equal(sim.sent('results').length, 1, 'the stale countdown alarm ends nothing');
});

test('results: the next round starts by itself 5 seconds later', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  guess(sim, 'b');
  const [results] = sim.sent('results');
  assert.equal(results.msg.nextAt, T0 + R.RESULTS_MS);
  assert.equal(R.RESULTS_MS, 5000);
  assert.equal(sim.alarmAt, T0 + 5000);
  sim.clear();
  sim.tick(4999);
  assert.equal(sim.sent('round').length, 0);
  sim.tick(1);
  const [round] = sim.sent('round');
  assert.equal(round.msg.index, 1);
  assert.deepEqual(round.msg.place, { src: 'm', id: '4471234' });
  assert.equal(sim.state.phase, 'round');
});

test('results reveal the place and every guess; the table is sorted by total', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a', 10, 10);
  guess(sim, 'b', 48.85, 2.35);
  const [results] = sim.sent('results');
  assert.deepEqual(results.msg.place, PLACES[0]);
  assert.deepEqual(results.msg.table.map((r) => r.playerId), ['b', 'a']);
  assert.equal(results.msg.table[0].total, 5000);
});

test('final: after the last round comes the final table and nothing more', () => {
  const sim = room({ places: PLACES.slice(0, 2) });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a', 48.85, 2.35);
  guess(sim, 'b', 10, 10);
  sim.tick(5000);
  assert.equal(sim.sent('final').length, 0);
  guess(sim, 'a', 35.6, 139.6);
  guess(sim, 'b', 35.6, 139.6);
  const [final] = sim.sent('final');
  assert.ok(final, 'the final table was sent');
  assert.equal(final.to, 'all');
  assert.equal(sim.state.phase, 'final');
  assert.equal(sim.sent('results').length, 2);
  assert.equal(sim.sent('results')[1].msg.nextAt, null);
  const t = tableOf(final.msg);
  assert.equal(t.a.length, 2);
  assert.equal(t.b.length, 2);
  assert.equal(final.msg.table[0].playerId, 'a');
  sim.clear();
  sim.tick(60000);
  assert.equal(sim.sent('round').length, 0);
  assert.equal(errors(guess(sim, 'a', 0, 0, 2))[0].msg.code, 'not-in-round');
});

test('late join during a round: 0 for rounds already played, plays the current one', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  guess(sim, 'b');
  sim.tick(5000);
  assert.equal(sim.state.index, 1);
  const out = sim.send({ type: 'join', playerId: 'c', name: 'Cy' });
  const snap = out.find((o) => o.msg.type === 'state');
  assert.equal(snap.to, 'c');
  assert.equal(snap.msg.phase, 'round');
  assert.equal(snap.msg.index, 1);
  assert.deepEqual(snap.msg.place, { src: 'm', id: '4471234' });
  assert.deepEqual(snap.msg.table.find((r) => r.playerId === 'c').points, [0]);
  guess(sim, 'a', 35.6, 139.6);
  guess(sim, 'b', 35.6, 139.6);
  assert.equal(sim.sent('results').length, 1, 'the round now waits for c too');
  guess(sim, 'c', 35.6, 139.6);
  const results = sim.sent('results')[1];
  assert.ok(results);
  const c = tableOf(results.msg).c;
  assert.equal(c[0], 0);
  assert.ok(c[1] > 0);
});

test('late join during results: 0 for the round just finished, plays the next one', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  guess(sim, 'b');
  sim.send({ type: 'join', playerId: 'c', name: 'Cy' });
  assert.deepEqual(sim.state.players.c.points, [0]);
  sim.tick(5000);
  guess(sim, 'a');
  guess(sim, 'b');
  assert.equal(sim.sent('results').length, 1, 'waits for c in round 2');
});

test('timer: a late joiner during the countdown sees when it ends', () => {
  const sim = room({ mode: 'timer', timerSec: 20 });
  sim.send({ type: 'start', playerId: 'a' });
  guess(sim, 'a');
  sim.tick(5000);
  const out = sim.send({ type: 'join', playerId: 'c', name: 'Cy' });
  assert.equal(out.find((o) => o.msg.type === 'state').msg.endsAt, T0 + 20000);
});

test('points equal scoreFor(distanceKm) from lib.js with the round forgiveness radius', () => {
  const cases = [[45, 10], [40.4168, -3.7038], [48.86, 2.35], [-33.87, 151.21]];
  for (const [lat, lon] of cases) {
    const sim = room({ players: ['a'] });
    sim.send({ type: 'start', playerId: 'a' });
    guess(sim, 'a', lat, lon);
    const g = sim.sent('results')[0].msg.guesses[0];
    const km = MG.distanceKm(PLACES[0], { lat, lon });
    assert.equal(g.km, km);
    assert.equal(g.points, MG.scoreFor(km, PLACES[0].forgiveKm), `${lat},${lon}`);
  }
  // The radius matters: Madrid is ~1050 km from Paris, so 200 km forgiven changes the score.
  assert.notEqual(MG.scoreFor(MG.distanceKm(PLACES[0], { lat: 40.4168, lon: -3.7038 }), 200),
    MG.scoreFor(MG.distanceKm(PLACES[0], { lat: 40.4168, lon: -3.7038 })));
});

test('a guess for another round, a second guess and a bad point are refused', () => {
  const sim = room();
  sim.send({ type: 'start', playerId: 'a' });
  assert.equal(errors(guess(sim, 'a', 1, 1, 1))[0].msg.code, 'wrong-round');
  assert.equal(errors(guess(sim, 'a', 91, 1))[0].msg.code, 'bad-guess');
  guess(sim, 'a', 1, 1);
  assert.equal(errors(guess(sim, 'a', 2, 2))[0].msg.code, 'already-guessed');
  assert.equal(sim.state.guesses.a.lat, 1);
  assert.equal(errors(guess(sim, 'zed', 2, 2))[0].msg.code, 'not-in-room');
});

test('a guess in the lobby is refused', () => {
  const sim = room();
  assert.equal(errors(guess(sim, 'a', 1, 1, 0))[0].msg.code, 'not-in-round');
});

test('idle expiry: a room with no client message for IDLE_MS is cleared', () => {
  const sim = room();
  assert.equal(R.IDLE_MS, 3 * 60 * 60 * 1000);
  assert.equal(sim.alarmAt, T0 + R.IDLE_MS);
  sim.tick(R.IDLE_MS - 1000);
  sim.send({ type: 'join', playerId: 'b', name: 'Bob' });
  sim.tick(1000);
  assert.ok(sim.state, 'activity moved the expiry');
  sim.tick(R.IDLE_MS - 1001);
  assert.ok(sim.state);
  sim.tick(1);
  assert.equal(sim.state, null);
  assert.equal(sim.alarmAt, null);
});

test('state survives a JSON round trip, as storage would put it through hibernation', () => {
  const a = room({ mode: 'timer', timerSec: 30 });
  a.send({ type: 'start', playerId: 'a' });
  guess(a, 'a');
  a.clear();
  const b = new Sim();
  b.now = a.now;
  b.state = JSON.parse(JSON.stringify(a.state));
  b.alarmAt = a.alarmAt;
  a.tick(30000);
  b.tick(30000);
  assert.ok(a.sent('results').length, 'the countdown ended the round');
  assert.deepEqual(b.state, a.state);
  assert.deepEqual(b.log, a.log);
});
