/* YoSoro! お宝ガチャ — ガチャ機（宝船の操舵台）・舵輪・開封演出・結果カード
 * 契約は docs/DESIGN.md §9.1。DB・抽選ロジックには一切触れない。
 *
 * createStage(stageEl, { sound, reducedMotion, onMood? }) → {
 *   setInteractive, onTurn, startSpin, abort, playReveal, showResultStatic,
 *   resultActionsEl, reset, setAttract,
 *   // 追加（任意）: setReducedMotion(b), destroy(), get state
 * }
 * 演出まわりの追加フック: 演出中に 'celebrate' / 'idle' の背景ムードを
 *   opts.onMood(mood) と stageEl への CustomEvent('yg-mood', {detail:{mood}}) で通知する。 */

import { createConfetti } from './confetti.js';

/* ================================================================
 * 定数・ユーティリティ
 * ================================================================ */
const MW = 600; // 機械の設計座標（px）
const MH = 905;
const WCX = 300; // 舵輪の中心
const WCY = 586;
const WR = 172; // 舵輪SVGの半径（持ち手の先端まで）
const BW = 420; // 演出用の宝箱の基準サイズ
const BH = Math.round((BW * 170) / 200);
const TURN_DEG = 120;
const DETENT = 45;
const TAU = Math.PI * 2;
const ABORT = Symbol('abort');

let UID = 0;
const nextId = () => `yg${++UID}`;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const f1 = (n) => (Math.round(n * 10) / 10).toString();
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${f1(x0)} ${f1(y0)} A${r} ${r} 0 ${large} ${sweep} ${f1(x1)} ${f1(y1)}`;
}
function hexMix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================================================================
 * 宝箱（SVG 200x170）。パレット違いで 木 / 金 / 銀 / カプセル色 を作る
 * ================================================================ */
const BRASS = ['#f8e2a6', '#d5ad59', '#8f6d25'];
const PAL = {
  wood: { bHi: '#b98258', bMid: '#8f5e3d', bLo: '#64401f', lHi: '#c9935f', lMid: '#9d6841', lLo: '#744a2b', band: BRASS, line: 'rgba(45,22,8,.42)', inner: '#2d170b', glow: '#ffd98a' },
  gold: { bHi: '#fff1b0', bMid: '#f2bb3a', bLo: '#b97a14', lHi: '#fff6c4', lMid: '#f7cb52', lLo: '#c78a1b', band: ['#fffbe6', '#ffe08a', '#b7791a'], line: 'rgba(130,75,0,.38)', inner: '#6a3b05', glow: '#fff2b8', gem: '#e0305a' },
  silver: { bHi: '#f6fcff', bMid: '#a8d7ee', bLo: '#6797bd', lHi: '#ffffff', lMid: '#bfe4f6', lLo: '#7fb0cf', band: ['#ffffff', '#cde8f5', '#7aa2bd'], line: 'rgba(30,70,100,.30)', inner: '#16415a', glow: '#e6f7ff', gem: '#6c7cff', holo: true },
};
function paint(c) {
  return {
    bHi: hexMix(c, '#ffffff', 0.28), bMid: c, bLo: hexMix(c, '#000000', 0.34),
    lHi: hexMix(c, '#ffffff', 0.38), lMid: hexMix(c, '#ffffff', 0.08), lLo: hexMix(c, '#000000', 0.26),
    band: BRASS, line: 'rgba(30,14,6,.42)', inner: '#2d170b', glow: '#ffd98a',
  };
}
const CAPSULE_COLORS = [
  PAL.wood, paint('#d9534f'), paint('#3d86d6'), paint('#3aa66a'), paint('#f0b93a'),
  paint('#8e63c7'), paint('#26aeb0'), paint('#ee8a3c'), paint('#e96aa0'), PAL.wood,
];

const ARCH = 'M14 92 L14 64 Q14 22 100 22 Q186 22 186 64 L186 92 Z';
const FRONT = 'M14 90 H186 V152 Q186 160 178 160 H22 Q14 160 14 152 Z';
const STAR4 = (x, y, r) => `M${x} ${y - r} Q${x + r * 0.16} ${y - r * 0.16} ${x + r} ${y} Q${x + r * 0.16} ${y + r * 0.16} ${x} ${y + r} Q${x - r * 0.16} ${y + r * 0.16} ${x - r} ${y} Q${x - r * 0.16} ${y - r * 0.16} ${x} ${y - r} Z`;

/** @returns {{defs:string, base:string, lid:string, lidIn:string}} */
function chestParts(id, p) {
  const grad = (name, stops, x2 = 0, y2 = 1) =>
    `<linearGradient id="${id}${name}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops
      .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`)
      .join('')}</linearGradient>`;
  const defs =
    grad('b', [[0, p.bHi], [0.5, p.bMid], [1, p.bLo]]) +
    grad('l', [[0, p.lHi], [0.45, p.lMid], [1, p.lLo]]) +
    grad('h', [[0, p.band[0]], [0.5, p.band[1]], [1, p.band[2]]]) +
    grad('v', [[0, p.band[2]], [0.28, p.band[0]], [0.62, p.band[1]], [1, p.band[2]]], 1, 0) +
    `<radialGradient id="${id}r" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fffbe8"/><stop offset=".55" stop-color="${p.band[1]}"/><stop offset="1" stop-color="${p.band[2]}"/></radialGradient>` +
    `<radialGradient id="${id}in" cx=".5" cy="1" r="1"><stop offset="0" stop-color="${p.glow}"/><stop offset=".6" stop-color="${p.inner}"/><stop offset="1" stop-color="${p.inner}"/></radialGradient>` +
    `<clipPath id="${id}ca"><path d="${ARCH}"/></clipPath><clipPath id="${id}cb"><path d="${FRONT}"/></clipPath>` +
    (p.holo
      ? `<linearGradient id="${id}ho" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="70" y2="0" gradientTransform="rotate(30)" spreadMethod="repeat">
          <stop offset="0" stop-color="#ff9ad5"/><stop offset=".25" stop-color="#ffe9a0"/><stop offset=".5" stop-color="#8dffe6"/><stop offset=".75" stop-color="#9ab6ff"/><stop offset="1" stop-color="#ff9ad5"/></linearGradient>`
      : '');

  const rivet = (x, y, r = 2.6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id}r)" stroke="rgba(60,40,8,.55)" stroke-width=".6"/>`;
  const holo = (clip) => (p.holo ? `<g clip-path="url(#${id}${clip})"><g class="yg-holo"><rect x="-140" y="-80" width="480" height="300" fill="url(#${id}ho)" opacity=".5"/></g></g>` : '');
  const glints = p.holo || p.gem ? `<path class="yg-twk" d="${STAR4(48, 118, 8)}" fill="#fff"/><path class="yg-twk yg-twk2" d="${STAR4(158, 140, 6)}" fill="#fff"/>` : '';

  const base = `
    <ellipse cx="100" cy="164" rx="86" ry="6" fill="rgba(10,40,60,.28)"/>
    <ellipse cx="100" cy="91" rx="81" ry="10" fill="${p.inner}"/>
    <ellipse class="yg-int-glow" cx="100" cy="90" rx="74" ry="8" fill="${p.glow}"/>
    <g>
      <circle cx="58" cy="88" r="8" fill="#ffd23f" stroke="#b8860b" stroke-width="1.4"/>
      <circle cx="80" cy="85" r="9" fill="#ffe27a" stroke="#b8860b" stroke-width="1.4"/>
      <circle cx="104" cy="86" r="9" fill="#ffd23f" stroke="#b8860b" stroke-width="1.4"/>
      <circle cx="126" cy="88" r="8" fill="#ffe27a" stroke="#b8860b" stroke-width="1.4"/>
      <circle cx="92" cy="91" r="6" fill="#ff7a8a" stroke="#a02b45" stroke-width="1"/>
    </g>
    <path d="${FRONT}" fill="url(#${id}b)"/>
    <g clip-path="url(#${id}cb)">
      <path d="M14 112 H186 M14 134 H186" stroke="${p.line}" stroke-width="2"/>
      <path d="M20 101 C60 99 110 104 180 100 M20 123 C70 126 120 120 180 124 M20 146 C60 143 120 149 180 145" stroke="${p.line}" stroke-width="1" fill="none" opacity=".7"/>
      <path d="M14 91 H186" stroke="rgba(255,255,255,.35)" stroke-width="3"/>
      <rect x="32" y="90" width="18" height="70" fill="url(#${id}v)"/>
      <rect x="150" y="90" width="18" height="70" fill="url(#${id}v)"/>
      <rect x="10" y="148" width="180" height="14" fill="url(#${id}h)"/>
      <path d="M10 148 H190" stroke="rgba(60,40,8,.5)" stroke-width="1"/>
      ${holo('cb')}
    </g>
    ${rivet(41, 100)}${rivet(41, 135)}${rivet(159, 100)}${rivet(159, 135)}
    ${rivet(24, 155, 2.2)}${rivet(70, 155, 2.2)}${rivet(130, 155, 2.2)}${rivet(176, 155, 2.2)}
    <rect x="85" y="94" width="30" height="36" rx="6" fill="url(#${id}h)" stroke="rgba(80,55,10,.6)" stroke-width="1.4"/>
    <circle cx="100" cy="108" r="5.4" fill="${p.gem || '#3a2410'}" stroke="rgba(60,40,8,.7)" stroke-width="1"/>
    <path d="M98 108 H102 L103 120 H97 Z" fill="#2b1808"/>
    ${glints}`;

  const lid = `
    <path d="${ARCH}" fill="url(#${id}l)"/>
    <g clip-path="url(#${id}ca)">
      <path d="M14 72 Q14 36 100 36 Q186 36 186 72 M14 56 Q16 28 100 28 Q184 28 186 56" stroke="${p.line}" stroke-width="1.6" fill="none" opacity=".8"/>
      <path d="M14 82 H186" stroke="${p.line}" stroke-width="1.6"/>
      <rect x="32" y="10" width="18" height="90" fill="url(#${id}v)"/>
      <rect x="150" y="10" width="18" height="90" fill="url(#${id}v)"/>
      <rect x="10" y="84" width="180" height="11" fill="url(#${id}h)"/>
      <path d="M10 84 H190" stroke="rgba(255,255,255,.4)" stroke-width="1.2"/>
      <path d="M10 95 H190" stroke="rgba(60,40,8,.45)" stroke-width="1.2"/>
      <ellipse cx="62" cy="44" rx="34" ry="7" transform="rotate(-14 62 44)" fill="rgba(255,255,255,.26)"/>
      ${holo('ca')}
    </g>
    ${rivet(41, 66)}${rivet(159, 66)}${rivet(41, 89, 2.2)}${rivet(159, 89, 2.2)}
    <path d="M90 82 H110 V102 Q110 108 104 108 H96 Q90 108 90 102 Z" fill="url(#${id}h)" stroke="rgba(80,55,10,.6)" stroke-width="1.2"/>
    <circle cx="100" cy="97" r="3" fill="rgba(60,40,8,.55)"/>`;

  const lidIn = `
    <path d="${ARCH}" fill="url(#${id}in)"/>
    <path d="M14 92 L14 64 Q14 22 100 22 Q186 22 186 64 L186 92" fill="none" stroke="url(#${id}h)" stroke-width="7" stroke-linejoin="round"/>`;

  return { defs, base, lid, lidIn };
}

