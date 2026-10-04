/* YoSoro! お宝ガチャ — 効果音（Web Audio で合成。音声ファイルなし）
 * 契約: sound.unlock / setEnabled / setVolume / play(name)
 *   name: tap / tick / spin / wipe / slam / stab / fanfare-sponsor / fanfare-rare / fanfare-sticker / error（drop / shake / open は旧名）
 * AudioContext が使えない環境でも例外を投げない。 */

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = true;
let volume = 0.8;
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

const N = {
  C4: 261.63, G4: 392, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568, A6: 1760, C7: 2093,
};

/** 太い「ドン」：低いサイン波の急降下＋短いローパスノイズ。スタンプ／タイトルの着地 */
function thunk(t, vol = 1, f0 = 130) {
  tone('sine', f0, t, 0.3, 0.9 * vol, { f1: 38, a: 0.002 });
  noise(t, 0.09, 0.5 * vol, { type: 'lowpass', f: 900, q: 0.5, a: 0.001 });
  noise(t, 0.02, 0.18 * vol, { f: 3200, q: 3, a: 0.001 });
}

/** 短く明るい「ジャン」：矩形波の和音をローパスで開いて閉じる */
function stab(freqs, t, dur, vol) {
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.9;
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(6000, t + 0.03);
  f.frequency.exponentialRampToValueAtTime(1400, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  for (const fr of freqs) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = fr;
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  f.connect(g);
  g.connect(master);
}

/* ---------- 各効果音（グラフィックなクリック／スウッシュ／ドン／ジャン。ファンファーレなし） ---------- */
const recipes = {
  tap() {
    // 乾いたクリック
    const t = now();
    noise(t, 0.022, 0.4, { f: 3600, q: 4, a: 0.001 });
    tone('sine', 880, t, 0.05, 0.22, { f1: 420, a: 0.001 });
  },

  tick() {
    // 舵輪の刻み（毎回ほんの少し音程を変える）
    const t = now();
    const r = 0.94 + Math.random() * 0.12;
    noise(t, 0.014, 0.55, { f: 3000 * r, q: 8, a: 0.0008 });
    tone('triangle', 1700 * r, t, 0.02, 0.14, { f1: 1100, a: 0.0008 });
  },

  spin() {
    // 空転の立ち上がり：帯域が上がるノイズ＋低い持ち上がり
    const t = now();
    noise(t, 0.95, 0.2, { f: 300, f1: 2400, q: 1.1, a: 0.25 });
    tone('sine', 90, t, 0.9, 0.09, { f1: 260, a: 0.2 });
  },

  wipe() {
    // シャッター／ワイプ：短いフィルタードノイズのスウッシュ
    const t = now();
    noise(t, 0.3, 0.34, { f: 500, f1: 3400, q: 1.3, a: 0.04 });
    noise(t, 0.012, 0.2, { type: 'highpass', f: 5000, a: 0.001 });
  },

  slam() {
    // タイトル文字・スタンプの着地
    thunk(now(), 1);
  },

  stab() {
    const t = now();
    stab([N.C5, N.G5, N.C6], t, 0.34, 0.07);
    thunk(t, 0.7, 110);
  },

  'fanfare-sponsor'() {
    // 協賛特別賞：明るいジャン＋太いドン（短い）
    const t = now();
    stab([N.C5, N.E5, N.G5, N.C6], t, 0.42, 0.08);
    stab([N.G5, N.C6, N.E6, N.G6], t + 0.12, 0.34, 0.05);
    thunk(t, 0.9, 120);
    noise(t, 0.35, 0.12, { type: 'highpass', f: 6000, a: 0.002 });
  },

  'fanfare-rare'() {
    // レア：細く高いジャン
    const t = now();
    stab([N.E6, N.A6], t, 0.26, 0.05);
    stab([N.A6, N.C7], t + 0.09, 0.22, 0.04);
    thunk(t, 0.5, 150);
  },

  'fanfare-sticker'() {
    // ステッカー：軽い2連クリックのポップ
    const t = now();
    tone('square', N.G5, t, 0.07, 0.05, { lp: 3500 });
    tone('square', N.C6, t + 0.07, 0.1, 0.05, { lp: 3500 });
    noise(t + 0.07, 0.03, 0.2, { f: 4200, q: 3, a: 0.001 });
  },

  error() {
    const t = now();
    tone('square', 196, t, 0.12, 0.08, { lp: 800 });
    tone('square', 147, t + 0.14, 0.2, 0.08, { lp: 800 });
  },
};
// 旧名（契約の互換）
recipes.drop = recipes.wipe;
recipes.shake = recipes.slam;
recipes.open = recipes.stab;

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
