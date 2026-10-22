'use strict';

const CFG = window.MG_CONFIG || {};
// Чистые функции (очки, расстояния, ссылка для друзей) живут в lib.js: их проверяют тесты.
const {
  MAX_POINTS, flag, shuffle, randomPointNear, distanceKm, scoreFor, forgivenessKm, formatKm,
  resolveCountry, encodeChallenge, decodeChallenge, cleanName, nameError, formatResult, buildLogRecord,
  pluralRu, idFromBytes, roomIdFromHash, roomLink, roomSocketUrl, buildRoomCreate, describeRoomMode,
} = window.MG;
// Сколько случайных точек пробуем в стране, прежде чем перейти к следующей.
const POINTS_PER_BATCH = 4;
const BATCHES_PER_COUNTRY = 2;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const regionNames = new Intl.DisplayNames(['ru'], { type: 'region' });

let places = null; // { "KE": [[lat, lon, population], ...], ... }
// Поля лога (logId … finished) описывают текущую игру для /api/log, см. «Лог игры».
const state = {
  rounds: [], guesses: [], index: 0,
  logId: '', startedAt: 0, buildMs: 0, settings: null, challenge: false, errors: [], finished: false,
};

// ---------- Страны и случайные точки ----------

// Радиус прощения страны считается один раз на код: places не меняется за игру.
// Страны нет в places.json — радиус 0. Пока файл не загрузился (игра по ссылке его не ждёт),
// ноль не кэшируется.
const forgiveCache = new Map();
function forgiveFor(cc) {
  if (!places) return 0;
  if (!forgiveCache.has(cc)) forgiveCache.set(cc, forgivenessKm(places[cc]));
  return forgiveCache.get(cc);
}

function countryName(cc) {
  try { return regionNames.of(cc) || cc; } catch { return cc; }
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

// mapillary-js весит 1 МБ: грузим его только когда нужна панорама Mapillary.
let mapillaryReady = null;
function loadMapillary() {
  mapillaryReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.js';
    s.integrity = 'sha384-1AlAxcgdzKreJ5f2K+t7SW3pEE0ek9u3lUwlZXX+v+FtEk1tWSg6DBVLb3ZKhpB+';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { mapillaryReady = null; reject(new Error('Не удалось загрузить Mapillary.')); };
    document.head.appendChild(s);
  });
  return mapillaryReady;
}

const GOOGLE_RADIUS_M = 3000;

let streetViewService = null;
async function googlePanoAt(lat, lon, source, needLinks) {
  try {
    const { data } = await streetViewService.getPanorama({
      location: { lat, lng: lon },
      radius: GOOGLE_RADIUS_M,
      sources: [source],
    });
    // У одиночной фотосферы нет соседних точек: по ней можно только крутиться, но не ходить.
    if (needLinks && !data.links?.length) return null;
    // kind для лога: съёмка самого Google или фотосфера человека.
    const kind = source === google.maps.StreetViewSource.GOOGLE ? 'google' : 'sphere';
    const found = { src: 'g', id: data.location.pano, lat: data.location.latLng.lat(), lon: data.location.latLng.lng(), kind };
    // Google иногда отдаёт панораму на другом конце света (из Кубы — в Аргентину), такие отбрасываем.
    return distanceKm({ lat, lon }, found) * 1000 <= GOOGLE_RADIUS_M * 1.5 ? found : null;
  } catch {
    return null;
  }
}

// Сначала съёмка самого Google, и только если её нет — фотосферы людей:
// без этого даже в Японии попадаются фотосферы баров вместо улиц.
// spheres: 'off' — без фотосфер, 'walk' — только те, где есть соседние точки, 'any' — любые.
async function tryGoogle(lat, lon, spheres) {
  streetViewService ??= new google.maps.StreetViewService();
  const own = await googlePanoAt(lat, lon, google.maps.StreetViewSource.GOOGLE, false);
  if (own || spheres === 'off') return own;
  // OUTDOOR: панорамы Google и уличные фотосферы людей, без съёмки внутри зданий.
  return googlePanoAt(lat, lon, google.maps.StreetViewSource.OUTDOOR, spheres === 'walk');
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
  return { src: 'm', id: String(img.id), lat: ilat, lon: ilon, kind: 'mapillary' };
}

