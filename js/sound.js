/* Yo Draw（お宝ガチャ） — 効果音（Web Audio で合成。音声ファイルなし）
 *
 * 契約（js/stage.js・js/app.js・js/admin.js が使う）
 *   sound.unlock()                                   冪等。どのジェスチャ（タップ・キー）の中で呼んでもよい
 *   sound.play(name, delayMs = 0, group = 'default') ctx.currentTime + max(0.012, delayMs/1000) に予約して鳴らす（旧 play(name) もそのまま）
 *   sound.cancelScheduled(group?)                    その group の予約を止める（省略で全部）
 *   sound.status()                                   'running' | 'locked'（タップ待ち）| 'interrupted' | 'unavailable' | 'off'
 *   sound.onStatusChange(cb)                         状態が変わるたび cb(status)。戻り値は解除関数
 *   sound.test()                                     スタッフ画面のテスト音（短いファンファーレ）
 *   sound.setEnabled(b) / sound.setVolume(v)
 *   name: tap / tick / spin / wipe / slam / stab / fanfare-sponsor / fanfare-rare / fanfare-sticker / error（drop / shake / open は旧名）
 * AudioContext が使えない環境でも、どの関数も例外を投げない（何もしない）。
 *
 * iPad（WebKit）で音が出なくなる原因と、ここでの対策
 *  1. 解錠: タッチの pointerdown / touchstart は音声の解錠にならない（ユーザー操作として扱われるのは touchend / pointerup / click / keydown）。
 *     → この4つを聴き続け、そのハンドラの「中で」AudioContext を作って resume() する。動き出すまで、
 *        また 'interrupted' / 'suspended' に戻るたび・画面に戻るたびに、聴く状態へ戻す。
 *  2. 消音: 本体の消音（コントロールセンターのベル／古い機種のサイドスイッチ）では、既定（ambient）の Web Audio が無音になる。
 *     → navigator.audioSession があれば type = 'playback' にし、さらに iOS（iPad）では audioSession の有無に関わらず、
 *        無音の <audio> をループ再生して再生カテゴリに保つ（audioSession だけでは実機で未確認のための二重の備え）。iOS 以外では何もしない。
 *  3. 'interrupted': 画面ロック・アプリ切替・Siri などで state が 'interrupted' になる。'running' 以外はすべて「再開が必要」と扱う。
 *  4. 溜め込まない: 鳴らせない間に呼ばれた音は、250ms 以内に再開できたときだけ鳴らし、それ以外は捨てる（後からまとめて鳴らない）。
 *  5. 音量: 各音を測って揃え（LEVEL）、最後に簡易リミッターを通す。音量スライダー（master）はリミッターの後ろ。 */

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : undefined;

const WAIT_MS = 250;        // 再開待ちの上限。これを過ぎた音は捨てる
const MIN_LEAD = 0.012;     // 予約の最短リード（秒）
const START_GUARD = 0.06;   // 起動直後の約50msは DynamicsCompressor の立ち上がりで音が約10dB小さくなる（実測）。それより前には鳴らさない
const TICK_GAP = 0.0299;    // tick どうしの最小間隔（秒・予約時刻で比べる。30ms の列が丸め誤差で落ちないよう少しだけ緩める）
const GESTURE_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'];
const LISTEN = { capture: true, passive: true };

/* 音ごとの音量補正。volume=1.0 のとき、回路（リミッター・安全弁）を通した後のピークが次になるよう、OfflineAudioContext で測って決めた値。
 *   fanfare-sponsor −1 / fanfare-rare・fanfare-sticker・stab・slam −2 / wipe・spin・error −6 / tap −9 / tick −10 （dBFS）
 * レシピや回路を変えたら測り直すこと：_renderOffline(name, new OfflineAudioContext(2, 48000 * 2.5, 48000), { volume: 1, delayMs: 300 }) を
 * startRendering() して最大値を見る（DynamicsCompressor は起動直後が小さく出るので、必ず 300ms ほど後ろに置いて測る）。 */
