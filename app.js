'use strict';

const CFG = window.WG_CONFIG || {};
const MAX_POINTS = 5000;
// Как у GeoGuessr на карте мира: 5000 · e^(−d / 1492 км).
const SCORE_SCALE_KM = 1492.7;
// Сколько случайных точек пробуем в стране, прежде чем перейти к следующей.
const POINTS_PER_BATCH = 4;
const BATCHES_PER_COUNTRY = 2;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const regionNames = new Intl.DisplayNames(['ru'], { type: 'region' });

let places = null; // { "KE": [[lat, lon, population], ...], ... }
const state = { rounds: [], guesses: [], index: 0 };

// ---------- Страны и случайные точки ----------

function countryName(cc) {
  try { return regionNames.of(cc) || cc; } catch { return cc; }
}

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

// Город выбираем с весом √населения: столицы чаще, но и маленькие города попадаются.
function pickPlace(list) {
  const weights = list.map((p) => Math.sqrt(p[2]));
  let r = Math.random() * weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

// Точка в 1–40 км от города, чаще ближе: так попадаем и в города, и в глубинку.
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

// ---------- Источники снимков ----------

let googleReady = null;
function loadGoogle() {
  if (!CFG.googleApiKey) return Promise.resolve(false);
  if (!googleReady) {
    googleReady = new Promise((resolve) => {
      window.__wgGoogleLoaded = () => resolve(true);
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CFG.googleApiKey)}&v=weekly&callback=__wgGoogleLoaded`;
      s.async = true;
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  return googleReady;
}

// Google зовёт эту функцию, если ключ не подошёл.
window.gm_authFailure = () => fail('Google не принял ключ. Проверьте googleApiKey в config.js и ограничения ключа.');

let streetViewService = null;
async function tryGoogle(lat, lon) {
  streetViewService ??= new google.maps.StreetViewService();
  try {
    const { data } = await streetViewService.getPanorama({
      location: { lat, lng: lon },
      radius: 3000,
      // OUTDOOR: панорамы Google и уличные фотосферы людей, без съёмки внутри зданий.
      sources: [google.maps.StreetViewSource.OUTDOOR],
    });
    const loc = data.location;
    return { src: 'g', id: loc.pano, lat: loc.latLng.lat(), lon: loc.latLng.lng() };
  } catch {
    return null;
  }
}

async function tryMapillary(lat, lon) {
  const h = 0.04; // ≈ 9 × 9 км вокруг точки
  const clampLon = (v) => Math.max(-180, Math.min(180, v));
  const bbox = [clampLon(lon - h), lat - h, clampLon(lon + h), lat + h].map((v) => v.toFixed(5)).join(',');
  const url = 'https://graph.mapillary.com/images'
    + `?access_token=${encodeURIComponent(CFG.mapillaryToken)}`
    + `&fields=id,is_pano,computed_geometry,geometry&bbox=${bbox}&limit=100`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Mapillary не принял ключ. Проверьте mapillaryToken в config.js.');
  }
  if (!res.ok) return null;
  const { data = [] } = await res.json();
  const usable = data.filter((d) => d.computed_geometry || d.geometry);
  if (!usable.length) return null;
  const panos = usable.filter((d) => d.is_pano);
  const pool = panos.length ? panos : usable;
  const img = pool[Math.floor(Math.random() * pool.length)];
  const [ilon, ilat] = (img.computed_geometry || img.geometry).coordinates;
  return { src: 'm', id: String(img.id), lat: ilat, lon: ilon };
}

async function findAt([lat, lon], sources) {
  for (const s of sources) {
    const found = s === 'g' ? await tryGoogle(lat, lon) : await tryMapillary(lat, lon);
    if (found) return found;
  }
  return null;
}

// Страна по координатам — снимок у границы может оказаться у соседей.
let lastNominatim = 0;
async function countryAt(lat, lon) {
  const wait = lastNominatim + 1100 - Date.now(); // Nominatim просит не чаще 1 запроса в секунду
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=3&lat=${lat}&lon=${lon}`);
    const json = await res.json();
    return json.address?.country_code?.toUpperCase() || null;
  } catch {
    return null;
  }
}

// Каждый раунд — новая страна, страны выбираются равновероятно.
async function generateRounds(count, sources, onProgress) {
  const rounds = [];
  const usedCountries = new Set();
  for (const cc of shuffle(Object.keys(places))) {
    if (rounds.length === count) break;
    if (usedCountries.has(cc)) continue;
    onProgress(rounds.length + 1, count);
    let found = null;
    for (let b = 0; b < BATCHES_PER_COUNTRY && !found; b++) {
      const points = Array.from({ length: POINTS_PER_BATCH }, () => randomPointNear(places[cc]));
      found = (await Promise.all(points.map((p) => findAt(p, sources)))).find(Boolean) || null;
    }
    if (!found) continue;
    found.cc = (await countryAt(found.lat, found.lon)) || cc;
    if (usedCountries.has(found.cc)) continue;
    usedCountries.add(found.cc);
    rounds.push(found);
  }
  if (rounds.length < count) throw new Error('Не удалось найти достаточно мест. Попробуйте ещё раз.');
  return rounds;
}

