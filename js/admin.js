// スタッフ画面（DESIGN.md §7）：PIN認証・初回セットアップ・在庫・設定・履歴・バックアップ・リセット・SW更新
import * as db from './db.js';
import { sound } from './sound.js';
import { validateBackup } from './db.js';
import { createDefaultConfig, createDefaultInitials, PIN_MIN, PIN_MAX } from './config.js';
import { h, hashPin, fmtDateTime, fileStamp, maskId, toCsv, saveFile } from './util.js';
import { createTenkey, openDialog, confirmDialog, alertDialog, toast } from './ui.js';

const root = document.getElementById('admin-root');
let closeResolve = null;

// ---------- 共通 ----------
const ERR_TEXT = {
  PENDING_EXISTS: '未確認の抽選があります。先にスタッフ確認（OK）を済ませてください',
  NEGATIVE: '残数がマイナスになるため調整できません',
  DAY_HAS_DRAWS: '抽選が始まった日の初期本数は変更できません（残数の調整を使ってください）',
  INVALID_BACKUP: 'バックアップファイルが正しくありません',
};
const errText = (e) => ERR_TEXT[e?.code] || '保存できませんでした';
const failMsg = (e) => alertDialog(e?.code === 'INVALID_BACKUP' ? `${ERR_TEXT.INVALID_BACKUP}：${e.message.replace(/^INVALID_BACKUP: /, '')}` : errText(e), '失敗しました');

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

/** 現在の config を読み直して変更し保存する（古い画面の内容で上書きしない）。 */
async function updateConfig(mutator, logType, logDetail) {
  const cfg = await db.getConfig();
  mutator(cfg);
  await db.saveConfig(cfg, logType, logDetail);
  return cfg;
}

function applySound(cfg) {
  try { sound.setEnabled(cfg.sound?.enabled !== false); sound.setVolume(cfg.sound?.volume ?? 0.7); } catch { /* noop */ }
}

const pill = (text, kind) => h('span', { class: `pill pill--${kind}` }, text);
const numInput = (value, props = {}) =>
  h('input', { type: 'number', class: 'num', min: 0, step: 1, inputmode: 'numeric', value: String(value), ...props });
const btn = (label, onclick, kind = 'ghost', props = {}) =>
  h('button', { type: 'button', class: `btn btn--${kind} btn--sm`, onclick, ...props }, label);

function card(title, ...children) {
  return h('section', { class: 'a-card' }, title ? h('h3', { class: 'a-card-title' }, title) : null, ...children);
}

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
  ['status', '状態'], ['inventory', '在庫'], ['prizes', '景品設定'],
  ['history', '履歴'], ['data', 'バックアップ・リセット'], ['settings', '設定'],
];
let currentTab = 'status';