/** カプセル用シンボル群（機械内の隠しSVGに入れる） */
function capsuleDefs(prefix) {
  let defs = '';
  let syms = '';
  CAPSULE_COLORS.forEach((p, i) => {
    const id = `${prefix}c${i}`;
    const c = chestParts(id, p);
    defs += c.defs;
    syms += `<symbol id="${prefix}cap${i}" viewBox="0 0 200 170">${c.base}${c.lid}</symbol>`;
  });
  return `<defs>${defs}${syms}</defs>`;
}

/** 演出用の宝箱 1レイヤー（base / lid / lid内側 を別DOMにして lid を3D回転） */
function chestLayerHTML(variant, pal) {
  const id = nextId();
  const c = chestParts(id, pal);
  const svg = (inner) => `<svg viewBox="0 0 200 170" aria-hidden="true" focusable="false"><defs>${c.defs}</defs>${inner}</svg>`;
  return `<div class="yg-ch" data-v="${variant}">
    <div class="yg-ch-base">${svg(c.base)}</div>
    <div class="yg-ch-lid">
      <div class="yg-face yg-fc-out">${svg(c.lid)}</div>
      <div class="yg-face yg-fc-in">${svg(c.lidIn)}</div>
    </div>
  </div>`;
}

/* ================================================================
 * ガチャ機本体の SVG
 * ================================================================ */
function ropeLine(x1, y1, x2, y2, step = 15) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.floor(len / step);
  const dx = (x2 - x1) / n;
  const dy = (y2 - y1) / n;
  let s = `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#8d6d3a" stroke-width="9.5" stroke-linecap="round"/>`;
  for (let i = 0; i <= n; i++) {
    s += `<rect x="-8.5" y="-4.4" width="17" height="8.8" rx="4.4" transform="translate(${f1(x1 + dx * i)} ${f1(y1 + dy * i)}) rotate(-24)" fill="#ecd9a8" stroke="#9c7b45" stroke-width="1"/>`;
  }
  return s;
}

function anchorGlyph(color, shadow, w = 3.4) {
  const p = `<circle cx="0" cy="-16" r="4.2" fill="none"/><path d="M0 -12 V15 M-8 -8 H8 M-15 3 Q-13 15 0 16 Q13 15 15 3" fill="none"/><path d="M-15 3 L-19 8 M-15 3 L-10.5 6.5 M15 3 L19 8 M15 3 L10.5 6.5" fill="none"/>`;
  return `<g stroke="${shadow}" stroke-width="${w + 1.6}" stroke-linecap="round" stroke-linejoin="round" transform="translate(1 1.6)">${p}</g><g stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</g>`;
}

function bodySVG() {
  const body = 'M96 430 H504 Q512 430 514 440 L532 740 Q533 748 525 748 H75 Q67 748 68 740 L86 440 Q88 430 96 430 Z';
  let ticks = '';
  for (let a = 0; a < 360; a += 7.5) {
    const major = a % 45 === 0;
    const [x0, y0] = polar(WCX, WCY, major ? 121 : 126, a);
    const [x1, y1] = polar(WCX, WCY, 133, a);
    ticks += `M${f1(x0)} ${f1(y0)} L${f1(x1)} ${f1(y1)} `;
  }
  let star = '';
  for (let i = 0; i < 16; i++) {
    const [x, y] = polar(WCX, WCY, i % 2 === 0 ? (i % 4 === 0 ? 118 : 90) : 30, i * 22.5 - 90);
    star += `${i ? 'L' : 'M'}${f1(x)} ${f1(y)} `;
  }
  let studs = '';
  for (let a = 0; a < 360; a += 22.5) {
    const [x, y] = polar(WCX, WCY, 146, a);
    studs += `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.4" fill="url(#ygRivet)" stroke="rgba(60,40,8,.6)" stroke-width=".8"/>`;
  }
  let portRivets = '';
  [[230, 790], [230, 774], [236, 766], [370, 790], [370, 774], [364, 766]].forEach(([x, y]) => {
    portRivets += `<circle cx="${x}" cy="${y}" r="2.6" fill="url(#ygRivet)" stroke="rgba(60,40,8,.6)" stroke-width=".7"/>`;
  });
  let railRivets = '';
  for (let x = 80; x <= 520; x += 40) railRivets += `<circle cx="${x}" cy="753" r="2.6" fill="url(#ygRivet)" stroke="rgba(60,40,8,.6)" stroke-width=".7"/>`;

  return `<svg class="yg-body" viewBox="0 0 ${MW} ${MH}" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="ygWoodH" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5f3b22"/><stop offset=".12" stop-color="#85563a"/><stop offset=".45" stop-color="#a77049"/>
      <stop offset=".62" stop-color="#9a6642"/><stop offset=".9" stop-color="#7d5036"/><stop offset="1" stop-color="#5a3620"/>
    </linearGradient>
    <linearGradient id="ygWoodDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a4e31"/><stop offset=".5" stop-color="#5f3b24"/><stop offset="1" stop-color="#4a2c19"/></linearGradient>
    <linearGradient id="ygBrassBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8e2a6"/><stop offset=".45" stop-color="#d5ad59"/><stop offset=".6" stop-color="#c39a45"/><stop offset="1" stop-color="#8f6d25"/></linearGradient>
    <linearGradient id="ygBrassV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe9b4"/><stop offset=".4" stop-color="#d5ad59"/><stop offset="1" stop-color="#8f6d25"/></linearGradient>
    <radialGradient id="ygRivet" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fffbe8"/><stop offset=".55" stop-color="#d5ad59"/><stop offset="1" stop-color="#8f6d25"/></radialGradient>
    <radialGradient id="ygNavy" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#2a86ad"/><stop offset=".6" stop-color="#145a7a"/><stop offset="1" stop-color="#0a3248"/></radialGradient>
    <linearGradient id="ygPort" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070f14"/><stop offset=".7" stop-color="#17262f"/><stop offset="1" stop-color="#2b414d"/></linearGradient>
    <radialGradient id="ygFloor" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="rgba(8,40,60,.4)"/><stop offset="1" stop-color="rgba(8,40,60,0)"/></radialGradient>
    <pattern id="ygGrain" width="140" height="46" patternUnits="userSpaceOnUse">
      <path d="M0 8 C30 4 70 12 140 7 M0 24 C40 28 90 18 140 25 M0 38 C30 34 80 41 140 37" stroke="rgba(45,22,8,.2)" fill="none" stroke-width="1.5"/>
      <path d="M0 16 C40 13 90 19 140 15 M0 31 C30 33 90 28 140 32" stroke="rgba(255,225,175,.13)" fill="none" stroke-width="1.3"/>
    </pattern>
    <clipPath id="ygBodyClip"><path d="${body}"/></clipPath>
  </defs>

  <!-- 接地影 -->
  <ellipse cx="300" cy="846" rx="290" ry="14" fill="url(#ygFloor)"/>

  <!-- 甲板（台座） -->
  <rect x="26" y="812" width="548" height="26" rx="12" fill="url(#ygWoodDark)"/>
  <rect x="26" y="812" width="548" height="5" rx="2.5" fill="url(#ygBrassV)"/>
  <rect x="26" y="812" width="548" height="26" rx="12" fill="url(#ygGrain)"/>
  <path d="M26 826 H574" stroke="rgba(0,0,0,.25)" stroke-width="1.5"/>

  <!-- 船体（大砲口の段） -->
  <path d="M60 748 H540 L552 814 H48 Z" fill="url(#ygWoodDark)"/>
  <path d="M60 748 H540 L552 814 H48 Z" fill="url(#ygGrain)"/>
  <path d="M57 768 H543 M53 790 H547" stroke="rgba(25,12,4,.5)" stroke-width="2.2"/>
  <path d="M57 770 H543 M53 792 H547" stroke="rgba(255,225,175,.14)" stroke-width="1.4"/>

  <!-- 大砲口（取り出し口） -->
  <path d="M214 810 V784 Q214 756 242 756 H358 Q386 756 386 784 V810 Z" fill="url(#ygBrassBody)"/>
  <path d="M226 808 V786 Q226 765 246 765 H354 Q374 765 374 786 V808 Z" fill="url(#ygPort)"/>
  <path d="M226 797 H374 V808 H226 Z" fill="rgba(255,255,255,.1)"/>
  <path d="M232 798 Q300 790 368 798" stroke="rgba(255,255,255,.18)" stroke-width="2" fill="none"/>
  <path d="M214 784 Q214 756 242 756 H358 Q386 756 386 784" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2"/>
  ${portRivets}
  <g transform="translate(138 787) scale(1.05)">${anchorGlyph('#e8c46f', '#4a3208', 3.6)}</g>
  <g transform="translate(462 787) scale(1.05)">${anchorGlyph('#e8c46f', '#4a3208', 3.6)}</g>

  <!-- 真鍮のレール -->
  <rect x="62" y="745" width="476" height="14" rx="5" fill="url(#ygBrassV)" stroke="rgba(80,55,10,.5)" stroke-width="1"/>
  ${railRivets}

  <!-- 本体（操舵台） -->
  <path d="${body}" fill="url(#ygWoodH)"/>
  <path d="${body}" fill="url(#ygGrain)"/>
  <g clip-path="url(#ygBodyClip)">
    <path d="M168 430 L160 748 M432 430 L440 748 M118 430 L108 748 M482 430 L492 748" stroke="rgba(30,14,5,.42)" stroke-width="2.4"/>
    <path d="M170 430 L162 748 M434 430 L442 748 M120 430 L110 748 M484 430 L494 748" stroke="rgba(255,225,175,.16)" stroke-width="1.4"/>
    <path d="M96 442 H504 L519 738 H81 Z" fill="none" stroke="rgba(255,230,190,.22)" stroke-width="2"/>
  </g>
  <path d="${body}" fill="none" stroke="rgba(40,18,6,.55)" stroke-width="3"/>

  <!-- 舵輪の台座（コンパス盤） -->
  <circle cx="${WCX}" cy="${WCY + 4}" r="154" fill="rgba(20,8,0,.34)"/>
  <circle cx="${WCX}" cy="${WCY}" r="150" fill="#4a2d1a"/>
  <circle cx="${WCX}" cy="${WCY}" r="146" fill="url(#ygNavy)" stroke="url(#ygBrassBody)" stroke-width="9"/>
  <circle cx="${WCX}" cy="${WCY}" r="136" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="3"/>
  <path d="${ticks}" stroke="rgba(255,236,190,.5)" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="${WCX}" cy="${WCY}" r="116" fill="none" stroke="rgba(255,236,190,.22)" stroke-width="1.5"/>
  <path d="${star}Z" fill="rgba(255,232,170,.2)" stroke="rgba(255,232,170,.36)" stroke-width="1.2"/>
  <circle cx="${WCX + 4}" cy="${WCY + 8}" r="97" fill="none" stroke="rgba(2,12,20,.4)" stroke-width="32"/>
  ${studs}

  <!-- ロープ -->
  <g>${ropeLine(94, 439, 506, 439)}</g>
  <g>${ropeLine(72, 741, 528, 741)}</g>

  <!-- 隅金具 -->
  ${[['translate(98 446)', ''], ['translate(502 446) scale(-1 1)', ''], ['translate(78 736) scale(1 -1)', ''], ['translate(522 736) scale(-1 -1)', '']]
    .map(
      ([t]) => `<g transform="${t}"><path d="M0 0 H38 Q42 0 42 4 V13 H13 V42 H4 Q0 42 0 38 Z" fill="url(#ygBrassBody)" stroke="rgba(80,55,10,.6)" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="url(#ygRivet)"/><circle cx="31" cy="7" r="2.6" fill="url(#ygRivet)"/><circle cx="7" cy="31" r="2.6" fill="url(#ygRivet)"/></g>`
    )
    .join('')}
</svg>`;
}

