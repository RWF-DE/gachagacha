// スタッフ画面（DESIGN.md §7 / docs/CUSTOMIZE.md §8）：PIN認証・初回セットアップ・状態・在庫・景品と日程・イベント・履歴・アンケート・バックアップ・設定
import * as db from './db.js';
import { sound } from './sound.js';
import { validateBackup } from './db.js';
import { PIN_MIN, PIN_MAX } from './config.js';
import { splitPhrases } from './poster.js';
import { aggregateSurvey, ageLabelOf, triggerLabelsOf, pct, UNANSWERED } from './survey.js';
import { LIMITS, newId, nextDayId, normalizeConfig, validateProfileFile } from './profile.js';
import { TEMPLATES, DEFAULT_TEMPLATE_ID, TIER_LATIN, templateConfig } from './templates.js';
import { THEMES, resolveTheme, applyTheme, contrastReport } from './theme.js';
import { MOTIFS, motifPreviewSvg } from './motifs.js';
import { h, hashPin, fmtDateTime, fileStamp, maskId, toCsv, saveFile } from './util.js';
import { createTenkey, openDialog, confirmDialog, alertDialog, toast } from './ui.js';

const root = document.getElementById('admin-root');
let closeResolve = null;

// ---------- 共通 ----------
const len = (s) => [...s].length;                       // 文字数はコードポイント（LIMITS と同じ数え方）
const PRINTABLE = /^[\x20-\x7E]*$/;                     // 欧文の欄に入れてよい字（印字可能な ASCII）
const inRange = (n, r) => n >= r.min && n <= r.max;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const ERR_TEXT = {
  PENDING_EXISTS: '未確認の抽選があります。先にスタッフ確認（OK）を済ませてください',
  NEGATIVE: '残数がマイナスになるため調整できません',
  DAY_HAS_DRAWS: 'その日の初期本数は変更できません。在庫の±調整を使ってください',
  PRIZE_HAS_DRAWS: '抽選済みの景品は削除できません。残数を0にしてください',
  DAY_LOCKED: '抽選がある日・開催中の日は削除できません',
  BAD_REQUEST: '入力を確認してください',
  HAS_DRAWS: '抽選履歴があるため読み込めません。本番リセットで履歴を消してから読み込んでください',
  NOT_SETUP: '初回セットアップが済んでいません',
  INVALID_BACKUP: 'バックアップファイルが正しくありません',
};
// BAD_REQUEST の detail（db.saveBoxSettings）→ 何が悪いか。画面側で先に検証するので、ここへ来るのは保険
const BAD_TEXT = {
  days: `開催日は${LIMITS.days.min}〜${LIMITS.days.max}日にしてください`,
  'day-label': `開催日の名前は1〜${LIMITS.dayLabel}字で入力してください`,
  categories: `賞は${LIMITS.categories.min}〜${LIMITS.categories.max}個にしてください`,
  'category-name': `賞の名前は1〜${LIMITS.categoryName}字で入力してください`,
  'category-latin': `賞の欧文は半角の英数字と記号だけ（${LIMITS.categoryLatin}字まで）にしてください`,
  prizes: `景品は${LIMITS.prizes.min}〜${LIMITS.prizes.max}個にしてください`,
  'prize-name': `景品の名前は1〜${LIMITS.prizeName}字で入力してください`,
  initial: `本数は0〜${LIMITS.initialMax}の整数で入力してください`,
};
/** names = {day(id)→名前, prize(id)→名前}：エラーの対象（detail の id）を名前で伝える */
function errText(e, names = {}) {
  const code = e?.code;
  const day = e?.detail && names.day ? names.day(e.detail) : null;
  const prize = e?.detail && names.prize ? names.prize(e.detail) : null;
  if (code === 'DAY_HAS_DRAWS') return day ? `「${day}」の初期本数は変更できません。在庫の±調整を使ってください` : ERR_TEXT.DAY_HAS_DRAWS;
  if (code === 'PRIZE_HAS_DRAWS') return prize ? `「${prize}」は抽選済みのため削除できません。残数を0にしてください` : ERR_TEXT.PRIZE_HAS_DRAWS;
  if (code === 'DAY_LOCKED') return day ? `「${day}」は抽選がある日・開催中の日のため削除できません` : ERR_TEXT.DAY_LOCKED;
  if (code === 'BAD_REQUEST') return (own(BAD_TEXT, String(e.detail)) && BAD_TEXT[e.detail]) || ERR_TEXT.BAD_REQUEST;
  if (code === 'INVALID_PROFILE' && e.detail) return `設定ファイルが正しくありません：${e.detail}`;
  return ERR_TEXT[code] || '保存できませんでした';
}
const failMsg = (e) => alertDialog(e?.code === 'INVALID_BACKUP' ? `${ERR_TEXT.INVALID_BACKUP}：${e.message.replace(/^INVALID_BACKUP: /, '')}` : errText(e), '失敗しました');

/** 子を差し替える（null / false は除く。replaceChildren(null) は「null」という文字になる） */
const put = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

function mountOverlay(...children) {
  const el = h('div', { class: 'admin', 'data-testid': 'admin' }, ...children);
  root.replaceChildren(el);
  return el;
}
function closeOverlay() {
  root.replaceChildren();
  const r = closeResolve;
  closeResolve = null;
  r?.();
}

async function verifyPin(pin) {
  const cfg = await db.getConfig();
  return !!cfg?.pinHash && (await hashPin(pin)) === cfg.pinHash;
}

/**
 * 現在の config を読み直して変更し保存する（古い画面の内容で上書きしない）。
 * 「読む」と「書く」は別のトランザクションなので、別のカードの保存（配色・回すもの・名前・参加の方法など）がほぼ同時に走ると、
 * 同じ古い config を読んだ2つが続けて書いて、あとの書き込みが先の変更を消してしまう。1つずつ順番に行う。
 */
let configWrites = Promise.resolve();
function updateConfig(mutator, logType, logDetail) {
  const run = async () => {
    const cfg = await db.getConfig();
    mutator(cfg);
    await db.saveConfig(cfg, logType, logDetail);
    return cfg;
  };
  const done = configWrites.then(run);
  configWrites = done.catch(() => {});   // 失敗しても、次の保存は止めない（失敗は呼び出し元に返す）
  return done;
}

function applySound(cfg) {
  try { sound.setEnabled(cfg.sound?.enabled !== false); sound.setVolume(cfg.sound?.volume ?? 0.7); } catch { /* noop */ }
}
/** 配色をスタッフ画面にもすぐ反映する（プレイヤー画面へは閉じたときの refresh() → applyLook で反映される） */
function showTheme(themeCfg) {
  try { applyTheme(resolveTheme(themeCfg)); } catch { /* noop */ }
}

const pill = (text, kind) => h('span', { class: `pill pill--${kind}` }, text);
const numInput = (value, props = {}) =>
  h('input', { type: 'number', class: 'num', min: 0, step: 1, inputmode: 'numeric', value: String(value), ...props });
const textInput = (value, max, props = {}) =>
  h('input', { type: 'text', class: 'txt', value: String(value ?? ''), maxLength: max, autocomplete: 'off', ...props });
const btn = (label, onclick, kind = 'ghost', props = {}) =>
  h('button', { type: 'button', class: `btn btn--${kind} btn--sm`, onclick, ...props }, label);
/** ラベル付きの入力欄（上にラベル・下にヒント） */
const field = (label, input, hint, max) =>
  h('label', { class: 'fld' }, h('span', { class: 'fld-k' }, label, max ? h('small', {}, `${max}字まで`) : null), input, hint ? h('span', { class: 'fld-h' }, hint) : null);
const check = (input, text) => h('label', { class: 'chk' }, input, ` ${text}`);

function card(title, ...children) {
  return h('section', { class: 'a-card' }, title ? h('h3', { class: 'a-card-title' }, title) : null, ...children);
}

/** 入力の誤りを示す：赤い枠にして、そこへ移動する（次に触ると消える）。 */
function flag(el) {
  if (!el) return;
  el.classList.add('is-bad');
  el.setAttribute('aria-invalid', 'true');
  const clear = () => { el.classList.remove('is-bad'); el.removeAttribute('aria-invalid'); };
  el.addEventListener('input', clear, { once: true });
  el.addEventListener('change', clear, { once: true });
  try { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); } catch { /* noop */ }
}

/** モチーフの見本（<svg>）。色は '#rrggbb' でも 'var(--main)' でもよい（motifPreviewSvg は固定色しか通さないので、色は作ったあとに style へ入れる）。 */
function motifIcon(id, size, wc, hl) {
  const box = h('span', { class: 'motif-svg', 'aria-hidden': 'true' });
  box.innerHTML = motifPreviewSvg(id, { size });
  const svg = box.firstElementChild;
  svg.style.setProperty('--wc', wc);
  svg.style.setProperty('--hl', hl);
  return box;
}
const chips = (colors) => h('span', { class: 'th-chips', 'aria-hidden': 'true' },
  ['paper', 'main', 'ink', 'accent'].map((k) => h('i', { style: { backgroundColor: colors[k] } })));
const themeLabel = (t) => (t?.custom ? 'カスタム' : (own(THEMES, t?.preset) ? THEMES[t.preset].label : THEMES.yosoro.label));
const motifLabel = (id) => (own(MOTIFS, id) ? MOTIFS[id] : MOTIFS.helm).label;

// ---------- 入口 ----------
export async function open() {
  if (!(await db.isSetUp())) return openSetup();
  db.requestPersist();
  swRefresh();
  return new Promise((resolve) => {
    closeResolve = resolve;
    showPin();
  });
}

let failCount = 0;
let lockUntil = 0;

function showPin() {
  const msg = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'pin-error' });
  const pad = createTenkey({
    maxLength: PIN_MAX, mask: true, placeholder: 'PIN', testid: 'pin',
    onSubmit: async (v) => {
      if (Date.now() < lockUntil) { msg.textContent = `しばらくしてからもう一度入力してください`; pad.clear(); return; }
      if (v.length >= PIN_MIN && (await verifyPin(v))) { failCount = 0; return showMain('status'); }
      pad.clear();
      if (++failCount >= 5) { lockUntil = Date.now() + 30000; failCount = 0; msg.textContent = '30秒間ロックしました'; }
      else msg.textContent = 'PINが違います';
    },
  });
  mountOverlay(h('div', { class: 'admin-center' },
    h('h1', { class: 'a-title' }, 'スタッフ画面'),
    h('p', { class: 'a-sub' }, 'PINを入力してください'),
    pad.el, msg,
    btn('キャンセル', closeOverlay, 'ghost', { 'data-testid': 'pin-cancel' })));
}

// ---------- メイン ----------
const TABS = [
  ['status', '状態'], ['inventory', '在庫'], ['prizes', '景品・日程'], ['event', 'イベント'],
  ['history', '履歴'], ['survey', 'アンケート'], ['data', 'バックアップ・リセット'], ['settings', '設定'],
];
let currentTab = 'status';

function showMain(tab = currentTab) {
  currentTab = tab;
  const body = h('div', { class: 'admin-scroll', 'data-testid': `tab-${tab}` }, h('p', { class: 'a-sub' }, '読み込み中…'));
  const foot = h('div', { class: 'admin-foot' });   // 画面の下に付ける操作の帯（景品・日程の「保存する」）。空なら出ない
  mountOverlay(
    h('header', { class: 'admin-head' },
      h('h1', { class: 'a-title a-title--s' }, 'スタッフ画面'),
      h('nav', { class: 'a-tabs' }, TABS.map(([id, label]) =>
        h('button', { type: 'button', class: `a-tab${id === tab ? ' is-on' : ''}`, 'data-testid': `tabbtn-${id}`, onclick: () => showMain(id) }, label))),
      btn('閉じる', closeOverlay, 'primary', { 'data-testid': 'admin-close' })),
    body, foot);
  const renderers = { status: renderStatus, inventory: renderInventory, prizes: renderPrizes, event: renderEvent, history: renderHistory, survey: renderSurvey, data: renderData, settings: renderSettings };
  renderers[tab](body, foot).catch((e) => { body.replaceChildren(h('p', { class: 'msg msg--error' }, `読み込めませんでした（${e?.code || 'ERR'}）`)); });
}
const rerender = () => showMain(currentTab);

// ---------- Service Worker 状態 ----------
async function swRefresh() {
  try { (await navigator.serviceWorker?.getRegistration())?.update().catch(() => {}); } catch { /* noop */ }
}

function askSw(message) {
  return new Promise((resolve) => {
    const ctl = navigator.serviceWorker?.controller;
    if (!ctl) return resolve(null);
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 4000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    ctl.postMessage(message, [ch.port2]);
  });
}

async function getSwStatus() {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const controlled = !!navigator.serviceWorker.controller;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  const cache = controlled ? await askSw({ type: 'CHECK_CACHE' }) : null;
  return { supported: true, controlled, waiting: !!reg?.waiting, reg, cache };
}

async function applyUpdate(reg) {
  if (await db.getPendingDraw()) return alertDialog(ERR_TEXT.PENDING_EXISTS);
  if (!reg?.waiting) return alertDialog('適用できる更新はありません');
  const ok = await confirmDialog({ title: 'アプリを更新します', message: '画面が再読み込みされます。よろしいですか？', okLabel: '更新する' });
  if (!ok) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
}

