/* YoSoro! お宝ガチャ — 背景シーン（青空・雲・波・カモメ）
 * createScene(bgEl) → { setMood('idle'|'celebrate'|'calm'), destroy() }
 * 動きはすべて CSS の transform/opacity アニメーション（常駐JSなし）。タブ非表示時は停止。 */

const SVGNS = 'http://www.w3.org/2000/svg';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ふわふわの雲（円の集合） */
function cloudSVG(seed, w = 260, h = 110) {
  const r = mulberry(seed);
  const baseY = h * 0.72;
  let top = '';
  let shade = '';
  const n = 6 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const cx = w * (0.14 + 0.72 * t) + (r() - 0.5) * 10;
    const hump = Math.sin(Math.PI * t);
    const rad = 16 + hump * (22 + r() * 14);
    const cy = baseY - rad * 0.55 - hump * 6;
    top += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}"/>`;
    shade += `<circle cx="${cx.toFixed(1)}" cy="${(cy + rad * 0.28).toFixed(1)}" r="${(rad * 0.96).toFixed(1)}"/>`;
  }
  const flat = `<rect x="${w * 0.1}" y="${baseY - 22}" width="${w * 0.8}" height="26" rx="13"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">
    <g fill="#bfe0f0" opacity=".9">${shade}<rect x="${w * 0.1}" y="${baseY - 18}" width="${w * 0.8}" height="26" rx="13"/></g>
    <g fill="#ffffff">${top}${flat}</g>
  </svg>`;
}

/** 波（横方向に継ぎ目なくループ。前半＝後半） */
function wavePath(vbW, vbH, amp, periodsPerHalf, baseline) {
  const half = vbW / 2;
  const seg = half / (periodsPerHalf * 2); // 山または谷1つ分
  let d = `M0 ${baseline}`;
  const segs = periodsPerHalf * 4;
  d += ` q ${seg / 2} ${-amp * 2} ${seg} 0`;
  for (let i = 1; i < segs; i++) d += ` t ${seg} 0`;
  d += ` V ${vbH} H0 Z`;
  return d;
}

function waveSVG({ amp, periods, fill, foam, baseline = 14, h = 120 }) {
  const vbW = 1200;
  const d = wavePath(vbW, h, amp, periods, baseline);
  const crest = d.replace(/ V .*$/, '');
  return `<svg viewBox="0 0 ${vbW} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path d="${d}" fill="${fill}"/>
    ${foam ? `<path d="${crest}" fill="none" stroke="rgba(255,255,255,${foam})" stroke-width="3" stroke-linecap="round"/>` : ''}
  </svg>`;
}

const SHIP = `<svg viewBox="0 0 140 100" width="140" height="100" aria-hidden="true" focusable="false">
  <g fill="#7fb2c9">
    <path d="M10 70 H130 L118 88 Q70 96 22 88 Z"/>
    <rect x="68" y="8" width="3" height="64"/>
    <rect x="34" y="22" width="3" height="48"/>
    <rect x="102" y="26" width="3" height="44"/>
    <path d="M71 12 Q98 30 71 66 Z"/>
    <path d="M66 12 Q42 30 66 66 Z"/>
    <path d="M37 26 Q56 40 37 66 Z"/>
    <path d="M105 30 Q122 42 105 66 Z"/>
    <path d="M130 70 L146 62 L120 66 Z"/>
  </g>
</svg>`;

const LIGHTHOUSE = `<svg viewBox="0 0 200 150" width="200" height="150" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="ygLhGlow"><stop offset="0" stop-color="#fff6c8" stop-opacity=".95"/><stop offset="1" stop-color="#fff6c8" stop-opacity="0"/></radialGradient>
  </defs>
  <path d="M0 150 Q10 108 52 104 Q70 92 112 100 Q160 96 176 128 L200 150 Z" fill="#7fae8f" opacity=".9"/>
  <path d="M30 150 Q44 120 80 116 Q120 112 150 130 L170 150 Z" fill="#6a9d7d" opacity=".9"/>
  <path d="M96 38 H124 L130 106 H90 Z" fill="#f4f8fb"/>
  <path d="M93.5 64 H126.5 L127.5 78 H92.5 Z" fill="#d7625a"/>
  <path d="M91 92 H129 L130 106 H90 Z" fill="#d7625a"/>
  <rect x="94" y="26" width="32" height="14" rx="3" fill="#6b7f8a"/>
  <rect x="99" y="28" width="22" height="10" fill="#ffe9a0"/>
  <path d="M92 26 L110 8 L128 26 Z" fill="#c0504d"/>
  <circle cx="110" cy="33" r="34" fill="url(#ygLhGlow)" class="yg-lh-glow"/>
</svg>`;

