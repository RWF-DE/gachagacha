// プレイヤー画面の状態機械と統合（DESIGN.md §4/§5/§9）
// 方針: 抽選の確定・保存は db.draw() だけが行い、演出は保存完了「後」に始める。
import * as db from './db.js';
import { sound } from './sound.js';
import { createStage } from './stage.js';
import { chooseScreen, studentScreen, surveyAgeScreen, surveyTriggerScreen, infoScreen, jp } from './screens.js';
import { dayText, fitHeader } from './poster.js';
import { normalizeStudentId, validateStudentId, describeIdRule } from './lottery.js';
import { h, longPress } from './util.js';
import {
  LONG_PRESS_OK_MS, LONG_PRESS_ADMIN_MS, IDLE_RESET_MS, SURVEY_VERSION, SURVEY_ADVANCE_MS,
} from './config.js';
import { templateConfig, TIER_LATIN, YOSORO_TIER_LATIN } from './templates.js';
import { applyTheme, resolveTheme } from './theme.js';
import { getMotif } from './motifs.js';
import * as admin from './admin.js';

const params = new URLSearchParams(location.search);
const FAST = params.get('fast') === '1';
const REDUCED = FAST || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

const $ = (sel) => document.querySelector(sel);
const host = $('#screen-host');

let stage = null;
let introPlayed = false;   // 起動後の最初の待機画面だけ、タイトルの登場演出を付ける
let config = null;
let state = 'boot';        // boot | choose | student | survey-age | survey-trigger | wheel | drawing | result | closed | error | fatal
let kind = null;           // 'student' | 'guest'（抽選前だけ保持）
let studentId = null;      // 正規化済み。メモリ内のみ。URL/console/DOM属性には出さない
let survey = null;         // 一般の方のアンケート回答 {age:id|null, triggers:[id]}。メモリ内のみ（抽選の保存まで何も書かない）
let navToken = 0;          // 画面遷移ごとに増やし、古い非同期結果を無視する
let drawing = false;       // 抽選開始ガード（1回だけ）
let idleTimer = 0;

const MSG_USED = 'この学籍番号では/参加済みです。/スタッフに/確認してください';
const safe = (fn) => { try { return fn(); } catch { /* 演出系の失敗で運用を止めない */ } };
const play = (name) => safe(() => sound.play(name));

// ---------- 見た目の設定（配色・回すもの・名前と文言・参加の方法・アンケート。docs/CUSTOMIZE.md §5〜§7） ----------
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v, d, min = 0) => (typeof v === 'string' && [...v].length >= min ? v : d);   // 文字列（min 字以上）だけ使い、それ以外は既定
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/**
 * config から見た目の設定を取り出す。足りない項目・形の違う項目はテンプレート denpasai-2026（＝よーそろ）の値で補う
 * （データ層の正規化が入る前の v1 config が来る間の橋渡し。正規化済みの config には補う項目が無く、そのまま返る）。
 */