// ---------- 状態タブ ----------
async function renderStatus(el) {
  const [cfg, activeId, pending, persisted, backup, total, sw, inv] = await Promise.all([
    db.getConfig(), db.getActiveDayId(), db.getPendingDraw(), db.persisted(), db.getBackupStatus(),
    db.getBoxTotal(), getSwStatus(), db.listInventory(),
  ]);
  const dayName = (id) => cfg.days.find((d) => d.id === id)?.label || id;

  // 開催日
  const dayBtns = cfg.days.map((d) =>
    h('button', {
      type: 'button', class: `btn btn--sm ${d.id === activeId ? 'btn--primary' : 'btn--ghost'}`, 'data-testid': `day-${d.id}`,
      'aria-pressed': String(d.id === activeId),
      onclick: async () => {
        if (d.id === activeId) return;
        const ok = await confirmDialog({
          title: `${d.label}に切り替えます`,
          message: '日ごとに別のくじ箱です。前の日の残りは自動では繰り越されません。',
          okLabel: '切り替える',
        });
        if (!ok) return;
        try { await db.setActiveDay(d.id); toast(`${d.label}に切り替えました`); rerender(); } catch (e) { failMsg(e); }
      },
    }, d.label));

  // オフライン準備
  let offline;
  if (!sw.supported) offline = pill('非対応のブラウザです', 'bad');
  else if (!sw.controlled) offline = pill('未完了：このページをもう一度開き直してください（HTTPSで開いて数十秒待つ）', 'warn');
  else if (!sw.cache) offline = pill('確認できませんでした（再確認してください）', 'warn');
  else if (sw.cache.ok) offline = pill(`オフライン準備完了（${sw.cache.total}ファイル）`, 'ok');
  else offline = pill(`未完了：${sw.cache.missing.length}ファイルが未保存`, 'bad');

  // 本数未定の警告
  const unknown = cfg.prizes.filter((p) => p.countUnknown);
  const unknownRows = unknown.map((p) => {
    const counts = cfg.days.map((d) => `${d.label} ${inv.find((r) => r.key === `${d.id}:${p.id}`)?.initial ?? 0}本`).join(' / ');
    return h('li', {}, `${p.name}（${counts}）`);
  });

  const upd = sw.waiting
    ? h('div', {}, pill('新しいバージョンがあります', 'warn'), ' ',
        btn('更新を適用', () => applyUpdate(sw.reg), 'primary', { disabled: !!pending, 'data-testid': 'apply-update' }),
        pending ? h('p', { class: 'a-note' }, '未確認の抽選があるため適用できません') : null)
    : pill('更新はありません', 'ok');

  put(el,
    card('開催日（くじ箱）',
      h('div', { class: 'a-row' }, ...dayBtns),
      h('p', { class: 'a-note' }, `現在：${dayName(activeId)}　くじ箱の残り合計 ${total} 口`),
      total <= 0 ? pill('くじ箱が空です（プレイヤー画面は「終了」表示）', 'warn') : null),
    card('状態',
      kv('オフライン準備', offline, btn('再確認', rerender, 'ghost', { 'data-testid': 'recheck' })),
      kv('保存領域の保護', persisted ? pill('保護されています', 'ok') : pill('未許可（Safariが自動削除する可能性があります）', 'warn'),
        persisted ? null : btn('許可を求める', async () => { await db.requestPersist(); rerender(); })),
      kv('未確認の抽選', pending ? pill(`あり：${pending.label}（${pending.prizeName}）`, 'warn') : pill('なし', 'ok'),
        pending ? btn('履歴で確認', () => showMain('history')) : null),
      kv('最終バックアップ', backup.lastBackupAt ? `${fmtDateTime(backup.lastBackupAt)}（以降 ${backup.drawsSince} 件）` : `なし（抽選 ${backup.drawsTotal} 件）`,
        backup.drawsSince > 0 ? pill('バックアップ推奨', 'warn') : null),
      kv('アプリ更新', upd)),
    unknown.length ? card('本数が未定の景品',
      h('p', { class: 'a-note' }, '本数が決まったら「景品・日程」で入力してください。0本のままだと当たりません。'),
      h('ul', { class: 'a-list' }, unknownRows)) : null,
  );
}

const kv = (k, v, extra) => h('div', { class: 'kv' }, h('div', { class: 'kv-k' }, k), h('div', { class: 'kv-v' }, v, extra ? ' ' : null, extra || null));

// ---------- 在庫タブ ----------
async function renderInventory(el) {
  const [cfg, activeId, inv, draws] = await Promise.all([db.getConfig(), db.getActiveDayId(), db.listInventory(), db.listDraws()]);
  const drawn = {};
  for (const d of draws) drawn[`${d.dayId}:${d.prizeId}`] = (drawn[`${d.dayId}:${d.prizeId}`] || 0) + 1;
  const cards = cfg.days.map((day) => {
    const rows = cfg.prizes.map((p) => ({ p, rec: inv.find((r) => r.key === `${day.id}:${p.id}`) })).filter((x) => x.rec);
    const total = rows.reduce((s, x) => s + x.rec.remaining, 0);
    const catName = (id) => cfg.categories.find((c) => c.id === id)?.name || '';
    const body = rows.map(({ p, rec }) => h('tr', { 'data-testid': `inv-${day.id}-${p.id}` },
      h('td', { class: 'l' }, h('div', { class: 'cat' }, catName(p.categoryId)), p.name, p.countUnknown ? pill('本数未定', 'warn') : null),
      h('td', {}, String(rec.initial)),
      h('td', {}, rec.adjust ? (rec.adjust > 0 ? `+${rec.adjust}` : String(rec.adjust)) : '0'),
      h('td', {}, String(drawn[rec.key] || 0)),
      h('td', { class: 'strong', 'data-testid': `remaining-${day.id}-${p.id}` }, String(rec.remaining)),
      h('td', {}, total > 0 ? `${((rec.remaining / total) * 100).toFixed(1)}%` : '—'),
      h('td', {}, btn('± 調整', () => adjustDialog(cfg, day, p, rec).then((done) => done && rerender()), 'ghost', { 'data-testid': `adjust-${day.id}-${p.id}` }))));
    return card(`${day.label}${day.id === activeId ? '（開催中）' : ''}　残り合計 ${total} 口`,
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ...['景品', '初期', '調整', '出た数', '残り', '確率', ''].map((t, i) => h('th', { class: i === 0 ? 'l' : '' }, t)))),
        h('tbody', {}, body))));
  });
  put(el,
    h('p', { class: 'a-note' }, '確率＝その景品の残り ÷ その日の残り合計。プレイヤー画面には表示されません。'),
    ...cards);
}

const REASONS = ['追加入荷', '欠品・数量不足', '数え間違いの修正', 'テスト抽選の戻し', 'その他'];

async function adjustDialog(cfg, day, prize, rec) {
  let delta = 0;
  const preview = h('div', { class: 'adj-preview', 'data-testid': 'adj-preview' });
  const input = numInput(0, { min: -9999, 'data-testid': 'adj-delta' });
  const set = (v) => {
    delta = Math.trunc(Number(v)) || 0;
    input.value = String(delta);
    const next = rec.remaining + delta;
    preview.textContent = `${rec.remaining} → ${next}${next < 0 ? '（マイナスは不可）' : ''}`;
    preview.classList.toggle('is-bad', next < 0);
  };
  input.addEventListener('input', () => set(input.value));
  const quick = [-10, -5, -1, 1, 5, 10].map((n) => btn(n > 0 ? `+${n}` : String(n), () => set(delta + n), 'ghost', { 'data-testid': `adj-q${n}` }));
  const reasonSel = h('select', { class: 'sel', 'data-testid': 'adj-reason' }, REASONS.map((r) => h('option', { value: r }, r)));
  const note = h('input', { type: 'text', class: 'txt', placeholder: '補足（任意）', maxLength: 60, 'data-testid': 'adj-note' });
  set(0);
  const r = await openDialog({
    title: `${day.label}　${prize.name}`,
    body: h('div', { class: 'adj' },
      h('p', { class: 'a-note' }, `現在の残り：${rec.remaining} 本。追加は＋、減らすは−。`),
      h('div', { class: 'a-row' }, ...quick),
      h('div', { class: 'a-row' }, h('label', {}, '増減 ', input), preview),
      h('div', { class: 'a-row' }, h('label', {}, '理由 ', reasonSel), note)),
    actions: [
      { label: 'キャンセル', kind: 'ghost', value: false, testid: 'dlg-cancel' },
      { label: '調整する', kind: 'primary', value: true, testid: 'dlg-ok',
        check: () => (delta === 0 ? '増減を入力してください' : rec.remaining + delta < 0 ? '残数がマイナスになります' : true) },
    ],
  });
  if (r !== true) return false;
  const reason = reasonSel.value + (note.value.trim() ? `：${note.value.trim()}` : '');
  try { await db.adjustInventory(day.id, prize.id, delta, reason); toast('調整しました（ログに記録）'); return true; } catch (e) { failMsg(e); return false; }
}

// ---------- 景品・賞・開催日の編集部品（「景品・日程」タブとセットアップの手順4で共有。docs/CUSTOMIZE.md §4.2・§8） ----------
const TIER_LABEL = { sponsor: '特別（いちばん派手）', rare: 'レア', sticker: '通常' };
/** 本数の入力欄の文字 → 0〜100000 の整数。だめなら NaN（空・小数・負・全角などは受け付けない） */
const parseCount = (v) => { const s = String(v ?? '').trim(); return /^[0-9]{1,6}$/.test(s) && Number(s) <= LIMITS.initialMax ? Number(s) : NaN; };

/**
 * draft = {days, categories, prizes, initials}（initials は {日:{景品:本数}}）。入力のたびに内部の下書きへ写すので、追加・削除で描き直しても入力は消えない。
 * 抽選のある日（drawnDays）は初期本数を変えられない（新しい景品はその日 0 本）。抽選のある景品（drawnPrizes）と、
 * 抽選のある・開催中（activeDayId）の最後の日は削除できない（保存済みのものだけ。まだ保存していない追加分は自由に消せる）。
 * wizard=true は初回セットアップ：何も保存されていないので全部自由。testid も手順用（bx-cat- / bx-pname- / init-）。
 * 戻り値：{el, validate(), raw(), dirty(), label}。validate() は {ok:true, value} か {ok:false, message, el}（value は saveBoxSettings の入力）。
 */
