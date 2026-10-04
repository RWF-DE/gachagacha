/* YoSoro! お宝ガチャ — 紙吹雪・金貨・星のきらめき（Canvas 2D）
 * createConfetti(hostEl) → { burst(kind, x, y, opts), rain(kind, ms), clear(), destroy() }
 * - hostEl 内に position:absolute の canvas を作る（hostEl は position:fixed/relative で全画面想定）
 * - パーティクルが無いときは RAF を止める。総数は上限あり。DPR は最大 2。 */

const MAX = 280;
const TAU = Math.PI * 2;

const PALETTES = {
  sponsor: ['#ffd23f', '#ffb81c', '#fff2b8', '#ff7a59', '#4cc9f0', '#ff5d8f', '#7ae582', '#ffffff'],
  rare: ['#e6f7ff', '#7fc8e8', '#b5a7ff', '#ffa3d7', '#9bf6ff', '#ffffff', '#caffbf'],
  sticker: ['#ff9f80', '#ffd166', '#6ec6e8', '#fff1e6', '#8ad6a0', '#ff7a8a'],
};

const rnd = (a, b) => a + Math.random() * (b - a);

export function createConfetti(host, { back = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = back ? 'yg-confetti yg-confetti-back' : 'yg-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  const g = canvas.getContext('2d');

  let W = 0;
  let H = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  const parts = [];
  const rains = [];

  function resize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === H && d === dpr) return;
    W = w; H = h; dpr = d;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }

  function add(p) {
    if (parts.length >= MAX) return;
    parts.push(p);
  }

  let lifeK = 1;
  function confettiPiece(x, y, vx, vy, pal, o = {}) {
    add({
      t: 0, x, y, vx, vy,
      g: o.g ?? 900, drag: o.drag ?? 1.6,
      rot: rnd(0, TAU), vr: rnd(-9, 9),
      ph: rnd(0, TAU), vph: rnd(6, 14),
      w: rnd(8, 15), h: rnd(5, 9),
      c: pal[(Math.random() * pal.length) | 0],
      ttl: (o.ttl ?? rnd(2.4, 4)) * lifeK,
      sway: rnd(0.5, 1.6), swayPh: rnd(0, TAU),
      kind: 0,
    });
  }

  function coinPiece(x, y, vx, vy, o = {}) {
    add({
      t: 0, x, y, vx, vy, g: 760, drag: 0.9,
      rot: rnd(-0.5, 0.5), vr: rnd(-2, 2),
      ph: rnd(0, TAU), vph: rnd(5, 10),
      r: rnd(11, 17), ttl: (o.ttl ?? rnd(2.6, 4)) * lifeK, kind: 1,
      sway: 0, swayPh: 0,
    });
  }

  function starPiece(x, y, vx, vy, pal, o = {}) {
    add({
      t: 0, x, y, vx, vy, g: o.g ?? 60, drag: 2.2,
      rot: rnd(0, TAU), vr: rnd(-2, 2),
      r: rnd(9, 22), c: pal[(Math.random() * pal.length) | 0],
      ttl: (o.ttl ?? rnd(0.8, 1.6)) * lifeK, kind: 2, sway: 0, swayPh: 0,
    });
  }

  function burst(kind, x, y, o = {}) {
    resize();
    lifeK = o.life ?? 1;
    const pal = PALETTES[kind] || PALETTES.sticker;
    const k = o.scale ?? 1;
    const up = -Math.PI / 2;
    const conf = Math.round((kind === 'sponsor' ? 110 : kind === 'rare' ? 56 : 44) * k);
    for (let i = 0; i < conf; i++) {
      const a = up + rnd(-1.15, 1.15);
      const sp = rnd(380, kind === 'sponsor' ? 980 : 780);
      confettiPiece(x + rnd(-30, 30), y, Math.cos(a) * sp, Math.sin(a) * sp, pal);
    }
    if (kind === 'sponsor') {
      for (let i = 0; i < Math.round(26 * k); i++) {
        const a = up + rnd(-1.0, 1.0);
        const sp = rnd(420, 900);
        coinPiece(x + rnd(-20, 20), y, Math.cos(a) * sp, Math.sin(a) * sp);
      }
    }
    const stars = Math.round((kind === 'sponsor' ? 30 : kind === 'rare' ? 34 : 12) * k);
    const spal = kind === 'sticker' ? ['#fff7d6', '#ffe08a'] : ['#ffffff', '#fff2b8', '#e6f7ff', ...pal.slice(0, 2)];
    for (let i = 0; i < stars; i++) {
      const a = rnd(0, TAU);
      const sp = rnd(60, 420);
      starPiece(x + Math.cos(a) * rnd(0, 40), y + Math.sin(a) * rnd(0, 30), Math.cos(a) * sp, Math.sin(a) * sp - 80, spal);
    }
    lifeK = 1;
    kick();
  }

  /** 画面上部から降らせる（一定時間） */
  function rain(kind, ms = 1400, o = {}) {
    resize();
    rains.push({ kind, left: ms / 1000, rate: o.rate ?? (kind === 'sponsor' ? 70 : 38), acc: 0 });
    kick();
  }

  function stepRain(dt) {
    for (let i = rains.length - 1; i >= 0; i--) {
      const r = rains[i];
      r.left -= dt;
      r.acc += dt * r.rate;
      const pal = PALETTES[r.kind] || PALETTES.sticker;
      while (r.acc >= 1) {
        r.acc -= 1;
        const x = rnd(0, W);
        if (r.kind === 'sponsor' && Math.random() < 0.22) coinPiece(x, -20, rnd(-60, 60), rnd(80, 220));
        else if (r.kind === 'rare' && Math.random() < 0.4) starPiece(x, rnd(-10, H * 0.5), 0, rnd(30, 90), ['#ffffff', '#e6f7ff', '#fff2b8'], { ttl: 1.2, g: 0 });
        else confettiPiece(x, -20, rnd(-70, 70), rnd(120, 320), pal, { g: 260, drag: 1.2, ttl: 5 });
      }
      if (r.left <= 0) rains.splice(i, 1);
    }
  }

  function drawStar(x, y, r, rot) {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const rr = i % 2 === 0 ? r : r * 0.22;
      const a = rot + (i * Math.PI) / 4;
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  }

  function draw() {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const life = p.t / p.ttl;
      const fade = life > 0.75 ? Math.max(0, 1 - (life - 0.75) / 0.25) : 1;
      if (p.kind === 0) {
        const flip = Math.cos(p.ph);
        g.setTransform(dpr * Math.cos(p.rot), dpr * Math.sin(p.rot), -dpr * Math.sin(p.rot) * flip, dpr * Math.cos(p.rot) * flip, p.x * dpr, p.y * dpr);
        g.globalAlpha = fade;
        // 面の向きで明るさを変える（3D感）
        g.fillStyle = p.c;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        if (flip < 0) {
          g.fillStyle = 'rgba(0,0,0,0.18)';
          g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
      } else if (p.kind === 1) {
        const f = Math.abs(Math.cos(p.ph));
        const rx = Math.max(1.2, p.r * f);
        g.setTransform(dpr, 0, 0, dpr, p.x * dpr, p.y * dpr);
        g.rotate(p.rot);
        g.globalAlpha = fade;
        g.fillStyle = '#b8860b';
        g.beginPath(); g.ellipse(0, 0, rx + 1.6, p.r + 1.6, 0, 0, TAU); g.fill();
        g.fillStyle = f > 0.5 ? '#ffd23f' : '#e0a81c';
        g.beginPath(); g.ellipse(0, 0, rx, p.r, 0, 0, TAU); g.fill();
        if (rx > 5) {
          g.fillStyle = '#fff0a0';
          g.beginPath(); g.ellipse(0, 0, rx * 0.62, p.r * 0.62, 0, 0, TAU); g.fill();
          g.fillStyle = '#e0a81c';
          g.beginPath(); g.ellipse(0, 0, rx * 0.28, p.r * 0.28, 0, 0, TAU); g.fill();
        }
      } else {
        const s = Math.max(0, Math.sin(Math.PI * Math.min(1, life))); // ふくらんで消える
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = Math.min(1, s * 1.4);
        g.fillStyle = p.c;
        drawStar(p.x, p.y, p.r * (0.4 + 0.8 * s), p.rot);
        g.globalAlpha = Math.min(1, s * 1.4) * 0.35;
        g.beginPath(); g.arc(p.x, p.y, p.r * 0.9 * s, 0, TAU); g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.04, (now - last) / 1000 || 0.016);
    last = now;
    stepRain(dt);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dt;
      p.vy += p.g * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= p.kind === 0 ? Math.exp(-0.9 * dt) : d;
      p.x += p.vx * dt + (p.sway ? Math.sin(p.t * 3 + p.swayPh) * p.sway : 0);
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.vph) p.ph += p.vph * dt;
      if (p.t >= p.ttl || p.y > H + 40) parts.splice(i, 1);
    }
    draw();
    if (parts.length || rains.length) raf = requestAnimationFrame(frame);
    else g.clearRect(0, 0, canvas.width, canvas.height);
  }

  function kick() {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function clear() {
    parts.length = 0;
    rains.length = 0;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
  }

  function destroy() {
    clear();
    canvas.remove();
  }

  return { burst, rain, clear, destroy, resize, get count() { return parts.length; } };
}

export default createConfetti;