async function findAt([lat, lon], sources, spheres) {
  for (const s of sources) {
    const found = s === 'g' ? await tryGoogle(lat, lon, spheres) : await tryMapillary(lat, lon);
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
async function generateRounds(count, sources, spheres, onProgress) {
  const rounds = [];
  const usedCountries = new Set();
  // Панорама у границы находится из двух стран; когда Nominatim промолчал, по стране её не отсеять.
  const usedIds = new Set();
  for (const cc of shuffle(Object.keys(places))) {
    if (rounds.length === count) break;
    if (usedCountries.has(cc)) continue;
    onProgress(rounds.length + 1, count);
    let found = null;
    for (let b = 0; b < BATCHES_PER_COUNTRY && !found; b++) {
      const points = Array.from({ length: POINTS_PER_BATCH }, () => randomPointNear(places[cc]));
      found = (await Promise.all(points.map((p) => findAt(p, sources, spheres)))).find(Boolean) || null;
    }
    if (!found || usedIds.has(found.id)) continue;
    found.cc = resolveCountry(cc, await countryAt(found.lat, found.lon));
    if (usedCountries.has(found.cc)) continue;
    usedCountries.add(found.cc);
    usedIds.add(found.id);
    rounds.push(found);
  }
  if (rounds.length < count) throw new Error('Не удалось найти достаточно мест. Попробуйте ещё раз.');
  return rounds;
}

// ---------- Ссылка для друзей ----------

const challengeUrl = () => `${location.origin}${location.pathname}#c=${encodeChallenge(state.rounds)}`;

// ---------- Лог игры ----------

// Каждая игра отправляет одну запись в /api/log (Cloudflare KV): при старте, в конце и при
// закрытии страницы посреди игры. Повторная отправка той же игры перезаписывает запись.
// Лог никогда не мешает игре: любая ошибка отправки молча проглатывается.

function newLogId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

// Новая игра: пустые раунды и свежая запись лога. settings — null для игры по ссылке.
function beginLog(settings) {
  Object.assign(state, {
    rounds: [], guesses: [], index: 0,
    logId: newLogId(), startedAt: Date.now(), buildMs: 0,
    settings, challenge: !settings, errors: [], finished: false,
  });
}

function logError(round, message) {
  state.errors.push({ round, message: String(message) });
}

function postLog(beacon = false) {
  try {
    const body = JSON.stringify(buildLogRecord({
      id: state.logId,
      startedAt: state.startedAt,
      buildMs: state.buildMs,
      name: cleanName($('player-name').value),
      settings: state.settings,
      challenge: state.challenge,
      rounds: state.rounds,
      guesses: state.guesses,
      errors: state.errors,
    }));
    if (beacon) {
      navigator.sendBeacon('/api/log', body);
    } else {
      fetch('/api/log', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body })
        .catch(() => {});
    }
  } catch { /* лог не должен ломать игру */ }
}

// ---------- Экраны ----------

function show(id) {
  for (const s of ['menu', 'loading', 'lobby', 'room-round', 'game', 'result', 'final']) $(s).hidden = s !== id;
}

function fail(message) {
  show('menu');
  $('menu-error').textContent = message;
}

const total = () => state.guesses.reduce((s, g) => s + g.points, 0);

let panoViewer = null;
async function showPanorama(round) {
  if (round.src === 'm') await loadMapillary();
  if (panoViewer?.remove) panoViewer.remove(); // у Mapillary свой teardown
  panoViewer = null;
  const host = $('pano');
  host.innerHTML = '';
  const el = document.createElement('div');
  host.appendChild(el);
  if (round.src === 'g') {
    const pano = new google.maps.StreetViewPanorama(el, {
      pano: round.id,
      addressControl: false,
      showRoadLabels: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
    });
    // Панорама не загрузилась (чёрный экран и т. п.) — в лог, с номером раунда.
    const roundNo = state.index + 1;
    pano.addListener('status_changed', () => {
      const status = pano.getStatus();
      if (status !== google.maps.StreetViewStatus.OK) logError(roundNo, status);
    });
    panoViewer = pano;
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

async function startRound() {
  const round = state.rounds[state.index];
  show('game');
  $('hud-round').textContent = `Раунд ${state.index + 1} / ${state.rounds.length}`;
  $('hud-score').textContent = `Очки: ${total().toLocaleString('ru')}`;
  try {
    await showPanorama(round);
  } catch (e) {
    logError(state.index + 1, e.message);
    postLog();
    fail(e.message);
    return;
  }
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
  const forgiven = guess.forgiven >= 1;
  $('result-forgiven').textContent = forgiven ? `Прощено ${formatKm(guess.forgiven)}: разброс внутри страны` : '';
  $('result-forgiven').hidden = !forgiven;
  $('result-points').textContent = `+${guess.points.toLocaleString('ru')} очков`;
  $('next').textContent = state.index + 1 < state.rounds.length ? 'Следующий раунд' : 'Итоги';
}

function showFinal() {
  state.finished = true;
  postLog();
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
  return formatResult({
    name: $('player-name').value,
    total: total(),
    max: state.rounds.length * MAX_POINTS,
    rounds: state.rounds.map((r, i) => ({ cc: r.cc, points: state.guesses[i].points })),
    url: challengeUrl(),
  });
}

// target — где показать, что скопировано: на итогах игры или в комнате.
async function copy(text, message, target = 'copied') {
  try {
    await navigator.clipboard.writeText(text);
    $(target).textContent = message;
  } catch {
    $(target).textContent = text;
  }
  $(target).hidden = false;
}

// ---------- Имя игрока ----------

// Имя помнится в браузере. В приватном режиме или с запрещённым хранилищем localStorage
// бросает исключение: тогда имя просто не запоминается, игра работает дальше.
const NAME_KEY = 'monguess.name';

function setupPlayerName() {
  const input = $('player-name');
  try { input.value = cleanName(localStorage.getItem(NAME_KEY)); } catch { /* хранилище недоступно */ }
  input.addEventListener('input', () => {
    try { localStorage.setItem(NAME_KEY, cleanName(input.value)); } catch { /* хранилище недоступно */ }
    // Стираем только своё сообщение: ошибку битой ссылки и прочие оставляем.
    input.classList.remove('invalid');
    if ($('menu-error').textContent === nameError('')) $('menu-error').textContent = '';
  });
}

// Без имени игра не начинается — ни новая, ни по ссылке друга.
function nameMissing() {
  const message = nameError($('player-name').value);
  if (!message) return false;
  $('menu-error').textContent = message;
  $('player-name').classList.add('invalid');
  $('player-name').focus();
  return true;
}

// ---------- Комната: игра с друзьями вживую ----------

// Один сокет на комнату: подключиться, отправить JSON, разобрать ответ по type в roomHandlers.
// Протокол сообщений описан в начале rooms/rules.js. playerId пока живёт только в памяти:
// перезагрузка страницы входит в комнату новым игроком.
const room = { id: '', playerId: '', ws: null, phase: '', settings: null, roundsTotal: 0, players: [] };

const randomId = (length) => idFromBytes(crypto.getRandomValues(new Uint8Array(length)));
const pageBase = () => `${location.origin}${location.pathname}`;

const ROOM_ERRORS = {
  'no-room': 'Комнаты по этой ссылке нет: игра давно закончилась или ссылка набрана с ошибкой.',
  'bad-name': nameError(''),
  started: 'Игра уже началась.',
};
const roomErrorText = (msg) => ROOM_ERRORS[msg.code] || `Комната не приняла запрос: ${msg.message}`;

function roomSend(msg) {
  if (room.ws?.readyState === WebSocket.OPEN) room.ws.send(JSON.stringify(msg));
}

// Открыть сокет комнаты id и первым сообщением отправить first (create или join).
// Пока не пришло первое state, игрок ещё на экране загрузки: сбой возвращает его в меню.
function roomConnect(id, first) {
  room.id = id;
  room.playerId = first.playerId;
  room.phase = '';
  const ws = new WebSocket(roomSocketUrl(location, id));
  room.ws = ws;
  ws.onopen = () => roomSend(first);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    roomHandlers[msg.type]?.(msg);
  };
  ws.onclose = () => {
    if (room.ws !== ws) return; // закрыли сами
    room.ws = null;
    if (!room.phase) fail('Не удалось подключиться к комнате. Проверьте интернет и попробуйте ещё раз.');
    else $('lobby-error').textContent = 'Связь с комнатой потеряна. Обновите страницу, чтобы войти снова.';
  };
}

const roomHandlers = {
  state(msg) {
    const entering = !room.phase;
    Object.assign(room, { phase: msg.phase, settings: msg.settings, roundsTotal: msg.roundsTotal, players: msg.players });
    if (entering) history.replaceState(null, '', roomLink(pageBase(), room.id));
    if (msg.phase === 'lobby') showLobby();
    else showRoomRound(msg.index, msg.roundsTotal);
  },
  players(msg) {
    room.players = msg.players;
    renderPlayers();
  },
  round(msg) {
    room.phase = 'round';
    showRoomRound(msg.index, msg.of);
  },
  error(msg) {
    if (room.phase) {
      $('lobby-error').textContent = roomErrorText(msg);
      return;
    }
    // В комнату не пустили: сокет больше не нужен.
    const ws = room.ws;
    room.ws = null;
    ws?.close();
    if (msg.code === 'no-room') leaveRoomLink();
    fail(roomErrorText(msg));
  },
};

async function createRoom() {
  const search = menuSearch();
  if (!search) return;
  let rounds;
  try {
    ({ rounds } = await findPlaces(search));
  } catch (e) {
    fail(e.message);
    return;
  }
  $('loading-text').textContent = 'Создаю комнату…';
  roomConnect(randomId(10), buildRoomCreate({
    playerId: room.playerId || randomId(16),
    name: $('player-name').value,
    mode: $('room-mode').value,
    timerSec: $('room-timer').value,
    rounds,
    forgiveKm: forgiveFor,
  }));
}

function joinRoom(id) {
  $('menu-error').textContent = '';
  show('loading');
  $('loading-text').textContent = 'Вхожу в комнату…';
  roomConnect(id, { type: 'join', playerId: room.playerId || randomId(16), name: cleanName($('player-name').value) });
}

function showLobby() {
  show('lobby');
  $('lobby-link').value = roomLink(pageBase(), room.id);
  const n = room.roundsTotal;
  $('lobby-info').textContent = `${n} ${pluralRu(n, 'раунд', 'раунда', 'раундов')} · ${describeRoomMode(room.settings)}`;
  renderPlayers();
}

// Имена — только textContent: их вписывают другие игроки.
function renderPlayers() {
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    li.textContent = p.name;
    if (p.playerId === room.playerId) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = ' (вы)';
      li.append(you);
    }
    if (!p.connected) {
      li.classList.add('away');
      li.title = 'Не в сети';
    }
    list.append(li);
  }
}

