// Visual effects of MonGuess: number reels, confetti, the winner screen and the loading globe.
// DOM and canvas only: no network and no game state; app.js decides when each one plays.
// Under prefers-reduced-motion every effect becomes a still picture or nothing.
// The browser gets these as window.MGFX.
(function () {
  'use strict';

  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (n) => n.toLocaleString('ru');
  const rand = (a, b) => a + Math.random() * (b - a);

  // Restarts a one-off CSS animation (.pop in style.css) on an element.
  function pop(el) {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  // ---------- Reels ----------

  // The height of one reel cell; .reel in style.css uses the same 1.25em.
  const REEL_EM = 1.25;

  // Writes value into box as slot-machine reels, one per digit: each strip runs 0-9 twice and
  // stops on its digit, the right-hand reels later. Returns the ms until the last reel stops;
  // 0 when motion is reduced and the number is simply written.
  function spinReels(box, value, { first = 0.9, step = 0.25 } = {}) {
    const text = fmt(value);
    box.textContent = '';
    if (calm()) {
      box.textContent = text;
      return 0;
    }
    const strips = [];
    for (const ch of text) {
      if (!/\d/.test(ch)) {
        const gap = document.createElement('span');
        gap.className = 'reel-gap';
        box.append(gap);
        continue;
      }
      const reel = document.createElement('span');
      reel.className = 'reel';
      const strip = document.createElement('span');
      for (const c of `01234567890123456789${ch}`) strip.append(Object.assign(document.createElement('i'), { textContent: c }));
      strip.style.transitionDuration = `${first + step * strips.length}s`;
      reel.append(strip);
      box.append(reel);
      strips.push(strip);
    }
    void box.offsetWidth; // the strips start at 0, then slide to their digit
    for (const strip of strips) strip.style.transform = `translateY(-${20 * REEL_EM}em)`;
    const ms = (first + step * (strips.length - 1)) * 1000;
    setTimeout(() => pop(box), ms);
    return ms;
  }

  // ---------- Confetti ----------

  const COLORS = ['#3fb68b', '#f4c95d', '#e8edf3', '#ff7a7a', '#6aa9ff', '#b48cff'];
  let canvas = null;
  let ctx = null;
  let pieces = [];
  let looping = false;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // One canvas over the whole page, made on first use; it lets every click through.
  function ensureCanvas() {
    if (canvas) return;
    canvas = Object.assign(document.createElement('canvas'), { id: 'confetti' });
    canvas.setAttribute('aria-hidden', 'true');
    document.body.append(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function add(piece) {
    pieces.push({
      w: rand(6, 10), h: rand(3, 6), spin: rand(-0.3, 0.3), angle: rand(0, Math.PI * 2),
      flip: rand(0, Math.PI * 2), flipSpeed: rand(0.08, 0.2), ...piece,
    });
    if (!looping) {
      looping = true;
      requestAnimationFrame(loop);
    }
  }

  function loop() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of pieces) {
      p.vy += p.gravity;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      p.flip += p.flipSpeed;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      // Squeezing one axis by cos() makes a flat strip look like it tumbles.
      ctx.scale(1, Math.cos(p.flip));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    pieces = pieces.filter((p) => p.y < innerHeight + 40);
    if (pieces.length) requestAnimationFrame(loop);
    else {
      looping = false;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  // A party popper from the middle of el, upwards. Nothing for a hidden element.
  function burst(el, count = 70, speed = 11) {
    const r = el.getBoundingClientRect();
    if (calm() || !r.width) return;
    ensureCanvas();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    for (let i = 0; i < count; i++) {
      const a = rand(-Math.PI * 0.9, -Math.PI * 0.1);
      const s = rand(speed * 0.4, speed);
      add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, gravity: 0.3, drag: 0.97, color: COLORS[i % COLORS.length] });
    }
  }

  // Confetti falling over the whole screen for ms.
  function rain(ms) {
    if (calm()) return;
    ensureCanvas();
    const until = performance.now() + ms;
    const drop = () => {
      for (let i = 0; i < 8; i++) {
        add({ x: rand(0, innerWidth), y: rand(-40, -10), vx: rand(-1, 1), vy: rand(2, 4), gravity: 0.05, drag: 0.995,
          color: COLORS[Math.floor(rand(0, COLORS.length))] });
      }
      if (performance.now() < until) requestAnimationFrame(drop);
    };
    drop();
  }

  // ---------- Winner screen ----------

  let hideTimer = null;

  // The #winner screen of index.html: label, a big name and the points, under confetti rain, for
  // ms; a click closes it sooner. done runs once, when it starts to close.
  function showWinner({ label, name, points }, done = () => {}, ms = 3500) {
    const box = document.getElementById('winner');
    box.querySelector('.winner-label').textContent = label;
    box.querySelector('.winner-name').textContent = name;
    box.querySelector('.winner-points').textContent = points;
    clearTimeout(hideTimer);
    box.hidden = false;
    void box.offsetWidth;
    box.classList.add('in');
    rain(ms);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      box.onclick = null;
      box.classList.remove('in');
      hideTimer = setTimeout(() => { box.hidden = true; }, 500);
      done();
    };
    const timer = setTimeout(close, ms);
    box.onclick = close;
  }

  // ---------- Loading globe ----------

  const GLOBE_W = 128;
  const GLOBE_H = 150; // room below the sphere for its shadow
  const R = 56;
  const CX = GLOBE_W / 2;
  const CY = 64;
  const TILT = 0.38; // the north pole leans towards the viewer
  const TURN_S = 18; // seconds per turn
  const START_ROT = -0.35; // Europe and Africa face the viewer first: the Pacific has few places
  const LIGHT = [-0.55, 0.55, 0.63]; // from the upper left, slightly in front
  const PING_MS = 1600;
  const PING_EVERY_MS = 650;

  const toVec = ([lat, lon]) => {
    const a = (lat * Math.PI) / 180;
    const b = (lon * Math.PI) / 180;
    return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)];
  };

  // Runs the globe on canvas until the returned stop() is called. getCells() gives the dots as
  // [lat, lon] pairs, or null while places.json is still loading: the sphere turns without them.
  function startGlobe(canvasEl, getCells) {
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = GLOBE_W * dpr;
    canvasEl.height = GLOBE_H * dpr;
    const g = canvasEl.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ct = Math.cos(TILT);
    const st = Math.sin(TILT);
    let dots = null;
    let rot = START_ROT;
    let last = performance.now();
    let nextPing = 0;
    let frameId = 0;
    const pings = [];

    // A unit vector to the screen: X, Y, depth z (> 0 is the near side) and the normal nx, ny.
    function project([x, y, z]) {
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const nx = x * cr + z * sr;
      const z0 = -x * sr + z * cr;
      const ny = y * ct - z0 * st;
      const nz = y * st + z0 * ct;
      return { X: CX + R * nx, Y: CY - R * ny, z: nz, nx, ny };
    }
    const lit = (p) => Math.max(0, p.nx * LIGHT[0] + p.ny * LIGHT[1] + p.z * LIGHT[2]);

    function drawShadow() {
      g.save();
      g.translate(CX + 8, CY + R + 11);
      g.scale(1, 0.13);
      const shadow = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.95);
      shadow.addColorStop(0, 'rgba(0,0,0,0.5)');
      shadow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = shadow;
      g.beginPath();
      g.arc(0, 0, R * 0.95, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // No outline: the lit edge melts into the background and the far edge goes dark, so the
    // shape comes from light, as on a real ball.
    function drawSphere() {
      const body = g.createRadialGradient(CX - 20, CY - 22, 2, CX + 8, CY + 10, R + 10);
      body.addColorStop(0, '#344355');
      body.addColorStop(0.45, '#1a2330');
      body.addColorStop(1, '#06090d');
      g.fillStyle = body;
      g.beginPath();
      g.arc(CX, CY, R, 0, Math.PI * 2);
      g.fill();
    }

    // A ping lies on the surface: squashed along the radius near the edge, dimmer in shadow.
    function drawPing(p, age) {
      const angle = Math.atan2(-p.ny, p.nx);
      const squash = Math.max(0.15, p.z);
      const shade = 0.55 + 0.45 * lit(p);
      const r = 2 + 12 * age;
      g.strokeStyle = `rgba(244,201,93,${(1 - age) * 0.9 * shade})`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(p.X, p.Y, r * squash, r, angle, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = `rgba(244,201,93,${(1 - age * age) * shade})`;
      g.beginPath();
      g.ellipse(p.X, p.Y, 2 * squash, 2, angle, 0, Math.PI * 2);
      g.fill();
    }

    function draw(now) {
      if (!dots) {
        const cells = getCells();
        if (cells) dots = cells.map(toVec);
      }
      g.clearRect(0, 0, GLOBE_W, GLOBE_H);
      drawShadow();
      drawSphere();
      if (!dots) return;
      for (const v of dots) {
        const p = project(v);
        if (p.z < 0) continue;
        const r = 0.45 + 0.5 * p.z;
        g.fillStyle = `rgba(200,210,222,${0.06 + 0.55 * lit(p)})`;
        g.fillRect(p.X - r, p.Y - r, r * 2, r * 2);
      }
      if (now > nextPing) {
        for (let k = 0; k < 30; k++) {
          const v = dots[Math.floor(Math.random() * dots.length)];
          if (project(v).z > 0.3) {
            pings.push({ v, born: now });
            break;
          }
        }
        nextPing = now + PING_EVERY_MS;
      }
      for (let i = pings.length - 1; i >= 0; i--) {
        const age = (now - pings[i].born) / PING_MS;
        if (age >= 1) {
          pings.splice(i, 1);
          continue;
        }
        const p = project(pings[i].v);
        if (p.z >= 0) drawPing(p, age);
      }
    }

    function frame(now) {
      rot += ((now - last) / 1000) * ((Math.PI * 2) / TURN_S);
      last = now;
      draw(now);
      frameId = requestAnimationFrame(frame);
    }

    if (calm()) draw(-1); // one still frame, no pings
    else frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }

  window.MGFX = { spinReels, burst, showWinner, startGlobe };
})();