function createBoxEditor({ draft, wizard = false, drawnDays = new Set(), drawnPrizes = new Set(), activeDayId = null, onChange }) {
  const st = {
    days: draft.days.map((d) => ({ id: d.id, label: d.label })),
    cats: draft.categories.map((c) => ({ id: c.id, name: c.name, tier: c.tier, latin: c.latin ?? '' })),
    prizes: draft.prizes.map((p) => ({ id: p.id, categoryId: p.categoryId, name: p.name, countUnknown: !!p.countUnknown })),
    init: {},
  };
  for (const d of st.days) {
    st.init[d.id] = {};
    for (const p of st.prizes) st.init[d.id][p.id] = String(draft.initials?.[d.id]?.[p.id] ?? 0);
  }
  const savedDays = new Set(wizard ? [] : st.days.map((d) => d.id));
  const locked = (dayId) => drawnDays.has(dayId);
  const sig = () => JSON.stringify([st.days, st.cats, st.prizes, st.init]);
  const sig0 = sig();
  const changed = () => onChange?.();
  const rootEl = h('div', { class: 'bx' });
  let refs;
  const tid = (forWizard, forTab) => (wizard ? forWizard : forTab);   // 手順用とタブ用で testid が違う（init-/pinit- など）

  const labelOfDay = (dayId) => st.days.find((d) => d.id === dayId)?.label.trim() || dayId;

  // ----- 追加・削除（できない理由は文字で返し、ボタンは押せなくして理由を出す） -----
  const dayRemoveWhy = () => {
    if (st.days.length <= LIMITS.days.min) return `開催日は${LIMITS.days.min}日以上必要です`;
    const last = st.days[st.days.length - 1];
    if (savedDays.has(last.id)) {
      if (drawnDays.has(last.id)) return `${labelOfDay(last.id)}は抽選があるため削除できません`;
      if (last.id === activeDayId) return `${labelOfDay(last.id)}は開催中です。「状態」で別の日に切り替えると削除できます`;
    }
    return '';
  };
  const dayAddWhy = () => (st.days.length >= LIMITS.days.max ? `開催日は最大${LIMITS.days.max}日までです` : '');
  const prizeDelWhy = (pid) => (drawnPrizes.has(pid) ? '抽選済みのため削除できません（残数を0にしてください）'
    : st.prizes.length <= LIMITS.prizes.min ? `景品は${LIMITS.prizes.min}つ以上必要です` : '');
  const catDelWhy = (cid) => (st.prizes.some((p) => p.categoryId === cid) ? '景品を0個にすると削除できます'
    : st.cats.length <= LIMITS.categories.min ? `賞は${LIMITS.categories.min}つ以上必要です` : '');

  function addDay() {
    const nid = nextDayId(st.days);
    if (!nid || dayAddWhy()) return;
    const first = st.days[0];
    if (st.days.length === 1 && first.label.trim() === '当日') first.label = '1日目';   // 1日→2日：「当日」は「1日目」に
    st.days.push({ id: nid, label: `${st.days.length + 1}日目` });
    st.init[nid] = {};
    for (const p of st.prizes) st.init[nid][p.id] = st.init[first.id]?.[p.id] ?? '0';   // 初期本数は1日目と同じ値から
    render(); changed();
  }
  function removeDay() {
    if (dayRemoveWhy()) return;
    const d = st.days.pop();
    delete st.init[d.id];
    if (st.days.length === 1 && st.days[0].label.trim() === '1日目') st.days[0].label = '当日';
    render(); changed();
  }
  function addCat() {
    if (st.cats.length >= LIMITS.categories.max) return;
    const cid = newId('c', st.cats.map((c) => c.id));
    st.cats.push({ id: cid, name: '', tier: 'sticker', latin: '' });
    render(); changed();
    focusIn(refs.cat.get(cid));
  }
  function delCat(cid) {
    if (catDelWhy(cid)) return;
    st.cats.splice(st.cats.findIndex((c) => c.id === cid), 1);
    render(); changed();
  }
  function addPrize(cid) {
    if (st.prizes.length >= LIMITS.prizes.max) return;
    const pid = newId('p', st.prizes.map((p) => p.id));
    st.prizes.push({ id: pid, categoryId: cid, name: '', countUnknown: false });
    for (const d of st.days) st.init[d.id][pid] = '0';
    render(); changed();
    focusIn(refs.pname.get(pid));
  }
  function delPrize(pid) {
    if (prizeDelWhy(pid)) return;
    st.prizes.splice(st.prizes.findIndex((p) => p.id === pid), 1);
    for (const d of st.days) delete st.init[d.id][pid];
    render(); changed();
  }
  const focusIn = (el) => { try { el?.scrollIntoView({ block: 'center' }); el?.focus({ preventScroll: true }); } catch { /* noop */ } };

  // ----- 描画 -----
  function dayCard() {
    const addWhy = dayAddWhy();
    const remWhy = dayRemoveWhy();
    return card('開催日',
      h('p', { class: 'a-note' }, '日ごとに別のくじ箱です。名前は自由に変えられます（例：1日目・当日・土曜）。'),
      h('div', { class: 'bx-days' }, st.days.map((d, i) => {
        const inp = textInput(d.label, LIMITS.dayLabel, { 'data-testid': `bx-day-${d.id}`, 'aria-label': `${i + 1}日目の名前` });
        inp.addEventListener('input', () => {
          d.label = inp.value;
          for (const s of refs.heads.get(d.id) || []) s.textContent = d.label.trim() || `${i + 1}日目`;
          changed();
        });
        refs.day.set(d.id, inp);
        return field(`${i + 1}日目の名前`, inp, null, LIMITS.dayLabel);
      })),
      h('div', { class: 'a-row' },
        btn('日を追加', addDay, 'ghost', { 'data-testid': 'bx-day-add', disabled: !!addWhy }),
        btn('最後の日を削除', removeDay, 'ghost', { 'data-testid': 'bx-day-remove', disabled: !!remWhy })),
      addWhy || remWhy ? h('p', { class: 'a-note bx-why', 'data-testid': 'bx-day-why' }, [addWhy, remWhy].filter(Boolean).join('／')) : null);
  }

  function prizeRow(p) {
    const nameIn = textInput(p.name, LIMITS.prizeName, {
      placeholder: '景品の名前', 'aria-label': '景品の名前', 'data-testid': tid(`bx-pname-${p.id}`, `pname-${p.id}`),
    });
    nameIn.addEventListener('input', () => { p.name = nameIn.value; changed(); });
    refs.pname.set(p.id, nameIn);
    const unkNote = h('div', {});
    const paintUnk = () => put(unkNote, p.countUnknown
      ? h('div', { class: 'msg msg--warn' }, '本数が未定です。決まったら入力してください（0本のままだと当たりません）') : null);
    paintUnk();
    const unk = h('input', { type: 'checkbox', checked: p.countUnknown, 'data-testid': `bx-unk-${p.id}` });
    unk.addEventListener('change', () => { p.countUnknown = unk.checked; paintUnk(); changed(); });
    const delWhy = prizeDelWhy(p.id);
    return h('tr', {},
      h('td', { class: 'l' }, nameIn, unkNote, drawnPrizes.has(p.id) ? h('div', { class: 'bx-why' }, '抽選済みの景品です（削除できません。残数を0にしてください）') : null),
      ...st.days.map((d) => {
        const cell = numInput(st.init[d.id][p.id], {
          max: LIMITS.initialMax, disabled: locked(d.id), 'aria-label': `${labelOfDay(d.id)}の初期本数`,
          'data-testid': tid(`init-${d.id}-${p.id}`, `pinit-${d.id}-${p.id}`),
        });
        cell.addEventListener('input', () => { st.init[d.id][p.id] = cell.value; changed(); });
        refs.init.set(`${d.id}:${p.id}`, cell);
        return h('td', {}, cell);
      }),
      h('td', {}, check(unk, '本数未定')),
      h('td', {}, btn('削除', () => delPrize(p.id), 'ghost', { 'data-testid': `bx-pdel-${p.id}`, disabled: !!delWhy, title: delWhy || undefined, 'aria-label': `${p.name.trim() || '景品'}を削除` })));
  }

  function catCard(c) {
    const mine = st.prizes.filter((p) => p.categoryId === c.id);
    const nameIn = textInput(c.name, LIMITS.categoryName, {
      placeholder: '賞の名前（例：特賞）', 'aria-label': '賞の名前', 'data-testid': tid(`bx-cat-${c.id}`, `cat-${c.id}`),
    });
    nameIn.addEventListener('input', () => { c.name = nameIn.value; changed(); });
    refs.cat.set(c.id, nameIn);
    const latinIn = textInput(c.latin, LIMITS.categoryLatin, {
      class: 'txt bx-latin', placeholder: TIER_LATIN[c.tier], lang: 'en', autocapitalize: 'characters', autocorrect: 'off', spellcheck: false,
      'aria-label': '欧文', 'data-testid': `bx-latin-${c.id}`,
    });
    latinIn.addEventListener('input', () => { c.latin = latinIn.value; changed(); });
    refs.latin.set(c.id, latinIn);
    const tierSel = h('select', { class: 'sel', 'aria-label': '演出', 'data-testid': `bx-tier-${c.id}` },
      Object.entries(TIER_LABEL).map(([v, l]) => h('option', { value: v, selected: v === c.tier }, l)));
    tierSel.addEventListener('change', () => { c.tier = tierSel.value; latinIn.placeholder = TIER_LATIN[c.tier]; changed(); });

    const addWhy = st.prizes.length >= LIMITS.prizes.max ? `景品は最大${LIMITS.prizes.max}個までです` : '';
    const delWhy = catDelWhy(c.id);
    const head = h('tr', {}, h('th', { class: 'l' }, '景品名'),
      ...st.days.map((d, i) => {
        const nm = h('span', { class: 'bx-dayname' }, d.label.trim() || `${i + 1}日目`);
        (refs.heads.get(d.id) || refs.heads.set(d.id, []).get(d.id)).push(nm);
        return h('th', {}, nm, locked(d.id) ? h('span', { class: 'bx-lock' }, '変更不可') : null, h('span', { class: 'bx-th-sub' }, '初期本数'));
      }),
      h('th', {}, ''), h('th', {}, ''));
    return h('section', { class: 'a-card bx-cat', 'data-testid': `bx-card-${c.id}` },
      h('div', { class: 'bx-cat-head' },
        field('賞の名前', nameIn, null, LIMITS.categoryName),
        field('演出', tierSel),
        field('欧文（結果画面の飾り）', latinIn, null, LIMITS.categoryLatin)),
      mine.length
        ? h('div', { class: 'tbl-wrap' }, h('table', { class: `tbl bx-tbl${st.days.length >= 5 ? ' bx-tbl--many' : ''}` }, h('thead', {}, head), h('tbody', {}, mine.map(prizeRow))))
        : h('p', { class: 'a-note' }, 'この賞にはまだ景品がありません。景品を追加するか、この賞を削除してください。'),
      h('div', { class: 'a-row' },
        btn('景品を追加', () => addPrize(c.id), 'ghost', { 'data-testid': `bx-padd-${c.id}`, disabled: !!addWhy }),
        btn('この賞を削除', () => delCat(c.id), 'ghost', { 'data-testid': `bx-cdel-${c.id}`, disabled: !!delWhy }),
        addWhy || delWhy ? h('span', { class: 'a-note bx-why' }, addWhy || delWhy) : null));
  }

  function render() {
    refs = { day: new Map(), cat: new Map(), latin: new Map(), pname: new Map(), init: new Map(), heads: new Map() };
    const lockedLabels = st.days.filter((d) => locked(d.id)).map((d) => d.label.trim() || d.id);
    const catAddWhy = st.cats.length >= LIMITS.categories.max ? `賞は最大${LIMITS.categories.max}個までです` : '';
    put(rootEl,
      lockedLabels.length ? h('p', { class: 'msg msg--warn', 'data-testid': 'bx-locked' },
        `${lockedLabels.join('・')}は抽選が始まっているため、初期本数は変更できません。「在庫」の±調整を使ってください（新しい景品も、その日は0本から始まります）。`) : null,
      h('p', { class: 'a-note' }, '演出は結果画面の派手さの系統です（順位ではありません）。欧文は結果画面などに出る飾りの文字で、空なら演出ごとの既定になります。'),
      dayCard(),
      st.cats.map(catCard),
      h('div', { class: 'a-row' },
        btn('賞を追加', addCat, 'secondary', { 'data-testid': 'bx-cat-add', disabled: !!catAddWhy }),
        catAddWhy ? h('span', { class: 'a-note bx-why' }, catAddWhy) : null),
      h('p', { class: 'a-note', 'data-testid': 'bx-count' }, `賞 ${st.cats.length}/${LIMITS.categories.max}　景品 ${st.prizes.length}/${LIMITS.prizes.max}　開催日 ${st.days.length}/${LIMITS.days.max}`));
  }

  // ----- 検証・取り出し -----
  /** 画面の値を検証して、saveBoxSettings の入力にする。だめなら message と、直す欄 el */
  function validate() {
    const bad = (message, el) => ({ ok: false, message, el });
    for (const [i, d] of st.days.entries()) {
      const s = d.label.trim();
      if (!s) return bad(`${i + 1}日目の開催日の名前を入力してください`, refs.day.get(d.id));
      if (len(s) > LIMITS.dayLabel) return bad(`開催日の名前は${LIMITS.dayLabel}字までです`, refs.day.get(d.id));
    }
    for (const c of st.cats) {
      const s = c.name.trim();
      if (!s) return bad('賞の名前を入力してください', refs.cat.get(c.id));
      if (len(s) > LIMITS.categoryName) return bad(`賞の名前は${LIMITS.categoryName}字までです（${s}）`, refs.cat.get(c.id));
      const l = c.latin.trim();
      if (!PRINTABLE.test(l)) return bad(`欧文は半角の英数字と記号だけにしてください（賞「${s}」）`, refs.latin.get(c.id));
      if (len(l) > LIMITS.categoryLatin) return bad(`欧文は${LIMITS.categoryLatin}字までです（賞「${s}」）`, refs.latin.get(c.id));
    }
    if (!inRange(st.prizes.length, LIMITS.prizes)) return bad(`景品は${LIMITS.prizes.min}〜${LIMITS.prizes.max}個にしてください`);
    for (const p of st.prizes) {
      const s = p.name.trim();
      const cat = st.cats.find((c) => c.id === p.categoryId)?.name.trim() || '';
      if (!s) return bad(`${cat ? `「${cat}」の` : ''}景品の名前を入力してください`, refs.pname.get(p.id));
      if (len(s) > LIMITS.prizeName) return bad(`景品の名前は${LIMITS.prizeName}字までです（${s}）`, refs.pname.get(p.id));
    }
    const initials = {};
    for (const d of st.days) {
      if (locked(d.id)) continue;   // 抽選が始まった日の初期本数は送らない（変えられない）
      initials[d.id] = {};
      for (const p of st.prizes) {
        const n = parseCount(st.init[d.id][p.id]);
        if (Number.isNaN(n)) return bad(`${labelOfDay(d.id)}・「${p.name.trim()}」の本数は0〜${LIMITS.initialMax}の整数で入力してください`, refs.init.get(`${d.id}:${p.id}`));
        initials[d.id][p.id] = n;
      }
    }
    return {
      ok: true,
      value: {
        days: st.days.map((d) => ({ id: d.id, label: d.label.trim() })),
        categories: st.cats.map((c) => ({ id: c.id, name: c.name.trim(), tier: c.tier, latin: c.latin.trim() })),
        prizes: st.prizes.map((p) => ({ id: p.id, categoryId: p.categoryId, name: p.name.trim(), countUnknown: p.countUnknown })),
        initials,
      },
    };
  }
  /** 検証しない今の下書き（セットアップで「戻る」とき入力を残すため）。本数は入力のままの文字列 */
  const raw = () => ({
    days: st.days.map((d) => ({ ...d })), categories: st.cats.map((c) => ({ ...c })), prizes: st.prizes.map((p) => ({ ...p })),
    initials: JSON.parse(JSON.stringify(st.init)),
  });

  render();
  return {
    el: rootEl, validate, raw, dirty: () => sig() !== sig0,
    label: { day: labelOfDay, prize: (pid) => st.prizes.find((p) => p.id === pid)?.name.trim() || pid },
  };
}

// ---------- 景品・日程タブ ----------
async function renderPrizes(el, foot) {
  const [cfg, inv, draws, activeId] = await Promise.all([db.getConfig(), db.listInventory(), db.listDraws(), db.getActiveDayId()]);
  const byKey = new Map(inv.map((r) => [r.key, r]));
  const initials = {};
  for (const d of cfg.days) {
    initials[d.id] = {};
    for (const p of cfg.prizes) initials[d.id][p.id] = byKey.get(`${d.id}:${p.id}`)?.initial ?? 0;
  }
  const dirtyPill = h('span', { class: 'pill pill--warn', hidden: true, 'data-testid': 'prizes-dirty' }, '未保存の変更があります');
  const err = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'prizes-error' });
  const editor = createBoxEditor({
    draft: { days: cfg.days, categories: cfg.categories, prizes: cfg.prizes, initials },
    drawnDays: new Set(draws.map((d) => d.dayId)), drawnPrizes: new Set(draws.map((d) => d.prizeId)), activeDayId: activeId,
    onChange: () => { dirtyPill.hidden = !editor.dirty(); err.textContent = ''; },
  });
  let busy = false;
  const save = async () => {
    if (busy) return;
    err.textContent = '';
    const r = editor.validate();
    if (!r.ok) { err.textContent = r.message; flag(r.el); return; }
    busy = true;
    try {
      await db.saveBoxSettings(r.value);
      toast('保存しました');
      rerender();   // 保存した内容を読み直す
    } catch (e) {
      err.textContent = errText(e, { day: (i) => cfg.days.find((d) => d.id === i)?.label ?? editor.label.day(i), prize: (i) => cfg.prizes.find((p) => p.id === i)?.name ?? editor.label.prize(i) });
    } finally { busy = false; }
  };
  put(el,
    h('p', { class: 'a-note' }, '賞の名前・景品・日別の初期本数・開催日を編集できます。保存するまでは変わりません。過去の抽選履歴の名前も変わりません。'),
    editor.el);
  put(foot, btn('保存する', save, 'primary', { 'data-testid': 'prizes-save' }), dirtyPill, err);   // 長い一覧でも、いつでも保存できるよう画面の下に置く
}