// Временно, до экрана раунда (#25): только номер раунда.
function showRoomRound(index, of) {
  show('room-round');
  $('room-round-text').textContent = `Раунд ${index + 1} из ${of}`;
}

// Меню снова главное: без ссылки друга или комнаты в адресе.
function leaveRoomLink() {
  history.replaceState(null, '', location.pathname);
  $('challenge-note').hidden = true;
  $('landing').hidden = false;
  $('new-instead').hidden = true;
  $('play-friends').hidden = false;
  $('start').textContent = 'Играть';
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
  // Временно Google первым, он и выбран по умолчанию: Mapillary Graph API отдаёт пустоту (с 2026-10-19).
  if (have.includes('g')) options.push(['g', 'Только Google']);
  if (have.length === 2) options.push(['gm', 'Google + Mapillary']);
  if (have.includes('m')) options.push(['m', 'Только Mapillary']);
  $('source').innerHTML = options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  // Фотосферы бывают только у Google.
  const syncSpheres = () => {
    $('spheres-label').hidden = !$('source').value.includes('g');
    // Временно: у нового приложения Mapillary Graph API отдаёт пустоту (с 2026-10-19).
    $('mapillary-note').hidden = !$('source').value.includes('m');
  };
  $('source').onchange = syncSpheres;
  syncSpheres();
}