function showMain(tab = currentTab) {
  currentTab = tab;
  const body = h('div', { class: 'admin-scroll', 'data-testid': `tab-${tab}` }, h('p', { class: 'a-sub' }, '読み込み中…'));
  mountOverlay(
    h('header', { class: 'admin-head' },
      h('h1', { class: 'a-title a-title--s' }, 'スタッフ画面'),
      h('nav', { class: 'a-tabs' }, TABS.map(([id, label]) =>
        h('button', { type: 'button', class: `a-tab${id === tab ? ' is-on' : ''}`, 'data-testid': `tabbtn-${id}`, onclick: () => showMain(id) }, label))),
      btn('閉じる', closeOverlay, 'primary', { 'data-testid': 'admin-close' })),
    body);
  const renderers = { status: renderStatus, inventory: renderInventory, prizes: renderPrizes, history: renderHistory, data: renderData, settings: renderSettings };
  renderers[tab](body).catch((e) => { body.replaceChildren(h('p', { class: 'msg msg--error' }, `読み込めませんでした（${e?.code || 'ERR'}）`)); });
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
          message: '日ごとに別のくじ箱です。1日目の残りは2日目へ自動では繰り越されません。',
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

  el.replaceChildren(
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
      h('p', { class: 'a-note' }, '本数が決まったら「景品設定」で入力してください。0本のままだと当たりません。'),
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
  el.replaceChildren(
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

// ---------- 景品設定タブ ----------
async function renderPrizes(el) {
  const [cfg, inv, draws] = await Promise.all([db.getConfig(), db.listInventory(), db.listDraws()]);
  const lockedDays = new Set(draws.map((d) => d.dayId));
  const catInputs = {}, nameInputs = {}, unkInputs = {}, initInputs = {};
  const sections = cfg.categories.map((c) => {
    catInputs[c.id] = h('input', { type: 'text', class: 'txt', value: c.name, maxLength: 40, 'data-testid': `cat-${c.id}` });
    const rows = cfg.prizes.filter((p) => p.categoryId === c.id).map((p) => {
      nameInputs[p.id] = h('input', { type: 'text', class: 'txt', value: p.name, maxLength: 60, 'data-testid': `pname-${p.id}` });
      unkInputs[p.id] = h('input', { type: 'checkbox', checked: !!p.countUnknown });
      return h('tr', {},
        h('td', { class: 'l' }, nameInputs[p.id]),
        ...cfg.days.map((d) => {
          const rec = inv.find((r) => r.key === `${d.id}:${p.id}`);
          const inp = numInput(rec?.initial ?? 0, { disabled: lockedDays.has(d.id), 'data-testid': `pinit-${d.id}-${p.id}` });
          (initInputs[d.id] ||= {})[p.id] = inp;
          return h('td', {}, inp);
        }),
        h('td', {}, h('label', { class: 'chk' }, unkInputs[p.id], ' 本数未定')));
    });
    return card(null,
      h('div', { class: 'a-row' }, h('label', {}, '賞の名称 ', catInputs[c.id]), h('span', { class: 'a-note' }, `系統：${c.tier}（演出の種類。変更不可）`)),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', { class: 'l' }, '景品名'), ...cfg.days.map((d) => h('th', {}, `${d.label} 初期本数`)), h('th', {}, ''))),
        h('tbody', {}, rows))));
  });
  const locked = cfg.days.filter((d) => lockedDays.has(d.id)).map((d) => d.label);
  el.replaceChildren(
    h('p', { class: 'a-note' }, '賞の名称・景品名・日別の初期本数を編集できます。過去の抽選履歴の名称は変わりません。'),
    locked.length ? h('p', { class: 'msg msg--warn' }, `${locked.join('・')}は抽選が始まっているため、初期本数は変更できません。「在庫」の±調整を使ってください。`) : null,
    ...sections,
    h('div', { class: 'a-row' }, btn('保存する', async () => {
      const initials = {};
      for (const d of cfg.days) {
        if (lockedDays.has(d.id)) continue;
        initials[d.id] = {};
        for (const p of cfg.prizes) initials[d.id][p.id] = initInputs[d.id][p.id].value;
      }
      try {
        await db.savePrizeSettings({
          categories: cfg.categories.map((c) => ({ id: c.id, name: catInputs[c.id].value })),
          prizes: cfg.prizes.map((p) => ({ id: p.id, name: nameInputs[p.id].value, countUnknown: unkInputs[p.id].checked })),
          initials,
        });
        toast('保存しました');
        rerender();
      } catch (e) { failMsg(e); }
    }, 'primary', { 'data-testid': 'prizes-save' })));
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
    list.replaceChildren(
      draws.length === 0 ? h('p', { class: 'a-sub' }, 'まだ抽選はありません') :
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ...['番号', '日時', '区分', '賞／景品', '状態', ''].map((t, i) => h('th', { class: i === 0 || i === 3 ? 'l' : '' }, t)))),
          h('tbody', {}, rows))),
      draws.length > shown ? btn('さらに表示', () => { shown += 100; paint(); }) : null);
  };
  paint();
  const counts = cfg.days.map((d) => `${d.label} ${draws.filter((x) => x.dayId === d.id).length}件`).join(' / ');
  el.replaceChildren(
    h('p', { class: 'a-note' }, `新しい順。学籍番号は末尾2桁以外を伏せています。合計 ${draws.length} 件（${counts}）`),
    list);
}