// ---------- イベントタブ（名前と表示・配色・回すもの・参加の方法） ----------
// 名前と表示の欄：[キー, testid, 表示名, 上限, 最小, 半角だけ, ヒント]。入力の上限は LIMITS（docs/CUSTOMIZE.md §2）
const BRAND_FIELDS = [
  ['name', 'brand-name', 'ガチャ名', LIMITS.brandName, 1, false, '待機画面の大きな題字'],
  ['nameLatin', 'brand-latin', '欧文名', LIMITS.nameLatin, 0, true, '半角。題字の下の読み（空なら出しません）'],
  ['eventName', 'event-name', 'イベント名', LIMITS.eventName, 1, false, 'タブの題名・CSV・設定ファイルに使います'],
  ['eventLabel', 'brand-event-label', 'ロゴの文字（和）', LIMITS.eventLabel, 0, false, '画面左上のロゴの横'],
  ['eventLatin', 'brand-event-latin', 'ロゴの文字（欧文）', LIMITS.eventLatin, 0, true, '半角。ロゴの横・スタンプの下'],
  ['tagline', 'brand-tagline', '帯の文字', LIMITS.tagline, 0, false, '待機画面の帯（空なら出しません）'],
  ['prizeWord', 'brand-prize-word', '景品の呼び方', LIMITS.prizeWord, 1, false, '「〇〇を引こう！」の〇〇'],
];
/** 名前と表示の検証。v = {キー: 文字列}（持っているキーだけ見る）。誤りがあれば {key, message}、無ければ null */
function checkBrand(v) {
  for (const [key, , label, max, min, ascii] of BRAND_FIELDS) {
    if (!(key in v)) continue;
    const s = String(v[key] ?? '').trim();
    if (!s && min > 0) return { key, message: `${label}を入力してください` };
    if (ascii && !PRINTABLE.test(s)) return { key, message: `${label}は半角の英数字と記号だけにしてください` };
    if (len(s) > max) return { key, message: `${label}は${max}字までです` };
  }
  return null;
}

async function renderEvent(el) {
  const cfg = await db.getConfig();
  const ev = { name: cfg.brand.name, tagline: cfg.brand.tagline, theme: cfg.theme, motif: cfg.motif };   // 保存済みの値（プレビューの元）
  const themeCard = buildThemeCard(ev);
  put(el,
    h('p', { class: 'a-note' }, '変えた内容は、スタッフ画面を閉じるとプレイヤー画面に反映されます（配色だけは、この画面ですぐ変わります）。'),
    buildBrandCard(cfg, ev, () => themeCard.repaint()),
    themeCard.el,
    buildMotifCard(ev, () => themeCard.repaint()),
    buildEntryCard(cfg));
}

function buildBrandCard(cfg, ev, onLive) {
  const cur = { eventName: cfg.eventName, ...cfg.brand };
  const inputs = {};
  const err = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'brand-error' });
  const fields = BRAND_FIELDS.map(([key, testid, label, max, , ascii, hint]) => {
    const inp = textInput(cur[key], max, ascii ? { lang: 'en', autocapitalize: 'off', autocorrect: 'off', spellcheck: false, 'data-testid': testid } : { 'data-testid': testid });
    inputs[key] = inp;
    inp.addEventListener('input', () => { err.textContent = ''; if (key === 'name' || key === 'tagline') { ev[key] = inp.value.trim(); onLive(); } });
    return field(label, inp, hint, max);
  });
  const save = async () => {
    err.textContent = '';
    const v = Object.fromEntries(BRAND_FIELDS.map(([key]) => [key, inputs[key].value.trim()]));
    const bad = checkBrand(v);
    if (bad) { err.textContent = bad.message; flag(inputs[bad.key]); return; }
    try {
      await updateConfig((c) => {
        c.eventName = v.eventName;
        Object.assign(c.brand, { name: v.name, nameLatin: v.nameLatin, eventLabel: v.eventLabel, eventLatin: v.eventLatin, tagline: v.tagline, prizeWord: v.prizeWord });
      }, 'brand', { eventName: v.eventName, brand: { name: v.name, nameLatin: v.nameLatin, eventLabel: v.eventLabel, eventLatin: v.eventLatin, tagline: v.tagline, prizeWord: v.prizeWord } });
      Object.assign(ev, { name: v.name, tagline: v.tagline });
      onLive();
      toast('保存しました');
    } catch (e) { err.textContent = errText(e); }
  };
  return card('名前と表示',
    h('div', { class: 'a-grid' }, fields),
    h('div', { class: 'a-row' }, btn('保存', save, 'primary', { 'data-testid': 'brand-save' }), err));
}

function buildThemeCard(ev) {
  const ROLES = [['paper', '地の色（紙）'], ['main', '主色'], ['ink', '文字の色（インク）'], ['accent', '差し色']];
  // 入力中のカスタムの4色（保存済みの配色から始める）。<input type=color> の値は小文字なので、そろえておく
  const lower = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.toLowerCase()]));
  const custom = lower(resolveTheme(ev.theme));
  const err = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'theme-error' });
  const presetBtns = Object.entries(THEMES).map(([tid, t]) => h('button', {
    type: 'button', class: 'th-btn', 'data-testid': `theme-${tid}`, onclick: () => pickPreset(tid),
  }, h('span', { class: 'th-name' }, t.label), chips(t)));
  const inputs = Object.fromEntries(ROLES.map(([k]) => [k, h('input', { type: 'color', class: 'th-color', value: custom[k], 'data-testid': `theme-c-${k}` })]));
  for (const [k] of ROLES) inputs[k].addEventListener('input', () => { custom[k] = inputs[k].value; paintLive(); });
  const warn = h('ul', { class: 'th-warn', 'data-testid': 'theme-warn' });
  const state = h('span', { class: 'pill pill--ok', 'data-testid': 'theme-state' });

  // プレビュー：入力中の4色を自分の CSS 変数に持つ（画面全体の配色には触れない）
  const pvName = h('div', { class: 'thp-name' });
  const pvTag = h('div', { class: 'thp-tag' });
  const pvRow = h('div', { class: 'thp-row' }, h('b', {}, '01'), h('span', {}, '入口の行（主色の面に紙色の文字）'));
  const pvMotif = h('div', { class: 'thp-motif' });
  const preview = h('div', { class: 'th-pv', 'data-testid': 'theme-preview', 'aria-label': '配色の見本' },
    h('div', { class: 'thp-top' }, h('div', { class: 'thp-text' }, pvName, pvTag), pvMotif), pvRow);

  function paintLive() {
    for (const [k] of ROLES) preview.style.setProperty(`--${k}`, custom[k]);
    pvName.textContent = ev.name || 'ガチャ名';
    pvTag.textContent = ev.tagline;
    pvTag.hidden = !ev.tagline;
    pvMotif.replaceChildren(motifIcon(ev.motif, 96, 'var(--main)', 'var(--accent)'));
    const rep = contrastReport(custom);
    put(warn, rep.map((r) => h('li', { class: r.ok ? 'is-ok' : 'is-ng', 'data-key': r.key },
      h('span', { class: 'th-w-l' }, r.label),
      h('span', { class: 'th-w-n' }, `${r.ratio.toFixed(2)}（${r.min}以上）`),
      pill(r.ok ? 'OK' : '注意', r.ok ? 'ok' : 'warn'))));
    warn.dataset.ok = String(rep.every((r) => r.ok));
  }
  function paintAll() {
    const active = ev.theme.custom ? null : (own(THEMES, ev.theme.preset) ? ev.theme.preset : 'yosoro');
    for (const b of presetBtns) b.setAttribute('aria-pressed', String(b.dataset.testid === `theme-${active}`));
    state.textContent = ev.theme.custom ? 'いまはカスタムの配色です' : `いまは「${themeLabel(ev.theme)}」です`;
    for (const [k] of ROLES) inputs[k].value = custom[k];
    paintLive();
  }
  let busy = false;   // 保存中の連打は無視する（保存の順番が入れ替わらないように）
  async function save(theme, logDetail, msg) {
    if (busy) return;
    busy = true;
    err.textContent = '';
    try {
      const saved = await updateConfig((c) => { c.theme = typeof theme === 'function' ? theme(c.theme) : theme; }, 'theme', logDetail);
      ev.theme = saved.theme;
    } catch (e) { err.textContent = errText(e); return; } finally { busy = false; }
    showTheme(ev.theme);   // 保存できてから、スタッフ画面にも反映する
    Object.assign(custom, lower(resolveTheme(ev.theme)));
    paintAll();
    toast(msg);
  }
  const pickPreset = (tid) => save({ preset: tid, custom: null }, { preset: tid }, '配色を変えました');
  const applyCustom = () => save((t) => ({ preset: t.preset, custom: { ...custom } }), { custom: { ...custom } }, 'カスタムの配色を適用しました');
  const backToPreset = () => save((t) => ({ preset: t.preset, custom: null }), { preset: 'reset-custom' }, 'プリセットの配色に戻しました');

  const el = card('配色',
    h('p', { class: 'a-note' }, 'タップすると、すぐ保存して反映します。'),
    h('div', { class: 'th-grid' }, presetBtns),
    h('h4', { class: 'a-sub-title' }, 'カスタム'),
    h('div', { class: 'th-custom' },
      h('div', { class: 'th-inputs' }, ROLES.map(([k, label]) => h('label', { class: 'th-in' }, h('span', { class: 'fld-k' }, label), inputs[k]))),
      preview),
    h('p', { class: 'a-note' }, '主色・差し色の面には紙色の文字が、協賛特別賞（特別）の差し色の面にはインクの文字が載ります。読みにくい組み合わせは「注意」が出ます（保存はできます）。'),
    warn,
    h('div', { class: 'a-row' },
      btn('適用', applyCustom, 'primary', { 'data-testid': 'theme-custom-apply' }),
      btn('プリセットに戻す', backToPreset, 'ghost', { 'data-testid': 'theme-custom-reset' }),
      state),
    err);
  paintAll();
  return { el, repaint: paintLive };
}

/** 「舵輪（よーそろ）」→ 名前と（補足）を2行に分ける。textContent は元の文字列のまま */
function labelParts(label) {
  const m = /^(.*?)(（.*）)?$/.exec(label);
  return h('span', { class: 'mo-name' }, m[1], m[2] ? h('small', {}, m[2]) : null);
}

function buildMotifCard(ev, onChange) {
  const err = h('p', { class: 'msg msg--error', role: 'alert' });
  let busy = false;
  const btns = Object.entries(MOTIFS).map(([mid, m]) => h('button', {
    type: 'button', class: 'mo-btn', 'data-testid': `motif-${mid}`, onclick: async () => {
      if (busy) return;
      busy = true;
      err.textContent = '';
      try { await updateConfig((c) => { c.motif = mid; }, 'motif', { motif: mid }); } catch (e) { err.textContent = errText(e); return; } finally { busy = false; }
      ev.motif = mid;
      paint();
      onChange();
      toast('回すものを変えました');
    },
  }, motifIcon(mid, 72, 'var(--main)', 'var(--accent)'), labelParts(m.label)));
  const paint = () => { const cur = own(MOTIFS, ev.motif) ? ev.motif : 'helm'; for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.testid === `motif-${cur}`)); };
  paint();
  return card('回すもの',
    h('p', { class: 'a-note' }, '抽選画面で回す図形です。待機画面・結果画面の飾りも同じ図形になります。タップすると、すぐ保存します。'),
    h('div', { class: 'mo-grid' }, btns), err);
}

function buildEntryCard(cfg) {
  const e = cfg.entry;
  const cbStu = h('input', { type: 'checkbox', checked: e.student.enabled, 'data-testid': 'entry-student' });
  const cbGst = h('input', { type: 'checkbox', checked: e.guest.enabled, 'data-testid': 'entry-guest' });
  const cbSvy = h('input', { type: 'checkbox', checked: cfg.survey.enabled, 'data-testid': 'entry-survey' });
  const t = {
    stuTitle: textInput(e.student.title, LIMITS.entryTitle, { 'data-testid': 'entry-student-title' }),
    stuSub: textInput(e.student.sub, LIMITS.entrySub, { 'data-testid': 'entry-student-sub' }),
    gstTitle: textInput(e.guest.title, LIMITS.entryTitle, { 'data-testid': 'entry-guest-title' }),
    gstSub: textInput(e.guest.sub, LIMITS.entrySub, { 'data-testid': 'entry-guest-sub' }),
  };
  const err = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'entry-error' });
  const sync = () => {
    cbSvy.disabled = !cbGst.checked;
    t.stuTitle.disabled = t.stuSub.disabled = !cbStu.checked;
    t.gstTitle.disabled = t.gstSub.disabled = !cbGst.checked;
    err.textContent = '';
  };
  for (const cb of [cbStu, cbGst]) cb.addEventListener('change', sync);
  sync();
  const save = async () => {
    err.textContent = '';
    if (!cbStu.checked && !cbGst.checked) { err.textContent = '学生と一般の方の、少なくとも一方は選んでください'; flag(cbStu); return; }
    const rows = [[cbStu, t.stuTitle, t.stuSub, '学生'], [cbGst, t.gstTitle, t.gstSub, '一般の方']];
    for (const [cb, ti, su, name] of rows) {
      if (!cb.checked) continue;   // 使わない行の文言は今のまま残す
      const a = ti.value.trim(); const b = su.value.trim();
      if (!a) { err.textContent = `${name}の見出しを入力してください`; flag(ti); return; }
      if (len(a) > LIMITS.entryTitle) { err.textContent = `${name}の見出しは${LIMITS.entryTitle}字までです`; flag(ti); return; }
      if (len(b) > LIMITS.entrySub) { err.textContent = `${name}の補足は${LIMITS.entrySub}字までです`; flag(su); return; }
    }
    const next = { stuOn: cbStu.checked, gstOn: cbGst.checked, svyOn: cbSvy.checked };
    try {
      await updateConfig((c) => {
        c.entry.student.enabled = next.stuOn;
        c.entry.guest.enabled = next.gstOn;
        if (next.stuOn) { c.entry.student.title = t.stuTitle.value.trim(); c.entry.student.sub = t.stuSub.value.trim(); }
        if (next.gstOn) { c.entry.guest.title = t.gstTitle.value.trim(); c.entry.guest.sub = t.gstSub.value.trim(); }
        c.survey.enabled = next.svyOn;
      }, 'entry', { student: next.stuOn, guest: next.gstOn, survey: next.svyOn });
      toast('保存しました');
    } catch (x) { err.textContent = errText(x); }
  };
  return card('参加の方法',
    h('p', { class: 'a-note' }, '来場者が待機画面で選ぶ入口です。少なくとも一方は選んでください。見出しと補足は入口の行に出る文字です。'),
    h('div', { class: 'en-row' }, check(cbStu, '学生（学籍番号で参加済みを確認）'),
      h('div', { class: 'a-grid' }, field('見出し', t.stuTitle, null, LIMITS.entryTitle), field('補足', t.stuSub, null, LIMITS.entrySub))),
    h('div', { class: 'en-row' }, check(cbGst, '一般の方（学籍番号なし）'),
      h('div', { class: 'a-grid' }, field('見出し', t.gstTitle, null, LIMITS.entryTitle), field('補足', t.gstSub, null, LIMITS.entrySub)),
      h('div', { class: 'en-sub' }, check(cbSvy, '一般の方に、抽選の前のアンケートを出す'),
        h('p', { class: 'a-note' }, 'アンケートを出さないときは、一般の方は入口を選ぶとそのまま抽選に進みます。質問は「アンケート」タブで変えられます。'))),
    h('div', { class: 'a-row' }, btn('保存', save, 'primary', { 'data-testid': 'entry-save' }), err));
}