function frontSVG() {
  let rivets = '';
  for (let x = 124; x <= 476; x += 32) rivets += `<circle cx="${x}" cy="412" r="3.4" fill="url(#ygRivet)" stroke="rgba(60,40,8,.6)" stroke-width=".8"/>`;
  return `<svg class="yg-front" viewBox="0 0 ${MW} ${MH}" aria-hidden="true" focusable="false">
    <!-- ドームの襟（真鍮） -->
    <path d="M108 392 H492 Q501 392 501 402 V420 Q501 432 489 432 H111 Q99 432 99 420 V402 Q99 392 108 392 Z" fill="url(#ygBrassBody)" stroke="rgba(80,55,10,.6)" stroke-width="1.6"/>
    <path d="M104 399 H496" stroke="rgba(255,255,255,.6)" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M104 425 H496" stroke="rgba(80,55,10,.4)" stroke-width="2.4" stroke-linecap="round"/>
    ${rivets}
    <!-- 頂部の飾りと小旗 -->
    <ellipse cx="300" cy="62" rx="15" ry="5.5" fill="url(#ygBrassBody)" stroke="rgba(80,55,10,.6)" stroke-width="1"/>
    <rect x="298.4" y="6" width="3.2" height="52" rx="1.6" fill="url(#ygBrassV)"/>
    <circle cx="300" cy="52" r="8.5" fill="url(#ygRivet)" stroke="rgba(80,55,10,.6)" stroke-width="1"/>
    <g class="yg-flag">
      <path d="M301.6 9 Q336 3 374 16 Q336 30 301.6 28 Z" fill="#e0654a" stroke="#a6402b" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M303 17 Q336 12 366 17 Q336 22 303 21 Z" fill="rgba(255,255,255,.85)"/>
    </g>
  </svg>`;
}