// ---------- バックアップ・リセットタブ ----------
async function renderData(el) {
  const backup = await db.getBackupStatus();
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'data-testid': 'restore-file',
    onchange: async () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f && (await restore(f))) rerender(); } });
  el.replaceChildren(
    card('バックアップ',
      h('p', { class: 'a-note' }, backup.lastBackupAt
        ? `最終：${fmtDateTime(backup.lastBackupAt)}　以降の抽選 ${backup.drawsSince} 件`
        : `まだバックアップがありません（抽選 ${backup.drawsTotal} 件）`),
      h('p', { class: 'a-note' }, '交代時・各日の終了時に書き出してください。学籍番号を含むので、イベント後に削除してください。'),
      h('div', { class: 'a-row' },
        btn('バックアップを書き出す（JSON）', backupFlow, 'primary', { 'data-testid': 'backup-export' }),
        btn('バックアップから復元', () => fileInput.click(), 'ghost', { 'data-testid': 'backup-restore' }),
        fileInput)),
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

async function csvFlow(masked) {
  const [draws, cfg] = await Promise.all([db.listDraws(), db.getConfig()]);
  const dayName = (id) => cfg.days.find((d) => d.id === id)?.label || id;
  const rows = [['抽選番号', '開催日', '抽選日時', '区分', '学籍番号', '賞の名称', '景品名', '確認日時']];
  for (const d of [...draws].reverse()) {
    rows.push([d.label, dayName(d.dayId), fmtDateTime(d.drawnAt), d.kind === 'student' ? '学生' : '一般',
      d.kind === 'student' ? (masked ? maskId(d.studentId) : d.studentId) : '', d.categoryName, d.prizeName, d.confirmedAt ? fmtDateTime(d.confirmedAt) : '未確認']);
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
  try { await db.importAll(obj); applySound(await db.getConfig()); toast('復元しました'); return true; } catch (e) { await failMsg(e); return false; }
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

  const pins = ['現在のPIN', '新しいPIN', '新しいPIN（確認）'].map((ph, i) =>
    h('input', { type: 'password', class: 'txt', inputmode: 'numeric', maxLength: PIN_MAX, placeholder: ph, autocomplete: 'off', 'data-testid': `pin-${['cur', 'new', 'new2'][i]}` }));

  el.replaceChildren(
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
      h('p', { class: 'a-note' }, '変更はすぐに反映されます。')),
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

// ================= 初回セットアップ =================
export function openSetup() {
  return new Promise((resolve) => {
    const draft = { config: createDefaultConfig(), initials: createDefaultInitials(), pin: null, activeDayId: 'day1' };
    const steps = [stepPin, stepPrizes, stepRule, stepStart];
    let idx = 0;
    const go = (n) => { idx = n; draw(); };
    const finish = () => { root.replaceChildren(); resolve(); };

    function draw() {
      const content = h('div', { class: 'admin-scroll wizard-body' });
      const nav = h('div', { class: 'wizard-nav' });
      mountOverlay(
        h('header', { class: 'admin-head' },
          h('h1', { class: 'a-title a-title--s' }, '初回セットアップ'),
          h('div', { class: 'wizard-steps' }, steps.map((_, i) => h('span', { class: `dot${i === idx ? ' is-on' : i < idx ? ' is-done' : ''}` }, String(i + 1))))),
        content, nav);
      steps[idx]({ content, nav, draft, go, next: () => go(idx + 1), prev: () => go(idx - 1), finish, idx });
    }
    draw();
  });
}

function stepPin({ content, nav, draft, next, finish }) {
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
  content.replaceChildren(h('div', { class: 'admin-center' }, title, h('p', { class: 'a-note' }, 'スタッフ画面に入るための数字です。忘れないよう控えておいてください。'), pad.el, msg));
  // データが消えた場合など：バックアップがあればここから復元して再開できる
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'data-testid': 'setup-restore-file',
    onchange: async () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f && (await restore(f))) finish(); } });
  nav.replaceChildren(btn('バックアップから復元する', () => fileInput.click(), 'ghost', { 'data-testid': 'setup-restore' }), fileInput);
}

function stepPrizes({ content, nav, draft, next, prev }) {
  const cfg = draft.config;
  const inputs = {};
  const rows = cfg.prizes.map((p) => {
    const cat = cfg.categories.find((c) => c.id === p.categoryId);
    return h('tr', {},
      h('td', { class: 'l' }, h('div', { class: 'cat' }, cat.name), p.name,
        p.countUnknown ? h('div', { class: 'msg msg--warn' }, '本数が未定です。決まったら入力（スタッフ画面の「景品設定」でも変更できます）') : null),
      ...cfg.days.map((d) => {
        const inp = numInput(draft.initials[d.id][p.id], { 'data-testid': `init-${d.id}-${p.id}` });
        (inputs[d.id] ||= {})[p.id] = inp;
        return h('td', {}, inp);
      }));
  });
  content.replaceChildren(
    h('h2', { class: 'a-title a-title--s' }, '景品と日別の本数の確認'),
    h('p', { class: 'a-note' }, '各日は別のくじ箱です。両日の本数を同じにすると、両日で同じ確率になります。0本の景品は当たりません。'),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', { class: 'l' }, '景品'), ...cfg.days.map((d) => h('th', {}, `${d.label}`)))),
      h('tbody', {}, rows))));
  const err = h('span', { class: 'msg msg--error' });
  nav.replaceChildren(btn('戻る', prev), err, btn('次へ', () => {
    for (const d of cfg.days) for (const p of cfg.prizes) {
      const n = Number(inputs[d.id][p.id].value);
      if (!Number.isInteger(n) || n < 0 || n > 100000) { err.textContent = '本数は0以上の整数で入力してください'; return; }
      draft.initials[d.id][p.id] = n;
    }
    next();
  }, 'primary', { 'data-testid': 'setup-next' }));
}