// ---------- 履歴タブ ----------
async function renderHistory(el) {
  const [draws, cfg] = await Promise.all([db.listDraws(), db.getConfig()]);
  let shown = 100;
  const list = h('div', {});
  const paint = () => {
    const rows = draws.slice(0, shown).map((d) => h('tr', { 'data-testid': `draw-${d.id}` },
      h('td', { class: 'l strong' }, d.label),
      h('td', {}, fmtDateTime(d.drawnAt)),
      h('td', {}, d.kind === 'student' ? `学生 ${maskId(d.studentId)}` : '一般'),
      h('td', { class: 'l' }, h('div', { class: 'cat' }, d.categoryName), d.prizeName),
      h('td', {}, d.confirmedAt ? pill('確認済み', 'ok') : pill('未確認', 'warn')),
      h('td', {}, d.confirmedAt ? null : h('div', { class: 'a-row' },
        btn('結果を再表示', closeOverlay, 'ghost', { 'data-testid': `redisplay-${d.id}` }),
        btn('確認済みにする', async () => {
          const ok = await confirmDialog({ title: `${d.label} を確認済みにします`, message: `${d.categoryName}／${d.prizeName} をお渡し済みとして記録します。`, okLabel: '確認済みにする' });
          if (!ok) return;
          try { await db.confirmDraw(d.id); toast('確認済みにしました'); rerender(); } catch (e) { failMsg(e); }
        }, 'primary', { 'data-testid': `confirm-${d.id}` })))));
    put(list,
      draws.length === 0 ? h('p', { class: 'a-sub' }, 'まだ抽選はありません') :
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ...['番号', '日時', '区分', '賞／景品', '状態', ''].map((t, i) => h('th', { class: i === 0 || i === 3 ? 'l' : '' }, t)))),
          h('tbody', {}, rows))),
      draws.length > shown ? btn('さらに表示', () => { shown += 100; paint(); }) : null);
  };
  paint();
  const counts = cfg.days.map((d) => `${d.label} ${draws.filter((x) => x.dayId === d.id).length}件`).join(' / ');
  put(el,
    h('p', { class: 'a-note' }, `新しい順。学籍番号は末尾2桁以外を伏せています。合計 ${draws.length} 件（${counts}）`),
    list);
}

// ---------- アンケートタブ（一般の方の回答の集計と、質問・選択肢の編集） ----------
const SCOPE_ALL = 'all';

/** 横棒（幅は割合。CSS だけで描く）。色だけに頼らず、数と％も必ず並べる。 */
function barRow(testid, label, count, of, retired) {
  const p = pct(count, of);
  return h('div', { class: 'bar-row', 'data-testid': testid, 'data-count': String(count) },
    h('div', { class: 'bar-l' }, label, retired ? h('span', { class: 'bar-old' }, '旧選択肢') : null),
    h('div', { class: 'bar-t', 'aria-hidden': 'true' }, h('i', { style: { width: `${p}%` } })),
    h('div', { class: 'bar-n' }, h('b', {}, String(count)), h('span', {}, `${p.toFixed(1)}%`)));
}

/** 集計表の見出し：文節ごとに折り返し、文節の途中では折らない（nw）。 */
const nwPhrases = (text) => splitPhrases(text).map((x) => h('span', { class: 'ph nw' }, x));

function surveyCsvRows(agg, scopeLabel, cfg) {
  const { q1, q2 } = cfg.survey;
  const rows = [[`来場者アンケート集計（${cfg.entry.guest.title}）`, scopeLabel], [],
    ['一般の抽選数', agg.total], ['回答あり', agg.answered], [UNANSWERED, agg.unanswered], [],
    [`Q1 ${q1.short}`, '人数', '回答者に対する割合（%）']];
  for (const r of agg.ages) rows.push([r.label, r.count, pct(r.count, agg.answered)]);
  rows.push([], [`Q2 ${q2.short}（複数選択可。割合の合計は100%を超える）`, '人数', '回答者に対する割合（%）']);
  for (const r of agg.triggers) rows.push([r.label, r.count, pct(r.count, agg.answered)]);
  rows.push([], [`${q1.short} × ${q2.short}（人数）`, ...agg.triggers.map((t) => t.label)]);
  for (const a of agg.ages) rows.push([a.label, ...agg.triggers.map((t) => agg.cross[a.id]?.[t.id] || 0)]);
  return rows;
}

async function renderSurvey(el) {
  const [draws, cfg] = await Promise.all([db.listDraws(), db.getConfig()]);
  const { q1, q2 } = cfg.survey;
  let scope = SCOPE_ALL;
  const view = h('div', { class: 'sv-admin' });
  const editor = buildSurveyEditor(cfg);   // 下の「質問と選択肢」。上のボタンからここへ移動する
  const scopes = [[SCOPE_ALL, '全日程'], ...cfg.days.map((d) => [d.id, d.label])];
  const scopeLabel = () => scopes.find(([id]) => id === scope)[1];
  const aggNow = () => aggregateSurvey(draws, { dayId: scope === SCOPE_ALL ? null : scope, ages: q1.options, triggers: q2.options });

  const paint = () => {
    const agg = aggNow();
    const crossMax = Math.max(1, ...agg.ages.flatMap((a) => agg.triggers.map((t) => agg.cross[a.id]?.[t.id] || 0)));
    const noData = agg.answered === 0;
    put(view,
      h('div', { class: 'a-row' },
        ...scopes.map(([id, label]) => h('button', {
          type: 'button', class: `btn btn--sm ${id === scope ? 'btn--primary' : 'btn--ghost'}`, 'aria-pressed': String(id === scope), 'data-testid': `sv-scope-${id}`,
          onclick: () => { scope = id; paint(); },
        }, label)),
        h('span', { class: 'a-spacer' }),
        btn('質問と選択肢を編集', () => editor.scrollIntoView({ block: 'start' }), 'ghost', { 'data-testid': 'sv-edit-jump' }),
        btn('集計をCSVで書き出す', () => saveFile(new File(['﻿' + toCsv(surveyCsvRows(aggNow(), scopeLabel(), cfg))], `yosoro-gacha-survey-${scope}-${fileStamp()}.csv`, { type: 'text/csv' })), 'secondary', { 'data-testid': 'sv-csv' })),
      card(`${scopeLabel()}の回答数`,
        h('div', { class: 'sv-sum' },
          h('div', { class: 'sv-stat', 'data-testid': 'sv-total' }, h('small', {}, '一般の抽選'), h('b', {}, String(agg.total))),
          h('div', { class: 'sv-stat', 'data-testid': 'sv-answered' }, h('small', {}, '回答あり'), h('b', {}, String(agg.answered))),
          h('div', { class: 'sv-stat', 'data-testid': 'sv-unanswered' }, h('small', {}, UNANSWERED), h('b', {}, String(agg.unanswered)))),
        h('p', { class: 'a-note' }, '割合は「回答あり」の人数に対する値です。未回答は、アンケートを出していなかったとき（導入前・オフにしていた間・古いバックアップ）の抽選の分です。学生（学籍番号）は対象外です。')),
      noData ? h('p', { class: 'a-sub', 'data-testid': 'sv-empty' }, 'まだ回答はありません') : null,
      card(`Q1 ${q1.short}`, h('div', { class: 'sv-bars' }, agg.ages.map((r) => barRow(`sv-age-${r.id}`, r.label, r.count, agg.answered, r.retired)))),
      card(`Q2 ${q2.short}（複数選択可）`,
        h('p', { class: 'a-note' }, '1人が複数選べるため、割合の合計は100%を超えます。'),
        h('div', { class: 'sv-bars' }, agg.triggers.map((r) => barRow(`sv-trig-${r.id}`, r.label, r.count, agg.answered, r.retired)))),
      card(`${q1.short} × ${q2.short}（人数）`,
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl tbl-cross', 'data-testid': 'sv-cross' },
          h('thead', {}, h('tr', {}, h('th', { class: 'l' }, nwPhrases(`${q1.short}＼`), nwPhrases(q2.short)), ...agg.triggers.map((t) => h('th', { class: 'l' }, splitPhrases(t.label).map((x) => h('span', { class: `ph${x.length <= 6 || /[A-Za-z]/.test(x) ? ' nw' : ''}` }, x)))))),
          h('tbody', {}, agg.ages.map((a) => h('tr', {}, h('td', { class: 'l strong2' }, nwPhrases(a.label)),
            ...agg.triggers.map((t) => {
              const n = agg.cross[a.id]?.[t.id] || 0;
              return h('td', { class: n ? 'has' : '', 'data-testid': `sv-cross-${a.id}-${t.id}`, style: n ? { backgroundColor: `rgba(var(--main-rgb), ${(0.12 + 0.4 * (n / crossMax)).toFixed(2)})` } : {} }, String(n));
            }))))))));
  };
  paint();
  put(el,
    h('p', { class: 'a-note' }, `${cfg.entry.guest.title}が抽選の前に答えたアンケートの集計です。個人を特定する情報は集めていません。回答はこのiPadとバックアップファイルにだけ保存されます。`),
    cfg.survey.enabled ? null : h('p', { class: 'msg msg--warn', 'data-testid': 'sv-disabled-note' },
      '今はアンケートを使わない設定です（「イベント」タブの「参加の方法」）。下の集計は、これまでの記録のぶんです。質問を直しておくこともできます。'),
    view,
    editor);
}

/** 「質問と選択肢」：見出し・短い名前・選択肢（追加・名前の変更・削除）・注意書き。既存の選択肢は id を変えず、新しい選択肢は newId で採番する。 */
function buildSurveyEditor(cfg) {
  const ed = {
    notice: cfg.survey.notice,
    q1: { heading: cfg.survey.q1.heading, short: cfg.survey.q1.short, options: cfg.survey.q1.options.map((o) => ({ ...o })) },
    q2: { heading: cfg.survey.q2.heading, short: cfg.survey.q2.short, options: cfg.survey.q2.options.map((o) => ({ ...o })) },
  };
  const LIM = { q1: LIMITS.q1Options, q2: LIMITS.q2Options };
  const NAME = { q1: 'Q1（単一選択）', q2: 'Q2（複数選択）' };
  const HINT = { q1: '選ぶと自動で次へ進みます。', q2: '1つ以上選ぶと、次へ進めます。' };
  const err = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'sv-edit-error' });
  const body = h('div', {});
  let refs;

  const qBlock = (k) => {
    const q = ed[k];
    const lim = LIM[k];
    const heading = textInput(q.heading, LIMITS.surveyHeading, { 'data-testid': `sv-edit-${k}-heading` });
    heading.addEventListener('input', () => { q.heading = heading.value; err.textContent = ''; });
    const short = textInput(q.short, LIMITS.surveyShort, { 'data-testid': `sv-edit-${k}-short` });
    short.addEventListener('input', () => { q.short = short.value; err.textContent = ''; });
    refs[k] = { heading, short, opts: [] };
    const rows = q.options.map((o, i) => {
      const inp = textInput(o.label, LIMITS.optionLabel, { 'aria-label': `${NAME[k]}の選択肢${i + 1}`, 'data-testid': `sv-edit-${k}-opt-${i}` });
      inp.addEventListener('input', () => { o.label = inp.value; err.textContent = ''; });
      refs[k].opts.push(inp);
      return h('div', { class: 'sv-opt' }, h('span', { class: 'sv-opt-n' }, String(i + 1)), inp,
        btn('削除', () => { q.options.splice(i, 1); paint(); }, 'ghost', { 'data-testid': `sv-edit-${k}-del-${i}`, disabled: q.options.length <= lim.min, 'aria-label': `選択肢${i + 1}を削除` }));
    });
    const addBtn = btn('選択肢を追加', () => {
      q.options.push({ id: newId(k, q.options.map((o) => o.id)), label: '' });
      paint();
      const last = refs[k].opts[refs[k].opts.length - 1];
      try { last.scrollIntoView({ block: 'center' }); last.focus({ preventScroll: true }); } catch { /* noop */ }
    }, 'ghost', { 'data-testid': `sv-edit-${k}-add`, disabled: q.options.length >= lim.max });
    return h('div', { class: 'sv-q' },
      h('h4', { class: 'a-sub-title' }, NAME[k]),
      h('p', { class: 'a-note' }, HINT[k]),
      h('div', { class: 'a-grid' },
        field('見出し', heading, '「/」は改行してよい位置（表示されません）', LIMITS.surveyHeading),
        field('短い名前', short, '集計・CSVの見出しに使います', LIMITS.surveyShort)),
      h('div', { class: 'sv-opts' }, rows),
      h('div', { class: 'a-row' }, addBtn,
        h('span', { class: 'a-note' }, `選択肢は${lim.min}〜${lim.max}個（いま${q.options.length}個）。1つ${LIMITS.optionLabel}字まで・同じ名前は使えません`)));
  };
  const noticeIn = h('textarea', { class: 'txt sv-notice', rows: 3, maxLength: LIMITS.surveyNotice, 'data-testid': 'sv-edit-notice', value: ed.notice });
  noticeIn.addEventListener('input', () => { ed.notice = noticeIn.value; err.textContent = ''; });
  function paint() {
    refs = {};
    put(body, qBlock('q1'), qBlock('q2'),
      h('div', { class: 'sv-q' }, field('注意書き（2つの質問の画面に出ます）', noticeIn, '空なら出しません', LIMITS.surveyNotice)));
  }
  paint();

  /** 誤りがあれば {message, el}、無ければ null */
  function problem() {
    for (const k of ['q1', 'q2']) {
      const q = ed[k];
      const heading = q.heading.trim();
      if (!heading) return { message: `${NAME[k]}の見出しを入力してください`, el: refs[k].heading };
      if (len(heading) > LIMITS.surveyHeading) return { message: `${NAME[k]}の見出しは${LIMITS.surveyHeading}字までです`, el: refs[k].heading };
      const short = q.short.trim();
      if (!short) return { message: `${NAME[k]}の短い名前を入力してください`, el: refs[k].short };
      if (len(short) > LIMITS.surveyShort) return { message: `${NAME[k]}の短い名前は${LIMITS.surveyShort}字までです`, el: refs[k].short };
      if (!inRange(q.options.length, LIM[k])) return { message: `${NAME[k]}の選択肢は${LIM[k].min}〜${LIM[k].max}個にしてください` };
      const seen = new Set();
      for (const [i, o] of q.options.entries()) {
        const s = o.label.trim();
        if (!s) return { message: `${NAME[k]}の選択肢${i + 1}を入力してください`, el: refs[k].opts[i] };
        if (len(s) > LIMITS.optionLabel) return { message: `${NAME[k]}の選択肢は${LIMITS.optionLabel}字までです（${s}）`, el: refs[k].opts[i] };
        if (seen.has(s)) return { message: `${NAME[k]}に同じ名前の選択肢があります（${s}）`, el: refs[k].opts[i] };
        seen.add(s);
      }
    }
    if (len(ed.notice.trim()) > LIMITS.surveyNotice) return { message: `注意書きは${LIMITS.surveyNotice}字までです`, el: noticeIn };
    return null;
  }
  const save = async () => {
    err.textContent = '';
    const bad = problem();
    if (bad) { err.textContent = bad.message; flag(bad.el); return; }
    const q = (k) => ({ heading: ed[k].heading.trim(), short: ed[k].short.trim(), options: ed[k].options.map((o) => ({ id: o.id, label: o.label.trim() })) });
    try {
      await updateConfig((c) => { c.survey.q1 = q('q1'); c.survey.q2 = q('q2'); c.survey.notice = ed.notice.trim(); }, 'survey-edit', { q1: ed.q1.options.length, q2: ed.q2.options.length });
      toast('保存しました');
      rerender();
    } catch (e) { err.textContent = errText(e); }
  };
  return card('質問と選択肢',
    h('p', { class: 'a-note' }, '一般の方に出す2つの質問を直せます。選択肢の名前を直したり削除したりしても、これまでの回答には、答えたときの名前が残ります（削除した選択肢は、集計に「旧選択肢」として出ます）。'),
    body,
    h('div', { class: 'a-row' }, btn('保存', save, 'primary', { 'data-testid': 'sv-edit-save' }), err));
}