function lookOf(cfg) {
  const d = templateConfig('denpasai-2026').config;
  const c = obj(cfg);
  const b = obj(c.brand);
  const e = obj(c.entry);
  const s = obj(c.survey);
  const way = (k) => { const x = obj(e[k]); const w = d.entry[k]; return { enabled: bool(x.enabled, w.enabled), title: str(x.title, w.title, 1), sub: str(x.sub, w.sub) }; };
  const q = (k) => {
    const x = obj(s[k]);
    const w = d.survey[k];
    const ok = Array.isArray(x.options) && x.options.length >= 2 && x.options.every((o) => o && typeof o.id === 'string' && typeof o.label === 'string');
    return { heading: str(x.heading, w.heading, 1), short: str(x.short, w.short, 1), options: ok ? x.options : w.options };
  };
  const entry = { student: way('student'), guest: way('guest') };
  if (!entry.student.enabled && !entry.guest.enabled) entry.student.enabled = entry.guest.enabled = true;   // 入口がなくなる設定は無効
  // 賞の欧文：v1 の config には無いので、よーそろの系統別ラベルで補う
  const cats = (Array.isArray(c.categories) ? c.categories : []).map((x) => ({
    id: x?.id, tier: x?.tier, latin: typeof x?.latin === 'string' ? x.latin : (YOSORO_TIER_LATIN[x?.tier] ?? ''),
  }));
  return {
    eventName: str(c.eventName, d.eventName, 1),
    brand: {
      name: str(b.name, d.brand.name, 1),
      nameLatin: str(b.nameLatin, d.brand.nameLatin),
      eventLabel: str(b.eventLabel, d.brand.eventLabel),
      eventLatin: str(b.eventLatin, d.brand.eventLatin),
      tagline: str(b.tagline, d.brand.tagline),
      prizeWord: str(b.prizeWord, d.brand.prizeWord, 1),
      wordmark: 'wordmark' in b ? b.wordmark : d.brand.wordmark,   // null（手詰めなし）も設定の値。形の検証は screens.js tunedOf
    },
    theme: { preset: str(obj(c.theme).preset, d.theme.preset), custom: obj(c.theme).custom ?? null },
    motif: str(c.motif, d.motif),
    entry,
    survey: { enabled: bool(s.enabled, d.survey.enabled), notice: str(s.notice, d.survey.notice), q1: q('q1'), q2: q('q2') },
    /** 結果画面に出す賞の欧文。今の config から categoryId で引く（飾りなので。賞が消えていれば系統の既定） */
    latinFor: (categoryId, tier) => {
      const cat = cats.find((x) => x.id === categoryId);
      return (cat && cat.latin) || TIER_LATIN[cat?.tier ?? tier] || '';
    },
  };
}

let look = lookOf(null);   // 今の見た目の設定（画面の組み立てに渡す）
let lookKey = '';

/**
 * 見た目の設定を画面に反映する：配色（CSS 変数・theme-color）・回すもの・文言（stage）・ロゴ・タブのタイトル。
 * refresh() から、どの画面も出す前に呼ぶ。演出中には呼ばない（スタッフ画面は演出中に開けないので、そこからの変更も安全）。
 * 配色・回すもの・名前が前回と同じなら何もしない（抽選のたびに <html> のスタイルを書き直さない）。
 */
function applyLook(cfg) {
  look = lookOf(cfg);
  const key = JSON.stringify([look.eventName, look.brand, look.theme, look.motif]);
  if (key === lookKey) return;
  lookKey = key;
  const { brand } = look;
  safe(() => applyTheme(resolveTheme(look.theme)));
  safe(() => stage.setMotif(look.motif));
  safe(() => stage.setBrand(brand));
  safe(() => {
    const logo = $('#logo');
    logo.setAttribute('aria-label', brand.name);
    // ロゴ横の文字「{eventLabel} / {eventLatin}」。縦置きでは欧文だけ（和文は .jp で隠れる）。片方が空ならもう片方だけ（隠さない）
    const text = logo.querySelector('.logo-text');
    if (brand.eventLabel && brand.eventLatin) text.replaceChildren(h('span', { class: 'jp' }, `${brand.eventLabel} / `), brand.eventLatin);
    else text.replaceChildren(brand.eventLabel || brand.eventLatin || '');
    fitHeader($('#stage'));   // ロゴの長さが変わったので、ヘッダ帯の重なりを調べ直す
  });
  safe(() => {
    document.title = `${brand.name}｜${look.eventName}`;
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', brand.name);
  });
}

// ---------- 画面遷移の共通処理 ----------
// 入力途中で放置されたら待機へ戻す画面（アンケートを含む）
const IDLE_STATES = new Set(['student', 'survey-age', 'survey-trigger', 'wheel']);

