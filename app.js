'use strict';

const CFG = window.MG_CONFIG || {};
// Чистые функции (очки, расстояния, ссылка для друзей) живут в lib.js: их проверяют тесты.
const {
  MAX_POINTS, flag, shuffle, randomPointNear, distanceKm, forgivenessKm, scoreGuess, sizeBonus, sizeBonusText,
  describeScoring, formatKm, difficultyLevel, countryPool, countryAllowed, describeDifficulty,
  resolveCountry, encodeChallenge, decodeChallenge, cleanName, nameError, formatResult, buildLogRecord,
  pluralRu, idFromBytes, roomIdFromHash, roomLink, roomSocketUrl, buildRoomCreate, describeRoomMode,
  guessedStatus, secondsLeft, RESULTS_MS, nextRoundText, roomResultRows, roomFinalRows, roomSeatKey, roomSeatText,
  parseRoomSeat, reconnectDelay,
} = window.MG;
// Сколько случайных точек пробуем в стране, прежде чем перейти к следующей.
const POINTS_PER_BATCH = 4;
const BATCHES_PER_COUNTRY = 2;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const regionNames = new Intl.DisplayNames(['ru'], { type: 'region' });

let places = null; // { "KE": [[lat, lon, population], ...], ... }
// Поля лога (logId … roundsTotal) описывают текущую игру для /api/log, см. «Лог игры».
// В комнате rounds и guesses — только сыгранные раунды и свои ответы, room — id комнаты.
// scoring — подсчёт очков: 'size' (с учётом размера страны) или 'classic'.
const state = {
  rounds: [], guesses: [], index: 0, scoring: 'size',
  logId: '', startedAt: 0, buildMs: 0, settings: null, challenge: false, errors: [], finished: false,
  room: null, roundsTotal: 0,
};

// ---------- Страны и случайные точки ----------

// Разброс страны (forgivenessKm, по нему растягивается кривая очков) считается один раз на код:
// places не меняется за игру. Страны нет в places.json — разброс 0. Пока файл не загрузился
// (игра по ссылке его не ждёт), ноль не кэшируется.
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

// Снимки Mapillary ищем по векторным тайлам z13 (≈ 4,9 × 4,9 км у экватора): в них один слой
// sequence, по записи на серию снимков, с id одного её снимка. Тайл z14 со всеми снимками весит
// в центре Токио 6 МБ, z13 — 300 КБ. Точное место снимка даёт запрос Graph API по его id (поиск
// Graph API по квадрату больше ~600 м отвечает ошибкой).
const MAPILLARY_Z = 13;
// Качество серии не равно качеству её снимка, поэтому снимок проверяем ещё раз по ответу Graph API,
// но не больше чем MAPILLARY_LOOKUPS снимков на поиск.
const MAPILLARY_LOOKUPS = 3;
const MAPILLARY_KEY_ERROR = 'Mapillary не принял ключ. Проверьте mapillaryToken в config.js.';