function glassSVG() {
  const R = 175;
  // 左上の三日月ハイライト
  const [ox0, oy0] = polar(R, R, 158, 196);
  const [ox1, oy1] = polar(R, R, 158, 282);
  const [ix1, iy1] = polar(R, R, 140, 282);
  const [ix0, iy0] = polar(R, R, 140, 196);
  const cres = `M${f1(ox0)} ${f1(oy0)} A158 158 0 0 1 ${f1(ox1)} ${f1(oy1)} L${f1(ix1)} ${f1(iy1)} A140 140 0 0 0 ${f1(ix0)} ${f1(iy0)} Z`;
  return `<svg class="yg-glass" viewBox="0 0 350 350" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="ygCres" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".35" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity=".1"/></linearGradient>
      <radialGradient id="ygGlassEdge" cx=".5" cy=".5" r=".5"><stop offset=".86" stop-color="#bdeaff" stop-opacity="0"/><stop offset=".97" stop-color="#8fd6f2" stop-opacity=".5"/><stop offset="1" stop-color="#ffffff" stop-opacity=".75"/></radialGradient>
      <radialGradient id="ygGlassTint" cx=".4" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff" stop-opacity=".22"/><stop offset=".6" stop-color="#cdeefb" stop-opacity=".05"/><stop offset="1" stop-color="#4aa9cf" stop-opacity=".22"/></radialGradient>
    </defs>
    <circle cx="${R}" cy="${R}" r="${R}" fill="url(#ygGlassTint)"/>
    <circle cx="${R}" cy="${R}" r="${R}" fill="url(#ygGlassEdge)"/>
    <circle cx="${R}" cy="${R}" r="173" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2.4"/>
    <path d="${cres}" fill="url(#ygCres)"/>
    <ellipse cx="86" cy="86" rx="22" ry="9" transform="rotate(-42 86 86)" fill="rgba(255,255,255,.92)"/>
    <ellipse cx="116" cy="62" rx="6" ry="3.2" transform="rotate(-42 116 62)" fill="rgba(255,255,255,.8)"/>
    <path d="${arcPath(R, R, 160, -16, 34)}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="5" stroke-linecap="round"/>
    <path d="${arcPath(R, R, 164, 96, 150)}" fill="none" stroke="rgba(160,225,250,.55)" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
}

/* ================================================================
 * 舵輪（SVG 344x344 / 中心 0,0）
 * ================================================================ */
function wheelSVG() {
  const id = nextId();
  // 持ち手のプロファイル（中心からの距離 d, 半幅 w）
  const pts = [[20, 5.6], [60, 4.8], [100, 4.2], [108, 4.0], [112, 5.8], [117, 8.6], [121.5, 5.2], [126, 4.4], [131, 7.2], [139, 11], [147, 10.4], [153, 7.4], [157, 6.2], [160.5, 8.8], [164, 9.6], [167.6, 6.6], [169.6, 2.2]];
  const w = (d) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [d0, w0] = pts[i];
      const [d1, w1] = pts[i + 1];
      if (d >= d0 && d <= d1) {
        const t = (1 - Math.cos(((d - d0) / (d1 - d0)) * Math.PI)) / 2;
        return w0 + (w1 - w0) * t;
      }
    }
    return 2;
  };
  const right = [];
  const left = [];
  for (let d = 20; d <= 169.6; d += 1.6) {
    right.push(`${f1(w(d))} ${f1(-d)}`);
    left.push(`${f1(-w(d))} ${f1(-d)}`);
  }
  const spoke = `M${right.join(' L')} L${left.reverse().join(' L')} Z`;

  let spokes = '';
  let studs = '';
  let seams = '';
  for (let k = 0; k < 8; k++) {
    spokes += `<use href="#${id}s" transform="rotate(${k * 45})"/>`;
    const [x, y] = polar(0, 0, 96, k * 45 - 90);
    studs += `<circle cx="${f1(x)}" cy="${f1(y)}" r="6.2" fill="url(#${id}br)" stroke="rgba(60,40,8,.65)" stroke-width="1"/><circle cx="${f1(x - 1.6)}" cy="${f1(y - 1.8)}" r="1.8" fill="rgba(255,255,255,.75)"/>`;
    const [sx0, sy0] = polar(0, 0, 82, k * 45 + 22.5 - 90);
    const [sx1, sy1] = polar(0, 0, 110, k * 45 + 22.5 - 90);
    seams += `M${f1(sx0)} ${f1(sy0)} L${f1(sx1)} ${f1(sy1)} `;
  }
  let hubRivets = '';
  for (let k = 0; k < 8; k++) {
    const [x, y] = polar(0, 0, 29, k * 45 - 22.5);
    hubRivets += `<circle cx="${f1(x)}" cy="${f1(y)}" r="2.8" fill="url(#${id}br)" stroke="rgba(60,40,8,.65)" stroke-width=".8"/>`;
  }
  return `<svg viewBox="${-WR} ${-WR} ${WR * 2} ${WR * 2}" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${id}sg" gradientUnits="userSpaceOnUse" x1="-11" y1="0" x2="11" y2="0">
      <stop offset="0" stop-color="#4f301b"/><stop offset=".26" stop-color="#b3825a"/><stop offset=".48" stop-color="#d1a374"/><stop offset=".72" stop-color="#94643f"/><stop offset="1" stop-color="#4b2c19"/>
    </linearGradient>
    <radialGradient id="${id}rg" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="111">
      <stop offset=".72" stop-color="#5d3921"/><stop offset=".79" stop-color="#b98558"/><stop offset=".88" stop-color="#a06c45"/><stop offset=".96" stop-color="#7d5034"/><stop offset="1" stop-color="#4f2f1b"/>
    </radialGradient>
    <radialGradient id="${id}br" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#fffbe8"/><stop offset=".5" stop-color="#e2bb67"/><stop offset="1" stop-color="#8f6d25"/></radialGradient>
    <radialGradient id="${id}hub" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="#fff3c4"/><stop offset=".45" stop-color="#dcb35e"/><stop offset="1" stop-color="#8a6422"/></radialGradient>
    <radialGradient id="${id}hub2" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#f6dc9a"/><stop offset="1" stop-color="#b58a38"/></radialGradient>
    <path id="${id}s" d="${spoke}" fill="url(#${id}sg)" stroke="rgba(40,20,8,.55)" stroke-width="1"/>
  </defs>
  ${spokes}
  <!-- 王様スポーク（真っ直ぐ上）の飾り：真鍮リングと赤いトルコ結び -->
  <rect x="-13" y="-141.5" width="26" height="5.4" rx="2.7" fill="url(#${id}br)" stroke="rgba(60,40,8,.6)" stroke-width=".8"/>
  <rect x="-12" y="-150.5" width="24" height="6" rx="3" fill="#d9534f" stroke="rgba(90,20,20,.6)" stroke-width=".8"/>
  <path d="M-10 -148 H10" stroke="rgba(255,255,255,.4)" stroke-width="1.2"/>
  <!-- 真鍮のフェルール -->
  ${[...Array(8)].map((_, k) => `<g transform="rotate(${k * 45})"><rect x="-7" y="-117" width="14" height="5.5" rx="2" fill="url(#${id}br)" stroke="rgba(60,40,8,.6)" stroke-width=".8"/></g>`).join('')}
  <!-- リム -->
  <circle r="96" fill="none" stroke="url(#${id}rg)" stroke-width="30"/>
  <path d="${seams}" stroke="rgba(35,16,5,.55)" stroke-width="1.6"/>
  <circle r="104" fill="none" stroke="rgba(45,20,6,.28)" stroke-width="1.2" stroke-dasharray="46 9 20 7"/>
  <circle r="90" fill="none" stroke="rgba(255,225,175,.18)" stroke-width="1.2" stroke-dasharray="30 12 52 8"/>
  <circle r="81" fill="none" stroke="url(#${id}br)" stroke-width="3"/>
  <circle r="111" fill="none" stroke="rgba(40,18,6,.7)" stroke-width="1.6"/>
  <path d="${arcPath(0, 0, 103, -150, -112)}" fill="none" stroke="rgba(255,236,200,.5)" stroke-width="4" stroke-linecap="round"/>
  ${studs}
  <!-- ハブ -->
  <circle r="43" fill="rgba(10,4,0,.3)" transform="translate(3 4)"/>
  <circle r="42" fill="url(#${id}hub)" stroke="#6b4a12" stroke-width="2.4"/>
  <circle r="35" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.6"/>
  <circle r="34" fill="none" stroke="rgba(110,76,16,.5)" stroke-width="1.4"/>
  ${hubRivets}
  <circle r="21.5" fill="url(#${id}hub2)" stroke="#7d5a1a" stroke-width="2"/>
  <g transform="scale(.66) translate(0 1)">${anchorGlyph('#6b4a12', 'rgba(255,240,190,.7)', 3.4)}</g>
  <ellipse cx="-14" cy="-20" rx="14" ry="6" transform="rotate(-38 -14 -20)" fill="rgba(255,255,255,.5)"/>
</svg>`;
}

/* ================================================================
 * ヒント（回す方向を示す円弧矢印）
 * ================================================================ */
function hintSVG() {
  const r = 192;
  const a0 = -34;
  const a1 = 58;
  const d = arcPath(0, 0, r, a0, a1);
  const [ex, ey] = polar(0, 0, r, a1);
  // 先端の矢じり（接線方向＝時計回り）
  const t = ((a1 + 90) * Math.PI) / 180;
  const nx = Math.cos((a1 * Math.PI) / 180);
  const ny = Math.sin((a1 * Math.PI) / 180);
  const tipx = ex + Math.cos(t) * 20;
  const tipy = ey + Math.sin(t) * 20;
  const head = `M${f1(ex + nx * 15)} ${f1(ey + ny * 15)} L${f1(tipx)} ${f1(tipy)} L${f1(ex - nx * 15)} ${f1(ey - ny * 15)} Z`;
  return `<svg viewBox="-210 -210 420 420" aria-hidden="true" focusable="false">
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="${d}" fill="none" stroke="rgba(13,63,86,.55)" stroke-width="14"/>
      <path d="${head}" fill="rgba(13,63,86,.55)" stroke="rgba(13,63,86,.55)" stroke-width="6"/>
      <path d="${d}" fill="none" stroke="#fff" stroke-width="7" stroke-dasharray="2 14" class="yg-hint-dash"/>
      <path d="${head}" fill="#fff" stroke="#fff" stroke-width="2"/>
    </g>
  </svg>`;
}

/* ================================================================
 * カプセル（ドーム内の小さな宝箱）の簡易物理
 * ================================================================ */
function createCapsuleSim(container, prefix) {
  const R = 175;
  const rc = 24.5;
  const Rw = R - rc - 5;
  const floorY = 334 - rc + 7;
  const COUNT = 30;
  const ids = shuffle([...Array(COUNT)].map((_, i) => (i < 4 ? 0 : 1 + ((i - 4) % 8)))); // 0=木
  const caps = [];
  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'yg-cap';
    el.innerHTML = `<div class="yg-cap-in" style="animation-delay:${(-Math.random() * 4).toFixed(2)}s;animation-duration:${(2.6 + Math.random() * 1.6).toFixed(2)}s"><svg viewBox="0 0 200 170" aria-hidden="true" focusable="false"><use href="#${prefix}cap${ids[i]}"/></svg></div>`;
    container.appendChild(el);
    caps.push({
      el, kind: ids[i],
      x: R + rnd(-100, 100), y: R + rnd(10, 130), vx: 0, vy: 0,
      a: rnd(-40, 40), va: 0, hidden: false,
    });
  }
  let asleep = false;
  let calm = 0;
  let settleT = 0;

  function render() {
    for (const c of caps) {
      c.el.style.transform = `translate(${f1(c.x - 31)}px, ${f1(c.y - 26.5)}px) rotate(${f1(c.a)}deg)`;
    }
  }

  function step(dt, stir, dir) {
    if (asleep && stir <= 0) return false;
    asleep = false;
    const sub = 2;
    const h = dt / sub;
    let energy = 0;
    for (const c of caps) { c.px = c.x; c.py = c.y; }
    for (let s = 0; s < sub; s++) {
      for (const c of caps) {
        c.vy += 1800 * h;
        if (stir > 0) {
          const dx = c.x - R;
          const dy = c.y - R;
          const d = Math.hypot(dx, dy) || 1;
          // ゆるい回転流＋下から跳ね上げる（かき混ぜるイメージ。回しすぎると壁沿いに回るだけになるので弱め）
          c.vx += (-dy / d) * dir * stir * 160 * h;
          c.vy += (dx / d) * dir * stir * 160 * h;
          const low = clamp((c.y - 120) / 200, 0.15, 1); // 下にいるほど跳ねやすい
          if (Math.random() < stir * 0.07 * low) {
            c.vy -= rnd(520, 980) * stir;
            c.vx += rnd(-420, 420) * stir;
            c.va += rnd(-420, 420) * stir;
          }
        }
        c.x += c.vx * h;
        c.y += c.vy * h;
        c.a += c.va * h;
        const damp = 1 - (stir > 0 ? 0.5 : 1.0) * h;
        c.vx *= damp; c.vy *= damp;
        c.va *= 1 - 1.4 * h;
        // 壁
        const dx = c.x - R;
        const dy = c.y - R;
        const d = Math.hypot(dx, dy);
        if (d > Rw) {
          const nx = dx / d;
          const ny = dy / d;
          c.x = R + nx * Rw;
          c.y = R + ny * Rw;
          const vn = c.vx * nx + c.vy * ny;
          if (vn > 0) {
            c.vx -= 1.3 * vn * nx;
            c.vy -= 1.3 * vn * ny;
            const vt = -c.vx * ny + c.vy * nx;
            c.va += vt * 0.2;
            c.vx *= 0.985; c.vy *= 0.985;
          }
        }
        if (c.y > floorY) {
          c.y = floorY;
          if (c.vy > 0) c.vy *= -0.2;
          c.vx *= 0.96;
          c.va *= 0.92;
        }
      }
      // 衝突
      for (let i = 0; i < caps.length; i++) {
        const A = caps[i];
        if (A.hidden) continue;
        for (let j = i + 1; j < caps.length; j++) {
          const B = caps[j];
          if (B.hidden) continue;
          const dx = B.x - A.x;
          const dy = B.y - A.y;
          const dd = dx * dx + dy * dy;
          const min = rc * 2;
          if (dd < min * min && dd > 0.0001) {
            const d = Math.sqrt(dd);
            const nx = dx / d;
            const ny = dy / d;
            const ov = (min - d) * 0.5;
            A.x -= nx * ov; A.y -= ny * ov;
            B.x += nx * ov; B.y += ny * ov;
            const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
            if (rv < 0) {
              const j2 = -rv * 0.55;
              A.vx -= j2 * nx; A.vy -= j2 * ny;
              B.vx += j2 * nx; B.vy += j2 * ny;
              const tv = -(B.vx - A.vx) * ny + (B.vy - A.vy) * nx;
              A.va -= tv * 0.05; B.va += tv * 0.05;
            }
          }
        }
      }
    }
    for (const c of caps) energy += Math.abs(c.x - c.px) + Math.abs(c.y - c.py) + Math.abs(c.va) * 0.004;
    render();
    if (stir <= 0) {
      // 落ち着いたら（または一定時間たったら）スリープして rAF を止める
      calm = energy / caps.length < 0.3 ? calm + dt : calm;
      settleT += dt;
      if (calm > 0.4 || settleT > 2.2) {
        asleep = true;
        calm = 0;
        for (const c of caps) { c.vx = c.vy = c.va = 0; }
      }
    } else { calm = 0; settleT = 0; }
    return !asleep;
  }

  // 初期配置：見えない所で沈めておく
  for (let i = 0; i < 420; i++) step(1 / 60, 0, 1);
  for (const c of caps) { c.vx = c.vy = c.va = 0; }
  asleep = true;
  render();

  return {
    step,
    wake() { asleep = false; calm = 0; settleT = 0; },
    get active() { return !asleep; },
    /** 取り出し口に近い木のカプセルを1つ隠す（落ちた宝箱になる） */
    takeOne() {
      let best = null;
      for (const c of caps) {
        if (c.hidden || c.kind !== 0) continue;
        if (!best || c.y > best.y) best = c;
      }
      if (best) { best.hidden = true; best.el.classList.add('is-gone'); }
      return best;
    },
    restore() {
      for (const c of caps) if (c.hidden) { c.hidden = false; c.el.classList.remove('is-gone'); }
      this.wake();
    },
    caps,
  };
}

/* ================================================================
 * 結果カード用の小さな飾り
 * ================================================================ */
const TIER_ICON = {
  sponsor: '<svg viewBox="0 0 48 40" aria-hidden="true"><path d="M4 32 L8 10 L19 22 L24 6 L29 22 L40 10 L44 32 Z" fill="currentColor" stroke="rgba(60,30,0,.55)" stroke-width="2" stroke-linejoin="round"/><rect x="4" y="33" width="40" height="5" rx="2" fill="currentColor" stroke="rgba(60,30,0,.55)" stroke-width="1.6"/></svg>',
  rare: '<svg viewBox="0 0 48 44" aria-hidden="true"><path d="M24 3 L30 16 L44 17 L33 27 L37 41 L24 33 L11 41 L15 27 L4 17 L18 16 Z" fill="currentColor" stroke="rgba(10,50,80,.55)" stroke-width="2" stroke-linejoin="round"/></svg>',
  sticker: '<svg viewBox="0 0 48 48" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="10" r="4.4"/><path d="M24 15 V41 M15 22 H33 M7 28 Q9 40 24 41 Q39 40 41 28"/><path d="M7 28 L4 33 M7 28 L12 31 M41 28 L44 33 M41 28 L36 31"/></g></svg>',
};

/* ================================================================
 * createStage
 * ================================================================ */
export function createStage(stageEl, opts = {}) {
  const sound = opts.sound || { play() {}, unlock() {} };
  const fast = (() => {
    try { return new URLSearchParams(location.search).get('fast') === '1'; } catch (e) { return false; }
  })();
  let reducedBase = !!opts.reducedMotion || fast;
  const doc = stageEl.ownerDocument || document;
  const P = nextId();

  /* ---------- DOM ---------- */
  stageEl.classList.add('yg-host');
  const root = doc.createElement('div');
  root.className = 'yg-stage yg-attract';
  root.dataset.interactive = 'false';
  root.dataset.state = 'idle';
  if (reducedBase) root.classList.add('yg-reduced');
  root.innerHTML = `
    <svg class="yg-defs" width="0" height="0" aria-hidden="true" focusable="false">${capsuleDefs(P)}</svg>
    <div class="yg-machine">
      <div class="yg-shake">
        ${bodySVG()}
        <div class="yg-dome">
          <div class="yg-dome-in"><div class="yg-caps"></div></div>
          ${glassSVG()}
          <div class="yg-sheen"></div>
        </div>
        ${frontSVG()}
        <div class="yg-wheelwrap" data-testid="wheel" role="button" tabindex="-1" aria-label="舵輪を回す">
          <div class="yg-sway"><div class="yg-wheel">${wheelSVG()}</div></div>
        </div>
        <div class="yg-pawl" aria-hidden="true"><svg viewBox="0 0 30 40"><path d="M9 2 H21 L19 26 L15 36 L11 26 Z" fill="url(#ygBrassV)" stroke="rgba(80,55,10,.7)" stroke-width="1.2" stroke-linejoin="round"/><circle cx="15" cy="7" r="3.4" fill="url(#ygRivet)" stroke="rgba(60,40,8,.7)" stroke-width=".8"/></svg></div>
        <div class="yg-hint" aria-hidden="true">${hintSVG()}<div class="yg-hint-orbit"><i class="yg-hint-dot"></i></div></div>
      </div>
      <div class="yg-drop" aria-hidden="true"><svg viewBox="0 0 200 170"><use href="#${P}cap0"/></svg></div>
      <button type="button" class="yg-spin" data-testid="spin-button">
        <svg class="yg-spin-ic" viewBox="0 0 32 32" aria-hidden="true"><path d="M26 16 A10 10 0 1 1 20 7" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/><path d="M15 3 L24 6.5 L18 14 Z" fill="currentColor"/></svg>
        <span class="yg-spin-tx">タップでまわす</span>
      </button>
    </div>`;
  stageEl.appendChild(root);

  const $ = (sel, from = root) => from.querySelector(sel);
  const machine = $('.yg-machine');
  const shakeEl = $('.yg-shake');
  const wheelWrap = $('.yg-wheelwrap');
  const wheelEl = $('.yg-wheel');
  const pawl = $('.yg-pawl');
  const spinBtn = $('.yg-spin');
  const dropEl = $('.yg-drop');
  const sim = createCapsuleSim($('.yg-caps'), P);

  // 位置合わせ（設計座標）
  Object.assign(wheelWrap.style, { left: `${WCX - WR}px`, top: `${WCY - WR}px`, width: `${WR * 2}px`, height: `${WR * 2}px` });
  Object.assign($('.yg-hint').style, { left: `${WCX - 210}px`, top: `${WCY - 210}px` });
  Object.assign(pawl.style, { left: `${WCX - 15}px`, top: `${WCY - 150}px` });

  /* ---------- 結果オーバーレイ（body 直下の position:fixed） ---------- */
  const ov = doc.createElement('div');
  ov.className = 'yg-overlay';
  ov.dataset.tier = 'sticker';
  ov.setAttribute('aria-hidden', 'true');
  const raysBg = (colors, period) => {
    let s = '';
    const span = 360 / colors.length;
    colors.forEach((c, i) => {
      const a = i * span;
      s += `transparent ${f1(a)}deg, ${c} ${f1(a + span * 0.18)}deg, transparent ${f1(a + span * 0.36)}deg, transparent ${f1(a + span)}deg${i < colors.length - 1 ? ',' : ''}`;
    });
    return `repeating-conic-gradient(from 0deg, ${s})`.replace(/,\s*\)/, ')');
  };
  ov.innerHTML = `
    <div class="yg-ov-backdrop"></div>
    <div class="yg-rays yg-rays-a"><i></i></div>
    <div class="yg-rays yg-rays-b"><i></i></div>
    <div class="yg-flash"></div>
    <div class="yg-ov-stack">
      <div class="yg-slot"></div>
      <section class="yg-card" data-testid="result-card" role="status" aria-live="polite">
        <i class="yg-rivet yg-r1"></i><i class="yg-rivet yg-r2"></i><i class="yg-rivet yg-r3"></i><i class="yg-rivet yg-r4"></i>
        <div class="yg-card-inner">
          <div class="yg-cat"><span class="yg-cat-ic"></span><span class="yg-cat-tx" data-testid="result-category"></span><span class="yg-cat-ic"></span></div>
          <div class="yg-prize" data-testid="result-prize"></div>
          <div class="yg-label" data-testid="result-label"></div>
          <div class="yg-notice">この画面のままスタッフにお見せください</div>
          <div class="yg-actions" data-testid="result-actions"></div>
        </div>
        <i class="yg-tw yg-tw1"></i><i class="yg-tw yg-tw2"></i><i class="yg-tw yg-tw3"></i><i class="yg-tw yg-tw4"></i><i class="yg-tw yg-tw5"></i><i class="yg-tw yg-tw6"></i>
      </section>
    </div>
    <div class="yg-chest" aria-hidden="true">
      <div class="yg-chest-glow"></div>
      <div class="yg-layers">
        ${chestLayerHTML('wood', PAL.wood)}
        ${chestLayerHTML('silver', PAL.silver)}
        ${chestLayerHTML('gold', PAL.gold)}
      </div>
      <div class="yg-mouth"></div>
      <div class="yg-seam"></div>
      <div class="yg-flare"></div>
    </div>`;
  doc.body.appendChild(ov);
  const rayA = $('.yg-rays-a', ov);
  const rayB = $('.yg-rays-b', ov);
  rayB.firstElementChild.style.backgroundImage = raysBg(['#ffd36b', '#ff9ec7', '#ffe9a8', '#8fe3ff', '#d6c2ff', '#ffe08a'], 1);
  const backdrop = $('.yg-ov-backdrop', ov);
  const flash = $('.yg-flash', ov);
  const stack = $('.yg-ov-stack', ov);
  const slotEl = $('.yg-slot', ov);
  const card = $('.yg-card', ov);
  const catEl = $('.yg-cat', ov);
  const catTx = $('.yg-cat-tx', ov);
  const prizeEl = $('.yg-prize', ov);
  const labelEl = $('.yg-label', ov);
  const actionsEl = $('.yg-actions', ov);
  const chest = $('.yg-chest', ov);
  const chestGlow = $('.yg-chest-glow', ov);
  const seam = $('.yg-seam', ov);
  const mouth = $('.yg-mouth', ov);
  const flare = $('.yg-flare', ov);
  const lids = [...ov.querySelectorAll('.yg-ch-lid')];
  const layerOf = (v) => $(`.yg-ch[data-v="${v}"]`, ov);
  const lidsOf = (v) => $('.yg-ch-lid', layerOf(v));
  const confetti = createConfetti(ov); // 前面：開封の一瞬のはじけ
  const confettiBack = createConfetti(ov, { back: true }); // 背面：カードの後ろに降る（文字を隠さない）

  /* ---------- 状態 ---------- */
  let interactive = false;
  let armed = false;
  let attract = true;
  let turnCb = null;
  let mode = 'idle'; // idle | spin | decel
  let runTok = 0;
  let busy = false; // 演出中（overlay 表示中を含む）
  let shown = false; // overlay 表示中
  let scale = 1;
  let angle = 0;
  let vel = 0; // deg/s
  let spinDir = 1;
  let decelT0 = 0;
  let decelDur = 600;
  let decelV0 = 0;
  let lastDet = Math.floor(angle / DETENT);
  let lastFrame = 0;
  let raf = 0;
  let live = []; // 演出で作った Animation
  let destroyed = false;
  let timers = [];

  const setState = (s) => { root.dataset.state = s; };
  const emitMood = (mood) => {
    try { if (typeof opts.onMood === 'function') opts.onMood(mood); } catch (e) { /* noop */ }
    try { stageEl.dispatchEvent(new CustomEvent('yg-mood', { detail: { mood }, bubbles: true })); } catch (e) { /* noop */ }
  };

  /* ---------- 画面フィット ---------- */
  function fit() {
    const w = stageEl.clientWidth;
    const h = stageEl.clientHeight;
    if (!w || !h) return;
    scale = Math.min(w / MW, h / MH) * 0.98;
    machine.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(fit);
    ro.observe(stageEl);
  }
  const onWinResize = () => fit();
  window.addEventListener('resize', onWinResize);
  fit();

  /* ---------- 舵輪の動力学 ---------- */
  const setAngle = (a) => {
    angle = a;
    wheelEl.style.transform = `rotate(${a.toFixed(2)}deg)`;
  };
  setAngle(0);

  let lastPawl = 0;
  function flickPawl(dir) {
    const t = performance.now();
    if (t - lastPawl < 55) return;
    lastPawl = t;
    if (typeof pawl.animate === 'function') {
      pawl.animate(
        [{ transform: `rotate(${dir * -22}deg)` }, { transform: 'rotate(0deg)' }],
        { duration: 90, easing: 'ease-out' }
      );
    }
  }
  function detents(dir) {
    const d = Math.floor(angle / DETENT);
    if (d !== lastDet) {
      lastDet = d;
      sound.play('tick');
      flickPawl(dir || 1);
    }
  }

  const needsFrame = () => dragging || mode !== 'idle' || Math.abs(vel) > 0.6 || sim.active;
  function kick() {
    if (!raf && !destroyed) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  function frame(now) {
    raf = 0;
    const dt = clamp((now - lastFrame) / 1000, 0.001, 0.05);
    lastFrame = now;
    let stir = 0;
    if (!dragging) {
      if (mode === 'spin') {
        vel += (spinDir * 780 - vel) * (1 - Math.exp(-dt * 4.2));
      } else if (mode === 'decel') {
        const p = clamp((now - decelT0) / decelDur, 0, 1);
        vel = decelV0 * (1 - p) * (1 - p);
        if (p >= 1) { vel = 0; mode = 'idle'; }
      } else {
        vel *= Math.exp(-dt * 1.7);
        if (Math.abs(vel) < 4) vel = 0;
      }
      if (vel) { setAngle(angle + vel * dt); detents(Math.sign(vel)); }
    }
    if (mode === 'spin') stir = 1;
    else if (mode === 'decel') stir = clamp(Math.abs(vel) / 700, 0, 1) * 0.8;
    else if (dragging || Math.abs(vel) > 60) stir = clamp(Math.abs(vel) / 900, 0, 0.5);
    sim.step(dt, stir, Math.sign(vel) || spinDir);
    if (needsFrame()) raf = requestAnimationFrame(frame);
  }

  /* ---------- 入力（ドラッグ / タップ / ボタン / キー） ---------- */
  let dragging = false;
  let pid = null;
  let cx0 = 0;
  let cy0 = 0;
  let lastA = 0;
  let lastT = 0;
  let accum = 0;
  let moved = 0;
  let downT = 0;
  let downX = 0;
  let downY = 0;
  let sx = 0;
  let sy = 0;

  const canInput = () => interactive && armed && mode === 'idle' && !busy;

  function fire(kind) {
    if (!armed || !interactive) return;
    armed = false;
    interactive = false; // setInteractive(false) を呼ぶ前にガード
    applyInteractive();
    if (kind !== 'drag') {
      // タップ/ボタン：舵輪にぐるっと勢いをつける
      spinDir = 1;
      vel = 760;
      kick();
    } else {
      spinDir = Math.sign(accum) || spinDir;
    }
    const cb = turnCb;
    if (cb) {
      try { cb(); } catch (e) { console.error(e); }
    }
  }

  function endDrag(release) {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('is-dragging');
    if (pid != null) { try { wheelWrap.releasePointerCapture(pid); } catch (e) { /* noop */ } }
    pid = null;
    if (release) { vel = clamp(vel, -900, 900); if (Math.abs(vel) < 20) vel = 0; }
    kick();
  }

  wheelWrap.addEventListener('pointerdown', (e) => {
    if (!canInput() || dragging) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = wheelWrap.getBoundingClientRect();
    cx0 = r.left + r.width / 2;
    cy0 = r.top + r.height / 2;
    const dx = e.clientX - cx0;
    const dy = e.clientY - cy0;
    if (Math.hypot(dx, dy) > (r.width / 2) * 1.02) return;
    e.preventDefault();
    dragging = true;
    pid = e.pointerId;
    try { wheelWrap.setPointerCapture(pid); } catch (err) { /* noop */ }
    lastA = (Math.atan2(dy, dx) * 180) / Math.PI;
    lastT = performance.now();
    downT = lastT;
    downX = sx = e.clientX;
    downY = sy = e.clientY;
    accum = 0;
    moved = 0;
    vel = 0;
    root.classList.add('is-dragging');
    sound.play('tap');
    kick();
  });

  wheelWrap.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pid) return;
    const dx = e.clientX - cx0;
    const dy = e.clientY - cy0;
    moved = Math.max(moved, Math.hypot(e.clientX - downX, e.clientY - downY));
    if (Math.hypot(dx, dy) < 18) return; // 中心付近は角度が不安定
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    let d = a - lastA;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    lastA = a;
    const t = performance.now();
    const dtm = Math.max(8, t - lastT) / 1000;
    lastT = t;
    vel = vel * 0.55 + (d / dtm) * 0.45;
    accum += d;
    setAngle(angle + d);
    detents(Math.sign(d));
    if (Math.abs(accum) >= TURN_DEG && canInput()) {
      endDrag(true);
      fire('drag');
    }
  });

  const onUp = (e) => {
    if (!dragging || e.pointerId !== pid) return;
    const dur = performance.now() - downT;
    const tapLike = moved < 14 && dur < 500 && Math.abs(accum) < TURN_DEG && e.type === 'pointerup';
    endDrag(true);
    if (tapLike && canInput()) fire('tap');
  };
  wheelWrap.addEventListener('pointerup', onUp);
  wheelWrap.addEventListener('pointercancel', (e) => { if (e.pointerId === pid) endDrag(true); });
  wheelWrap.addEventListener('lostpointercapture', (e) => { if (dragging && e.pointerId === pid) endDrag(true); });
  wheelWrap.addEventListener('contextmenu', (e) => e.preventDefault());
  wheelWrap.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && canInput()) {
      e.preventDefault();
      fire('key');
    }
  });
  spinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (canInput()) { sound.play('tap'); fire('button'); }
  });

  function applyInteractive() {
    root.dataset.interactive = interactive ? 'true' : 'false';
    wheelWrap.tabIndex = interactive ? 0 : -1;
  }

  /* ---------- 演出ヘルパ ---------- */
  const isReduced = (r) => !!(r && r.reduced) || reducedBase;
  const chk = (tok) => { if (tok !== runTok || destroyed) throw ABORT; };
  function run(el, kf, o) {
    if (!el || typeof el.animate !== 'function') return Promise.resolve();
    const a = el.animate(kf, { fill: 'both', ...o });
    live.push(a);
    return new Promise((res) => { a.onfinish = res; a.oncancel = res; });
  }
  function cancelLive() {
    for (const a of live) { try { a.cancel(); } catch (e) { /* noop */ } }
    live = [];
  }
  function later(fn, ms) {
    const t = setTimeout(() => { timers = timers.filter((x) => x !== t); fn(); }, ms);
    timers.push(t);
  }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  const poseT = (cx, cy, s, rot = 0) => `translate(${f1(cx - BW / 2)}px, ${f1(cy - BH / 2)}px) rotate(${rot}deg) scale(${s.toFixed(4)})`;

  function fitText(el, maxPx, minPx) {
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = `${maxPx}px`;
    const avail = el.clientWidth;
    let size = maxPx;
    let guard = 40;
    while (el.scrollWidth > avail + 1 && size > minPx && guard-- > 0) {
      size = Math.max(minPx, size * 0.94);
      el.style.fontSize = `${size.toFixed(1)}px`;
    }
    if (el.scrollWidth > avail + 1) el.style.whiteSpace = 'normal';
  }

  function prepareOverlay(r) {
    const tier = r.tier === 'sponsor' || r.tier === 'rare' ? r.tier : 'sticker';
    ov.dataset.tier = tier;
    catEl.dataset.tier = tier;
    catTx.textContent = r.categoryName || '';
    prizeEl.textContent = r.prizeName || '';
    labelEl.textContent = r.label ? `抽選番号 ${r.label}` : '';
    labelEl.hidden = !r.label;
    const icons = catEl.querySelectorAll('.yg-cat-ic');
    icons.forEach((n) => { n.innerHTML = TIER_ICON[tier]; });
    // 状態リセット
    ov.classList.remove('is-open', 'is-shown', 'is-leaving', 'is-reduced', 'is-on', 'is-pre');
    card.style.cssText = '';
    chest.style.cssText = '';
    flash.style.cssText = '';
    seam.style.cssText = '';
    mouth.style.cssText = '';
    flare.style.cssText = '';
    chestGlow.style.cssText = '';
    rayA.style.cssText = '';
    rayB.style.cssText = '';
    backdrop.style.cssText = '';
    lids.forEach((l) => { l.style.cssText = ''; });
    ['wood', 'silver', 'gold'].forEach((v) => { layerOf(v).style.cssText = ''; });
    layerOf('wood').dataset.on = '1';
    layerOf('silver').dataset.on = tier === 'rare' ? '0' : '';
    layerOf('gold').dataset.on = tier === 'sponsor' ? '0' : '';
    // 文字のフィット（レイアウト確定後）
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    fitText(prizeEl, clamp(vmin * 0.088, 38, 84), 30);
    fitText(catTx, clamp(vmin * 0.066, 30, 62), 24);
    shown = true;
    setState('reveal');
    return tier;
  }

  function slotPose() {
    const s = slotEl.getBoundingClientRect();
    return { cx: s.left + s.width / 2, cy: s.top + s.height / 2, s: s.width / BW };
  }

  function showTierLayer(tier) {
    // 最終の宝箱の見た目
    const v = tier === 'sponsor' ? 'gold' : tier === 'rare' ? 'silver' : 'wood';
    ['wood', 'silver', 'gold'].forEach((n) => { layerOf(n).style.opacity = n === v ? '1' : '0'; });
  }

  /* ---------- 短縮版 / 復旧用の表示 ---------- */
  async function revealQuick(r, tok, o = {}) {
    const dur = o.dur ?? 240;
    const tier = prepareOverlay(r);
    ov.classList.add('is-reduced', 'is-on');
    showTierLayer(tier);
    ov.classList.add('is-open');
    lids.forEach((l) => { l.style.transform = 'rotateX(-122deg)'; });
    const sp = slotPose();
    chest.style.transform = poseT(sp.cx, sp.cy, sp.s);
    backdrop.style.opacity = '';
    run(chest, [{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: 'ease-out' });
    const done = run(card, [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: dur + 80, easing: 'cubic-bezier(.2,.8,.3,1)' });
    ov.classList.add('is-shown');
    if (!o.silent) sound.play(tier === 'sponsor' ? 'fanfare-sponsor' : tier === 'rare' ? 'fanfare-rare' : 'fanfare-sticker');
    await done;
    chk(tok);
  }

  /* ---------- 通常の演出 ---------- */
  async function revealFull(r, tok) {
    const tier = prepareOverlay(r);
    chest.style.opacity = '0'; // 落下中はまだ背景を出さない（レイアウトだけ確定済み）
    const sponsor = tier === 'sponsor';
    const W = window.innerWidth;
    const H = window.innerHeight;

    /* 1) 舵輪が減速 → 取り出し口から宝箱が落ちる */
    startDecel(520);
    await sleep(200);
    chk(tok);
    root.classList.remove('is-spinning');
    sim.takeOne();
    sound.play('drop');
    dropEl.style.opacity = '1';
    const dropDone = run(
      dropEl,
      [
        { transform: 'translate(0, -30px) scale(.5)', opacity: 0, offset: 0 },
        { transform: 'translate(0, -24px) scale(.62)', opacity: 1, offset: 0.08 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0.37, easing: 'cubic-bezier(.3,0,.9,.6)' },
        { transform: 'translate(0, 0) scale(1.1, .88)', opacity: 1, offset: 0.4 },
        { transform: 'translate(0, -30px) scale(1) rotate(-5deg)', opacity: 1, offset: 0.5, easing: 'ease-out' },
        { transform: 'translate(0, 0) scale(1.07, .93) rotate(0deg)', opacity: 1, offset: 0.66, easing: 'ease-in' },
        { transform: 'translate(0, -10px) scale(1) rotate(2deg)', opacity: 1, offset: 0.77, easing: 'ease-out' },
        { transform: 'translate(0, 0) scale(1.03, .97) rotate(0deg)', opacity: 1, offset: 0.88, easing: 'ease-in' },
        { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 1 },
      ],
      { duration: 800 }
    );
    later(() => { if (tok === runTok) ov.classList.add('is-on'); }, 480);
    await dropDone;
    chk(tok);

    /* 2) 中央へ飛んで大きくなる */
    const dr = dropEl.getBoundingClientRect();
    const from = { cx: dr.left + dr.width / 2, cy: dr.top + dr.height / 2, s: dr.width / BW };
    const sp = slotPose();
    const S = clamp((Math.min(W, H) * 0.54) / BW, 0.5, 1);
    const C = { cx: W / 2, cy: H * 0.45 };
    chest.style.opacity = '1';
    chest.style.transform = poseT(from.cx, from.cy, from.s);
    dropEl.style.opacity = '0';
    ov.classList.add('is-on');
    layerOf('wood').style.opacity = '1';
    const fly = run(
      chest,
      [
        { transform: poseT(from.cx, from.cy, from.s, 0), offset: 0 },
        { transform: poseT(from.cx + (C.cx - from.cx) * 0.45, Math.min(from.cy, C.cy) - H * 0.12, S * 0.55, -10), offset: 0.45, easing: 'ease-out' },
        { transform: poseT(C.cx, C.cy - 12, S * 1.1, 6), offset: 0.78 },
        { transform: poseT(C.cx, C.cy, S, 0), offset: 1 },
      ],
      { duration: 580, easing: 'cubic-bezier(.3,.1,.3,1)' }
    );
    run(chestGlow, [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 0.55, transform: 'scale(1)' }], { duration: 640, easing: 'ease-out' });
    await fly;
    chk(tok);
    await sleep(60);
    chk(tok);

    /* 3) 揺れ（系統色の光が隙間から漏れる） */
    const pose0 = poseT(C.cx, C.cy, S, 0);
    const amps = sponsor ? [5, 9, 13] : [5, 8.5, 12];
    for (let i = 0; i < amps.length; i++) {
      sound.play('shake');
      const a = amps[i];
      const lvl = (i + 1) / amps.length;
      const shakeKF = [0, -1, 1, -0.75, 0.75, -0.4, 0.3, 0].map((k, n, arr) => ({
        transform: poseT(C.cx + k * a * 0.9, C.cy - Math.abs(k) * a * 0.4, S * (1 + 0.035 * lvl * Math.sin((n / (arr.length - 1)) * Math.PI)), k * a),
        offset: n / (arr.length - 1),
      }));
      const tasks = [
        run(chest, shakeKF, { duration: 290 + i * 15, easing: 'ease-in-out' }),
        run(seam, [{ opacity: 0.12 * lvl }, { opacity: 0.55 + 0.45 * lvl, offset: 0.35 }, { opacity: 0.3 + 0.55 * lvl }], { duration: 290 + i * 15 }),
        run(chestGlow, [{ opacity: 0.55, transform: 'scale(1)' }, { opacity: 0.6 + 0.4 * lvl, transform: `scale(${1 + 0.22 * lvl})`, offset: 0.4 }, { opacity: 0.6 + 0.3 * lvl, transform: `scale(${1 + 0.1 * lvl})` }], { duration: 290 + i * 15 }),
      ];
      // 変身：金/銀へ
      if (i === 1 && tier !== 'sticker') {
        const v = sponsor ? 'gold' : 'silver';
        tasks.push(morph(v, tier));
      }
      await Promise.all(tasks);
      chk(tok);
      if (i < amps.length - 1) await sleep(sponsor ? 70 : 50);
      chk(tok);
    }
    if (sponsor) {
      // 溜め
      run(seam, [{ opacity: 0.85 }, { opacity: 1 }], { duration: 240 });
      run(chest, [{ transform: pose0 }, { transform: poseT(C.cx, C.cy + 6, S * 0.96, 0) }], { duration: 230, easing: 'ease-in' });
      await sleep(240);
      chk(tok);
    } else await sleep(40);
    chk(tok);

    /* 4) 開封！ */
    openBurst(tier, C, S);
    await sleep(sponsor ? 480 : 400);
    chk(tok);

    /* 5) 結果カードがせり上がる */
    const rise = Promise.all([
      run(chest, [{ transform: poseT(C.cx, C.cy, S, 0) }, { transform: poseT(sp.cx, sp.cy, sp.s, 0) }], { duration: 560, easing: 'cubic-bezier(.2,.8,.25,1)' }),
      run(chestGlow, [{ opacity: 1 }, { opacity: 0.8 }], { duration: 560 }),
      run(card, [
        { opacity: 0, transform: 'translateY(90px) scale(.86)' },
        { opacity: 1, transform: 'translateY(-6px) scale(1.015)', offset: 0.75 },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ], { duration: 580, easing: 'cubic-bezier(.2,.8,.3,1)' }),
    ]);
    await rise;
    chk(tok);
    ov.classList.add('is-shown');
    await sleep(60);
    chk(tok);
  }

  function morph(v, tier) {
    const el = layerOf(v);
    const burstKind = tier === 'sponsor' ? 'sponsor' : 'rare';
    run(flash, [{ opacity: 0 }, { opacity: tier === 'sponsor' ? 0.8 : 0.6, offset: 0.25 }, { opacity: 0 }], { duration: 480, easing: 'ease-out' });
    const dx = chest.getBoundingClientRect();
    confetti.burst(burstKind, dx.left + dx.width / 2, dx.top + dx.height * 0.45, { scale: 0.22 });
    return run(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-in' }).then(() => {
      layerOf('wood').style.opacity = '0';
    });
  }

  function openBurst(tier, C, S) {
    const sponsor = tier === 'sponsor';
    sound.play('open');
    later(() => sound.play(sponsor ? 'fanfare-sponsor' : tier === 'rare' ? 'fanfare-rare' : 'fanfare-sticker'), 140);
    if (sponsor || tier === 'rare') emitMood('celebrate');
    ov.classList.add('is-open');
    // 蓋
    lids.forEach((l) => {
      run(l, [
        { transform: 'rotateX(0deg)' },
        { transform: 'rotateX(-140deg)', offset: 0.55, easing: 'ease-in-out' },
        { transform: 'rotateX(-122deg)' },
      ], { duration: 520, easing: 'cubic-bezier(.2,.9,.3,1)' });
    });
    // 本体のはずみ
    run(chest, [
      { transform: poseT(C.cx, C.cy, S, 0) },
      { transform: poseT(C.cx, C.cy - 14, S * 1.07, 0), offset: 0.35 },
      { transform: poseT(C.cx, C.cy, S, 0) },
    ], { duration: 520, easing: 'ease-out' });
    run(flash, [{ opacity: 0 }, { opacity: sponsor ? 0.95 : 0.8, offset: 0.12 }, { opacity: 0 }], { duration: sponsor ? 700 : 520, easing: 'ease-out' });
    run(seam, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
    run(mouth, [{ opacity: 0, transform: 'scaleY(.1)' }, { opacity: 1, transform: 'scaleY(1)', offset: 0.3 }, { opacity: 0.32, transform: 'scaleY(.8)' }], { duration: 900, easing: 'ease-out' });
    run(flare, [{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1.1)', offset: 0.3 }, { opacity: 0, transform: 'scale(1.8)' }], { duration: 700, easing: 'ease-out' });
    run(rayA, [{ opacity: 0, transform: 'scale(.3) rotate(0deg)' }, { opacity: 1, transform: 'scale(1) rotate(25deg)' }], { duration: 800, easing: 'ease-out' });
    if (sponsor || tier === 'rare') run(rayB, [{ opacity: 0, transform: 'scale(.3) rotate(0deg)' }, { opacity: 1, transform: 'scale(1) rotate(-25deg)' }], { duration: 900, easing: 'ease-out' });
    // 光のシャワー
    const cr = chest.getBoundingClientRect();
    const mx = cr.left + cr.width / 2;
    const my = cr.top + cr.height * 0.4;
    confetti.burst(tier, mx, my, { life: 0.45 });
    if (sponsor) {
      later(() => confetti.burst('sponsor', mx, my, { scale: 0.5, life: 0.4 }), 260);
      confettiBack.rain('sponsor', 1700);
    } else if (tier === 'rare') confettiBack.rain('rare', 1200, { rate: 30 });
    else confettiBack.rain('sticker', 700, { rate: 22 });
  }

  /* ---------- 舵輪の減速 ---------- */
  function startDecel(ms) {
    if (mode === 'idle') return;
    decelV0 = vel || spinDir * 600;
    decelDur = ms;
    decelT0 = performance.now();
    mode = 'decel';
    kick();
  }

  /* ---------- 公開API ---------- */
  const api = {
    setInteractive(on) {
      on = !!on;
      if (on === interactive) return;
      if (!on && dragging) endDrag(false);
      interactive = on;
      armed = on;
      applyInteractive();
    },
    onTurn(cb) { turnCb = typeof cb === 'function' ? cb : null; },
    setAttract(on) {
      attract = !!on;
      root.classList.toggle('yg-attract', attract);
    },
    startSpin() {
      if (mode === 'spin') return;
      if (dragging) endDrag(false);
      mode = 'spin';
      spinDir = Math.sign(vel) || spinDir || 1;
      root.classList.add('is-spinning');
      setState('spin');
      sim.wake();
      sound.play('spin');
      kick();
    },
    abort() {
      runTok++;
      clearTimers();
      cancelLive();
      if (mode !== 'idle') { startDecel(260); }
      root.classList.remove('is-spinning');
      if (!shown) setState('idle');
      busy = false;
      dropEl.style.opacity = '0';
      sim.restore();
      kick();
    },
    async playReveal(r) {
      r = r || {};
      const tok = ++runTok;
      busy = true;
      clearTimers();
      cancelLive();
      confetti.clear(); confettiBack.clear();
      try {
        if (mode === 'idle') { api.startSpin(); await sleep(200); chk(tok); }
        if (isReduced(r)) {
          startDecel(160);
          await sleep(120);
          chk(tok);
          sound.play('drop');
          await revealQuick(r, tok, { dur: 240 });
          chk(tok);
          await sleep(60);
        } else {
          await revealFull(r, tok);
        }
      } catch (e) {
        if (e !== ABORT) console.error(e);
      } finally {
        if (tok === runTok) {
          root.classList.remove('is-spinning');
        }
      }
    },
    showResultStatic(r) {
      r = r || {};
      const tok = ++runTok;
      busy = true;
      clearTimers();
      cancelLive();
      confetti.clear(); confettiBack.clear();
      if (mode !== 'idle') startDecel(120);
      root.classList.remove('is-spinning');
      revealQuick(r, tok, { dur: 300, silent: true }).catch((e) => { if (e !== ABORT) console.error(e); });
    },
    resultActionsEl: actionsEl,
    async reset() {
      const tok = ++runTok;
      clearTimers();
      const wasShown = shown;
      const quick = reducedBase || ov.classList.contains('is-reduced');
      if (wasShown) {
        ov.classList.add('is-leaving');
        await sleep(quick ? 160 : 380);
        if (tok !== runTok) return; // reset 中に別の演出が始まった
      }
      cancelLive();
      confetti.clear(); confettiBack.clear();
      ov.classList.remove('is-on', 'is-pre', 'is-open', 'is-shown', 'is-leaving', 'is-reduced');
      ov.style.opacity = '';
      shown = false;
      busy = false;
      dropEl.style.opacity = '0';
      dropEl.getAnimations?.().forEach((a) => a.cancel());
      mode = mode === 'spin' ? 'decel' : mode;
      if (mode === 'decel') { decelV0 = vel; decelDur = 200; decelT0 = performance.now(); }
      root.classList.remove('is-spinning');
      sim.restore();
      setState('idle');
      emitMood('idle');
      kick();
    },
    setReducedMotion(b) {
      reducedBase = !!b || fast;
      root.classList.toggle('yg-reduced', reducedBase);
    },
    destroy() {
      destroyed = true;
      runTok++;
      clearTimers();
      cancelLive();
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', onWinResize);
      confetti.destroy(); confettiBack.destroy();
      ov.remove();
      root.remove();
    },
    get state() { return root.dataset.state; },
    get interactive() { return interactive; },
  };

  // 初期状態
  dropEl.style.opacity = '0';
  applyInteractive();
  return api;
}

export default createStage;