function setState(next) {
  state = next;
  navToken++;
  clearTimeout(idleTimer);
  if (IDLE_STATES.has(next)) armIdle();
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (IDLE_STATES.has(state)) showChoose();
  }, IDLE_RESET_MS);
}

function mount(el) {
  host.replaceChildren(el);
  safe(() => fitHeader($('#stage')));   // ヘッダ帯の文字が長い名前で重なるときだけ調整（収まるなら何もしない）
  return el;
}

const setMsg = (el, ...parts) => el.replaceChildren(...jp(...parts));

// ---------- 各画面 ----------
function showChoose() {
  setState('choose');
  kind = null; studentId = null; survey = null; drawing = false;
  safe(() => stage.setInteractive(false));
  mount(chooseScreen({
    intro: !introPlayed && !REDUCED,
    brand: look.brand,
    entry: look.entry,
    onStudent: () => { play('tap'); showStudent(); },
    onGuest: () => {
      play('tap');
      kind = 'guest';
      if (look.survey.enabled) { survey = { age: null, triggers: [] }; showSurveyAge(); } else { survey = null; showWheel(); }   // アンケートを使わない設定ではそのまま抽選へ
    },
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

  const screen = studentScreen({ rule, brand: look.brand, onSubmit: submit, onBack: () => { play('tap'); showChoose(); } });
  msg = screen.msg;
  if (message) setMsg(msg, message);
  mount(screen.el);
}

// 一般の方：Q1 年齢 → Q2 きっかけ → 舵輪。回答は survey（メモリ）に持ち、抽選の保存で初めて書く。
function showSurveyAge() {
  setState('survey-age');
  safe(() => stage.setInteractive(false));
  let timer = 0;
  const token = navToken;
  const { el } = surveyAgeScreen({
    survey: look.survey,
    brand: look.brand,
    selected: survey.age,
    onSelect: (id) => {
      if (state !== 'survey-age') return;
      play('tap');
      survey.age = id;
      clearTimeout(timer);   // 「選んだ」と見せてから進む。選び直しは最後のタップが有効
      timer = setTimeout(() => { if (state === 'survey-age' && token === navToken) showSurveyTrigger(); }, SURVEY_ADVANCE_MS);
    },
    onBack: () => { clearTimeout(timer); play('tap'); showChoose(); },
  });
  mount(el);
}

function showSurveyTrigger() {
  setState('survey-trigger');
  safe(() => stage.setInteractive(false));
  const { el } = surveyTriggerScreen({
    survey: look.survey,
    brand: look.brand,
    noun: getMotif(look.motif).noun,
    selected: survey.triggers,
    onChange: (ids) => { play('tap'); survey.triggers = ids; },
    onNext: () => { if (survey.age && survey.triggers.length) { play('tap'); showWheel(); } },
    onBack: () => { play('tap'); showSurveyAge(); },
  });
  mount(el);
}

/** 保存用の回答（Q2 の選択肢の並び順に整える）。検証は db.draw が行う。 */
const surveyPayload = () => ({
  v: SURVEY_VERSION,
  age: survey?.age ?? null,
  triggers: look.survey.q2.options.map((t) => t.id).filter((id) => survey?.triggers.includes(id)),
});

function showWheel() {
  setState('wheel');
  drawing = false;
  mount(stage.wheelScreen({
    onBack: () => {
      if (state !== 'wheel' || drawing) return;
      play('tap');
      if (kind === 'guest' && look.survey.enabled) showSurveyTrigger(); else showChoose();   // 一般の方は答えを残したまま Q2 へ（アンケートを使わない設定なら待機へ）
    },
  }));
  safe(() => stage.setInteractive(true));
}

function showClosed() {
  setState('closed');
  kind = null; studentId = null; survey = null;
  safe(() => stage.setInteractive(false));
  mount(infoScreen({
    brand: look.brand,
    name: 'closed', title: '本日の抽選は/終了しました', lead: 'たくさんの/ご参加/ありがとうございました！', tagged: true,
  }));
}

function showError(text = '保存できませんでした。/スタッフを/呼んでください') {
  setState('error');
  safe(() => stage.setInteractive(false));
  mount(infoScreen({
    brand: look.brand,
    name: 'error', tone: 'alert', title: text, small: true,
    lead: '景品は/決まっていません。/もう一度/はじめから/お試しください。',
    actions: [{ label: '最初にもどる', solid: true, testid: 'error-back', onClick: () => refresh() }],
  }));
}

function showFatal() {
  setState('fatal');
  mount(infoScreen({
    brand: look.brand,
    name: 'fatal', title: 'データを/開けません', small: true, lead: 'スタッフを/呼んでください。',
    actions: [{ label: '再読み込み', solid: true, onClick: () => location.reload() }],
  }));
}

// ---------- 抽選 ----------
const toReveal = (d) => ({
  tier: d.tier, categoryName: d.categoryName, prizeName: d.prizeName, label: d.label, reduced: REDUCED,
  categoryLatin: look.latinFor(d.categoryId, d.tier),   // 賞の欧文は今の config から引く（飾りなので抽選記録には持たない）
});

async function onTurn() {
  // 二重発火ガード：ここを通れるのは「舵輪画面で未抽選」のときだけ
  if (state !== 'wheel' || drawing) return;
  drawing = true;
  const myKind = kind;
  const myId = studentId;
  const mySurvey = myKind === 'guest' && look.survey.enabled ? surveyPayload() : undefined;   // アンケートを使わない設定では付けない（付けると拒否される）
  setState('drawing');   // 舵輪の画面はそのまま。空転しながら保存の完了を待つ
  safe(() => stage.startSpin());
  let result;
  try {
    result = await db.draw({ kind: myKind, studentId: myId, survey: mySurvey }); // complete まで待つ
  } catch (e) {
    studentId = null; survey = null;
    safe(() => stage.abort());
    drawing = false;
    play('error');
    const code = e && e.code;
    if (code === 'ALREADY_USED') return showStudent(MSG_USED);
    if (code === 'BOX_EMPTY') return showClosed();
    if (code === 'PENDING_EXISTS') return refresh();
    return showError();
  }
  studentId = null; survey = null; // 保存後は学籍番号・アンケート回答をメモリからも消す
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
    await db.migrateGamjaPrizeName();
    config = await db.getConfig();
    applyLook(config);   // 配色・回すもの・文言。どの画面を出すより前に（演出中には呼ばない）
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
  // 未確認の結果を表示中に開いた場合：まだ未確認なら結果画面はそのまま残す（配色・文言の変更だけ反映する）
  if (wasResult && (await db.getPendingDraw().catch(() => null))) {
    try { config = await db.getConfig(); applyLook(config); } catch { /* 飾りなので失敗しても結果画面はそのまま */ }
    return;
  }
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
  // 音の解錠は sound.js が自分でやる（pointerup / touchend / click / keydown の中で AudioContext を作って resume）。
  // iPad のタッチでは pointerdown は音声の解錠にならないので、ここでは待機リセット用の操作検知だけを行う。
  document.addEventListener('pointerdown', () => {
    if (IDLE_STATES.has(state)) armIdle();
  }, { capture: true });
  stage = createStage($('#stage'), { sound, reducedMotion: REDUCED });
  stage.onTurn(onTurn);
  stage.setInteractive(false);
  // 画面の大きさが変わったら、ヘッダ帯を測り直す（stage の拡縮の更新より後に登録＝後に走る。演出中は測らない）
  addEventListener('resize', () => { if (state !== 'drawing') safe(() => fitHeader($('#stage'))); });
  longPress($('#logo'), {
    ms: LONG_PRESS_ADMIN_MS,
    onProgress: (p) => $('#logo').style.setProperty('--p', p),
    onComplete: openAdmin,
  });
  safe(() => db.requestPersist());
  await refresh();
}

main();
