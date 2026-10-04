// 抽選画面（舵輪）と演出・結果カード（ポスター）。抽選ロジック・DBには一切触れない。
//
// 公開 API（app.js との境界）:
//   const stage = createStage(stageEl, { sound, reducedMotion });
//   stage.wheelScreen({ onBack }) : HTMLElement   舵輪の画面を作って返す（app.js が #screen-host に入れる）
//   stage.onTurn(cb)                              「回した」と判定したとき1回だけ cb（呼ぶ直前に自身を setInteractive(false)）
//   stage.setInteractive(on)                      舵輪の操作可否
//   stage.startSpin()                             保存待ちの間の空転を開始（入力の直後に呼ぶ）
//   stage.abort()                                 保存失敗：空転を止める
//   stage.playReveal(r): Promise                  保存完了「後」に呼ぶ。スタッフのボタンが出る瞬間に resolve
//   stage.showResultStatic(r)                     復旧用：演出なしで結果を表示
//   stage.resultActionsEl                         結果カード内の操作スロット（スタッフOKボタンを入れる）
//   stage.reset(): Promise                        結果を閉じて待機の紙へ
//   stage.setDay(text)                            ヘッダの開催日表示（飾り）
//   r = { tier:'sponsor'|'rare'|'sticker', categoryName, prizeName, label }
// ?fast=1 / prefers-reduced-motion では 1 秒未満の単純なフェードにする。
import {
  DEFS, wheelMark, metaHtml, splitChars, esc, fitStage, installGrain, halftone, splitPhrases, fontsReady,
} from './poster.js';

const TIERS = {
  sponsor: { mid: 'SPONSOR AWARD', capC: 'YoSoro! — Treasure Draw', base: { l: 178, p: 150 }, prize: { l: 112, p: 100 }, sound: 'fanfare-sponsor' },
  rare: { mid: 'RARE STICKER', base: { l: 148, p: 140 }, prize: { l: 112, p: 100 }, sound: 'fanfare-rare' },
  sticker: { mid: 'STICKER', base: { l: 158, p: 150 }, prize: { l: 116, p: 104 }, sound: 'fanfare-sticker' },
};
// 保存完了を 0ms とした演出の時刻（css/poster.css のタイムラインと揃える）
const TIMELINE = {
  sponsor: { shutter: [400, 700], cv: 1540, r0: 3540, cardOut: 2970, cat: 50, stamp: 1200, staff: 1400 },
  rare: { shutter: [800, 1050], cv: 1700, r0: 1750, cat: 60, stamp: 1300, staff: 1700 },
  sticker: { shutter: [700], cv: 1110, r0: 1150, cat: 60, stamp: 900, staff: 1300 },
};
const STAFF_DUR = 500;
const THRESHOLD_DEG = 180;     // 舵輪を回して発火する累積角度
const DRAG_TOLERANCE_PX = 12;  // これ以上動いたらタップではなくドラッグ扱い
const CIRC = 2 * Math.PI * 352;

const RESULT_HTML = `
<section id="shut" class="layer" aria-hidden="true">
  <div class="g a"><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div class="g b"><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div class="sweep"></div>
</section>
<section id="card" class="layer" aria-hidden="true">
  <div class="capline"></div>
  <span class="cap a" style="--k:0"></span>
  <span class="cap b" style="--k:1"></span>
  <div class="big" id="bigcat"></div>
  <span class="cap c" style="--k:3"></span>
</section>
<section id="result" class="layer" data-testid="result-card">
  <div class="bgf"></div>
  <div class="wmw">${wheelMark()}</div>
  <div class="inner-shake">
    ${metaHtml('<span id="m-mid"></span>')}
    <h2 class="cat" id="cat"></h2>
    <div class="ht" id="ht"></div>
    <div class="dno" id="num"><small>DRAW</small><b></b></div>
    <div class="rule"></div>
    <div class="plabel"><b>PRIZE</b><span>お宝 / 景品</span></div>
    <div class="prize" id="prize"></div>
    <div class="panel"><small>SHOW THIS SCREEN TO STAFF</small><p><span>この画面のまま</span><span>スタッフにお見せください</span></p></div>
    <div class="stamp" id="stamp"><div class="disc"></div><div class="ringl"></div><span class="s1">抽選番号</span><b class="s2" id="lotno"></b><span class="s3">DENPASAI 2026</span></div>
    <div class="staff" id="staffslot"></div>
  </div>
</section>`;