// Id снимков годных панорамных серий тайла. Null — тайл не скачался.
async function mapillaryCandidates([x, y]) {
  const url = `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${MAPILLARY_Z}/${x}/${y}`
    + `?access_token=${encodeURIComponent(CFG.mapillaryToken)}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) throw new Error(MAPILLARY_KEY_ERROR);
  if (!res.ok) return null;
  try {
    return MG.mapillarySequenceCandidates(new Uint8Array(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

// Место снимка по id из Graph API. Null — не панорама, качество ниже порога или сеть подвела.
async function mapillaryPlace(id) {
  const url = `https://graph.mapillary.com/${encodeURIComponent(id)}?fields=id,is_pano,geometry,quality_score`
    + `&access_token=${encodeURIComponent(CFG.mapillaryToken)}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) throw new Error(MAPILLARY_KEY_ERROR);
  if (!res.ok) return null;
  try {
    return MG.mapillaryGraphPlace(await res.json());
  } catch {
    return null;
  }
}

// Первый годный снимок среди не более чем MAPILLARY_LOOKUPS случайных кандидатов.
async function firstMapillaryPlace(ids) {
  for (const id of shuffle([...new Set(ids)]).slice(0, MAPILLARY_LOOKUPS)) {
    const place = await mapillaryPlace(id);
    if (place) return place;
  }
  return null;
}

async function tryMapillary(lat, lon) {
  const tile = MG.tileAt(lat, lon, MAPILLARY_Z);
  const ids = await mapillaryCandidates(tile);
  if (!ids) return null;
  if (ids.length) return firstMapillaryPlace(ids);
  // В своём тайле нет годной панорамной серии (пусто, только плоские фото или низкое качество):
  // смотрим 8 соседних, выходит квадрат ≈ 15 × 15 км у экватора.
  const near = await Promise.all(MG.tileNeighbours(...tile, MAPILLARY_Z).map(mapillaryCandidates));
  return firstMapillaryPlace(near.flatMap((found) => found || []));
}

async function findAt([lat, lon], sources, spheres) {
  for (const s of sources) {
    const found = s === 'g' ? await tryGoogle(lat, lon, spheres) : await tryMapillary(lat, lon);
    // Снимок, помеченный игроками как плохой, не годится: ищем дальше, как если бы его не было.
    if (found && !MG.isBadImage(found, badImages)) return found;
  }
  return null;
}

// ---------- Плохие картинки ----------

// Снимки, которые игроки пометили кнопкой «Плохая картинка» (/api/bad, functions/api/bad.js),
// ключами "src:id": findAt их пропускает. Список грузится перед сборкой каждой игры. Не
// загрузился (сеть, лимит KV, локально у scripts/play.sh нет /api/bad) — игра собирается без него.
const badImages = new Set();
const BAD_LOAD_MS = 3000;

async function loadBadImages() {
  try {
    const res = await fetch('/api/bad', { signal: AbortSignal.timeout(BAD_LOAD_MS) });
    if (!res.ok) return;
    for (const key of MG.parseBadList(await res.json())) badImages.add(key);
  } catch { /* без списка игра идёт как раньше */ }
}

// Кнопка в HUD: снимок текущего раунда (своей игры или комнаты) уходит в /api/bad и больше не
// попадётся ни в одной игре. Одно нажатие на раунд. Ответа сервера не ждём: кнопка сразу
// пишет «Отправлено», а ошибка отправки, как и у лога, молча проглатывается.
function reportBad() {
  const place = room.phase === 'round' ? room.place : state.rounds[state.index];
  const key = MG.badImageKey(place);
  if (!key) return;
  badImages.add(key); // и в этой вкладке он больше не попадётся, не дожидаясь списка с сервера
  setBadButton(true);
  fetch('/api/bad', {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src: place.src, id: place.id }),
  }).catch(() => {});
}

// sent — в этом раунде уже нажата; в начале каждого раунда кнопка снова доступна.
function setBadButton(sent) {
  $('hud-bad').textContent = sent ? 'Отправлено' : 'Плохая картинка';
  $('hud-bad').disabled = sent;
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

// Каждый раунд — новая страна, страны выбираются равновероятно из набора выбранной сложности.
async function generateRounds(count, sources, spheres, difficulty, onProgress) {
  const rounds = [];
  const usedCountries = new Set();
  // Панорама у границы находится из двух стран; когда Nominatim промолчал, по стране её не отсеять.
  const usedIds = new Set();
  for (const cc of shuffle(countryPool(Object.keys(places), difficulty))) {
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
    // Панорама у границы может оказаться в соседней стране не своей сложности: такой раунд пропускаем.
    if (!countryAllowed(found.cc, difficulty)) continue;
    if (usedCountries.has(found.cc)) continue;
    usedCountries.add(found.cc);
    usedIds.add(found.id);
    rounds.push(found);
  }
  if (rounds.length < count) throw new Error('Не удалось найти достаточно мест. Попробуйте ещё раз.');
  return rounds;
}

// ---------- Ссылка для друзей ----------

const challengeUrl = () => `${location.origin}${location.pathname}#c=${encodeChallenge(state.rounds, state.scoring)}`;

// ---------- Лог игры ----------

// Каждая игра отправляет одну запись в /api/log (Cloudflare KV): при старте, в конце и при
// закрытии страницы посреди игры. Повторная отправка той же игры перезаписывает запись.
// Лог никогда не мешает игре: любая ошибка отправки молча проглатывается.

function newLogId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

// Новая игра: пустые раунды и свежая запись лога. settings — null для игры по ссылке
// и для того, кто вошёл в чужую комнату; scoring есть всегда: из меню, из ссылки или комнаты.
// roomId и roundsTotal — только для игры в комнате.
function beginLog(settings, scoring, roomId = null, roundsTotal = 0) {
  Object.assign(state, {
    rounds: [], guesses: [], index: 0, scoring,
    logId: newLogId(), startedAt: Date.now(), buildMs: 0,
    settings, challenge: !settings && !roomId, errors: [], finished: false,
    room: roomId, roundsTotal,
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
      name: cleanName(state.room ? room.name : $('player-name').value),
      settings: state.settings,
      challenge: state.challenge,
      scoring: state.scoring,
      rounds: state.rounds,
      guesses: state.guesses,
      errors: state.errors,
      room: state.room,
      roundsTotal: state.roundsTotal,
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
  for (const s of ['menu', 'loading', 'lobby', 'game', 'result', 'final']) $(s).hidden = s !== id;
  if (id !== 'menu') closeSetup();
}

// Окно новой игры поверх главной. Пока оно открыто, страница под ним не прокручивается.
function openSetup() {
  document.documentElement.classList.add('setup-open');
}

function closeSetup() {
  document.documentElement.classList.remove('setup-open');
}

// Ошибка видна в окне новой игры, рядом с кнопкой, которая к ней привела.
function fail(message) {
  show('menu');
  openSetup();
  $('menu-error').textContent = message;
}

const roomMode = () => document.querySelector('input[name="room-mode"]:checked').value;

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
      if (room.phase === 'round' && room.guessed) return; // в комнате ответ уже отправлен
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
  stopSoloNext();
  const round = state.rounds[state.index];
  show('game');
  $('hud-round').textContent = `Раунд ${state.index + 1} / ${state.rounds.length}`;
  $('hud-score').textContent = `Очки: ${total().toLocaleString('ru')}`;
  setBadButton(false);
  try {
    await showPanorama(round);
  } catch (e) {
    if (state.rounds[state.index] !== round) return; // игру уже закончили кнопкой
    logError(state.index + 1, e.message);
    postLog();
    fail(e.message);
    return;
  }
  resetGuessMap();
}

let resultMap = null;
function freshResultMap() {
  if (resultMap) resultMap.remove();
  resultMap = L.map('result-map', { worldCopyJump: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(resultMap);
}

// Отсчёт до следующего раунда своей игры (и игры по ссылке друга); null, когда его нет.
let soloTick = null;

function stopSoloNext() {
  clearInterval(soloTick);
  soloTick = null;
}

// Следующий раунд своей игры или итоги после последнего: по кнопке и по концу отсчёта.
// Отсчёт останавливается первым, так что раунд не начнётся дважды.
function nextRound() {
  stopSoloNext();
  state.index++;
  if (state.index < state.rounds.length) startRound();
  else showFinal();
}

function showResult(round, guess) {
  show('result');
  freshResultMap();
  const actual = [round.lat, round.lon];
  const guessed = [guess.lat, guess.lon];
  L.polyline([guessed, actual], { color: '#fff', dashArray: '6 8', weight: 2 }).addTo(resultMap);
  L.circleMarker(guessed, { radius: 8, color: '#fff', weight: 2, fillColor: '#e74c3c', fillOpacity: 1 }).addTo(resultMap);
  L.circleMarker(actual, { radius: 9, color: '#fff', weight: 2, fillColor: '#3fb68b', fillOpacity: 1 }).addTo(resultMap);
  resultMap.fitBounds([guessed, actual], { padding: [60, 60], maxZoom: 10 });

  $('result-country').textContent = `${flag(round.cc)} ${countryName(round.cc)}`;
  $('result-distance').textContent = `Вы ошиблись на ${formatKm(guess.km)}`;
  showBonus(sizeBonusText(guess.bonus));
  $('result-points').textContent = `+${guess.points.toLocaleString('ru')} очков`;
  const last = state.index + 1 >= state.rounds.length;
  $('next').textContent = last ? 'Итоги' : 'Следующий раунд';
  $('room-next').hidden = last;
  stopSoloNext();
  if (last) return;
  // Как в комнате: через RESULTS_MS следующий раунд начнётся сам, кнопка начинает его сразу.
  const at = Date.now() + RESULTS_MS;
  const tick = () => {
    const now = Date.now();
    $('room-next').textContent = nextRoundText(at, now);
    if (now >= at) nextRound();
  };
  soloTick = setInterval(tick, 250);
  tick();
}

// «+N очков за размер страны» под расстоянием; пустой текст прячет строку.
function showBonus(text) {
  $('result-forgiven').textContent = text;
  $('result-forgiven').hidden = !text;
}

function showFinal() {
  stopSoloNext();
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
// Протокол сообщений описан в начале rooms/rules.js. Своё место в комнате (playerId и имя)
// браузер помнит в localStorage: перезагрузка или та же ссылка возвращают на то же место,
// а оборванная связь восстанавливается сама.
// Игра в комнате: index и place — текущий раунд, guessed — свой ответ уже отправлен, endsAt —
// конец таймера, nextAt — старт следующего раунда, table — таблица очков из последнего
// сообщения комнаты, notice — сбой, который показать вместо «Ответили N из M».
// kinds и search знает только создатель комнаты: как нашлись снимки и настройки поиска, для лога.
// name — имя, с которым вошли. joined — на текущем сокете уже пришло state; retries — сколько
// раз подряд переподключались, retry — таймер следующей попытки.
// freshRoom() — состояние «не в комнате»: с него страница начинает, к нему возвращает «Закончить игру».
const freshRoom = () => ({
  id: '', playerId: '', name: '', ws: null, phase: '', settings: null, roundsTotal: 0, players: [],
  index: -1, place: null, guessed: false, endsAt: null, nextAt: null, table: [], notice: '',
  loggedIndex: -1, tick: null, kinds: new Map(), search: null,
  joined: false, retries: 0, retry: null,
});
const room = freshRoom();

const randomId = (length) => idFromBytes(crypto.getRandomValues(new Uint8Array(length)));
const pageBase = () => `${location.origin}${location.pathname}`;

const ROOM_ERRORS = {
  'no-room': 'Комнаты по этой ссылке нет: игра давно закончилась или ссылка набрана с ошибкой.',
  'bad-name': nameError(''),
  started: 'Игра уже началась.',
};
const roomErrorText = (msg) => ROOM_ERRORS[msg.code] || `Комната не приняла запрос: ${msg.message}`;
const ROOM_LOST = 'Связь с комнатой потеряна. Обновите страницу, чтобы войти снова.';
const ROOM_RECONNECTING = 'Переподключение…';
// Отказы, после которых запомненное место бесполезно: комнаты нет или такого игрока не бывает.
const SEAT_GONE = ['no-room', 'bad-player'];

// Место в комнате id, запомненное в браузере, или null. Хранилище может быть недоступно
// (приватный режим): тогда место просто не помнится.
function loadSeat(id) {
  try { return parseRoomSeat(localStorage.getItem(roomSeatKey(id))); } catch { return null; }
}

function saveSeat() {
  try { localStorage.setItem(roomSeatKey(room.id), roomSeatText(room)); } catch { /* хранилище недоступно */ }
}

function forgetSeat(id) {
  try { localStorage.removeItem(roomSeatKey(id)); } catch { /* хранилище недоступно */ }
}

// true, если сообщение ушло.
function roomSend(msg) {
  if (room.ws?.readyState !== WebSocket.OPEN) return false;
  room.ws.send(JSON.stringify(msg));
  return true;
}

// Войти в комнату id: первым сообщением отправить first (create или join).
// Пока не пришло первое state, игрок ещё на экране загрузки: сбой возвращает его в меню.
function roomConnect(id, first) {
  clearTimeout(room.retry);
  Object.assign(room, { id, playerId: first.playerId, name: cleanName(first.name), phase: '', retries: 0, retry: null });
  roomOpen(first);
}

// Открыть сокет комнаты room.id и отправить first. Сокет, который закрыли не мы (сеть, сервер),
// посреди игры переподключается сам.
function roomOpen(first) {
  const ws = new WebSocket(roomSocketUrl(location, room.id));
  room.ws = ws;
  room.joined = false;
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
    else roomReconnect();
  };
}

// Связь оборвалась посреди игры: пробовать снова через 1, 2, 4, 8 с, потом каждые 10 с;
// через 2 минуты — связь потеряна. После итогов игры ждать от комнаты больше нечего.
function roomReconnect() {
  if (room.phase === 'final') return;
  const delay = reconnectDelay(room.retries);
  if (delay === null) {
    room.retry = null;
    roomLost(ROOM_LOST);
    return;
  }
  room.retries++;
  roomLost(ROOM_RECONNECTING);
  room.retry = setTimeout(() => {
    room.retry = null;
    roomOpen({ type: 'join', playerId: room.playerId, name: room.name });
  }, delay);
}

// Ссылка на комнату, где браузер уже сидел: сразу войти на своё место, без меню и без имени.
// true, если вход начался. Не пустят — место забывается, и вход идёт как обычно, через меню.
function resumeRoom(id) {
  const seat = loadSeat(id);
  if (!seat) return false;
  show('loading');
  $('loading-text').textContent = 'Возвращаюсь в комнату…';
  roomConnect(id, { type: 'join', ...seat });
  return true;
}

// Сообщение state приходит при входе: по фазе сразу рисуем нужный экран, в том числе тому,
// кто вошёл посреди игры.
// После переподключения state приходит снова: тот же раунд не перерисовывается (панорама и
// метка на карте остаются), только снимается или ставится замок ответа.
const roomHandlers = {
  state(msg) {
    const entering = !room.phase;
    const sameRound = !entering && msg.phase === 'round' && room.phase === 'round' && msg.index === room.index;
    Object.assign(room, {
      phase: msg.phase, settings: msg.settings, roundsTotal: msg.roundsTotal, players: msg.players, table: msg.table,
      joined: true, retries: 0,
    });
    const me = msg.players.find((p) => p.playerId === room.playerId);
    if (me) saveSeat(); // в законченную игру новичка не сажают: запоминать нечего
    if (entering) history.replaceState(null, '', roomLink(pageBase(), room.id));
    $('lobby-error').textContent = '';
    if (msg.phase !== 'final') room.tick ??= setInterval(roomTick, 250);
    if (sameRound) {
      Object.assign(room, { endsAt: msg.endsAt, notice: '' });
      lockRoomGuess(Boolean(me?.guessed));
      renderRoomStatus();
      roomTick();
    } else if (msg.phase === 'lobby') showLobby();
    else if (msg.phase === 'round') {
      showRoomRound({ index: msg.index, place: msg.place, endsAt: msg.endsAt, guessed: Boolean(me?.guessed) });
    } else if (msg.phase === 'results') showRoomResults({ ...msg.results, nextAt: msg.nextAt });
    else showRoomFinal();
  },
  players(msg) {
    room.players = msg.players;
    renderPlayers();
    renderRoomStatus();
  },
  round(msg) {
    room.phase = 'round';
    for (const p of room.players) p.guessed = false; // ответы прошлого раунда не в счёт
    showRoomRound({ index: msg.index, place: msg.place, endsAt: null, guessed: false });
  },
  guessed(msg) {
    const p = room.players.find((x) => x.playerId === msg.playerId);
    if (p) p.guessed = true;
    renderRoomStatus();
  },
  countdown(msg) {
    room.endsAt = msg.endsAt;
    roomTick();
  },
  results(msg) {
    room.phase = 'results';
    showRoomResults(msg);
  },
  final(msg) {
    room.phase = 'final';
    room.table = msg.table;
    // Итоги последнего раунда остаются на экране, к таблице ведёт кнопка «Итоги».
    $('next').hidden = false;
    if (state.room === room.id && !state.finished) {
      state.finished = true;
      postLog();
    }
  },
  error(msg) {
    if (room.phase && !room.joined) {
      // Обратно в комнату не пустили (например, она истекла): переподключение бессмысленно.
      const ws = room.ws;
      room.ws = null;
      ws?.close();
      if (SEAT_GONE.includes(msg.code)) forgetSeat(room.id);
      roomLost(ROOM_LOST);
      return;
    }
    if (room.phase === 'round') {
      room.notice = roomErrorText(msg);
      renderRoomStatus();
      return;
    }
    if (room.phase) {
      $('lobby-error').textContent = roomErrorText(msg);
      return;
    }
    // В комнату не пустили: сокет больше не нужен.
    const ws = room.ws;
    room.ws = null;
    ws?.close();
    if (SEAT_GONE.includes(msg.code)) forgetSeat(room.id);
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
  room.kinds = new Map(rounds.map((r) => [r.id, r.kind]));
  room.search = search;
  roomConnect(randomId(10), buildRoomCreate({
    playerId: room.playerId || randomId(16),
    name: $('player-name').value,
    mode: roomMode(),
    timerSec: $('room-timer').value,
    scoring: $('scoring').value,
    difficulty: search.difficulty,
    rounds,
    forgiveKm: forgiveFor,
  }));
}

function joinRoom(id) {
  $('menu-error').textContent = '';
  show('loading');
  $('loading-text').textContent = 'Вхожу в комнату…';
  const playerId = loadSeat(id)?.playerId || room.playerId || randomId(16);
  roomConnect(id, { type: 'join', playerId, name: cleanName($('player-name').value) });
}

function showLobby() {
  show('lobby');
  $('lobby-link').value = roomLink(pageBase(), room.id);
  const n = room.roundsTotal;
  $('lobby-info').textContent = `${n} ${pluralRu(n, 'раунд', 'раунда', 'раундов')} · ${describeRoomMode(room.settings)}`
    + ` · ${describeScoring(room.settings.scoring)} · ${describeDifficulty(room.settings.difficulty)}`;
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

const myRoomTotal = () => room.table.find((r) => r.playerId === room.playerId)?.total ?? 0;

// Раунд в комнате — тот же экран #game, что в своей игре. После ответа карта заперта до
// итогов раунда, в HUD — сколько игроков ответило и, в режиме таймера, сколько секунд осталось.
async function showRoomRound({ index, place, endsAt, guessed }) {
  Object.assign(room, { index, place, endsAt, guessed: false, nextAt: null, notice: '' });
  // Лог игры в комнате начинается с первого увиденного раунда. Кто вошёл позже или вернулся
  // после перезагрузки, сыграет только оставшиеся раунды: их и ждёт запись, чтобы считаться законченной.
  if (state.room !== room.id) {
    const search = room.search;
    beginLog(search && { sources: search.sources, spheres: search.spheres, rounds: search.count, difficulty: search.difficulty },
      room.settings.scoring, room.id, room.roundsTotal - index);
    postLog();
  }
  state.index = index; // номер раунда для ошибок панорамы в логе
  show('game');
  $('hud-round').textContent = `Раунд ${index + 1} из ${room.roundsTotal}`;
  $('hud-score').textContent = `Очки: ${myRoomTotal().toLocaleString('ru')}`;
  $('hud-room').hidden = false;
  $('hud-invite').hidden = false;
  setBadButton(false);
  resetGuessMap();
  lockRoomGuess(guessed);
  renderRoomStatus();
  room.tick ??= setInterval(roomTick, 250);
  roomTick();
  try {
    if (place.src === 'g' && !(await loadGoogle())) throw new Error('Не удалось загрузить Google Maps.');
    if (place.src === 'm' && !CFG.mapillaryToken) throw new Error('В этой комнате есть снимки Mapillary, а ключа Mapillary здесь нет.');
    if (room.index !== index || room.phase !== 'round') return; // раунд уже сменился
    await showPanorama(place);
  } catch (e) {
    logError(index + 1, e.message);
    room.notice = `Панорама не загрузилась: ${e.message}`;
    renderRoomStatus();
  }
}

function lockRoomGuess(locked) {
  room.guessed = locked;
  $('guess-box').classList.toggle('locked', locked);
  $('guess').textContent = locked ? 'Ответ принят — ждём остальных' : 'Угадать';
  $('guess').disabled = locked || !guessMarker;
}

function roomGuess() {
  if (!guessMarker || room.guessed) return;
  const ll = guessMarker.getLatLng();
  if (roomSend({ type: 'guess', round: room.index, lat: ll.lat, lon: ll.lng })) lockRoomGuess(true);
  else roomLost(room.retry || (room.ws && !room.joined) ? ROOM_RECONNECTING : ROOM_LOST);
}

// Позвать ещё игроков посреди игры, если ссылку из лобби уже не найти. На телефоне —
// системное «Поделиться», на компьютере ссылка уходит в буфер обмена, а кнопка коротко
// подтверждает это. Без доступа к буферу ссылка показывается, чтобы скопировать её руками.
async function inviteToRoom() {
  const url = roomLink(pageBase(), room.id);
  const button = $('hud-invite');
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'MonGuess', url }); } catch { /* меню закрыли */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    window.prompt('Ссылка на комнату:', url);
    return;
  }
  button.textContent = 'Ссылка скопирована';
  clearTimeout(button.reset);
  button.reset = setTimeout(() => { button.textContent = 'Пригласить'; }, 2000);
}

function renderRoomStatus() {
  if (room.phase !== 'round') return;
  $('hud-room').textContent = room.notice || guessedStatus(room.players);
}

// Раз в 250 мс: таймер раунда и отсчёт до следующего раунда.
function roomTick() {
  const now = Date.now();
  const timer = room.phase === 'round' && room.endsAt !== null;
  $('hud-timer').hidden = !timer;
  if (timer) {
    const left = secondsLeft(room.endsAt, now);
    $('hud-timer').textContent = left ? `Осталось ${left} с` : 'Время вышло';
    $('hud-timer').classList.toggle('urgent', left <= 5);
  }
  if (room.phase === 'results' && room.nextAt !== null) {
    $('room-next').textContent = nextRoundText(room.nextAt, now);
  }
}

function stopRoomTick() {
  clearInterval(room.tick);
  room.tick = null;
}

// Связь потеряна посреди игры: сказать об этом на том экране, где игрок сейчас.
function roomLost(text) {
  stopRoomTick();
  $('lobby-error').textContent = text;
  room.notice = text;
  $('hud-room').textContent = text;
  $('hud-timer').hidden = true;
  $('room-next').textContent = text;
}

// Итоги раунда в комнате — тот же экран #result: на карте ответы всех игроков с именами,
// под ней таблица раунда и отсчёт до следующего, который начнётся сам.
function showRoomResults(msg) {
  Object.assign(room, { index: msg.index, nextAt: msg.nextAt, endsAt: null, table: msg.table });
  logRoomRound(msg);
  const rows = roomResultRows(msg, room.playerId);
  const place = msg.place;
  const mine = msg.guesses.find((g) => g.playerId === room.playerId);
  const answered = Boolean(mine) && mine.km !== null;
  show('result');

  $('result-country').textContent = `${flag(place.cc)} ${countryName(place.cc)}`;
  $('result-distance').textContent = answered ? `Вы ошиблись на ${formatKm(mine.km)}` : 'Вы не ответили в этом раунде';
  // В классической комнате forgiveKm каждого раунда 0, так что прибавки нет.
  showBonus(sizeBonusText(answered ? sizeBonus(mine.km, place.forgiveKm) : 0));
  $('result-points').textContent = `+${(mine?.points ?? 0).toLocaleString('ru')} очков`;
  renderRoomResultsTable(rows);
  const last = msg.nextAt === null;
  $('room-next').hidden = last;
  $('next').textContent = 'Итоги';
  $('next').hidden = !last || room.phase !== 'final';
  roomTick();

  // Карта — после панели: ей нужно знать высоту панели, чтобы точки не ушли под неё.
  freshResultMap();
  const actual = [place.lat, place.lon];
  const points = [actual];
  for (const r of rows) {
    if (r.lat === null) continue;
    const p = [r.lat, r.lon];
    L.polyline([p, actual], { color: '#fff', dashArray: '6 8', weight: 2 }).addTo(resultMap);
    // Имя — только textContent: строку Leaflet вставил бы как HTML, а имена вписывают другие игроки.
    const label = document.createElement('span');
    label.textContent = r.name;
    L.circleMarker(p, { radius: 8, color: '#fff', weight: 2, fillColor: r.you ? '#e74c3c' : '#4f8bd6', fillOpacity: 1 })
      .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -8], className: r.you ? 'room-label you' : 'room-label' })
      .addTo(resultMap);
    points.push(p);
  }
  L.circleMarker(actual, { radius: 9, color: '#fff', weight: 2, fillColor: '#3fb68b', fillOpacity: 1 }).addTo(resultMap);
  const below = Math.min($('result-panel').offsetHeight + 40, $('result-map').offsetHeight * 0.6);
  resultMap.fitBounds(points, { paddingTopLeft: [60, 60], paddingBottomRight: [60, below], maxZoom: 10 });
}