// ---------- Ссылка для друзей ----------

function encodeChallenge(rounds) {
  const compact = rounds.map((r) => [r.src, r.id, +r.lat.toFixed(6), +r.lon.toFixed(6), r.cc]);
  return btoa(JSON.stringify(compact)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeChallenge(str) {
  try {
    const json = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).map(([src, id, lat, lon, cc]) => ({ src, id, lat, lon, cc }));
  } catch {
    return null;
  }
}

const challengeUrl = () => `${location.origin}${location.pathname}#c=${encodeChallenge(state.rounds)}`;

// ---------- Экраны ----------

function show(id) {
  for (const s of ['menu', 'loading', 'game', 'result', 'final']) $(s).hidden = s !== id;
}

function fail(message) {
  show('menu');
  $('menu-error').textContent = message;
}

const total = () => state.guesses.reduce((s, g) => s + g.points, 0);

let panoViewer = null;
function showPanorama(round) {
  if (panoViewer?.remove) panoViewer.remove(); // у Mapillary свой teardown
  panoViewer = null;
  const host = $('pano');
  host.innerHTML = '';
  const el = document.createElement('div');
  host.appendChild(el);
  if (round.src === 'g') {
    panoViewer = new google.maps.StreetViewPanorama(el, {
      pano: round.id,
      addressControl: false,
      showRoadLabels: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
    });
  } else {
    panoViewer = new mapillary.Viewer({
      accessToken: CFG.mapillaryToken,
      container: el,
      imageId: round.id,
      component: { cover: false },
    });
  }
}

let guessMap = null;
let guessMarker = null;
function resetGuessMap() {
  if (!guessMap) {
    guessMap = L.map('guess-map', { worldCopyJump: true, zoomControl: false }).setView([20, 0], 1);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(guessMap);
    guessMap.on('click', (e) => {
      const ll = e.latlng.wrap();
      if (guessMarker) guessMarker.setLatLng(ll);
      else guessMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: '#e74c3c', fillOpacity: 1 }).addTo(guessMap);
      $('guess').disabled = false;
    });
    // Карта меняет размер при наведении — Leaflet должен об этом знать.
    new ResizeObserver(() => guessMap.invalidateSize()).observe($('guess-map'));
  }
  if (guessMarker) {
    guessMarker.remove();
    guessMarker = null;
  }
  guessMap.setView([20, 0], 1);
  $('guess').disabled = true;
}

function startRound() {
  const round = state.rounds[state.index];
  show('game');
  $('hud-round').textContent = `Раунд ${state.index + 1} / ${state.rounds.length}`;
  $('hud-score').textContent = `Очки: ${total().toLocaleString('ru')}`;
  showPanorama(round);
  resetGuessMap();
}