function stepRule({ content, nav, draft, next, prev }) {
  const rule = draft.config.studentIdRule;
  const charset = h('select', { class: 'sel', 'data-testid': 'rule-charset' },
    h('option', { value: 'digits', selected: rule.charset !== 'alnum' }, '数字のみ'),
    h('option', { value: 'alnum', selected: rule.charset === 'alnum' }, '英数字'));
  const minI = numInput(rule.minLength, { min: 1, max: 20, 'data-testid': 'rule-min' });
  const maxI = numInput(rule.maxLength, { min: 1, max: 20, 'data-testid': 'rule-max' });
  content.replaceChildren(
    h('h2', { class: 'a-title a-title--s' }, '学籍番号のルール'),
    h('p', { class: 'a-note' }, '本校の学生は学籍番号の重複で「参加済み」を判定します（電波祭の両日を通じて1回）。入力が許される形を決めます。'),
    h('div', { class: 'a-row' }, h('label', {}, '文字 ', charset), h('label', {}, '最小桁数 ', minI), h('label', {}, '最大桁数 ', maxI)));
  const err = h('span', { class: 'msg msg--error' });
  nav.replaceChildren(btn('戻る', prev), err, btn('次へ', () => {
    const min = Math.floor(Number(minI.value)), max = Math.floor(Number(maxI.value));
    if (!(min >= 1 && max >= min && max <= 20)) { err.textContent = '桁数は 1〜20 で、最小 ≦ 最大 にしてください'; return; }
    draft.config.studentIdRule = { charset: charset.value, minLength: min, maxLength: max };
    next();
  }, 'primary', { 'data-testid': 'setup-next' }));
}

function stepStart({ content, nav, draft, prev, finish }) {
  const cfg = draft.config;
  const persistState = h('p', { class: 'a-note', 'data-testid': 'persist-state' });
  const showPersist = async () => { persistState.textContent = (await db.persisted()) ? '保存領域は保護されています' : 'まだ保護されていません（許可されない場合もあります）'; };
  showPersist();
  const days = cfg.days.map((d) => h('label', { class: 'chk radio' },
    h('input', { type: 'radio', name: 'day', value: d.id, checked: d.id === draft.activeDayId, 'data-testid': `start-${d.id}`, onchange: () => { draft.activeDayId = d.id; } }), ` ${d.label}`));
  const err = h('span', { class: 'msg msg--error', 'data-testid': 'setup-error' });
  content.replaceChildren(
    h('h2', { class: 'a-title a-title--s' }, '最後の準備'),
    card('データの保護',
      h('p', { class: 'a-note' }, 'iPadの空き容量が少ないとSafariがデータを消すことがあります。保護を許可しておくと安心です。'),
      btn('保存領域の保護を許可する', async () => { await db.requestPersist(); showPersist(); }, 'ghost', { 'data-testid': 'setup-persist' }), persistState),
    card('今日の開催日', h('div', { class: 'a-row' }, ...days)),
    card('設定内容', h('p', { class: 'a-note' }, `PIN：設定済み　学籍番号：${cfg.studentIdRule.charset === 'alnum' ? '英数字' : '数字'}${cfg.studentIdRule.minLength}〜${cfg.studentIdRule.maxLength}桁`)),
    h('p', { class: 'a-note' }, '※本番前に、リハーサルをしたら「バックアップ・リセット」の「本番リセット」で履歴を消してください。'));
  nav.replaceChildren(btn('戻る', prev), err, btn('はじめる', async () => {
    try {
      const config = draft.config;
      config.pinHash = await hashPin(draft.pin);
      await db.initialize({ config, activeDayId: draft.activeDayId, initials: draft.initials });
      db.requestPersist();
      finish();
    } catch { err.textContent = '保存できませんでした。もう一度お試しください'; }
  }, 'primary', { 'data-testid': 'setup-start' }));
}