export function createScene(bgEl) {
  if (!bgEl) return { setMood() {}, destroy() {} };
  bgEl.classList.add('yg-scene');
  bgEl.setAttribute('data-mood', 'idle');
  bgEl.setAttribute('aria-hidden', 'true');

  /* ---- 雲 ---- */
  const clouds = [
    // [seed, top%, scale, duration(s), delay(s), opacity]
    [3, 6, 1.25, 210, -70, 0.95],
    [11, 15, 0.8, 300, -210, 0.7],
    [21, 24, 1.05, 240, -150, 0.9],
    [34, 34, 0.6, 360, -40, 0.6],
    [47, 9, 0.7, 330, -280, 0.75],
    [58, 42, 0.9, 280, -100, 0.8],
    [66, 28, 1.4, 190, -20, 0.95],
  ]
    .map(
      ([seed, top, sc, dur, delay, op]) =>
        `<div class="yg-cloud" style="top:${top}%;--sc:${sc};--dur:${dur}s;--delay:${delay}s;opacity:${op}">${cloudSVG(seed)}</div>`
    )
    .join('');

  /* ---- 波 ---- */
  const waves = [
    { top: 0, amp: 5, periods: 3, fill: '#82cfe4', foam: 0.55, dur: 46, bob: 7 },
    { top: 8, amp: 7, periods: 2, fill: '#62bcd9', foam: 0.5, dur: 36, bob: 6 },
    { top: 18, amp: 10, periods: 2, fill: '#3b9cc2', foam: 0.45, dur: 28, bob: 5.2 },
    { top: 30, amp: 14, periods: 1, fill: '#237fa7', foam: 0.4, dur: 22, bob: 4.6, last: true },
  ]
    .map(
      (w, i) => `<div class="yg-wave yg-wave-${i}" style="--top:${w.top}%;--dur:${w.dur}s;--bob:${w.bob}s;--fill:${w.fill}">
        <div class="yg-wave-slide">${waveSVG({ amp: w.amp, periods: w.periods, fill: w.fill, foam: w.foam, baseline: 24 })}<div class="yg-wave-body${w.last ? ' is-last' : ''}"></div></div>
      </div>`
    )
    .join('');

  /* ---- 水面のきらめき ---- */
  const rg = mulberry(7);
  let glints = '';
  for (let i = 0; i < 18; i++) {
    const x = (rg() * 100).toFixed(1);
    const y = (2 + rg() * 30).toFixed(1);
    const w = (14 + rg() * 26).toFixed(0);
    const d = (2.4 + rg() * 3.2).toFixed(2);
    const dl = (-rg() * 6).toFixed(2);
    glints += `<i class="yg-glint" style="left:${x}%;top:${y}%;width:${w}px;--d:${d}s;animation-delay:${dl}s"></i>`;
  }

  bgEl.innerHTML = `
    <div class="yg-sky"></div>
    <div class="yg-sun"></div>
    <div class="yg-sunrays"></div>
    <div class="yg-clouds">${clouds}</div>
    <div class="yg-far">
      <div class="yg-lighthouse">${LIGHTHOUSE}</div>
      <div class="yg-ship"><div class="yg-ship-bob">${SHIP}</div></div>
    </div>
    <div class="yg-haze"></div>
    <div class="yg-sea">
      ${waves}
      <div class="yg-glints">${glints}</div>
    </div>
    <div class="yg-mood yg-mood-warm"></div>
    <div class="yg-mood yg-mood-calm"></div>
    <div class="yg-gulls"></div>`;

  const gulls = bgEl.querySelector('.yg-gulls');

  /* ---- カモメ ---- */
  let gullTimer = 0;
  let destroyed = false;
  function flyGull() {
    if (destroyed) return;
    if (!document.hidden && gulls && typeof gulls.animate === 'function') {
      const el = document.createElement('div');
      el.className = 'yg-gull';
      const flip = Math.random() < 0.5;
      const s = 0.8 + Math.random() * 0.8;
      el.innerHTML = `<svg viewBox="0 0 44 22" width="44" height="22" aria-hidden="true" focusable="false">
        <path fill="none" stroke="#4a6b7c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M2 14 Q12 2 22 12 Q32 2 42 14">
          <animate attributeName="d" dur="${(0.7 + Math.random() * 0.3).toFixed(2)}s" repeatCount="indefinite"
            values="M2 14 Q12 2 22 12 Q32 2 42 14;M2 8 Q12 14 22 12 Q32 14 42 8;M2 14 Q12 2 22 12 Q32 2 42 14"/>
        </path></svg>`;
      gulls.appendChild(el);
      const y0 = 8 + Math.random() * 30; // vh
      const dur = 16000 + Math.random() * 10000;
      const k = [];
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = flip ? 110 - t * 125 : -12 + t * 125;
        const y = y0 + Math.sin(t * Math.PI * 2 + Math.random()) * 3 - t * 4;
        k.push({ transform: `translate(${x}vw, ${y}vh) scale(${flip ? -s : s}, ${s})`, offset: t });
      }
      const a = el.animate(k, { duration: dur, easing: 'linear' });
      a.onfinish = () => el.remove();
      a.oncancel = () => el.remove();
    }
    gullTimer = setTimeout(flyGull, 14000 + Math.random() * 18000);
  }
  gullTimer = setTimeout(flyGull, 3500);

  /* ---- タブ非表示で停止（CPU/電池） ---- */
  const onVis = () => bgEl.classList.toggle('yg-paused', document.hidden);
  document.addEventListener('visibilitychange', onVis);

  return {
    setMood(mood) {
      const m = mood === 'celebrate' || mood === 'calm' ? mood : 'idle';
      bgEl.setAttribute('data-mood', m);
    },
    destroy() {
      destroyed = true;
      clearTimeout(gullTimer);
      document.removeEventListener('visibilitychange', onVis);
      bgEl.innerHTML = '';
    },
  };
}

export default createScene;