async function play(rounds) {
  state.rounds = rounds;
  state.guesses = [];
  state.index = 0;
  postLog();
  startRound();
}

// Настройки поиска мест из меню — общие для своей игры и комнаты. Null, если искать нечем:
// сообщение об этом уже на экране.
function menuSearch() {
  $('menu-error').textContent = '';
  if (!places) {
    fail('Не загрузился data/places.json. Откройте игру через веб-сервер, а не как файл — см. README.');
    return null;
  }
  const sources = [...$('source').value];
  if (!sources.length) {
    fail('Нет ни одного ключа. Впишите mapillaryToken или googleApiKey в config.js — см. README.');
    return null;
  }
  return { sources, spheres: $('spheres').value, count: Number($('rounds').value) };
}

// Места для игры под экраном загрузки. Сбой — исключение с текстом для игрока.
// buildMs — только сам поиск, без загрузки Google.
async function findPlaces({ sources, spheres, count }) {
  show('loading');
  $('loading-text').textContent = 'Загрузка…';
  if (sources.includes('g') && !(await loadGoogle())) throw new Error('Не удалось загрузить Google Maps.');
  const built = Date.now();
  const rounds = await generateRounds(count, sources, spheres, (n, of) => {
    $('loading-text').textContent = `Ищу место ${n} из ${of}…`;
  });
  return { rounds, buildMs: Date.now() - built };
}