let resultMap = null;
function showResult(round, guess) {
  show('result');
  if (resultMap) resultMap.remove();
  resultMap = L.map('result-map', { worldCopyJump: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(resultMap);
  const actual = [round.lat, round.lon];
  const guessed = [guess.lat, guess.lon];
  L.polyline([guessed, actual], { color: '#fff', dashArray: '6 8', weight: 2 }).addTo(resultMap);
  L.circleMarker(guessed, { radius: 8, color: '#fff', weight: 2, fillColor: '#e74c3c', fillOpacity: 1 }).addTo(resultMap);
  L.circleMarker(actual, { radius: 9, color: '#fff', weight: 2, fillColor: '#3fb68b', fillOpacity: 1 }).addTo(resultMap);
  resultMap.fitBounds([guessed, actual], { padding: [60, 60], maxZoom: 10 });

  $('result-country').textContent = `${flag(round.cc)} ${countryName(round.cc)}`;
  $('result-distance').textContent = `Вы ошиблись на ${formatKm(guess.km)}`;
  $('result-points').textContent = `+${guess.points.toLocaleString('ru')} очков`;
  $('next').textContent = state.index + 1 < state.rounds.length ? 'Следующий раунд' : 'Итоги';
}

function showFinal() {
  show('final');
  const max = state.rounds.length * MAX_POINTS;
  $('final-total').textContent = `${total().toLocaleString('ru')} из ${max.toLocaleString('ru')}`;
  $('final-table').innerHTML = '';
  state.rounds.forEach((r, i) => {
    const g = state.guesses[i];
    const row = $('final-table').insertRow();
    row.insertCell().textContent = `${flag(r.cc)} ${countryName(r.cc)}`;
    row.insertCell().textContent = formatKm(g.km);
    row.insertCell().textContent = g.points.toLocaleString('ru');
  });
  $('copied').hidden = true;
}

function resultText() {
  const max = state.rounds.length * MAX_POINTS;
  const lines = state.rounds.map((r, i) => `${flag(r.cc)} ${state.guesses[i].points.toLocaleString('ru')}`);
  return `🌍 World Guesser: ${total().toLocaleString('ru')} из ${max.toLocaleString('ru')}\n${lines.join('  ')}\nСыграй те же места: ${challengeUrl()}`;
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    $('copied').textContent = message;
  } catch {
    $('copied').textContent = text;
  }
  $('copied').hidden = false;
}

// ---------- Запуск ----------

function availableSources() {
  const s = [];
  if (CFG.googleApiKey) s.push('g');
  if (CFG.mapillaryToken) s.push('m');
  return s;
}

function fillSourceSelect() {
  const have = availableSources();
  const options = [];
  if (have.length === 2) options.push(['gm', 'Google + Mapillary']);
  if (have.includes('g')) options.push(['g', 'Только Google']);
  if (have.includes('m')) options.push(['m', 'Только Mapillary']);
  $('source').innerHTML = options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

async function play(rounds) {
  state.rounds = rounds;
  state.guesses = [];
  state.index = 0;
  startRound();
}

async function newGame() {
  $('menu-error').textContent = '';
  if (!places) {
    fail('Не загрузился data/places.json. Откройте игру через веб-сервер, а не как файл — см. README.');
    return;
  }
  const sources = [...$('source').value];
  if (!sources.length) {
    fail('Нет ни одного ключа. Впишите mapillaryToken или googleApiKey в config.js — см. README.');
    return;
  }
  show('loading');
  $('loading-text').textContent = 'Загрузка…';
  try {
    if (sources.includes('g') && !(await loadGoogle())) throw new Error('Не удалось загрузить Google Maps.');
    const count = Number($('rounds').value);
    const rounds = await generateRounds(count, sources, (n, of) => {
      $('loading-text').textContent = `Ищу место ${n} из ${of}…`;
    });
    history.replaceState(null, '', location.pathname);
    play(rounds);
  } catch (e) {
    fail(e.message);
  }
}

async function playChallenge(rounds) {
  if (rounds.some((r) => r.src === 'g')) {
    show('loading');
    $('loading-text').textContent = 'Загрузка…';
    if (!(await loadGoogle())) {
      fail('В этой игре есть панорамы Google, а ключа Google здесь нет.');
      return;
    }
  }
  play(rounds);
}

async function init() {
  fillSourceSelect();
  const challenge = location.hash.startsWith('#c=') ? decodeChallenge(location.hash.slice(3)) : null;

  if (challenge?.length) {
    const n = challenge.length;
    const word = n % 10 === 1 && n % 100 !== 11 ? 'раунд' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'раунда' : 'раундов';
    $('challenge-note').textContent = `Друг позвал вас сыграть: ${n} ${word}, те же места.`;
    $('challenge-note').hidden = false;
    $('options').hidden = true;
    $('new-instead').hidden = false;
    $('start').textContent = 'Играть';
  }

  $('start').onclick = () => {
    if (challenge?.length && location.hash.startsWith('#c=')) playChallenge(challenge);
    else newGame();
  };
  $('new-instead').onclick = () => {
    history.replaceState(null, '', location.pathname);
    $('challenge-note').hidden = true;
    $('options').hidden = false;
    $('new-instead').hidden = true;
    $('start').textContent = 'Новая игра';
  };
  $('guess').onclick = () => {
    const round = state.rounds[state.index];
    const ll = guessMarker.getLatLng();
    const guess = { lat: ll.lat, lon: ll.lng };
    guess.km = distanceKm(round, guess);
    guess.points = scoreFor(guess.km);
    state.guesses.push(guess);
    showResult(round, guess);
  };
  $('next').onclick = () => {
    state.index++;
    if (state.index < state.rounds.length) startRound();
    else showFinal();
  };
  $('copy-link').onclick = () => copy(challengeUrl(), 'Ссылка скопирована — отправьте её друзьям.');
  $('copy-result').onclick = () => copy(resultText(), 'Результат скопирован.');
  $('again').onclick = () => {
    history.replaceState(null, '', location.pathname);
    location.reload();
  };
  window.addEventListener('resize', () => panoViewer?.resize?.());

  try {
    places = await (await fetch('data/places.json')).json();
  } catch {
    fail('Не загрузился data/places.json. Откройте игру через веб-сервер, а не как файл — см. README.');
  }
}

init();