// ---------- バックアップ・リセットタブ ----------
async function renderData(el) {
  const backup = await db.getBackupStatus();
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'data-testid': 'restore-file',
    onchange: async () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f && (await restore(f))) rerender(); } });
  const profileFile = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'data-testid': 'profile-file',
    onchange: async () => { const f = profileFile.files?.[0]; profileFile.value = ''; if (f && (await profileImportFlow(f))) rerender(); } });
  put(el,
    card('バックアップ',
      h('p', { class: 'a-note' }, backup.lastBackupAt
        ? `最終：${fmtDateTime(backup.lastBackupAt)}　以降の抽選 ${backup.drawsSince} 件`
        : `まだバックアップがありません（抽選 ${backup.drawsTotal} 件）`),
      h('p', { class: 'a-note' }, '交代時・各日の終了時に書き出してください。学籍番号とアンケート回答（個人は特定されません）を含むので、イベント後に削除してください。'),
      h('div', { class: 'a-row' },
        btn('バックアップを書き出す（JSON）', backupFlow, 'primary', { 'data-testid': 'backup-export' }),
        btn('バックアップから復元', () => fileInput.click(), 'ghost', { 'data-testid': 'backup-restore' }),
        fileInput)),
    card('設定ファイル（イベントの設定だけ）',
      h('p', { class: 'a-note' }, '名前・配色・回すもの・参加の方法・アンケート・景品・日程・初期本数だけを書き出します。抽選履歴・学籍番号・PINは入りません。ほかのiPadや次のイベントで読み込めます。'),
      h('p', { class: 'a-note' }, '読み込めるのは、抽選履歴が1件もないときだけです（リハーサルのあとは、先に「本番リセット」をしてください）。在庫は、ファイルの初期本数で作り直します。'),
      h('div', { class: 'a-row' },
        btn('設定ファイルを書き出す', profileExportFlow, 'primary', { 'data-testid': 'profile-export' }),
        btn('設定ファイルを読み込む', () => profileFile.click(), 'ghost', { 'data-testid': 'profile-import' }),
        profileFile)),
    card('確認用の書き出し（CSV）',
      h('div', { class: 'a-row' },
        btn('CSV（学籍番号を伏せる）', () => csvFlow(true), 'ghost', { 'data-testid': 'csv-masked' }),
        btn('CSV（学籍番号を含む）', () => csvFlow(false), 'ghost', { 'data-testid': 'csv-full' }))),
    card('本番リセット',
      h('p', { class: 'a-note' }, '抽選履歴・参加済み番号・ログを消し、在庫を初期本数へ戻します（設定・PINは残ります）。リハーサル後、本番前に1回だけ使います。'),
      btn('本番リセット…', productionResetFlow, 'danger', { 'data-testid': 'reset-production' })),
    card('全初期化',
      h('p', { class: 'a-note' }, '設定・PINを含むすべてのデータを削除し、初回セットアップに戻します。'),
      btn('全初期化…', wipeFlow, 'danger', { 'data-testid': 'reset-wipe' })));
}

async function backupFlow() {
  let data, file;
  try {
    data = await db.exportAll();
    file = new File([JSON.stringify(data)], `yosoro-gacha-backup-${fileStamp(data.exportedAt)}.json`, { type: 'application/json' });
  } catch (e) { return failMsg(e); }
  // 共有シートはクリック直後に呼ぶ必要があるため、作成と保存を2段階にしている
  const msg = h('p', { class: 'a-note', 'data-testid': 'backup-msg' }, `${file.name}（抽選 ${data.draws.length} 件・参加済み ${data.students.length} 件）`);
  await openDialog({
    title: 'バックアップを作成しました',
    body: msg,
    actions: [
      { label: '閉じる', kind: 'ghost', value: 'close', testid: 'dlg-cancel' },
      { label: '保存・共有する', kind: 'primary', value: 'save', testid: 'backup-save',
        check: () => { // 押した直後（ユーザー操作の中）で保存を開始する
          saveFile(file).then(async (r) => {
            if (r === 'cancelled') return;
            await db.markBackup(data.exportedAt);
            toast(r === 'shared' ? '共有しました' : 'ダウンロードしました');
            rerender();
          }).catch(failMsg);
          return true;
        } },
    ],
  });
}

/** 設定ファイルの書き出し（バックアップと同じ2段階：作成 → 押した直後に保存・共有。iOS の共有シートはクリックの中で呼ぶ必要がある） */
async function profileExportFlow() {
  let data, file;
  try {
    data = await db.exportProfileFile();
    file = new File([JSON.stringify(data)], `yosoro-gacha-profile-${data.profile.config.eventId}-${fileStamp(data.exportedAt)}.json`, { type: 'application/json' });
  } catch (e) { return failMsg(e); }
  const c = data.profile.config;
  await openDialog({
    title: '設定ファイルを作成しました',
    body: h('div', {},
      h('p', { class: 'a-note', 'data-testid': 'profile-msg' }, `${file.name}（${c.brand.name}・開催日 ${c.days.length}日・景品 ${c.prizes.length}個）`),
      h('p', { class: 'a-note' }, '抽選履歴・学籍番号・PINは入っていません。')),
    actions: [
      { label: '閉じる', kind: 'ghost', value: 'close', testid: 'dlg-cancel' },
      { label: '保存・共有する', kind: 'primary', value: 'save', testid: 'profile-save',
        check: () => {
          saveFile(file).then((r) => { if (r !== 'cancelled') toast(r === 'shared' ? '共有しました' : 'ダウンロードしました'); }).catch(failMsg);
          return true;
        } },
    ],
  });
}

/** 選んだファイルを設定ファイルとして読み、検証する。だめなら理由を表示して null。ok なら {obj, config, initials}（db.importProfile に渡すのは obj） */
async function readProfileFile(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { await alertDialog('JSONとして読み込めませんでした', '読み込めません'); return null; }
  const v = validateProfileFile(obj);
  if (!v.ok) { await alertDialog(v.error, '読み込めません'); return null; }
  return { obj, config: v.config, initials: v.initials };
}

/** スタッフ画面からの設定ファイルの読み込み：検証 → 抽選履歴があれば断る → 内容の確認 → 読み込み（在庫は初期本数で作り直し） */
async function profileImportFlow(file) {
  const p = await readProfileFile(file);
  if (!p) return false;
  const b = await db.getBackupStatus();
  if (b.drawsTotal > 0) {
    await alertDialog(`抽選履歴が ${b.drawsTotal} 件あるため、設定ファイルは読み込めません。リハーサルの履歴を消すときは、先に「本番リセット」をしてください。`, '読み込めません');
    return false;
  }
  const c = p.config;
  const ok = await confirmDialog({
    title: '設定ファイルを読み込みますか？',
    message: h('div', {},
      h('div', { class: 'dlg-sum', 'data-testid': 'profile-summary' },
        kv('ガチャ名', c.brand.name), kv('イベント名', c.eventName),
        kv('開催日', `${c.days.length}日（${c.days.map((d) => d.label).join('・')}）`),
        kv('賞・景品', `賞 ${c.categories.length}つ・景品 ${c.prizes.length}個`)),
      h('p', { class: 'dlg-msg msg--warn' }, '今の設定と在庫は、ファイルの内容に置き換わります。開催日は最初の日に戻ります。PINと効果音の設定は、今のままです。')),
    okLabel: '読み込む', danger: true,
  });
  if (!ok) return false;
  try {
    const saved = await db.importProfile(p.obj);
    showTheme(saved.theme);
    toast('設定ファイルを読み込みました');
    return true;
  } catch (e) { await alertDialog(errText(e), '読み込めませんでした'); return false; }
}

async function csvFlow(masked) {
  const [draws, cfg] = await Promise.all([db.listDraws(), db.getConfig()]);
  const { q1, q2 } = cfg.survey;
  const dayName = (id) => cfg.days.find((d) => d.id === id)?.label || id;
  const rows = [['抽選番号', '開催日', '抽選日時', '区分', '学籍番号', '賞の名称', '景品名', '確認日時', q1.short, q2.short]];
  for (const d of [...draws].reverse()) {
    rows.push([d.label, dayName(d.dayId), fmtDateTime(d.drawnAt), d.kind === 'student' ? '学生' : '一般',
      d.kind === 'student' ? (masked ? maskId(d.studentId) : d.studentId) : '', d.categoryName, d.prizeName, d.confirmedAt ? fmtDateTime(d.confirmedAt) : '未確認',
      ...(d.kind === 'guest' ? [ageLabelOf(d, q1.options), d.survey ? triggerLabelsOf(d, q2.options).join('／') : UNANSWERED] : ['', ''])]);
  }
  const file = new File(['﻿' + toCsv(rows)], `yosoro-gacha-draws-${fileStamp()}.csv`, { type: 'text/csv' });
  await saveFile(file);
}

async function restore(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { await alertDialog('JSONとして読み込めませんでした', '復元できません'); return false; }
  const v = validateBackup(obj);
  if (!v.ok) { await alertDialog(v.error, '復元できません'); return false; }
  const s = v.summary;
  const ok = await confirmDialog({
    title: 'バックアップから復元しますか？',
    message: h('div', {},
      h('p', { class: 'dlg-msg' }, `作成：${fmtDateTime(s.exportedAt)}　抽選 ${s.draws} 件・参加済み ${s.students} 件${s.pending ? `・未確認 ${s.pending}` : ''}`),
      h('p', { class: 'dlg-msg msg--warn' }, '現在のデータはすべて置き換えられます（設定・PINもバックアップの内容になります）。')),
    okLabel: '復元する', danger: true,
  });
  if (!ok) return false;
  try {
    await db.importAll(obj);
    const cfg = await db.getConfig();
    applySound(cfg);
    showTheme(cfg.theme);
    toast('復元しました');
    return true;
  } catch (e) { await failMsg(e); return false; }
}

/** 危険操作の確認：決められた言葉＋PIN を要求する。 */
async function askDanger({ title, message, word }) {
  const wordInput = h('input', { type: 'text', class: 'txt', placeholder: word, 'data-testid': 'danger-word', autocomplete: 'off' });
  const pinInput = h('input', { type: 'password', class: 'txt', inputmode: 'numeric', maxLength: PIN_MAX, placeholder: 'PIN', 'data-testid': 'danger-pin', autocomplete: 'off' });
  const r = await openDialog({
    title,
    body: h('div', {}, message,
      h('p', { class: 'dlg-msg' }, `確認のため「${word}」と入力し、PINを入力してください。`),
      h('div', { class: 'a-row' }, wordInput, pinInput)),
    actions: [
      { label: 'キャンセル', kind: 'ghost', value: false, testid: 'dlg-cancel' },
      { label: '実行する', kind: 'danger', value: true, testid: 'dlg-ok',
        check: () => (wordInput.value.trim() === word ? (pinInput.value ? true : 'PINを入力してください') : `「${word}」と入力してください`) },
    ],
  });
  if (r !== true) return false;
  if (!(await verifyPin(pinInput.value))) { await alertDialog('PINが違います', '実行しませんでした'); return false; }
  return true;
}