async function newGame() {
  const search = menuSearch();
  if (!search) return;
  beginLog({ sources: search.sources, spheres: search.spheres, rounds: search.count });
  try {
    const { rounds, buildMs } = await findPlaces(search);
    state.buildMs = buildMs;
    play(rounds);
    // Ссылка на игру сразу в адресе: перезагрузка не теряет места, а скопировать её можно и в середине игры.
    history.replaceState(null, '', challengeUrl());
  } catch (e) {
    // Игра не собралась: в лог одна запись без раундов, с ошибкой.
    logError(null, e.message);
    postLog();
    fail(e.message);
  }
}

async function playChallenge(rounds) {
  beginLog(null);
  // Игра по ссылке не началась: в лог одна запись без раундов, с ошибкой.
  const failChallenge = (message) => {
    logError(null, message);
    postLog();
    fail(message);
  };
  if (rounds.some((r) => r.src === 'm') && !CFG.mapillaryToken) {
    failChallenge('В этой игре есть снимки Mapillary, а ключа Mapillary здесь нет.');
    return;
  }
  if (rounds.some((r) => r.src === 'g')) {
    show('loading');
    $('loading-text').textContent = 'Загрузка…';
    if (!(await loadGoogle())) {
      failChallenge('В этой игре есть панорамы Google, а ключа Google здесь нет.');
      return;
    }
  }
  play(rounds);
}

async function init() {
  fillSourceSelect();
  setupPlayerName();
  const hasLink = location.hash.startsWith('#c=');
  const challenge = hasLink ? decodeChallenge(location.hash.slice(3)) : null;
  if (hasLink && !challenge) $('menu-error').textContent = 'Ссылка на игру повреждена. Попросите друга скопировать её ещё раз.';
  const hasRoomLink = location.hash.startsWith('#r=');
  const roomId = roomIdFromHash(location.hash);
  if (hasRoomLink && !roomId) $('menu-error').textContent = 'Ссылка на комнату повреждена. Попросите друга скопировать её ещё раз.';

  if (challenge) {
    const n = challenge.length;
    $('challenge-note').textContent = `Друг позвал вас сыграть: ${n} ${pluralRu(n, 'раунд', 'раунда', 'раундов')}, те же места.`;
    $('challenge-note').hidden = false;
    $('landing').hidden = true;
    $('new-instead').hidden = false;
    $('play-friends').hidden = true;
  }
  if (roomId) {
    $('challenge-note').textContent = 'Вас позвали в комнату: впишите имя и войдите.';
    $('challenge-note').hidden = false;
    $('landing').hidden = true;
    $('new-instead').hidden = false;
    $('play-friends').hidden = true;
    $('start').textContent = 'Войти';
  }

  $('start').onclick = () => {
    if (nameMissing()) return;
    if (challenge && location.hash.startsWith('#c=')) playChallenge(challenge);
    else if (roomId && location.hash.startsWith('#r=')) joinRoom(roomId);
    else newGame();
  };
  $('play-friends').onclick = () => {
    if (nameMissing()) return;
    createRoom();
  };
  $('new-instead').onclick = leaveRoomLink;
  const syncRoomMode = () => { $('room-timer-label').hidden = $('room-mode').value !== 'timer'; };
  $('room-mode').onchange = syncRoomMode;
  syncRoomMode();
  $('lobby-copy').onclick = () => copy($('lobby-link').value, 'Ссылка скопирована — отправьте её друзьям.', 'lobby-copied');
  $('lobby-start').onclick = () => {
    $('lobby-error').textContent = '';
    roomSend({ type: 'start' });
  };
  $('guess').onclick = () => {
    const round = state.rounds[state.index];
    const ll = guessMarker.getLatLng();
    const guess = { lat: ll.lat, lon: ll.lng };
    guess.km = distanceKm(round, guess);
    const forgive = forgiveFor(round.cc);
    guess.points = scoreFor(guess.km, forgive);
    guess.forgiven = Math.min(forgive, guess.km);
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
  // Страницу закрыли посреди игры: последнее состояние уходит в лог через sendBeacon.
  window.addEventListener('pagehide', () => {
    if (state.rounds.length && !state.finished) postLog(true);
  });

  try {
    places = await (await fetch('data/places.json')).json();
  } catch {
    fail('Не загрузился data/places.json. Откройте игру через веб-сервер, а не как файл — см. README.');
  }
}

init();