function renderRoomResultsTable(rows) {
  const t = $('room-results');
  t.innerHTML = '';
  t.hidden = false;
  const head = t.createTHead().insertRow();
  for (const h of ['Игрок', 'Ошибка', 'Очки', 'Всего']) head.append(Object.assign(document.createElement('th'), { textContent: h }));
  const body = t.createTBody();
  for (const r of rows) {
    const row = body.insertRow();
    if (r.you) row.className = 'you';
    row.insertCell().textContent = r.name;
    row.insertCell().textContent = r.distance;
    row.insertCell().textContent = `+${r.points.toLocaleString('ru')}`;
    row.insertCell().textContent = r.total.toLocaleString('ru');
  }
}

// Свой раунд из итогов комнаты — в лог: место (оно открывается только в итогах) и свой ответ.
// Тот, кто вошёл уже после раунда, в нём не играл: ему нечего записывать.
function logRoomRound(msg) {
  if (state.room !== room.id || msg.index <= room.loggedIndex) return;
  const mine = msg.guesses.find((g) => g.playerId === room.playerId);
  if (!mine) return;
  room.loggedIndex = msg.index;
  const { src, id, lat, lon, cc } = msg.place;
  state.rounds.push({ src, id, lat, lon, cc, kind: room.kinds.get(id) ?? null });
  state.guesses.push({ lat: mine.lat, lon: mine.lon, km: mine.km, points: mine.points });
}