async function productionResetFlow() {
  const b = await db.getBackupStatus();
  const ok = await askDanger({
    title: '本番リセット', word: 'リセット',
    message: h('div', {},
      h('p', { class: 'dlg-msg' }, '抽選履歴・参加済みの学籍番号・ログを削除し、在庫を初期本数へ戻します。'),
      b.drawsSince > 0 ? h('p', { class: 'dlg-msg msg--warn' }, `未バックアップの抽選が ${b.drawsSince} 件あります。必要なら先にバックアップしてください。`) : null),
  });
  if (!ok) return;
  try { await db.productionReset(); toast('本番リセットしました'); rerender(); } catch (e) { failMsg(e); }
}

async function wipeFlow() {
  const ok = await askDanger({
    title: '全初期化', word: '初期化',
    message: h('p', { class: 'dlg-msg msg--warn' }, '設定・PIN・履歴・在庫のすべてを削除します。元に戻せません。'),
  });
  if (!ok) return;
  try { await db.wipeAll(); closeOverlay(); } catch (e) { failMsg(e); }
}

// ---------- 設定タブ ----------
// 効果音の状態（sound.status()）→ 表示文とピルの色
const SOUND_STATUS = {
  running: ['再生できます', 'ok'],
  locked: ['画面をタップすると有効になります', 'warn'],
  interrupted: ['中断中（タップで再開）', 'warn'],
  unavailable: ['この端末では使えません', 'bad'],
  off: ['オフ（設定）', 'warn'],
};

