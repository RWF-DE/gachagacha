/* YoSoro! お宝ガチャ — 効果音（Web Audio で合成。音声ファイルなし）
 * 契約: sound.unlock / setEnabled / setVolume / play(name)
 * AudioContext が使えない環境でも例外を投げない。 */

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = true;
let volume = 0.8;
let shakeN = 0;
let shakeT = 0;
let lastTickT = 0;

function ensure() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    master.connect(comp);
    comp.connect(ctx.destination);
    // ノイズバッファ（1.5秒）
    const len = Math.floor(ctx.sampleRate * 1.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

function applyGain() {
  if (!master || !ctx) return;
  try {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(enabled ? volume : 0, ctx.currentTime, 0.015);
  } catch (e) { /* noop */ }
}

/* ---------- 合成ヘルパ ---------- */
const now = () => ctx.currentTime + 0.012;

/** 単音。f1 があれば周波数スライド。 */
function tone(type, f0, t, dur, vol, o = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + dur);
  if (o.detune) osc.detune.value = o.detune;
  const a = o.a ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  if (o.hold) g.gain.setValueAtTime(vol, t + o.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = osc;
  if (o.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lp;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(o.dest || master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return g;
}

/** ノイズ（バンドパス等）。 */
function noise(t, dur, vol, o = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = o.type || 'bandpass';
  f.frequency.setValueAtTime(o.f || 1000, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  const a = o.a ?? 0.003;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  if (o.swell) {
    g.gain.linearRampToValueAtTime(vol, t + dur * o.swell);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(o.dest || master);
  src.start(t, Math.random() * 0.8);
  src.stop(t + dur + 0.05);
}

/** ブラス風（ノコギリ波2本＋サブ、ローパスがアタックで開く） */
function brass(freq, t, dur, vol) {
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(freq * 1.6, t);
  f.frequency.linearRampToValueAtTime(freq * 6, t + 0.05);
  f.frequency.exponentialRampToValueAtTime(freq * 2.4, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.03);
  g.gain.setValueAtTime(vol * 0.85, t + Math.max(0.05, dur * 0.6));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  [-7, 7].forEach((dt) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    o.detune.value = dt;
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.05);
  });
  const sub = ctx.createOscillator();
  sub.type = 'square';
  sub.frequency.value = freq / 2;
  const sg = ctx.createGain();
  sg.gain.value = 0.25;
  sub.connect(sg);
  sg.connect(f);
  sub.start(t);
  sub.stop(t + dur + 0.05);
  f.connect(g);
  g.connect(master);
}

/** ベル（基音＋非整数倍音） */
function bell(freq, t, dur, vol) {
  tone('sine', freq, t, dur, vol, { a: 0.002 });
  tone('sine', freq * 2.76, t, dur * 0.5, vol * 0.35, { a: 0.002 });
  tone('sine', freq * 5.4, t, dur * 0.25, vol * 0.15, { a: 0.002 });
}

const N = {
  C4: 261.63, E4: 329.63, G4: 392, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99,
  A5: 880, C6: 1046.5, D6: 1174.66, E6: 1318.5, G6: 1568, A6: 1760, C7: 2093, D7: 2349.3, E7: 2637,
};

/* ---------- 各効果音 ---------- */
const recipes = {
  tap() {
    const t = now();
    tone('sine', 560, t, 0.09, 0.5, { f1: 300 });
    noise(t, 0.03, 0.25, { f: 1800, q: 2 });
  },

  tick() {
    // 木製ラチェットのクリック（毎回少し音程を変える）
    const t = now();
    const r = 0.92 + Math.random() * 0.16;
    noise(t, 0.022, 0.55, { f: 2300 * r, q: 5 });
    tone('triangle', 1500 * r, t, 0.03, 0.22, { f1: 800 });
    tone('sine', 220 * r, t, 0.04, 0.2, { f1: 140 });
  },

  spin() {
    const t = now();
    const dur = 1.0;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(240, t + dur * 0.7);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(1600, t + dur * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
    noise(t, dur, 0.1, { f: 400, f1: 2400, q: 0.8, a: 0.2 });
  },

  drop() {
    const t = now();
    // 取り出し口をこすって出てくる音 → 着地3回（演出のバウンドに合わせる）
    noise(t, 0.28, 0.2, { f: 700, f1: 1800, q: 1.2, a: 0.08 });
    const hit = (dt, v, f) => {
      tone('sine', f, t + dt, 0.2, v, { f1: f * 0.32 });
      noise(t + dt, 0.07, v * 0.7, { type: 'lowpass', f: 900, q: 0.6 });
      tone('triangle', 1900 + Math.random() * 300, t + dt, 0.05, v * 0.12, { f1: 1200 });
    };
    hit(0.30, 0.95, 170);
    hit(0.53, 0.5, 190);
    hit(0.70, 0.25, 210);
  },

  shake() {
    const t = now();
    if (t - shakeT > 1.8) shakeN = 0;
    shakeT = t;
    const k = Math.min(shakeN++, 3);
    const base = 1 + k * 0.08;
    // ガタガタ（木の打音＋金具）
    for (let i = 0; i < 8; i++) {
      const dt = i * 0.038 + Math.random() * 0.012;
      const v = 0.32 + k * 0.07;
      noise(t + dt, 0.04, v, { f: (850 + Math.random() * 500) * base, q: 2.5 });
      tone('sine', (130 + Math.random() * 40) * base, t + dt, 0.07, v * 0.7, { f1: 80 });
      if (i % 2 === 0) tone('triangle', 2400 + Math.random() * 900, t + dt, 0.05, 0.06 + k * 0.02, { f1: 1800 });
    }
    // 緊張感の持ち上がり
    tone('sine', 220 * base, t, 0.34, 0.06 + k * 0.025, { f1: 330 * base, a: 0.1 });
  },

  open() {
    const t = now();
    // きしみ → ぶわっと光る
    tone('sawtooth', 150, t, 0.22, 0.08, { f1: 260, lp: 700, a: 0.03 });
    noise(t + 0.05, 0.42, 0.35, { f: 300, f1: 4200, q: 0.9, a: 0.12 });
    [N.C6, N.G6, N.C7].forEach((f, i) => bell(f, t + 0.22 + i * 0.05, 1.1, 0.16 - i * 0.03));
    tone('sine', 90, t + 0.12, 0.4, 0.5, { f1: 45 });
  },

  'fanfare-sponsor'() {
    const t = now() + 0.02;
    // 低音ヒット
    brass(N.C4 / 2, t, 0.5, 0.12);
    // 駆け上がり
    [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => brass(f, t + i * 0.1, 0.34, 0.1));
    // 持続和音（スウェル）
    [N.C5, N.E5, N.G5, N.C6, N.E6].forEach((f, i) => brass(f, t + 0.46, 1.3, 0.075 - i * 0.004));
    // 第2フレーズ
    brass(N.G5, t + 0.46, 0.2, 0.06);
    // シンバル風
    noise(t + 0.44, 1.3, 0.18, { type: 'highpass', f: 6000, q: 0.4, a: 0.004 });
    // きらめき
    for (let i = 0; i < 16; i++) {
      const f = [N.C7, N.E7, N.G6, N.D7, N.A6, N.C6][i % 6] * (1 + Math.random() * 0.01);
      bell(f, t + 0.55 + i * 0.085 + Math.random() * 0.02, 0.7, 0.07 * (1 - i / 22));
    }
    // コイン
    for (let i = 0; i < 6; i++) {
      tone('square', 2600 + Math.random() * 600, t + 0.7 + i * 0.11, 0.05, 0.035, { f1: 3400 });
    }
  },

  'fanfare-rare'() {
    const t = now() + 0.02;
    const run = [N.E6, N.G6, N.A6, N.C7, N.D7, N.E7, N.G6, N.C7, N.E7];
    run.forEach((f, i) => {
      bell(f, t + i * 0.075, 0.9, 0.13);
      bell(f * 1.002, t + i * 0.075 + 0.16, 0.7, 0.045); // エコー
    });
    // やわらかいパッド
    [N.C5, N.E5, N.G5].forEach((f) => tone('triangle', f, t + 0.3, 1.2, 0.05, { a: 0.25 }));
    noise(t + 0.55, 0.9, 0.05, { type: 'highpass', f: 7000, a: 0.1 });
    bell(N.C7, t + 0.7, 1.2, 0.12);
    bell(N.G6, t + 0.7, 1.2, 0.09);
  },

  'fanfare-sticker'() {
    const t = now() + 0.02;
    [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => {
      tone('square', f, t + i * 0.09, 0.14, 0.05, { lp: 3500 });
      tone('triangle', f, t + i * 0.09, 0.16, 0.12);
    });
    [N.G5, N.C6, N.E6].forEach((f) => {
      tone('square', f, t + 0.4, 0.4, 0.04, { lp: 3500 });
      tone('triangle', f, t + 0.4, 0.45, 0.1);
    });
    noise(t + 0.4, 0.25, 0.08, { type: 'highpass', f: 5000 });
    bell(N.E6 * 2, t + 0.42, 0.5, 0.05);
  },

  error() {
    const t = now();
    tone('sine', 247, t, 0.22, 0.22, { lp: 900 });
    tone('sine', 196, t + 0.16, 0.34, 0.22, { lp: 900 });
  },
};

export const sound = {
  unlock() {
    try {
      const c = ensure();
      if (!c) return;
      if (c.state !== 'running') c.resume().catch(() => {});
      // iOS: 無音バッファを1回鳴らして解錠
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch (e) { /* noop */ }
  },
  setEnabled(b) {
    enabled = !!b;
    applyGain();
  },
  setVolume(v) {
    const n = Number(v);
    volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : volume;
    applyGain();
  },
  play(name) {
    try {
      if (!enabled || volume <= 0) return;
      const c = ensure();
      if (!c) return;
      if (c.state === 'suspended') { c.resume().catch(() => {}); }
      if (c.state !== 'running') return; // 未解錠の間は鳴らさない（後からまとめて再生されるのを防ぐ）
      if (name === 'tick') {
        const t = c.currentTime;
        if (t - lastTickT < 0.03) return;
        lastTickT = t;
      }
      const fn = recipes[name];
      if (fn) fn();
    } catch (e) {
      // 音が鳴らなくても進行を止めない（開発時に気づけるよう警告だけ出す）
      try { console.warn('[sound] failed:', name, e && e.message); } catch (e2) { /* noop */ }
    }
  },
};

// 最初のユーザー操作で自動的に解錠（coreが unlock を呼び忘れても動くように）
try {
  const once = () => {
    sound.unlock();
    ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.removeEventListener(ev, once, true));
  };
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, once, true));
} catch (e) { /* noop */ }

export default sound;
