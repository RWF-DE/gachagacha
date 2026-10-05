// プレイヤー画面の状態機械と統合（DESIGN.md §4/§5/§9）
// 方針: 抽選の確定・保存は db.draw() だけが行い、演出は保存完了「後」に始める。
import * as db from './db.js';
import { sound } from './sound.js';
import { createStage } from './stage.js';
import { chooseScreen, studentScreen, infoScreen, jp } from './screens.js';
import { dayText } from './poster.js';
import { normalizeStudentId, validateStudentId, describeIdRule } from './lottery.js';
import { h, longPress } from './util.js';
import { LONG_PRESS_OK_MS, LONG_PRESS_ADMIN_MS, IDLE_RESET_MS } from './config.js';
import * as admin from './admin.js';

const params = new URLSearchParams(location.search);
const FAST = params.get('fast') === '1';
const REDUCED = FAST || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

const $ = (sel) => document.querySelector(sel);
const host = $('#screen-host');

let stage = null;
let introPlayed = false;   // 起動後の最初の待機画面だけ、タイトルの登場演出を付ける
let config = null;
let state = 'boot';        // boot | choose | student | wheel | drawing | result | closed | error | fatal
let kind = null;           // 'student' | 'guest'（抽選前だけ保持）
let studentId = null;      // 正規化済み。メモリ内のみ。URL/console/DOM属性には出さない
let navToken = 0;          // 画面遷移ごとに増やし、古い非同期結果を無視する
let drawing = false;       // 抽選開始ガード（1回だけ）
let idleTimer = 0;

const MSG_USED = 'この学籍番号では/参加済みです。/スタッフに/確認してください';
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

function mount(el) {
  host.replaceChildren(el);
  return el;
}

const setMsg = (el, ...parts) => el.replaceChildren(...jp(...parts));

// ---------- 各画面 ----------
function showChoose() {
  setState('choose');
  kind = null; studentId = null; drawing = false;
  safe(() => stage.setInteractive(false));
  mount(chooseScreen({
    intro: !introPlayed && !REDUCED,
    onStudent: () => { play('tap'); showStudent(); },
    onGuest: () => { play('tap'); kind = 'guest'; showWheel(); },
  }));
  introPlayed = true;
}

function showStudent(message = '') {
  setState('student');
  kind = 'student'; studentId = null;
  safe(() => stage.setInteractive(false));
  const rule = config.studentIdRule;
  let busy = false;
  let msg;

  const submit = async (raw) => {
    if (busy) return;
    const id = normalizeStudentId(raw);
    if (!validateStudentId(id, rule).ok) {
      setMsg(msg, '学籍番号は', describeIdRule(rule), 'で/入力してください');
      play('error');
      return;
    }
    busy = true;
    const token = navToken;
    let used;
    try { used = await db.isStudentUsed(id); } catch {
      busy = false;
      setMsg(msg, '確認できませんでした。/もう一度/お試しください');
      return;
    }
    busy = false;
    if (token !== navToken || state !== 'student') return;
    if (used) {
      setMsg(msg, MSG_USED);
      play('error');
      return;
    }
    studentId = id;
    showWheel();
  };

  const screen = studentScreen({ rule, onSubmit: submit, onBack: () => { play('tap'); showChoose(); } });
  msg = screen.msg;
  if (message) setMsg(msg, message);
  mount(screen.el);
}

function showWheel() {
  setState('wheel');
  drawing = false;
  mount(stage.wheelScreen({ onBack: () => { if (state === 'wheel' && !drawing) { play('tap'); showChoose(); } } }));
  safe(() => stage.setInteractive(true));
}

function showClosed() {
  setState('closed');
  kind = null; studentId = null;
  safe(() => stage.setInteractive(false));
  mount(infoScreen({
    name: 'closed', title: '本日の抽選は/終了しました', lead: 'たくさんの/ご参加/ありがとうございました！', tagged: true,
  }));
}

function showError(text = '保存できませんでした。/スタッフを/呼んでください') {
  setState('error');
  safe(() => stage.setInteractive(false));
  mount(infoScreen({
    name: 'error', tone: 'alert', title: text, small: true,
    lead: '景品は/決まっていません。/もう一度/はじめから/お試しください。',
    actions: [{ label: '最初にもどる', solid: true, testid: 'error-back', onClick: () => refresh() }],
  }));
}

function showFatal() {
  setState('fatal');
  mount(infoScreen({
    name: 'fatal', title: 'データを/開けません', small: true, lead: 'スタッフを/呼んでください。',
    actions: [{ label: '再読み込み', solid: true, onClick: () => location.reload() }],
  }));
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
  setState('drawing');   // 舵輪の画面はそのまま。空転しながら保存の完了を待つ
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
    if (code === 'ALREADY_USED') return showStudent(MSG_USED);
    if (code === 'BOX_EMPTY') return showClosed();
    if (code === 'PENDING_EXISTS') return refresh();
    return showError();
  }
  studentId = null; // 保存後は学籍番号をメモリからも消す
  state = 'result';
  try {
    await stage.playReveal(toReveal(result));
  } catch { /* 演出が失敗しても結果は保存済み。下で静的表示に切り替える */
    safe(() => stage.showResultStatic(toReveal(result)));
  }
  host.replaceChildren();
  mountOkButton(result.id, result.kind);
}

// ---------- スタッフOK（長押し） ----------
const OK_LABEL = 'お渡し済み・OK（1秒長押し）';

function mountOkButton(drawId, drawKind) {
  const status = h('p', { class: 'ok-status', role: 'alert', 'data-testid': 'ok-status' });
  const btn = h('button', { type: 'button', class: 'ok-btn', 'data-testid': 'ok-button' },
    h('span', { class: 'fill' }),
    h('span', { class: 'lbl' }, OK_LABEL),
    h('span', { class: 'lbl inv', 'aria-hidden': 'true' }, OK_LABEL));
  let finished = false;
  longPress(btn, {
    ms: LONG_PRESS_OK_MS,
    onProgress: (p) => { btn.style.setProperty('--p', p); },
    onComplete: async () => {
      if (finished) return;
      finished = true;
      btn.disabled = true;
      try {
        await db.confirmDraw(drawId);
      } catch {
        finished = false;
        btn.disabled = false;
        setMsg(status, '保存できませんでした。/もう一度/長押ししてください');
        return;
      }
      play('tap');
      try { await stage.reset(); } catch { /* noop */ }
      stage.resultActionsEl.replaceChildren();
      await refresh();
    },
  });
  // 一般の方（kind==='guest'）だけ、スタッフ向けに「印を付けてからOK」を出す（運用ルール：1人1回は印で管理）
  const note = drawKind === 'guest'
    ? h('p', { class: 'staff-note', 'data-testid': 'staff-note' },
      h('span', { class: 'sn-k' }, 'STAFF'), '一般の方：印（スタンプ/シール）を付けてからOK')
    : null;
  stage.resultActionsEl.replaceChildren(...(note ? [note] : []), btn, status);
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
    try { stage.setDay(dayText(config, await db.getActiveDayId())); } catch { /* 飾りなので失敗しても続行 */ }
    const pending = await db.getPendingDraw();
    if (pending) {
      // 未確認の抽選がある間は新規抽選させない。結果を再表示してスタッフOKを待つ。
      setState('result');
      safe(() => stage.setInteractive(false));
      host.replaceChildren();
      safe(() => stage.showResultStatic(toReveal(pending)));
      mountOkButton(pending.id, pending.kind);
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