async function renderSettings(el) {
  const cfg = await db.getConfig();
  const rule = cfg.studentIdRule;

  const charset = h('select', { class: 'sel', 'data-testid': 'rule-charset' },
    h('option', { value: 'digits', selected: rule.charset !== 'alnum' }, '数字のみ'),
    h('option', { value: 'alnum', selected: rule.charset === 'alnum' }, '英数字'));
  const minI = numInput(rule.minLength, { min: 1, max: 20, 'data-testid': 'rule-min' });
  const maxI = numInput(rule.maxLength, { min: 1, max: 20, 'data-testid': 'rule-max' });

  const snd = cfg.sound || { enabled: true, volume: 0.7 };
  const enabled = h('input', { type: 'checkbox', checked: snd.enabled !== false, 'data-testid': 'sound-enabled' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: String(snd.volume ?? 0.7), class: 'range', 'data-testid': 'sound-volume' });
  const saveSound = async () => {
    const c = await updateConfig((x) => { x.sound = { enabled: enabled.checked, volume: Number(vol.value) }; }, 'sound', { enabled: enabled.checked, volume: Number(vol.value) });
    applySound(c);
  };
  enabled.addEventListener('change', saveSound);
  vol.addEventListener('change', async () => { await saveSound(); try { sound.play('tap'); } catch { /* noop */ } });

  // 再生できる状態かの表示と、テスト音（このボタンのクリック自体が音を解錠するタップになる）
  const sndPill = h('span', { 'data-testid': 'sound-status' });
  const paintSnd = () => {
    let s = 'locked';
    try { s = sound.status(); } catch { /* noop */ }
    const [text, kind] = SOUND_STATUS[s] || SOUND_STATUS.locked;
    sndPill.className = `pill pill--${kind}`;
    sndPill.textContent = text;
    sndPill.setAttribute('data-status', s);
  };
  paintSnd();
  // 状態が変わったら更新する。この画面が消えたら（再描画・閉じる）自動で購読をやめる。
  // iOS は状態の変化を通知しないことがあるので、表示中だけ軽く見張る。
  let offSnd = () => {};
  let sndTimer = 0;
  const refreshSnd = () => {
    if (!sndPill.isConnected) { offSnd(); clearInterval(sndTimer); return; }
    paintSnd();
  };
  try { offSnd = sound.onStatusChange(refreshSnd); } catch { /* noop */ }
  sndTimer = setInterval(refreshSnd, 1500);
  const testBtn = h('button', {
    type: 'button', class: 'btn btn--primary btn--lg', 'data-testid': 'sound-test',
    onclick: () => {
      try { sound.unlock(); sound.test(); } catch { /* noop */ }
      paintSnd();
      let s = '';
      try { s = sound.status(); } catch { /* noop */ }
      if (s === 'off') toast('効果音がオフです。「効果音を鳴らす」をオンにして、音量を上げてください');
      else if (s === 'unavailable') toast('この端末では効果音を使えません');
    },
  }, 'テスト音を鳴らす');

  const pins = ['現在のPIN', '新しいPIN', '新しいPIN（確認）'].map((ph, i) =>
    h('input', { type: 'password', class: 'txt', inputmode: 'numeric', maxLength: PIN_MAX, placeholder: ph, autocomplete: 'off', 'data-testid': `pin-${['cur', 'new', 'new2'][i]}` }));

  put(el,
    card('学籍番号のルール',
      h('div', { class: 'a-row' }, h('label', {}, '文字 ', charset), h('label', {}, '最小桁数 ', minI), h('label', {}, '最大桁数 ', maxI)),
      h('p', { class: 'a-note' }, '全角→半角・前後の空白除去は自動で行います。'),
      btn('保存', async () => {
        const min = Math.floor(Number(minI.value)), max = Math.floor(Number(maxI.value));
        if (!(min >= 1 && max >= min && max <= 20)) return alertDialog('桁数は 1〜20 で、最小 ≦ 最大 にしてください');
        await updateConfig((c) => { c.studentIdRule = { charset: charset.value, minLength: min, maxLength: max }; }, 'student-rule', { charset: charset.value, min, max });
        toast('保存しました');
      }, 'primary', { 'data-testid': 'rule-save' })),
    card('効果音',
      h('div', { class: 'a-row' }, h('label', { class: 'chk' }, enabled, ' 効果音を鳴らす'), h('label', {}, '音量 ', vol)),
      h('div', { class: 'a-row' }, h('span', { class: 'a-note' }, '状態'), sndPill),
      h('div', { class: 'a-row' }, testBtn),
      h('p', { class: 'a-note' }, '変更はすぐに反映されます。'),
      h('p', { class: 'a-note', 'data-testid': 'sound-help' }, '音が出ないとき：iPad本体の音量ボタン／コントロールセンターの消音（ベル）／Bluetoothスピーカーの接続を確認。アプリを開き直したら一度画面をタップ。')),
    card('PINの変更',
      h('div', { class: 'a-row' }, ...pins),
      btn('PINを変更', async () => {
        const [cur, n1, n2] = pins.map((p) => p.value);
        const valid = new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`);
        if (!(await verifyPin(cur))) return alertDialog('現在のPINが違います');
        if (!valid.test(n1)) return alertDialog(`PINは${PIN_MIN}〜${PIN_MAX}桁の数字にしてください`);
        if (n1 !== n2) return alertDialog('確認用のPINが一致しません');
        const hash = await hashPin(n1);
        await updateConfig((c) => { c.pinHash = hash; }, 'pin-change', null);
        pins.forEach((p) => { p.value = ''; });
        toast('PINを変更しました');
      }, 'primary', { 'data-testid': 'pin-change' })));
}

// ================= 初回セットアップ（docs/CUSTOMIZE.md §8.2） =================
// 手順：はじめかた → PIN → イベントの基本 → 景品と本数 → 学籍番号のルール（学生が有効なときだけ）→ 最後の準備
const fromTemplate = (tplId) => { const t = templateConfig(tplId); return { config: normalizeConfig(t.config), initials: t.initials }; };

export function openSetup() {
  return new Promise((resolve) => {
    const draft = { templateId: DEFAULT_TEMPLATE_ID, profileName: null, ...fromTemplate(DEFAULT_TEMPLATE_ID), pin: null, activeDayId: 'day1' };
    const steps = [
      { title: 'はじめかた', run: stepWelcome },
      { title: 'PIN', run: stepPin },
      { title: 'イベントの基本', run: stepBasics },
      { title: '景品と本数', run: stepBox },
      { title: '学籍番号のルール', run: stepRule, skip: (d) => !d.config.entry.student.enabled },
      { title: '最後の準備', run: stepStart },
    ];
    let idx = 0;
    const finish = () => { root.replaceChildren(); resolve(); };
    const move = (dir) => {
      let i = idx + dir;
      while (steps[i]?.skip?.(draft)) i += dir;
      if (steps[i]) { idx = i; draw(); }
    };

    function draw() {
      const content = h('div', { class: 'admin-scroll wizard-body' });
      const nav = h('div', { class: 'wizard-nav' });
      const shown = steps.filter((s) => !s.skip?.(draft));
      const pos = shown.indexOf(steps[idx]);
      mountOverlay(
        h('header', { class: 'admin-head' },
          h('h1', { class: 'a-title a-title--s' }, '初回セットアップ'),
          h('span', { class: 'wizard-now', 'data-testid': 'setup-step' }, `${pos + 1}/${shown.length}　${steps[idx].title}`),
          h('div', { class: 'wizard-steps' }, shown.map((s, i) => h('span', { class: `dot${i === pos ? ' is-on' : i < pos ? ' is-done' : ''}`, title: s.title }, String(i + 1))))),
        content, nav);
      steps[idx].run({ content, nav, draft, next: () => move(1), prev: () => move(-1), finish });
    }
    draw();
  });
}

const backBtn = (prev) => btn('戻る', prev, 'ghost', { 'data-testid': 'setup-back' });

/** 1. はじめかた：テンプレート（既定は denpasai-2026）／設定ファイルを読み込む／バックアップから復元する */
function stepWelcome({ content, nav, draft, next, finish }) {
  const cards = Object.entries(TEMPLATES).map(([tplId, t]) => {
    const cfg = normalizeConfig(t.config);
    const colors = resolveTheme(cfg.theme);
    return h('button', { type: 'button', class: 'tpl', 'aria-pressed': 'false', 'data-testid': `setup-template-${tplId}`, 'data-tpl': tplId, onclick: () => choose(tplId) },
      h('span', { class: 'tpl-text' }, h('span', { class: 'tpl-name' }, t.label), h('span', { class: 'tpl-desc' }, t.description), chips(colors)),
      motifIcon(cfg.motif, 72, colors.main, colors.accent));
  });
  const info = h('p', { class: 'msg msg--ok', 'data-testid': 'setup-profile-info' });
  const paint = () => {
    for (const c of cards) c.setAttribute('aria-pressed', String(!draft.profileName && c.dataset.tpl === draft.templateId));
    info.textContent = draft.profileName
      ? `設定ファイルを読み込みました：${draft.config.brand.name}（${draft.config.eventName}）・開催日 ${draft.config.days.length}日・景品 ${draft.config.prizes.length}個`
      : '';
    info.hidden = !draft.profileName;
  };
  const choose = (tplId) => {
    Object.assign(draft, { templateId: tplId, profileName: null }, fromTemplate(tplId));
    draft.activeDayId = draft.config.days[0].id;
    showTheme(draft.config.theme);   // 選んだテンプレートの配色を、このスタッフ画面で見せる
    paint();
  };
  const profileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'data-testid': 'setup-profile-file',
    onchange: async () => {
      const f = profileInput.files?.[0]; profileInput.value = '';
      if (!f) return;
      const p = await readProfileFile(f);
      if (!p) return;
      Object.assign(draft, { templateId: null, profileName: f.name, config: p.config, initials: p.initials });
      draft.activeDayId = p.config.days[0].id;
      showTheme(draft.config.theme);
      paint();
    } });
  // データが消えた場合など：バックアップがあればここから復元して再開できる（PINもバックアップのものになる）
  const restoreInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'data-testid': 'setup-restore-file',
    onchange: async () => { const f = restoreInput.files?.[0]; restoreInput.value = ''; if (f && (await restore(f))) finish(); } });
  put(content,
    h('h2', { class: 'a-title a-title--s' }, 'はじめかたを選んでください'),
    h('p', { class: 'a-note' }, 'どれを選んでも、このあとの手順で名前・配色・景品・本数などを変えられます。'),
    h('div', { class: 'tpl-grid' }, cards),
    card('設定ファイルから始める',
      h('p', { class: 'a-note' }, '前に書き出した「設定ファイル」を使います。名前・配色・景品・本数などがそのまま入ります（抽選履歴・PINは入りません）。'),
      h('div', { class: 'a-row' }, btn('設定ファイルを読み込む', () => profileInput.click(), 'ghost', { 'data-testid': 'setup-profile' }), profileInput),
      info));
  paint();
  put(nav,
    btn('バックアップから復元する', () => restoreInput.click(), 'ghost', { 'data-testid': 'setup-restore' }), restoreInput,
    btn('次へ', next, 'primary', { 'data-testid': 'setup-next' }));
}

/** 2. PIN（2回入力で自動で次へ） */
function stepPin({ content, nav, draft, next, prev }) {
  let first = null;
  const title = h('h2', { class: 'a-title a-title--s' }, `スタッフ用PINを決めてください（${PIN_MIN}〜${PIN_MAX}桁）`);
  const msg = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'setup-pin-error' });
  const pad = createTenkey({
    maxLength: PIN_MAX, mask: true, placeholder: 'PIN', testid: 'pin',
    onSubmit: (v) => {
      msg.textContent = '';
      if (first == null) {
        if (v.length < PIN_MIN) { msg.textContent = `${PIN_MIN}桁以上で入力してください`; return; }
        first = v; pad.clear(); title.textContent = 'もう一度同じPINを入力してください';
      } else if (v === first) {
        draft.pin = v; next();
      } else {
        first = null; pad.clear(); title.textContent = `一致しませんでした。もう一度（${PIN_MIN}〜${PIN_MAX}桁）`;
      }
    },
  });
  put(content, h('div', { class: 'admin-center' }, title,
    h('p', { class: 'a-note' }, 'スタッフ画面に入るための数字です。忘れないよう控えておいてください。'),
    draft.pin ? h('p', { class: 'a-note' }, 'PINは決めてあります。そのまま「次へ」で進めます（変える場合は、もう一度入力してください）。') : null,
    pad.el, msg));
  put(nav, backBtn(prev), draft.pin ? btn('次へ', next, 'primary', { 'data-testid': 'setup-next' }) : null);
}

/** 3. イベントの基本：名前・配色・回すもの・参加の方法・開催日数 */
function stepBasics({ content, nav, draft, next, prev }) {
  const cfg = draft.config;
  const WIZ = { name: 'setup-brand-name', nameLatin: 'setup-brand-latin', eventName: 'setup-event-name', eventLabel: 'setup-event-label', eventLatin: 'setup-event-latin' };
  const cur = { eventName: cfg.eventName, ...cfg.brand };
  const inputs = {};
  const fields = BRAND_FIELDS.filter(([key]) => key in WIZ).map(([key, , label, max, , ascii, hint]) => {
    inputs[key] = textInput(cur[key], max, ascii ? { lang: 'en', autocapitalize: 'off', autocorrect: 'off', spellcheck: false, 'data-testid': WIZ[key] } : { 'data-testid': WIZ[key] });
    return field(label, inputs[key], hint, max);
  });

  // 配色・回すもの：選ぶとすぐ、このスタッフ画面にも見せる（決定は「次へ」で draft に入る＝選んだ時点で draft に入れる）
  const keptTheme = cfg.theme.custom ? { preset: cfg.theme.preset, custom: cfg.theme.custom } : null;   // 設定ファイルのカスタム配色（あれば選び直せるよう取っておく）
  const themeVal = () => (cfg.theme.custom ? '__custom' : (own(THEMES, cfg.theme.preset) ? cfg.theme.preset : 'yosoro'));
  const themeSel = h('select', { class: 'sel', 'data-testid': 'setup-theme', 'aria-label': '配色' },
    Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: themeVal() === k }, t.label)),
    keptTheme ? h('option', { value: '__custom', selected: true }, 'カスタム（設定ファイルの色）') : null);
  const themeChips = h('span', {});
  const paintTheme = () => put(themeChips, chips(resolveTheme(cfg.theme)));
  themeSel.addEventListener('change', () => {
    cfg.theme = themeSel.value === '__custom' ? { ...keptTheme } : { preset: themeSel.value, custom: null };
    showTheme(cfg.theme);
    paintTheme();
  });
  paintTheme();
  const motifVal = () => (own(MOTIFS, cfg.motif) ? cfg.motif : 'helm');
  const motifSel = h('select', { class: 'sel', 'data-testid': 'setup-motif', 'aria-label': '回すもの' },
    Object.entries(MOTIFS).map(([k, m]) => h('option', { value: k, selected: motifVal() === k }, m.label)));
  const motifView = h('span', { class: 'wz-motif' });
  const paintMotif = () => put(motifView, motifIcon(cfg.motif, 64, 'var(--main)', 'var(--accent)'));
  motifSel.addEventListener('change', () => { cfg.motif = motifSel.value; paintMotif(); });
  paintMotif();

  // 参加の方法
  const cbStu = h('input', { type: 'checkbox', checked: cfg.entry.student.enabled, 'data-testid': 'setup-entry-student' });
  const cbGst = h('input', { type: 'checkbox', checked: cfg.entry.guest.enabled, 'data-testid': 'setup-entry-guest' });
  const cbSvy = h('input', { type: 'checkbox', checked: cfg.survey.enabled, 'data-testid': 'setup-entry-survey' });
  const syncSvy = () => { cbSvy.disabled = !cbGst.checked; };
  cbGst.addEventListener('change', syncSvy);
  syncSvy();

  // 開催日数（1〜7）：増やした日の初期本数は1日目と同じ値。名前は1日なら「当日」、2日以上なら「N日目」
  const daysSel = h('select', { class: 'sel', 'data-testid': 'setup-days', 'aria-label': '開催日数' },
    Array.from({ length: LIMITS.days.max }, (_, i) => h('option', { value: String(i + 1), selected: cfg.days.length === i + 1 }, `${i + 1}日`)));
  daysSel.addEventListener('change', () => setDayCount(draft, Number(daysSel.value)));

  const err = h('span', { class: 'msg msg--error', role: 'alert', 'data-testid': 'setup-error' });
  /** 入力を draft に写す。strict なら検証して、だめなら false */
  const store = (strict) => {
    const v = Object.fromEntries(Object.keys(WIZ).map((k) => [k, inputs[k].value.trim()]));
    if (strict) {
      const bad = checkBrand(v);
      if (bad) { err.textContent = bad.message; flag(inputs[bad.key]); return false; }
      if (!cbStu.checked && !cbGst.checked) { err.textContent = '学生と一般の方の、少なくとも一方は選んでください'; flag(cbStu); return false; }
    }
    cfg.eventName = v.eventName;
    Object.assign(cfg.brand, { name: v.name, nameLatin: v.nameLatin, eventLabel: v.eventLabel, eventLatin: v.eventLatin });
    cfg.entry.student.enabled = cbStu.checked;
    cfg.entry.guest.enabled = cbGst.checked;
    if (!cbStu.checked && !cbGst.checked) { cfg.entry.student.enabled = true; cfg.entry.guest.enabled = true; }   // 戻るときの途中の状態。進むときは上で止める
    cfg.survey.enabled = cbSvy.checked;
    return true;
  };

  put(content,
    h('h2', { class: 'a-title a-title--s' }, 'イベントの基本'),
    h('p', { class: 'a-note' }, 'ここで決めた内容は、あとからスタッフ画面の「イベント」タブでも変えられます（帯の文字・景品の呼び方もそこで変えられます）。'),
    card('名前', h('div', { class: 'a-grid' }, fields)),
    card('見た目',
      h('div', { class: 'a-grid' },
        h('div', { class: 'wz-pick' }, field('配色', themeSel), themeChips),
        h('div', { class: 'wz-pick' }, field('回すもの', motifSel), motifView))),
    card('参加の方法',
      h('div', { class: 'a-col' },
        check(cbStu, '学生（学籍番号で参加済みを確認）'),
        check(cbGst, '一般の方（学籍番号なし）'),
        h('div', { class: 'en-sub' }, check(cbSvy, '一般の方に、抽選の前のアンケートを出す')),
        h('p', { class: 'a-note' }, 'アンケートを出さないときは、一般の方は入口を選ぶとそのまま抽選に進みます。'))),
    card('開催日数',
      h('div', { class: 'a-row' }, h('label', {}, '日数 ', daysSel)),
      h('p', { class: 'a-note' }, '日ごとに別のくじ箱です。1日なら「当日」、2日以上なら「1日目」「2日目」…の名前になります（次の手順で変えられます）。')));
  put(nav, backBtn(() => { if (store(false)) prev(); }), err, btn('次へ', () => { err.textContent = ''; if (store(true)) next(); }, 'primary', { 'data-testid': 'setup-next' }));
}

/** 開催日数を変える（増やした日の初期本数は1日目と同じ値）。名前は既定のときだけ「当日」⇔「1日目」を入れ替える。 */
function setDayCount(draft, n) {
  const { days } = draft.config;
  while (days.length > n) delete draft.initials[days.pop().id];
  while (days.length < n) {
    const first = days[0];
    const nid = nextDayId(days);
    if (!nid) break;
    days.push({ id: nid, label: `${days.length + 1}日目` });
    draft.initials[nid] = { ...(draft.initials[first.id] || {}) };
  }
  if (days.length === 1 && days[0].label.trim() === '1日目') days[0].label = '当日';
  if (days.length > 1 && days[0].label.trim() === '当日') days[0].label = '1日目';
  if (!days.some((d) => d.id === draft.activeDayId)) draft.activeDayId = days[0].id;
}

/** 4. 景品と本数：「景品・日程」タブと同じ編集部品（すべての日が編集できる） */
function stepBox({ content, nav, draft, next, prev }) {
  const cfg = draft.config;
  const editor = createBoxEditor({ draft: { days: cfg.days, categories: cfg.categories, prizes: cfg.prizes, initials: draft.initials }, wizard: true });
  put(content,
    h('h2', { class: 'a-title a-title--s' }, '景品と日別の本数'),
    h('p', { class: 'a-note' }, '各日は別のくじ箱です。日ごとの本数を同じにすると、どの日も同じ確率になります。0本の景品は当たりません。景品・本数は、あとからスタッフ画面の「景品・日程」でも変えられます。'),
    editor.el);
  const err = h('span', { class: 'msg msg--error', role: 'alert', 'data-testid': 'setup-error' });
  const store = (v) => { cfg.days = v.days; cfg.categories = v.categories; cfg.prizes = v.prizes; draft.initials = v.initials; };
  put(nav,
    backBtn(() => { store(editor.raw()); prev(); }), err,
    btn('次へ', () => {
      err.textContent = '';
      const r = editor.validate();
      if (!r.ok) { err.textContent = r.message; flag(r.el); return; }
      store(r.value);
      if (!cfg.days.some((d) => d.id === draft.activeDayId)) draft.activeDayId = cfg.days[0].id;
      next();
    }, 'primary', { 'data-testid': 'setup-next' }));
}

/** 5. 学籍番号のルール（学生が有効なときだけ） */
function stepRule({ content, nav, draft, next, prev }) {
  const rule = draft.config.studentIdRule;
  const charset = h('select', { class: 'sel', 'data-testid': 'rule-charset' },
    h('option', { value: 'digits', selected: rule.charset !== 'alnum' }, '数字のみ'),
    h('option', { value: 'alnum', selected: rule.charset === 'alnum' }, '英数字'));
  const minI = numInput(rule.minLength, { min: 1, max: 20, 'data-testid': 'rule-min' });
  const maxI = numInput(rule.maxLength, { min: 1, max: 20, 'data-testid': 'rule-max' });
  put(content,
    h('h2', { class: 'a-title a-title--s' }, '学籍番号のルール'),
    h('p', { class: 'a-note' }, '学生は学籍番号の重複で「参加済み」を判定します（イベント期間を通じて1回）。入力が許される形を決めます。'),
    h('div', { class: 'a-row' }, h('label', {}, '文字 ', charset), h('label', {}, '最小桁数 ', minI), h('label', {}, '最大桁数 ', maxI)));
  const err = h('span', { class: 'msg msg--error', role: 'alert', 'data-testid': 'setup-error' });
  put(nav, backBtn(prev), err, btn('次へ', () => {
    const min = Math.floor(Number(minI.value)), max = Math.floor(Number(maxI.value));
    if (!(min >= 1 && max >= min && max <= 20)) { err.textContent = '桁数は 1〜20 で、最小 ≦ 最大 にしてください'; return; }
    draft.config.studentIdRule = { charset: charset.value, minLength: min, maxLength: max };
    next();
  }, 'primary', { 'data-testid': 'setup-next' }));
}

/** 6. 最後の準備：保存領域の保護・今日の開催日・設定内容の確認 → 保存して開始 */
function stepStart({ content, nav, draft, prev, finish }) {
  const cfg = draft.config;
  if (!cfg.days.some((d) => d.id === draft.activeDayId)) draft.activeDayId = cfg.days[0].id;
  const persistState = h('p', { class: 'a-note', 'data-testid': 'persist-state' });
  const showPersist = async () => { persistState.textContent = (await db.persisted()) ? '保存領域は保護されています' : 'まだ保護されていません（許可されない場合もあります）'; };
  showPersist();
  const days = cfg.days.map((d) => h('label', { class: 'chk radio' },
    h('input', { type: 'radio', name: 'day', value: d.id, checked: d.id === draft.activeDayId, 'data-testid': `start-${d.id}`, onchange: () => { draft.activeDayId = d.id; } }), ` ${d.label}`));
  const err = h('span', { class: 'msg msg--error', role: 'alert', 'data-testid': 'setup-error' });
  const total = (d) => cfg.prizes.reduce((s, p) => s + (Number(draft.initials[d.id]?.[p.id]) || 0), 0);
  const way = [cfg.entry.student.enabled ? '学生' : null, cfg.entry.guest.enabled ? `一般の方（アンケート${cfg.survey.enabled ? 'あり' : 'なし'}）` : null].filter(Boolean).join('・');
  put(content,
    h('h2', { class: 'a-title a-title--s' }, '最後の準備'),
    card('データの保護',
      h('p', { class: 'a-note' }, 'iPadの空き容量が少ないとSafariがデータを消すことがあります。保護を許可しておくと安心です。'),
      btn('保存領域の保護を許可する', async () => { await db.requestPersist(); showPersist(); }, 'ghost', { 'data-testid': 'setup-persist' }), persistState),
    card('今日の開催日', h('div', { class: 'a-row' }, ...days)),
    card('設定内容',
      h('div', { 'data-testid': 'setup-summary' },
        kv('ガチャ名', `${cfg.brand.name}${cfg.brand.nameLatin ? `（${cfg.brand.nameLatin}）` : ''}`),
        kv('イベント名', cfg.eventName),
        kv('配色', h('span', {}, themeLabel(cfg.theme), ' ', chips(resolveTheme(cfg.theme)))),
        kv('回すもの', motifLabel(cfg.motif)),
        kv('参加の方法', way),
        kv('開催日・本数', cfg.days.map((d) => `${d.label} ${total(d)}本`).join(' / ')),
        cfg.entry.student.enabled ? kv('学籍番号', `${cfg.studentIdRule.charset === 'alnum' ? '英数字' : '数字'}${cfg.studentIdRule.minLength}〜${cfg.studentIdRule.maxLength}桁`) : null,
        kv('PIN', '設定済み'))),
    h('p', { class: 'a-note' }, '※本番前に、リハーサルをしたら「バックアップ・リセット」の「本番リセット」で履歴を消してください。'));
  let starting = false;   // 二重に押しても保存は1回だけ
  put(nav, backBtn(prev), err, btn('はじめる', async () => {
    if (starting) return;
    starting = true;
    err.textContent = '';
    try {
      const config = { ...cfg, pinHash: await hashPin(draft.pin) };
      await db.initialize({ config, activeDayId: draft.activeDayId, initials: draft.initials });
      db.requestPersist();
      finish();
    } catch { err.textContent = '保存できませんでした。もう一度お試しください'; starting = false; }
  }, 'primary', { 'data-testid': 'setup-start' }));
}