// Итог игры в комнате — экран #final: таблица всех игроков по раундам, своя строка выделена.
// Ссылка «те же места» и копирование результата — только для своей игры.
function showRoomFinal() {
  stopRoomTick();
  show('final');
  $('final-total').textContent = 'Итоги комнаты';
  $('copy-link').hidden = true;
  $('copy-result').hidden = true;
  $('copied').hidden = true;
  const t = $('final-table');
  t.innerHTML = '';
  t.classList.add('room');
  const n = room.roundsTotal;
  const head = t.createTHead().insertRow();
  const th = (text) => head.append(Object.assign(document.createElement('th'), { textContent: text }));
  th('');
  th('Игрок');
  for (let i = 1; i <= n; i++) th(String(i));
  th('Всего');
  const body = t.createTBody();
  for (const r of roomFinalRows(room.table, room.playerId)) {
    const row = body.insertRow();
    if (r.you) row.className = 'you';
    row.insertCell().textContent = `${r.place}.`;
    row.insertCell().textContent = r.name;
    for (let i = 0; i < n; i++) {
      const cell = row.insertCell();
      cell.className = 'num';
      cell.textContent = (r.points[i] ?? 0).toLocaleString('ru');
    }
    row.insertCell().textContent = r.total.toLocaleString('ru');
  }
}

