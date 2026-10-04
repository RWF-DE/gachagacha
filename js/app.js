// プレイヤー画面の状態機械と統合（DESIGN.md §4/§5/§9.1）
// 方針: 抽選の確定・保存は db.draw() だけが行い、演出は保存完了「後」に始める。
import * as db from './db.js';
import { createScene } from './scene.js';
import { sound } from './sound.js';
import { createStage } from './stage.js';
import { normalizeStudentId, validateStudentId, describeIdRule } from './lottery.js';
import { h, longPress } from './util.js';
import { createTenkey } from './ui.js';
import { LONG_PRESS_OK_MS, LONG_PRESS_ADMIN_MS, IDLE_RESET_MS } from './config.js';
import * as admin from './admin.js';

const params = new URLSearchParams(location.search);
const FAST = params.get('fast') === '1';
const REDUCED = FAST || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

const $ = (sel) => document.querySelector(sel);
const host = $('#screen-host');

let scene = null;
let stage = null;
let config = null;
let state = 'boot';        // boot | choose | student | wheel | drawing | result | closed | error | fatal
let kind = null;           // 'student' | 'guest'（抽選前だけ保持）
let studentId = null;      // 正規化済み。メモリ内のみ。URL/console/DOM属性には出さない
let navToken = 0;          // 画面遷移ごとに増やし、古い非同期結果を無視する
let drawing = false;       // 抽選開始ガード（1回だけ）
let idleTimer = 0;

const safe = (fn) => { try { return fn(); } catch { /* 演出系の失敗で運用を止めない */ } };
const play = (name) => safe(() => sound.play(name));

// ---------- 画面遷移の共通処理 ----------
function setState(next) {
  state = next;
  navToken++;
  clearTimeout(idleTimer);
  if (next === 'student' || next === 'wheel') armIdle();
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state === 'student' || state === 'wheel') showChoose();
  }, IDLE_RESET_MS);
}

function mount(name, ...children) {
  const el = h('section', { class: `screen screen--${name}`, 'data-testid': `screen-${name}` }, ...children);
  host.replaceChildren(el);
  return el;
}

const bigButton = (label, onclick, { kind = 'primary', testid, sub } = {}) =>
  h('button', { type: 'button', class: `btn btn--${kind} btn--xl`, 'data-testid': testid, onclick: () => { play('tap'); onclick(); } },
    h('span', { class: 'btn-label' }, label), sub ? h('span', { class: 'btn-sub' }, sub) : null);

// ---------- 各画面 ----------
function showChoose() {
  setState('choose');
  kind = null; studentId = null; drawing = false;
  safe(() => { stage.setInteractive(false); stage.setAttract(true); scene.setMood('idle'); });
  mount('choose',
    h('p', { class: 'eyebrow' }, config.eventName),
    h('h1', { class: 'title' }, 'お宝ガチャ'),
    h('p', { class: 'lead' }, 'おひとり1回・参加無料'),
    h('div', { class: 'choices' },
      bigButton('本校の学生', () => showStudent(), { testid: 'choose-student', sub: '学籍番号を入力します' }),
      bigButton('本校学生以外の方', () => { kind = 'guest'; showWheel(); }, { testid: 'choose-guest', kind: 'secondary', sub: '入力は不要です' })),
  );
}

function showStudent(message = '') {
  setState('student');
  kind = 'student'; studentId = null;
  safe(() => { stage.setInteractive(false); stage.setAttract(true); });
  const rule = config.studentIdRule;
  const msg = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'student-error' }, message);
  let busy = false;

  const submit = async (raw) => {
    if (busy) return;
    const id = normalizeStudentId(raw);
    if (!validateStudentId(id, rule).ok) {
      msg.textContent = `学籍番号は${describeIdRule(rule)}で入力してください`;
      play('error');
      return;
    }
    busy = true;
    const token = navToken;
    let used;
    try { used = await db.isStudentUsed(id); } catch {
      busy = false;
      msg.textContent = '確認できませんでした。もう一度お試しください';
      return;
    }
    busy = false;
    if (token !== navToken || state !== 'student') return;
    if (used) {
      msg.textContent = 'この学籍番号では参加済みです。スタッフに確認してください';
      play('error');
      return;
    }
    studentId = id;
    showWheel();
  };

  let input;
  if (rule.charset === 'alnum') {
    // 英数字ルールのときだけシステムキーボードを使う
    const field = h('input', {
      type: 'text', class: 'id-input', maxLength: rule.maxLength, placeholder: '学籍番号を入力',
      inputmode: 'text', autocapitalize: 'characters', autocorrect: 'off', spellcheck: false,
      autocomplete: 'off', 'data-testid': 'student-input',
      onkeydown: (e) => { if (e.key === 'Enter') submit(field.value); },
    });
    input = h('div', { class: 'id-alnum' }, field,
      h('button', { type: 'button', class: 'btn btn--primary btn--lg', 'data-testid': 'student-submit', onclick: () => submit(field.value) }, '決定'));
  } else {
    input = createTenkey({ maxLength: rule.maxLength, placeholder: '学籍番号', onSubmit: submit, testid: 'tenkey' }).el;
  }

  mount('student',
    h('h1', { class: 'title title--m' }, '学籍番号を入力してください'),
    input,
    msg,
    h('p', { class: 'note' }, '学籍番号は参加済みの確認だけに使います。'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--lg', 'data-testid': 'back', onclick: () => { play('tap'); showChoose(); } }, '← 戻る')),
  );
}