export function createStage(stageEl, { sound, reducedMotion = false } = {}) {
  const fast = !!reducedMotion;
  stageEl.insertAdjacentHTML('afterbegin', DEFS);
  stageEl.insertAdjacentHTML('beforeend', RESULT_HTML);
  installGrain(stageEl);
  if (fast) stageEl.classList.add('fast');

  const $ = (sel) => stageEl.querySelector(sel);
  const snd = (name) => { try { sound?.play(name); } catch { /* 音の失敗で進行を止めない */ } };
  const catEl = $('#cat'); const prizeEl = $('#prize'); const ruleEl = $('#result .rule'); const plabelEl = $('#result .plabel');
  const numEl = $('#num'); const htEl = $('#ht'); const staffEl = $('#staffslot'); const bigEl = $('#bigcat'); const cardEl = $('#card');

  let geo = fitStage(stageEl);
  stageEl.addEventListener('scroll', () => { stageEl.scrollLeft = 0; stageEl.scrollTop = 0; });
  let cur = null;          // 表示中の結果（レイアウト再計算用）
  let timers = [];
  let interactive = false;
  let turnCb = null;
  let wheel = null;        // 現在の舵輪画面の状態
  let spin = null;

  const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  // ---------- 拡縮 ----------
  const relayout = () => { geo = fitStage(stageEl); if (cur) layoutResult(); };
  addEventListener('resize', relayout);
  addEventListener('orientationchange', () => setTimeout(relayout, 120));

  // ---------- 舵輪画面 ----------
  function ticksSvg() {
    let s = '';
    for (let i = 0; i < 72; i++) {
      const a = (i * 5 * Math.PI) / 180;
      const major = i % 9 === 0;
      const r1 = 322; const r2 = major ? 350 : 336;
      s += `<line x1="${(Math.sin(a) * r1).toFixed(1)}" y1="${(-Math.cos(a) * r1).toFixed(1)}" x2="${(Math.sin(a) * r2).toFixed(1)}" y2="${(-Math.cos(a) * r2).toFixed(1)}" stroke-width="${major ? 5 : 3}"/>`;
    }
    return s;
  }

  function wheelScreen({ onBack } = {}) {
    const el = document.createElement('section');
    el.className = 'scr scr-wheel';
    el.setAttribute('data-testid', 'screen-wheel');
    el.innerHTML = `${metaHtml('お宝ガチャ — TREASURE DRAW')}
      <div class="step"><b>DRAW</b> TURN THE WHEEL</div>
      <h2><span class="ph">舵輪を回して、</span><br><span class="ph"><em>お宝</em>を引こう！</span></h2>
      <p class="sub"><span class="ph">舵輪をぐるっと回すか、</span><q>タップでまわす</q><span class="ph">を押して</span><span class="ph">ください。</span></p>
      <button type="button" class="go" data-testid="spin-button"><span class="wipe"></span><span>タップでまわす</span><svg aria-hidden="true"><use href="#rot"/></svg></button>
      <div class="readout"><b data-deg>0</b>° / ${THRESHOLD_DEG}°</div>
      <div class="dial">
        <svg viewBox="-360 -360 720 720" aria-hidden="true">
          <g stroke="#0A0E33">${ticksSvg()}</g>
          <circle class="arc" r="352" fill="none" stroke="#F23B20" stroke-width="8" transform="rotate(-90)" stroke-dashoffset="${CIRC.toFixed(1)}"/>
          <path d="M0 -318 l-17 -38 h34z" fill="#F23B20"/>
        </svg>
        <div class="wheelwrap" data-testid="wheel" tabindex="0" role="button" aria-label="舵輪（タップするか、ぐるっと回します）">${wheelMark('style="transform:rotate(38deg)"')}</div>
      </div>
      <button type="button" class="pbtn back" data-testid="back"><span>← 戻る</span></button>`;

    const wrap = el.querySelector('.wheelwrap');
    const svg = wrap.querySelector('.wm');
    const arc = el.querySelector('.arc');
    const deg = el.querySelector('[data-deg]');
    const w = { el, angle: 38, net: 0, fired: false, svg, arc, deg };
    wheel = w;

    const render = () => {
      svg.style.transform = `rotate(${w.angle}deg)`;
      const p = Math.min(1, Math.abs(w.net) / THRESHOLD_DEG);
      arc.style.strokeDashoffset = (CIRC * (1 - p)).toFixed(1);
      deg.textContent = String(Math.round(p * THRESHOLD_DEG));
    };
    w.render = render;
    render();

    const centerAngle = (e) => {
      const r = wrap.getBoundingClientRect();
      return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
    };
    let drag = null;
    let tickAcc = 0;
    wrap.addEventListener('pointerdown', (e) => {
      if (!interactive || w.fired) return;
      try { wrap.setPointerCapture(e.pointerId); } catch { /* noop */ }
      drag = { a: centerAngle(e), x: e.clientX, y: e.clientY, t: performance.now(), v: 0 };
      w.moved = false;
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag || !interactive || w.fired) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_TOLERANCE_PX) w.moved = true;
      const a = centerAngle(e);
      let d = a - drag.a;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      drag.a = a;
      const now = performance.now();
      const dt = Math.max(8, now - drag.t) / 1000;
      drag.t = now;
      drag.v = drag.v * 0.6 + (d / dt) * 0.4;
      w.angle += d;
      w.net += d;
      tickAcc += Math.abs(d);
      while (tickAcc >= 30) { tickAcc -= 30; snd('tick'); }
      render();
      if (Math.abs(w.net) >= THRESHOLD_DEG) { w.v = drag.v; drag = null; fire(); }
    });
    const end = () => { drag = null; };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    // タップ（ドラッグしていないときの click。プログラムからの click も受ける）
    wrap.addEventListener('click', () => { if (!w.moved) { snd('tap'); fire(); } });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); snd('tap'); fire(); } });
    el.querySelector('.go').addEventListener('click', () => { snd('tap'); fire(); });
    el.querySelector('.back').addEventListener('click', () => onBack?.());
    // Enter / Space（フォーカスがどこにも無いとき）
    const onKey = (e) => {
      if (!el.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if ((e.key === 'Enter' || e.key === ' ') && (e.target === document.body || e.target === document.documentElement)) {
        e.preventDefault(); snd('tap'); fire();
      }
    };
    document.addEventListener('keydown', onKey);
    applyInteractive();
    return el;
  }

  function fire() {
    if (!wheel || !interactive || wheel.fired) return;
    wheel.fired = true;
    setInteractive(false);
    turnCb?.();
  }

  function applyInteractive() {
    if (!wheel) return;
    wheel.el.classList.toggle('off', !interactive);
    const go = wheel.el.querySelector('.go');
    if (go) go.disabled = !interactive;
  }
  function setInteractive(on) { interactive = !!on; applyInteractive(); }

  // ---------- 空転（保存待ち〜シャッターが覆うまで。rAF はこの間だけ） ----------
  function startSpin() {
    stopSpin();
    if (!wheel) return;
    const w = wheel;
    const dir = (w.v ?? 1) < 0 ? -1 : 1;
    w.net = dir * THRESHOLD_DEG;
    w.render();
    snd('spin');
    const t0 = performance.now();
    const w0 = Math.min(500, Math.abs(w.v || 0));
    spin = { last: t0, tick: 0, raf: 0 };
    const loop = (t) => {
      if (!spin) return;
      const dt = Math.min(0.05, (t - spin.last) / 1000);
      spin.last = t;
      const speed = Math.min(900, w0 + 2000 * ((t - t0) / 1000));
      const d = speed * dt * dir;
      w.angle += d;
      w.svg.style.transform = `rotate(${w.angle}deg)`;
      spin.tick += Math.abs(d);
      while (spin.tick >= 45) { spin.tick -= 45; snd('tick'); }
      spin.raf = requestAnimationFrame(loop);
    };
    spin.raf = requestAnimationFrame(loop);
  }
  function stopSpin() {
    if (spin) cancelAnimationFrame(spin.raf);
    spin = null;
  }
  function abort() {
    clearTimers();
    stopSpin();
    if (wheel) { wheel.fired = false; wheel.net = 0; wheel.render?.(); }
  }

  // ---------- 結果の組み立て ----------
  function norm(r) {
    const tier = TIERS[r.tier] ? r.tier : 'sticker';
    return { tier, categoryName: String(r.categoryName ?? ''), prizeName: String(r.prizeName ?? ''), label: String(r.label ?? '') };
  }

  function buildResult(r) {
    const T = TIERS[r.tier];
    stageEl.classList.remove('t-sponsor', 't-rare', 't-sticker');
    stageEl.classList.add(`t-${r.tier}`);
    $('#m-mid').textContent = T.mid;
    const chars = [...r.categoryName];
    catEl.innerHTML = splitChars(r.categoryName);
    catEl.style.setProperty('--kd', `${Math.max(14, Math.min(70, Math.floor(420 / Math.max(1, chars.length - 1))))}ms`);
    prizeEl.textContent = r.prizeName;
    $('#lotno').textContent = r.label;
    numEl.querySelector('b').textContent = r.label.includes('-') ? r.label.split('-').pop() : r.label;
    htEl.innerHTML = r.tier === 'sponsor' ? halftone(236, 168) : '';
    if (r.tier === 'sponsor') buildCard(r);
  }

  // タイトルカードの行分け：文節の切れ目を優先（1文節が長すぎるときだけ文字で割る）
  function splitLines(name, lines) {
    const n = [...name].length;
    if (lines <= 1) return [name];
    const target = lines === 2 ? Math.floor(n / 2) : Math.ceil(n / 3);
    const pieces = [];
    for (const ph of splitPhrases(name)) {
      if ([...ph].length > target * 1.3) pieces.push(...[...ph]); else pieces.push(ph);
    }
    const out = [];
    let cur = '';
    for (const pc of pieces) {
      if (cur && [...cur].length + [...pc].length > target && out.length < lines - 1) { out.push(cur); cur = ''; }
      cur += pc;
    }
    if (cur) out.push(cur);
    return out;
  }

  function buildCard(r) {
    const chars = [...r.categoryName];
    const n = chars.length;
    const lines = n <= 3 ? 1 : n <= 8 ? 2 : 3;
    const parts = splitLines(r.categoryName, lines);
    let k = 0;
    bigEl.innerHTML = parts.map((p) => { const h = `<span class="ln">${splitChars(p, k)}</span>`; k += [...p].length; return h; }).join('');
    cardEl.style.setProperty('--kd', `${Math.max(14, Math.min(80, Math.floor(400 / Math.max(1, n - 1))))}ms`);
    cardEl.querySelector('.cap.a').textContent = TIERS.sponsor.mid;
    cardEl.querySelector('.cap.b').textContent = `電波祭 2026 / ${r.label}`;
    cardEl.querySelector('.cap.c').textContent = TIERS.sponsor.capC;
    cardEl.dataset.lines = String(parts.length);
  }

  function fitWidth(el, base, maxW) {
    el.style.fontSize = `${base}px`;
    const w = el.offsetWidth;
    if (w > maxW && w > 0) el.style.fontSize = `${Math.max(24, Math.floor((base * maxW) / w))}px`;
    return parseFloat(el.style.fontSize);
  }

  function fitPrize(text, base, maxW, maxH, minOne) {
    prizeEl.classList.remove('multi', 'anywhere');
    prizeEl.style.width = '';
    prizeEl.textContent = text;
    prizeEl.style.fontSize = `${base}px`;
    const w = prizeEl.offsetWidth;
    const one = w > maxW ? Math.floor((base * maxW) / w) : base;
    if (one >= minOne || text.length < 2) { prizeEl.style.fontSize = `${Math.max(24, one)}px`; return; }
    // 1行では小さくなりすぎる → 文節の切れ目でだけ折り返す（最後の手段）
    prizeEl.classList.add('multi');
    prizeEl.style.width = `${maxW}px`;
    prizeEl.innerHTML = splitPhrases(text).map((p) => `<span class="pp">${esc(p)}</span>`).join('');
    const fits = () => prizeEl.scrollWidth <= maxW + 1 && prizeEl.offsetHeight <= maxH;
    let s = Math.min(base, 96);
    for (; s >= 36; s -= 2) { prizeEl.style.fontSize = `${s}px`; if (fits()) break; }
    if (!fits()) {
      // 1文節が長すぎる場合だけ文字単位で折り返す
      prizeEl.classList.add('anywhere');
      for (s = Math.min(base, 72); s >= 28; s -= 2) { prizeEl.style.fontSize = `${s}px`; if (fits()) break; }
    }
  }

  // タイトルカードの文字：幅と高さに収まる最大サイズ（賞の名称はスタッフが編集できるので固定値にしない）
  function fitCard() {
    const { W, H } = geo;
    const lines = Number(cardEl.dataset.lines) || 1;
    const base = lines === 1 ? 400 : 338;
    bigEl.style.fontSize = `${base}px`;
    const w = bigEl.offsetWidth;
    if (!w) return;
    const byW = (W - 24 - 36) / w;
    const byH = (H - 54 - 76) / (lines * 0.88 * base);
    bigEl.style.fontSize = `${Math.max(24, Math.floor(base * Math.min(1, byW, byH)))}px`;
  }

  function layoutResult() {
    if (!cur) return;
    const { W, H, portrait: P } = geo;
    if (cur.tier === 'sponsor') fitCard();
    const T = TIERS[cur.tier];
    const k = P ? 'p' : 'l';
    // 賞の名称
    const catMax = P ? W - 80 : cur.tier === 'sponsor' ? W - 80 - 236 - 24 : cur.tier === 'sticker' ? W - 80 - 280 : W - 80;
    const cs = fitWidth(catEl, T.base[k], catMax);
    const catTop = P ? 150 : 76;
    const ruleTop = Math.round(catTop + cs + 18);
    const prizeTop = ruleTop + 58;
    const panelTop = H - (P ? 150 + 200 : 130 + 210);
    // 景品名（1行に収める。収まらなければ縮め、それでも小さすぎれば文節で折り返す）
    prizeEl.style.top = `${prizeTop}px`;
    fitPrize(cur.prizeName, T.prize[k], W - 80, Math.max(90, panelTop - prizeTop - 24), P ? 58 : 66);
    // 縦置きは余白が大きいので、見出し〜景品名のかたまりを上下の余白の中ほどに寄せる
    let dy = 0;
    if (P) {
      const blockH = prizeTop + prizeEl.offsetHeight - 74;
      dy = Math.max(0, Math.round((panelTop - 74 - 24 - blockH) * 0.42));
    }
    catEl.style.top = `${catTop + dy}px`;
    ruleEl.style.top = `${ruleTop + dy}px`;
    plabelEl.style.top = `${ruleTop + 28 + dy}px`;
    prizeEl.style.top = `${prizeTop + dy}px`;
    if (!P) {
      numEl.style.top = `${ruleTop - 122}px`;
      htEl.style.height = `${Math.max(60, Math.min(168, ruleTop - 12 - 78))}px`;
    } else {
      numEl.style.top = `${74 + dy}px`;
      htEl.style.top = `${74 + dy}px`;
      htEl.style.height = '';
    }
  }

  // ---------- 演出 ----------
  async function playReveal(raw) {
    clearTimers();
    const r = norm(raw);
    const TL = TIMELINE[r.tier];
    stageEl.classList.remove('playing', 'leaving');
    cur = r;
    stageEl.dataset.screen = 'seq';
    buildResult(r);
    await fontsReady(1000);
    geo = fitStage(stageEl);
    layoutResult();
    void stageEl.offsetWidth;
    stageEl.classList.add('playing');

    let finish;
    const done = new Promise((res) => { finish = res; });
    if (fast) {
      later(40, stopSpin);
      later(480, finish);
    } else {
      TL.shutter.forEach((t) => later(t, () => snd('wipe')));
      later(TL.cv + 30, stopSpin);
      if (r.tier === 'sponsor') {
        later(TL.cv + 120, () => snd('slam'));
        later(TL.cv + 120 + 3 * 80, () => snd('slam'));
        later(TL.cardOut, () => snd('wipe'));
      }
      later(TL.r0 + TL.cat, () => snd(TIERS[r.tier].sound));
      later(TL.r0 + TL.stamp + 150, () => snd('slam'));
      const onEnd = (e) => { if (e.target === staffEl && e.animationName === 'clipR') finish(); };
      staffEl.addEventListener('animationend', onEnd);
      later(TL.r0 + TL.staff + STAFF_DUR + 500, finish);
      done.then(() => staffEl.removeEventListener('animationend', onEnd));
    }
    await done;
    clearTimers();
    stopSpin();
    stageEl.dataset.screen = 'result';
    stageEl.classList.remove('playing');
  }

  function showResultStatic(raw) {
    clearTimers();
    stopSpin();
    const r = norm(raw);
    cur = r;
    stageEl.classList.remove('playing', 'leaving');
    stageEl.dataset.screen = 'result';
    buildResult(r);
    layoutResult();
    fontsReady(1500).then(() => { if (cur === r) { geo = fitStage(stageEl); layoutResult(); } });
  }

  async function reset() {
    clearTimers();
    stopSpin();
    if (cur && !fast) {
      stageEl.classList.add('leaving');
      await new Promise((res) => setTimeout(res, 330));
    }
    stageEl.classList.remove('playing', 'leaving', 't-sponsor', 't-rare', 't-sticker');
    stageEl.dataset.screen = 'idle';
    cur = null;
    staffEl.replaceChildren();
  }

  return {
    wheelScreen,
    onTurn(cb) { turnCb = cb; },
    setInteractive,
    startSpin,
    abort,
    playReveal,
    showResultStatic,
    reset,
    resultActionsEl: staffEl,
    setDay(text) { stageEl.style.setProperty('--day', JSON.stringify(text || '')); },
  };
}