// Меню снова главное: без ссылки друга или комнаты в адресе.
function leaveRoomLink() {
  history.replaceState(null, '', location.pathname);
  $('challenge-note').hidden = true;
  $('landing').hidden = false;
  $('new-instead').hidden = true;
  $('play-friends').hidden = false;
  $('start').textContent = 'Играть';
  openSetup();
}

// ---------- Закончить игру ----------

// Уйти из комнаты по своей воле. Сокет закрываем сами (room.ws = null до close(), так что
// onclose не переподключается), сервер считает это уходом игрока. Место забывается: перезагрузка
// не вернёт в комнату. Состояние комнаты — с нуля, чтобы «Угадать» и «Далее» снова вели свою
// игру, а следующий вход получил новое место. HUD и экран итогов — снова как в своей игре.
function leaveRoom() {
  const ws = room.ws;
  room.ws = null;
  ws?.close();
  stopRoomTick();
  clearTimeout(room.retry);
  forgetSeat(room.id);
  if (state.room === room.id && !state.finished) postLog();
  Object.assign(room, freshRoom());
  for (const id of ['hud-room', 'hud-timer', 'hud-invite', 'room-results']) $(id).hidden = true;
  $('next').hidden = false;
  lockRoomGuess(false);
}

// «Да» в окне «Закончить игру?»: игра бросается без итогов и открывается главная с окном новой
// игры. Брошенная игра уходит в лог один раз, незаконченной (finished остаётся false); потом
// раунды и комната в state сбрасываются, чтобы pagehide не отправил её ещё раз.
function endGame() {
  $('end-dialog').close();
  if (room.id) {
    leaveRoom();
  } else {
    stopSoloNext();
    if (state.rounds.length && !state.finished) postLog();
  }
  Object.assign(state, { rounds: [], guesses: [], index: 0, room: null, roundsTotal: 0 });
  show('menu');
  leaveRoomLink();
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
  // Google первым, он и выбран по умолчанию.
  if (have.includes('g')) options.push(['g', 'Только Google']);
  if (have.length === 2) options.push(['gm', 'Google + Mapillary']);
  if (have.includes('m')) options.push(['m', 'Только Mapillary']);
  $('source').innerHTML = options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  // Фотосферы бывают только у Google.
  const syncSpheres = () => {
    $('spheres-label').hidden = !$('source').value.includes('g');
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
  // Сложность по умолчанию — средняя, как выбрано в меню.
  return {
    sources, spheres: $('spheres').value, count: Number($('rounds').value),
    difficulty: difficultyLevel($('difficulty').value, 2),
  };
}

// Места для игры под экраном загрузки. Сбой — исключение с текстом для игрока.
// buildMs — только сам поиск, без загрузки Google.
async function findPlaces({ sources, spheres, count, difficulty }) {
  show('loading');
  $('loading-text').textContent = 'Загрузка…';
  if (sources.includes('g') && !(await loadGoogle())) throw new Error('Не удалось загрузить Google Maps.');
  await loadBadImages();
  const built = Date.now();
  const rounds = await generateRounds(count, sources, spheres, difficulty, (n, of) => {
    $('loading-text').textContent = `Ищу место ${n} из ${of}…`;
  });
  return { rounds, buildMs: Date.now() - built };
}

async function newGame() {
  const search = menuSearch();
  if (!search) return;
  beginLog({ sources: search.sources, spheres: search.spheres, rounds: search.count, difficulty: search.difficulty },
    $('scoring').value);
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

async function playChallenge({ rounds, scoring }) {
  beginLog(null, scoring);
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
    const n = challenge.rounds.length;
    $('challenge-note').textContent = `Друг позвал вас сыграть: ${n} ${pluralRu(n, 'раунд', 'раунда', 'раундов')}, те же места.`;
    $('challenge-note').hidden = false;
    $('landing').hidden = true;
    $('new-instead').hidden = false;
    $('play-friends').hidden = true;
  }
  if (roomId) {
    resumeRoom(roomId);
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
  // Выбор секунд — это выбор режима «На время».
  $('room-timer').onfocus = $('room-timer').onchange = () => {
    document.querySelector('input[name="room-mode"][value="timer"]').checked = true;
  };
  for (const a of document.querySelectorAll('[data-open-setup]')) {
    a.onclick = (e) => {
      e.preventDefault();
      openSetup();
    };
  }
  // Закрыть окно можно стрелкой, кликом мимо карточки и Esc; по ссылке друга оно и есть главная.
  const closable = () => !$('landing').hidden;
  document.querySelector('.setup-back').onclick = closeSetup;
  document.querySelector('.setup').onclick = (e) => {
    if (e.target === e.currentTarget && closable()) closeSetup();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closable()) closeSetup();
  });
  $('hud-invite').onclick = inviteToRoom;
  $('hud-bad').onclick = reportBad;
  // «Закончить игру»: сначала своё окно подтверждения. «Нет» и Esc (его dialog понимает сам)
  // закрывают окно, игра идёт дальше.
  $('hud-end').onclick = () => $('end-dialog').showModal();
  $('end-yes').onclick = endGame;
  $('end-no').onclick = () => $('end-dialog').close();
  $('lobby-copy').onclick = () => copy($('lobby-link').value, 'Ссылка скопирована — отправьте её друзьям.', 'lobby-copied');
  $('lobby-start').onclick = () => {
    $('lobby-error').textContent = '';
    roomSend({ type: 'start' });
  };
  $('guess').onclick = () => {
    if (room.phase === 'round') {
      roomGuess();
      return;
    }
    const round = state.rounds[state.index];
    const ll = guessMarker.getLatLng();
    const at = { lat: ll.lat, lon: ll.lng };
    const guess = { ...at, ...scoreGuess(round, at, forgiveFor(round.cc), state.scoring) };
    state.guesses.push(guess);
    showResult(round, guess);
  };
  $('next').onclick = () => {
    if (room.phase) {
      showRoomFinal();
      return;
    }
    nextRound();
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
    if ((state.rounds.length || state.room) && !state.finished) postLog(true);
  });

  try {
    places = await (await fetch('data/places.json')).json();
  } catch {
    fail('Не загрузился data/places.json. Откройте игру через веб-сервер, а не как файл — см. README.');
  }
}

init();