function showWheel() {
  setState('wheel');
  drawing = false;
  safe(() => { stage.setAttract(false); stage.setInteractive(true); });
  mount('wheel',
    h('h1', { class: 'title' }, '舵輪を回して、お宝を引こう！'),
    h('p', { class: 'lead' }, '舵輪をぐるっと回すか、「タップでまわす」を押してください。'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--lg', 'data-testid': 'back',
        onclick: () => { if (state === 'wheel' && !drawing) { play('tap'); showChoose(); } } }, '← 戻る')),
  );
}

function showDrawing() {
  setState('drawing');
  mount('drawing', h('h1', { class: 'title' }, 'お宝をさがしています…'));
}

function showClosed() {
  setState('closed');
  kind = null; studentId = null;
  safe(() => { stage.setInteractive(false); stage.setAttract(false); scene.setMood('calm'); });
  mount('closed',
    h('h1', { class: 'title' }, '本日の抽選は終了しました'),
    h('p', { class: 'lead' }, 'たくさんのご参加ありがとうございました！'),
  );
}

function showError(text = '保存できませんでした。スタッフを呼んでください') {
  setState('error');
  safe(() => stage.setInteractive(false));
  mount('error',
    h('h1', { class: 'title title--m' }, text),
    h('p', { class: 'lead' }, '景品は決まっていません。もう一度はじめからお試しください。'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary btn--lg', 'data-testid': 'error-back', onclick: () => refresh() }, '最初にもどる')),
  );
}

function showFatal() {
  setState('fatal');
  mount('fatal',
    h('h1', { class: 'title title--m' }, 'データを開けません'),
    h('p', { class: 'lead' }, 'スタッフを呼んでください。'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary btn--lg', onclick: () => location.reload() }, '再読み込み')),
  );
}

// ---------- 抽選 ----------
const toReveal = (d) => ({
  tier: d.tier, categoryName: d.categoryName, prizeName: d.prizeName, label: d.label, reduced: REDUCED,
});

async function onTurn() {
  // 二重発火ガード：ここを通れるのは「舵輪画面で未抽選」のときだけ
  if (state !== 'wheel' || drawing) return;
  drawing = true;
  const myKind = kind;
  const myId = studentId;
  showDrawing();
  safe(() => stage.startSpin());
  let result;
  try {
    result = await db.draw({ kind: myKind, studentId: myId }); // complete まで待つ
  } catch (e) {
    studentId = null;
    safe(() => stage.abort());
    drawing = false;
    play('error');
    const code = e && e.code;
    if (code === 'ALREADY_USED') return showStudent('この学籍番号では参加済みです。スタッフに確認してください');
    if (code === 'BOX_EMPTY') return showClosed();
    if (code === 'PENDING_EXISTS') return refresh();
    return showError();
  }
  studentId = null; // 保存後は学籍番号をメモリからも消す
  state = 'result';
  mount('result', h('h1', { class: 'title title--m' }, '結果をスタッフにお見せください'));
  safe(() => scene.setMood('celebrate'));
  try {
    await stage.playReveal(toReveal(result));
  } catch { /* 演出が失敗しても結果は保存済み。下で静的表示に切り替える */
    safe(() => stage.showResultStatic(toReveal(result)));
  }
  mountOkButton(result.id);
}

// ---------- スタッフOK（長押し） ----------
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function mountOkButton(drawId) {
  const R = 24, C = 2 * Math.PI * R;
  const fg = svgEl('circle', { class: 'ring-fg', cx: 28, cy: 28, r: R, fill: 'none', 'stroke-width': 6,
    'stroke-dasharray': C, 'stroke-dashoffset': C, 'stroke-linecap': 'round', transform: 'rotate(-90 28 28)' });
  const ring = svgEl('svg', { class: 'ok-ring', viewBox: '0 0 56 56', 'aria-hidden': 'true' });
  ring.append(svgEl('circle', { class: 'ring-bg', cx: 28, cy: 28, r: R, fill: 'none', 'stroke-width': 6 }), fg);
  const status = h('p', { class: 'ok-status', role: 'alert', 'data-testid': 'ok-status' });
  const btn = h('button', { type: 'button', class: 'ok-btn', 'data-testid': 'ok-button' },
    ring,
    h('span', { class: 'ok-text' },
      h('span', { class: 'ok-label' }, 'お渡し済み・OK'),
      h('span', { class: 'ok-hint' }, 'スタッフが1秒間 長押し')));
  let finished = false;
  longPress(btn, {
    ms: LONG_PRESS_OK_MS,
    onProgress: (p) => { fg.setAttribute('stroke-dashoffset', String(C * (1 - p))); btn.style.setProperty('--p', p); },
    onComplete: async () => {
      if (finished) return;
      finished = true;
      btn.disabled = true;
      try {
        await db.confirmDraw(drawId);
      } catch {
        finished = false;
        btn.disabled = false;
        status.textContent = '保存できませんでした。もう一度長押ししてください';
        return;
      }
      play('tap');
      try { await stage.reset(); } catch { /* noop */ }
      stage.resultActionsEl.replaceChildren();
      await refresh();
    },
  });
  stage.resultActionsEl.replaceChildren(btn, status);
}

// ---------- 起動・復旧 ----------
async function refresh() {
  try {
    if (state === 'result') {
      // 結果表示中にスタッフ画面で確認済みにした場合などの後始末
      try { await stage.reset(); } catch { /* noop */ }
      stage.resultActionsEl.replaceChildren();
    }
    if (!(await db.isSetUp())) {
      state = 'setup';
      await admin.openSetup();
      return refresh();
    }
    config = await db.getConfig();
    applySound();
    const pending = await db.getPendingDraw();
    if (pending) {
      // 未確認の抽選がある間は新規抽選させない。結果を再表示してスタッフOKを待つ。
      setState('result');
      safe(() => { stage.setInteractive(false); stage.setAttract(false); scene.setMood('celebrate'); });
      mount('result', h('h1', { class: 'title title--m' }, '結果をスタッフにお見せください'));
      safe(() => stage.showResultStatic(toReveal(pending)));
      mountOkButton(pending.id);
      return;
    }
    if ((await db.getBoxTotal()) <= 0) return showClosed();
    showChoose();
  } catch {
    showFatal();
  }
}

function applySound() {
  safe(() => {
    sound.setEnabled(config.sound?.enabled !== false);
    sound.setVolume(config.sound?.volume ?? 0.7);
  });
}

async function openAdmin() {
  if (state === 'drawing' || state === 'setup') return;
  const wasResult = state === 'result';
  safe(() => stage.setInteractive(false));
  await admin.open();
  // 未確認の結果を表示中に開いた場合：まだ未確認なら結果画面はそのまま残す
  if (wasResult && (await db.getPendingDraw().catch(() => null))) return;
  await refresh();
}

function hardenIpad() {
  // ピンチ・ダブルタップ拡大の抑止（CSS の touch-action と併用）
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input,textarea')) e.preventDefault(); });
  document.addEventListener('dblclick', (e) => e.preventDefault());
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 非HTTPS等。スタッフ画面で「未準備」と表示される */ });
  });
}

async function main() {
  hardenIpad();
  registerSW();
  let unlocked = false;
  document.addEventListener('pointerdown', () => {
    if (!unlocked) { unlocked = true; safe(() => sound.unlock()); } // iOS: 最初のユーザー操作で音を解錠
    if (state === 'student' || state === 'wheel') armIdle();
  }, { capture: true });
  scene = createScene($('#scene-bg'));
  stage = createStage($('#stage'), { sound, reducedMotion: REDUCED });
  stage.onTurn(onTurn);
  stage.setInteractive(false);
  longPress($('#logo'), {
    ms: LONG_PRESS_ADMIN_MS,
    onProgress: (p) => $('#logo').style.setProperty('--p', p),
    onComplete: openAdmin,
  });
  safe(() => db.requestPersist());
  await refresh();
}

main();