const LEVEL = {
  tap: 0.82,
  tick: 1.055,
  spin: 1.692,
  wipe: 1.86,
  slam: 0.496,
  stab: 0.545,
  'fanfare-sponsor': 0.512,
  'fanfare-rare': 1.023,
  'fanfare-sticker': 7.432,
  error: 4.635,
};
const MAKEUP = 1;           // リミッターの手前の共通ゲイン（各音の LEVEL で揃えたあとの微調整用）
const ALIAS = { drop: 'wipe', shake: 'slam', open: 'stab' };   // 旧名（契約の互換）

const noop = () => {};
const wall = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ---------- 端末まわり ---------- */
const hasAudioSession = () => { try { return !!navigator.audioSession; } catch (e) { return false; } };
const isIOS = () => {
  try {
    return /iP(hone|ad|od)/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);   // iPadOS のデスクトップ表示
  } catch (e) { return false; }
};
/** 再生カテゴリにする（消音スイッチでも鳴らす）。AudioContext を作る／resume する前に呼ぶ。 */
function setPlaybackSession() {
  try {
    if (hasAudioSession() && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
  } catch (e) { /* noop */ }
}

/** 無音の PCM WAV（16bit・モノ・全サンプル 0）を data: URI で作る。<audio muted> ではなく本当に再生させるための素材。 */
function silentWavUri(seconds = 1, rate = 8000) {
  const n = Math.floor(rate * seconds);
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** 最終の安全弁：|x| ≤ 0.9（−0.9dBFS）はそのまま通し、それを超える分だけなめらかに 0.95（−0.45dBFS）へ丸める（超過は 0.95 で頭打ち）。
 *  リミッター（DynamicsCompressor）は完全な壁ではなく、重なった大きな音でわずかに 0dBFS を超えることがあるため。 */
function ceilingCurve(n = 2049, knee = 0.9) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    let y = a;
    if (a > knee) {
      const u = (a - knee) / (1 - knee);   // 0..1
      y = knee + (1 - knee) * (u - (u * u) / 2);
    }
    c[i] = x < 0 ? -y : y;
  }
  return c;
}
const CEILING = ceilingCurve();

/* ================= エンジン =================
 * 画面で使うのは下の `sound`（1つ）。測定・テスト用に、OfflineAudioContext へ同じ回路を作る口（_createOfflineEngine）も用意してある。 */
function createEngine({ offlineCtx = null, volume: volume0 = 0.8 } = {}) {
  const offline = !!offlineCtx;
  let ctx = offlineCtx;
  let master = null;        // 音量（リミッターの後ろ）
  let makeup = null;        // リミッターの手前の共通ゲイン
  let noiseBuf = null;
  let enabled = true;
  let volume = volume0;
  let createFailed = false; // AudioContext を作ろうとして失敗した
  let cur = null;           // いま組み立てている 1 回分の { dest, bus }（レシピは同期で組み立てるので安全）
  let lastStatus = '';
  let armed = false;
  let kicked = false;       // この ctx で、ジェスチャ内の無音バッファをもう鳴らしたか
  let lastGestureResume = 0; // 最後に、ジェスチャの中で resume() を試した時刻（wall）
  let stuck = 0;            // resume() しても動かなかったタップの回数
  let userGesture = false;  // これまでに（聴いている4種の）ジェスチャが1回でもあったか
  let keepEl = null;        // iOS（iPad）の無音ループ <audio>（iOS 以外では作らない）
  let keepBroken = false;   // 無音ループがこの端末で再生できない（NotSupportedError など）。その場合はループ無しで続ける
  const buses = new Map();  // group → { group, node, sources:Set, dead, used }
  const ticks = [];         // 予約済み tick の { t, bus }（予約時刻の重複排除用）
  const waiters = [];       // 再開待ちの音 { t0, name, delayMs, group, waitMs }
  const listeners = new Set();

  /* ---------- 回路 ---------- */
  function build() {
    makeup = ctx.createGain();
    makeup.gain.value = MAKEUP;
    const limiter = ctx.createDynamicsCompressor();   // 簡易ブリックウォール・リミッター
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    const shaper = ctx.createWaveShaper();   // 最終の安全弁（上の ceilingCurve）
    shaper.curve = CEILING;
    master = ctx.createGain();
    master.gain.value = enabled ? volume : 0;
    makeup.connect(limiter);
    limiter.connect(shaper);
    shaper.connect(master);
    master.connect(ctx.destination);
    // ノイズバッファ（1.5秒）
    const len = Math.floor(ctx.sampleRate * 1.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    kicked = false;
    if (!offline) {
      try { ctx.addEventListener('statechange', onState); } catch (e) { try { ctx.onstatechange = onState; } catch (e2) { /* noop */ } }
    }
  }

  /** AudioContext を（なければ）作る。ジェスチャのハンドラの中から呼ばれたときに限って、iOS でそのまま動き出せる。 */
  function ensure() {
    if (ctx && !offline && ctx.state === 'closed') discard();
    if (ctx) return ctx;
    if (!AC) return null;
    try {
      setPlaybackSession();
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      build();
      createFailed = false;
    } catch (e) {
      ctx = null; master = null; makeup = null; noiseBuf = null;
      createFailed = true;
    }
    emit();
    return ctx;
  }

  /** 古い AudioContext を片付ける（動かないまま固まったときの作り直し用）。 */
  function discard() {
    const old = ctx;
    cancelAllBuses();
    ctx = null; master = null; makeup = null; noiseBuf = null;
    try { if (old && old.close) { const p = old.close(); if (p && p.catch) p.catch(noop); } } catch (e) { /* noop */ }
  }

  function applyGain() {
    if (!master || !ctx) return;
    try {
      const target = enabled ? volume : 0;
      master.gain.cancelScheduledValues(ctx.currentTime);
      if (offline || ctx.state !== 'running') master.gain.value = target;   // 動いていない間は時間が進まないので直接入れる
      else master.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
    } catch (e) { /* noop */ }
  }

  const isRunning = () => offline || (!!ctx && ctx.state === 'running');

  /* ---------- 状態 ---------- */
  const keepNeeded = () => !offline && !keepBroken && isIOS();   // iOS（iPad）だけ。audioSession があっても回す
  const keepPlaying = () => !!keepEl && !keepEl.paused;

  function status() {
    if (!offline && (!AC || createFailed)) return 'unavailable';
    if (!enabled || volume <= 0) return 'off';
    if (offline) return 'running';
    if (!ctx) return 'locked';
    if (ctx.state === 'interrupted') return 'interrupted';
    if (ctx.state !== 'running') return 'locked';
    if (keepNeeded() && !keepPlaying()) return 'locked';   // 消音スイッチ対策のループが止まっている＝音が出ないかもしれない。タップで直す
    return 'running';
  }

  function emit() {
    const s = status();
    if (s === lastStatus) return;
    lastStatus = s;
    for (const cb of [...listeners]) { try { cb(s); } catch (e) { /* noop */ } }
  }

  /* ---------- 解錠（ジェスチャ） ---------- */
  const needsGesture = () => !offline && !!AC && (!ctx || ctx.state !== 'running' || (keepNeeded() && !keepPlaying()));

  function arm() {
    if (armed || offline || typeof document === 'undefined') return;
    try {
      for (const ev of GESTURE_EVENTS) document.addEventListener(ev, onGesture, LISTEN);
      armed = true;
    } catch (e) { /* noop */ }
  }
  function disarm() {
    if (!armed || typeof document === 'undefined') return;
    try { for (const ev of GESTURE_EVENTS) document.removeEventListener(ev, onGesture, LISTEN); } catch (e) { /* noop */ }
    armed = false;
  }
  const syncArm = () => { if (needsGesture()) arm(); else disarm(); };

  function onGesture() {
    userGesture = true;
    unlock();
  }

  /** resume() を試す（ジェスチャの中なら通る。外では何も起きないか保留のまま）。 */
  function tryResume() {
    const c = ctx;
    if (!c || offline || c.state === 'running' || c.state === 'closed') return;
    try {
      const p = c.resume();
      if (p && typeof p.then === 'function') p.then(onMaybeRunning, noop);
    } catch (e) { /* noop */ }
  }
  function onMaybeRunning() {
    if (ctx && ctx.state === 'running') { stuck = 0; flushWaiters(); }
    syncArm();
    emit();
  }

  /** iOS（iPad）だけ（audioSession があっても）：無音の <audio> をループ再生して、Web Audio も消音スイッチを越えて鳴るようにする。
   *  ジェスチャの中で呼ぶ。再生中でない間は status() が 'locked'（= 次のタップで直す）になる。 */
  function startKeepAlive() {
    if (!keepNeeded()) return;
    try {
      if (!keepEl) {
        keepEl = new Audio();
        keepEl.src = silentWavUri();
        keepEl.loop = true;
        keepEl.preload = 'auto';
        keepEl.setAttribute('playsinline', '');
        keepEl.setAttribute('x-webkit-airplay', 'deny');
        keepEl.disableRemotePlayback = true;
        keepEl.addEventListener('pause', () => { syncArm(); emit(); });
        keepEl.addEventListener('playing', () => { syncArm(); emit(); });
        keepEl.addEventListener('error', () => { keepBroken = true; syncArm(); emit(); });   // 素材を読めない端末：ループ無しで続ける
      }
      if (keepEl.paused) {
        const p = keepEl.play();
        if (p && typeof p.catch === 'function') {
          p.catch((e) => {
            if (e && e.name === 'NotSupportedError') keepBroken = true;   // 再生できない端末（status を永久に 'locked' にしない）
            syncArm();                                                    // ジェスチャ外などで断られた → 聴く状態に戻し、次のタップでやり直す
            emit();
          });
        }
      }
    } catch (e) { /* noop */ }
  }
  function pauseKeepAlive() {
    try { if (keepEl && !keepEl.paused) keepEl.pause(); } catch (e) { /* noop */ }
  }

  function unlock() {
    try {
      if (offline) return;
      setPlaybackSession();
      let c = ensure();
      if (!c) return;
      startKeepAlive();
      if (c.state !== 'running') {
        // resume() しても動かないタップが続いたら、AudioContext を作り直す（WebKit で 'interrupted' のまま固まる例への保険）
        const tNow = wall();
        if (lastGestureResume && tNow - lastGestureResume > 600 && ++stuck >= 2) {
          stuck = 0;
          discard();
          c = ensure();
          if (!c) return;
        }
        lastGestureResume = tNow;
        tryResume();
      }
      if (c.state !== 'running' || !kicked) {
        // 旧 iOS 向け：ジェスチャの中で無音バッファを1回鳴らす
        try {
          const b = c.createBuffer(1, 1, 22050);
          const s = c.createBufferSource();
          s.buffer = b;
          s.connect(c.destination);
          s.start(0);
          kicked = true;
        } catch (e) { /* noop */ }
      }
      syncArm();
      emit();
    } catch (e) { /* noop */ }
  }

  /* ---------- 状態の変化 ---------- */
  function onState(ev) {
    if (ev && ev.target && ev.target !== ctx) return;   // 作り直す前の ctx のイベント
    if (!ctx) return;
    if (ctx.state === 'running') { stuck = 0; flushWaiters(); }
    else cancelAllBuses();                              // 中断中に積んだ予約が、再開後に遅れて鳴らないように捨てる
    syncArm();
    emit();
  }

  function onVisibility() {
    try {
      if (typeof document !== 'undefined' && document.hidden) { pauseKeepAlive(); arm(); emit(); return; }
      arm();                                            // 戻ってきた：次のタップで確実に再開できるよう聴く状態へ
      tryResume();                                      // 許されるなら（割り込みが終わっていれば）そのまま再開
      if (userGesture) startKeepAlive();                // 一度タップ済みなら、止めていた無音ループも（許されれば）戻す
      syncArm();
      emit();
    } catch (e) { /* noop */ }
  }

  /* ---------- 予約（グループごとのバス） ---------- */
  function busFor(group) {
    let b = buses.get(group);
    if (b && !b.dead) { b.used = wall(); return b; }
    // group 名を使い捨てにする呼び出しがあっても溜まらないよう、鳴り終わって久しいバスは片付ける
    if (buses.size >= 8) {
      const tNow = wall();
      for (const x of [...buses.values()]) if (x.sources.size === 0 && tNow - x.used > 5000) cancelBus(x);
    }
    const node = ctx.createGain();
    node.connect(makeup);
    b = { group, node, sources: new Set(), dead: false, used: wall() };
    buses.set(group, b);
    return b;
  }

  /** バスを切り離し、鳴っている／これから鳴る音源を止める。次に同じ group で鳴らすときは新しいバスができる。 */
  function cancelBus(b) {
    b.dead = true;
    for (const s of b.sources) {
      try { s.stop(0); } catch (e) { /* noop */ }
      try { s.disconnect(); } catch (e) { /* noop */ }
    }
    b.sources.clear();
    try { b.node.disconnect(); } catch (e) { /* noop */ }
    if (buses.get(b.group) === b) buses.delete(b.group);
  }
  function cancelAllBuses() {
    for (const b of [...buses.values()]) cancelBus(b);
    ticks.length = 0;
  }

  function cancelScheduled(group) {
    try {
      const all = group === undefined || group === null;
      const g = all ? null : String(group);
      if (all) cancelAllBuses();
      else {
        const b = buses.get(g);
        if (b) cancelBus(b);
      }
      for (let i = waiters.length - 1; i >= 0; i--) if (all || waiters[i].group === g) waiters.splice(i, 1);
    } catch (e) { /* noop */ }
  }

  const hasRecipe = (name) => Object.prototype.hasOwnProperty.call(recipes, name);

  /** 時刻 t（ctx.currentTime 基準）に name（正式名）を予約する。 */
  function schedule(name, t, group) {
    if (!hasRecipe(name)) return;
    const fn = recipes[name];
    if (t < START_GUARD) t = START_GUARD;
    const bus = busFor(group);
    if (name === 'tick') {
      // 予約時刻どうしで 30ms 未満は間引く（先に並べた tick 列にも効く）
      const tNow = ctx.currentTime;
      for (let i = ticks.length - 1; i >= 0; i--) if (ticks[i].bus.dead || ticks[i].t < tNow - 0.2) ticks.splice(i, 1);
      if (ticks.some((x) => Math.abs(x.t - t) < TICK_GAP)) return;
      ticks.push({ t, bus });
    }
    const trim = ctx.createGain();
    trim.gain.value = LEVEL[name] ?? 1;
    trim.connect(bus.node);
    cur = { dest: trim, bus };
    try { fn(t); } finally { cur = null; }
  }

  function flushWaiters() {
    if (!waiters.length || !ctx) return;
    const list = waiters.splice(0, waiters.length);
    const tNow = wall();
    for (const w of list) {
      const waited = tNow - w.t0;
      if (waited > w.waitMs) continue;                  // 古い音は捨てる
      try { schedule(w.name, ctx.currentTime + Math.max(MIN_LEAD, (w.delayMs - waited) / 1000), w.group); } catch (e) { /* noop */ }
    }
  }

  function play(rawName, delayMs, group, waitMs) {
    const name = Object.prototype.hasOwnProperty.call(ALIAS, rawName) ? ALIAS[rawName] : rawName;   // 旧名は正式名へ（LEVEL・tick判定も共通）
    try {
      if (!enabled || volume <= 0) return;
      if (!hasRecipe(name)) return;
      const c = ensure();
      if (!c) return;
      const g = group === undefined || group === null ? 'default' : String(group);
      const delay = Number(delayMs) > 0 ? Number(delayMs) : 0;
      if (isRunning()) {
        schedule(name, c.currentTime + Math.max(MIN_LEAD, delay / 1000), g);
        return;
      }
      // 動いていない（未解錠／中断中）。ジェスチャの中なら resume() が通るので、短時間で動いたときだけ鳴らす。
      const t0 = wall();
      while (waiters.length && (t0 - waiters[0].t0 > WAIT_MS || waiters.length >= 16)) waiters.shift();
      waiters.push({ t0, name, delayMs: delay, group: g, waitMs });
      tryResume();
      arm();
      emit();
    } catch (e) {
      // 音が鳴らなくても進行を止めない（開発時に気づけるよう警告だけ出す）
      try { console.warn('[sound] failed:', name, e && e.message); } catch (e2) { /* noop */ }
    }
  }

  /* ================= 合成ヘルパ ================= */
  function track(src) {
    const b = cur.bus;
    b.sources.add(src);
    src.onended = () => { b.sources.delete(src); };
  }

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
    g.connect(cur.dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    track(osc);
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
    g.connect(cur.dest);
    src.start(t, Math.random() * 0.8);
    src.stop(t + dur + 0.05);
    track(src);
  }

  const N = {
    C4: 261.63, G4: 392, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568, A6: 1760, C7: 2093,
  };

  /** 太い「ドン」：低い底＋胴鳴り＋短いノイズ。スタンプ／タイトルの着地。
   *  iPad 本体のスピーカーは 250Hz より下をほぼ出せない。底（f0→38Hz）だけに頼ると「音が小さい」ので、
   *  150〜400Hz の胴鳴り（サイン＋三角波）と中域のノイズで「ドン」を支え、底は大きなスピーカー向けに残す。 */
  function thunk(t, vol = 1, f0 = 130) {
    tone('sine', f0, t, 0.3, 0.34 * vol, { f1: 38, a: 0.002 });
    tone('sine', f0 * 2.4, t, 0.3, 0.7 * vol, { f1: f0 * 1.2, a: 0.002, hold: 0.04 });
    tone('triangle', f0 * 4.2, t, 0.16, 0.3 * vol, { f1: f0 * 1.8, a: 0.001, hold: 0.015 });
    noise(t, 0.09, 0.6 * vol, { type: 'lowpass', f: 1800, q: 0.7, a: 0.001 });
    noise(t, 0.025, 0.25 * vol, { f: 3200, q: 3, a: 0.001 });
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
      track(o);
    }
    f.connect(g);
    g.connect(cur.dest);
  }

  /* ---------- 各効果音（グラフィックなクリック／スウッシュ／ドン／ジャン。ファンファーレなし） ---------- */
  const recipes = {
    tap(t) {
      // 短いクリック＋ポップ。山（ピーク）を作るだけのクリック用ノイズは控えめにして、音程のある胴を厚くした（同じピークでより大きく聞こえる）
      noise(t, 0.02, 0.15, { f: 3600, q: 4, a: 0.001 });
      tone('sine', 880, t, 0.07, 0.3, { f1: 420, a: 0.001, hold: 0.012 });
      tone('triangle', 1760, t, 0.03, 0.1, { f1: 840, a: 0.001 });
    },

    tick(t) {
      // 舵輪の刻み（毎回ほんの少し音程を変える）
      const r = 0.94 + Math.random() * 0.12;
      noise(t, 0.012, 0.25, { f: 3000 * r, q: 8, a: 0.0008 });
      tone('triangle', 1700 * r, t, 0.028, 0.3, { f1: 1100, a: 0.0008 });
    },

    spin(t) {
      // 空転の立ち上がり：帯域が上がるノイズ＋低い持ち上がり
      noise(t, 0.95, 0.8, { f: 300, f1: 2400, q: 1.1, a: 0.25 });
      tone('sine', 90, t, 0.9, 0.06, { f1: 260, a: 0.2 });
    },

    wipe(t) {
      // シャッター／ワイプ：フィルタードノイズのスウッシュ（前半は音量を保ち、後半で消える＝帯域が上がりながら抜ける）
      noise(t, 0.3, 0.5, { f: 500, f1: 3400, q: 1.3, a: 0.04, swell: 0.5 });
      noise(t, 0.012, 0.1, { type: 'highpass', f: 5000, a: 0.001 });
    },

    slam(t) {
      // タイトル文字・スタンプの着地
      thunk(t, 1);
    },

    stab(t) {
      stab([N.C5, N.G5, N.C6], t, 0.34, 0.2);
      thunk(t, 0.7, 110);
    },

    'fanfare-sponsor'(t) {
      // 協賛特別賞：明るいジャン＋太いドン（短い）
      stab([N.C5, N.E5, N.G5, N.C6], t, 0.42, 0.17);
      stab([N.G5, N.C6, N.E6, N.G6], t + 0.12, 0.34, 0.11);
      thunk(t, 0.9, 120);
      noise(t, 0.35, 0.25, { type: 'highpass', f: 6000, a: 0.002 });
    },

    'fanfare-rare'(t) {
      // レア：細く高いジャン
      stab([N.E6, N.A6], t, 0.26, 0.12);
      stab([N.A6, N.C7], t + 0.09, 0.22, 0.10);
      thunk(t, 0.5, 150);
    },

    'fanfare-sticker'(t) {
      // ステッカー：軽い2連クリックのポップ
      tone('square', N.G5, t, 0.07, 0.05, { lp: 3500 });
      tone('square', N.C6, t + 0.07, 0.1, 0.05, { lp: 3500 });
      noise(t + 0.07, 0.03, 0.2, { f: 4200, q: 3, a: 0.001 });
    },

    error(t) {
      tone('square', 392, t, 0.12, 0.08, { lp: 2000 });
      tone('square', 294, t + 0.14, 0.2, 0.08, { lp: 2000 });
    },
  };

  /* ================= 初期化 ================= */
  if (offline) build();
  else if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // 動き出すまで聴き続ける。画面に戻ったときも聴く状態へ戻して再開を試す
    if (AC) arm();
    try {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pageshow', onVisibility);
      if (hasAudioSession() && navigator.audioSession.addEventListener) {
        navigator.audioSession.addEventListener('statechange', () => { arm(); tryResume(); emit(); });
      }
    } catch (e) { /* noop */ }
    // 'statechange' が来ないまま状態だけ変わる WebKit の癖への保険（軽い見張り）
    try {
      const id = setInterval(() => { syncArm(); emit(); }, 2000);
      if (id && id.unref) id.unref();
    } catch (e) { /* noop */ }
  }

  return {
    unlock,
    play(name, delayMs = 0, group = 'default') { play(name, delayMs, group, WAIT_MS); },
    cancelScheduled,
    status,
    onStatusChange(cb) {
      if (typeof cb !== 'function') return noop;
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    test() {
      // スタッフが押した直後：初回は音声回路の起動に時間がかかることがあるので、長めに待つ
      try { unlock(); play('fanfare-sponsor', 0, 'test', 1500); } catch (e) { /* noop */ }
    },
    setEnabled(b) {
      enabled = !!b;
      applyGain();
      emit();
    },
    setVolume(v) {
      const n = Number(v);
      volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : volume;
      applyGain();
      emit();
    },
  };
}

export const sound = createEngine();

/* ---- 測定・テスト用（契約の外。画面のコードは使わない） ---- */
/** OfflineAudioContext に本番と同じ回路（バス → リミッター → 音量）を作り、play / cancelScheduled / status を持つエンジンを返す。 */
export function _createOfflineEngine(octx, { volume = 1 } = {}) {
  return createEngine({ offlineCtx: octx, volume });
}
/** name を octx の先頭（またはdelayMs後）に1回分だけ組み立てる。呼んだあと octx.startRendering() で書き出す。 */
export function _renderOffline(name, octx, { volume = 1, delayMs = 0, group = 'default' } = {}) {
  const e = createEngine({ offlineCtx: octx, volume });
  e.play(name, delayMs, group);
  return e;
}

export default sound;
