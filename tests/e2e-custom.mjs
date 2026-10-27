// E2E（ほかのイベントで使うための設定機能）: node tests/e2e-custom.mjs（npm run e2e:custom）
// docs/CUSTOMIZE.md の機能（テンプレート・名前・配色・回すもの・参加の方法・景品と日程・アンケートの編集・設定ファイル・v1 バックアップ・文字の収まり）を、
// 実際の画面（Playwright / Chromium）で通し確認する。画面・CSS 変数・DOM・IndexedDB の中身のすべてで確かめる。
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e-custom.mjs
// 環境変数: E2E_ROOT（配信ルート）, PLAYWRIGHT_MODULE（playwright の場所）, HEADED=1, E2E_ONLY（動かすシナリオの番号。例 "1,3"）
// 既存の tests/e2e.mjs（既定のよーそろ）とは別の端末（ブラウザのコンテキスト）を使う。時間のかかる長押しは、config.js の定数だけ差し替えて短くする
// （実際の 3 秒長押しは [6] で使う。既存の e2e.mjs でも確かめている）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.E2E_ROOT || path.join(HERE, '..'));
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// 期待値の元はアプリのデータそのもの（テンプレート・配色・回すもの）。文言や色を直しても追従する。
const TPL = await imp('js/templates.js');
const { THEMES, contrastReport } = await imp('js/theme.js');
const { MOTIFS } = await imp('js/motifs.js');
const { LIMITS } = await imp('js/profile.js');
const GENERIC = TPL.TEMPLATES.generic;
const DENPASAI = TPL.TEMPLATES['denpasai-2026'];

const PIN = '1234';
const pinHashOf = (pin) => crypto.createHash('sha256').update(`yosoro-gacha:${pin}`).digest('hex');   // js/util.js hashPin と同じ
const len = (s) => [...s].length;

// ---------- 静的サーバ ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const URL_FAST = `${BASE}?fast=1`;

// ---------- 小さなテストランナー ----------
const ONLY = (process.env.E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const results = [];
const errors = [];            // どの端末でも出た pageerror / console.error（シナリオごとに増えていないことも確かめる）
let browser, page, cur;       // 今操作している端末のページと端末情報
const fetched = new Set();    // アプリが実際に読み込んだ同じ配信元のファイル（[9] で sw.js の PRECACHE にあるか確かめる）

async function step(name, fn) {
  const no = /^\[(\d+)\]/.exec(name)?.[1];
  if (ONLY.length && no && !ONLY.includes(no)) return;
  const t = Date.now();
  const before = errors.length;
  try {
    await fn();
    assert.deepEqual(errors.slice(before), [], 'このシナリオの間に JS エラー／console.error が出た');
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  FAIL ${name}\n       ${String(e.stack || e.message || e).split('\n').slice(0, 14).join('\n       ')}`);
    try { await page.screenshot({ path: path.join(os.tmpdir(), `e2e-custom-fail-${results.length}.png`) }); } catch { /* noop */ }
  }
}

// ---------- 端末（ブラウザのコンテキスト）----------
/**
 * 新しい端末（IndexedDB が空）。サービスワーカーは止める（キャッシュに左右されない）。
 * real=false のときは config.js の長押し時間（スタッフ画面 3 秒・OK 1 秒）だけを短く差し替える。
 */
async function newDevice({ name, viewport = { width: 1180, height: 820 }, real = false } = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
  if (!real) {
    await ctx.route('**/js/config.js', async (route) => {
      const resp = await route.fetch();
      const body = (await resp.text()).replace(/LONG_PRESS_ADMIN_MS = 3000/, 'LONG_PRESS_ADMIN_MS = 300').replace(/LONG_PRESS_OK_MS = 1000/, 'LONG_PRESS_OK_MS = 150');
      assert.ok(body.includes('LONG_PRESS_ADMIN_MS = 300') && body.includes('LONG_PRESS_OK_MS = 150'), 'config.js の差し替えに失敗');
      await route.fulfill({ response: resp, body });
    });
  }
  const p = await ctx.newPage();
  p.on('request', (r) => { const u = new URL(r.url()); if (`${u.origin}/` === BASE) fetched.add(u.pathname.slice(1) || 'index.html'); });
  p.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] console.error: ${m.text()}`);
    if (/2412345|2454321|2499999/.test(m.text())) errors.push(`[${name}] student id leaked to console: ${m.text()}`);
  });
  return { name, ctx, page: p, pin: PIN, adminMs: real ? 3300 : 450, okMs: real ? 1300 : 350 };
}
const use = (dev) => { cur = dev; page = dev.page; return dev; };

// ---------- ヘルパ ----------
const tid = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (id) => page.textContent(tid(id));
const val = (id) => page.inputValue(tid(id));
const attr = (id, a) => page.getAttribute(tid(id), a);
const count = (id) => page.locator(tid(id)).count();
const has = async (id) => (await count(id)) > 0;
/** 結果のヘッダ中央の文字（賞の欧文） */
const resultMid = async () => (await page.textContent('#m-mid')).trim();
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function dumpDb() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('yosoro-gacha');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const names = ['meta', 'inventory', 'draws', 'students', 'logs'];
      const out = {};
      const tx = db.transaction(names, 'readonly');
      let left = names.length;
      for (const n of names) {
        const r = tx.objectStore(n).getAll();
        r.onsuccess = () => { out[n] = r.result; if (--left === 0) { db.close(); resolve(out); } };
      }
    };
  }));
}
const metaVal = (d, key) => d.meta.find((m) => m.key === key)?.value;
const sortBy = (arr, k) => [...arr].sort((a, b) => (a[k] < b[k] ? -1 : 1));
const invMap = (d) => Object.fromEntries(d.inventory.map((r) => [r.key, r]));
const invCounts = (d) => Object.fromEntries(sortBy(d.inventory, 'key').map((r) => [r.key, [r.initial, r.remaining]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const lastLog = (d, type) => [...d.logs].reverse().find((l) => l.type === type);

/** <html> に付いた配色の CSS 変数 */
const cssVar = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`; };
async function assertTheme(colors, label = '') {
  for (const k of ['paper', 'main', 'ink', 'accent']) {
    assert.equal((await cssVar(`--${k}`)).toLowerCase(), colors[k].toLowerCase(), `${label} --${k}`);
  }
  assert.equal(await cssVar('--main-rgb'), rgbOf(colors.main), `${label} --main-rgb`);
  assert.equal(await cssVar('--ink-soft'), `rgba(${rgbOf(colors.ink)}, 0.62)`, `${label} --ink-soft`);
  assert.equal(await cssVar('--backdrop'), `rgba(${rgbOf(colors.ink)}, 0.72)`, `${label} --backdrop`);
  assert.equal((await page.getAttribute('meta[name="theme-color"]', 'content')).toLowerCase(), colors.paper.toLowerCase(), `${label} theme-color`);
}
const rgbCss = (hex) => `rgb(${rgbOf(hex)})`;
/** セレクタの要素（<svg> など）の中身と一致する回すものの id の一覧（見本・札用） */
async function motifsOf(selector) {
  return page.evaluate(({ sel, all }) => {
    const el = document.querySelector(sel);
    const probe = (svg) => { const p = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); p.innerHTML = svg; return p.innerHTML; };
    return Object.entries(all).filter(([, svg]) => probe(svg) === el.innerHTML).map(([id]) => id);
  }, { sel: selector, all: Object.fromEntries(Object.entries(MOTIFS).map(([id, m]) => [id, m.svg])) });
}
/**
 * セレクタの <svg>（スタッフ画面・セットアップの回すものの見本）が、motifPreviewSvg(id, opts) の出力そのものか。
 * 色は motifPreviewSvg に渡して描かせる（作ったあとに style を書き足さない）。ページ内で同じ向きに解析して比べる。
 */
async function isPreviewOf(selector, id, opts) {
  return page.evaluate(async ({ sel, id, opts }) => {
    const { motifPreviewSvg } = await import('/js/motifs.js');
    const probe = document.createElement('div');
    probe.innerHTML = motifPreviewSvg(id, opts);
    return document.querySelector(sel).outerHTML === probe.firstElementChild.outerHTML;
  }, { sel: selector, id, opts });
}
/** #wheel の中身と一致する回すものの id の一覧（ページ内で同じ向きに解析して比べる）。ちょうど 1 つのはず */
async function motifsInSymbol() {
  return page.evaluate((all) => {
    const sym = document.querySelector('symbol#wheel');
    const probe = (svg) => { const p = document.createElementNS('http://www.w3.org/2000/svg', 'symbol'); p.innerHTML = svg; return p.innerHTML; };
    return Object.entries(all).filter(([, svg]) => probe(svg) === sym.innerHTML).map(([id]) => id);
  }, Object.fromEntries(Object.entries(MOTIFS).map(([id, m]) => [id, m.svg])));
}

async function pressKeys(prefix, digits) {
  for (const ch of digits) await page.click(tid(`${prefix}-${ch}`));
}
async function typePin(pin) {
  await pressKeys('pin', pin);
  await page.click(tid('pin-ok'));
}

/** ロゴ長押し → PIN → スタッフ画面 */
async function openAdmin(tab) {
  const box = await page.locator(tid('logo')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(cur.adminMs);
  await page.mouse.up();
  await page.waitForSelector(tid('pin-ok'));
  await typePin(cur.pin);
  await page.waitForSelector(tid('tab-status'));
  if (tab) await gotoTab(tab);
}
async function gotoTab(tab) {
  await page.click(tid(`tabbtn-${tab}`));
  await page.waitForSelector(tid(`tab-${tab}`));
  await page.waitForFunction((t) => !document.querySelector(`[data-testid="tab-${t}"]`)?.textContent.includes('読み込み中'), tab);
}
/**
 * 閉じる。アプリは閉じたあとで refresh() して画面を作り直す（設定の変更はそこで反映される）ので、古い画面が残っている間に
 * 次の確認をして取りこぼさないよう、開く前の画面に印を付け、新しい画面（または結果の表示）になるまで待つ。
 */
async function closeAdmin() {
  await page.evaluate(() => document.querySelectorAll('#screen-host > *').forEach((e) => { e.dataset.stale = '1'; }));
  await page.click(tid('admin-close'));
  await page.waitForSelector(tid('admin'), { state: 'detached' });
  await page.waitForFunction(() => {
    const c = document.querySelector('#screen-host > *');
    return c ? !c.dataset.stale : !!document.querySelector('[data-testid="ok-button"]');
  }, null, { timeout: 15000 });
}
/** トーストを確かめて消す（画面の下の保存ボタンに被さって次のクリックを邪魔しないように） */
async function toastIs(re) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="toast"]')?.textContent || ''), re.source, { timeout: 8000 });
  await page.evaluate(() => document.querySelectorAll('[data-testid="toast"]').forEach((t) => t.remove()));
}
const waitScreen = (name) => page.waitForSelector(tid(`screen-${name}`), { timeout: 15000 });
/**
 * 読み取り read() の値が want になるまで待つ（最長 5 秒）。結果を表示したままスタッフ画面を閉じると、アプリは閉じたあとで設定を読み直して
 * 見た目を組み直す（非同期）ので、閉じた直後の値を見ると取りこぼす。時間切れのときは、そのときの値で assert の差分を出す。
 */
async function eventually(read, want, message, ms = 5000) {
  const t0 = Date.now();
  let got = await read();
  while (JSON.stringify(got) !== JSON.stringify(want) && Date.now() - t0 < ms) { await sleep(50); got = await read(); }
  assert.deepEqual(got, want, message);
}

async function longPressOk() {
  const box = await page.locator(tid('ok-button')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(cur.okMs);
  await page.mouse.up();
}
async function confirmResult() {
  await longPressOk();
  await page.waitForSelector(tid('ok-button'), { state: 'detached', timeout: 10000 });
}

/** 舵輪の画面 → 回す → 結果カード。DB の未確認の抽選（結果に表示されたもの）を返す */
async function spinAndWaitResult() {
  await waitScreen('wheel');
  await page.click(tid('spin-button'));
  await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
  await page.waitForSelector(tid('result-card'), { state: 'visible' });
  const d = await dumpDb();
  const pending = metaVal(d, 'pendingDrawId');
  assert.ok(pending, 'pendingDrawId が保存されている');
  const rec = d.draws.find((x) => x.id === pending);
  const t = await text('result-card');
  assert.ok(t.includes(rec.label), `結果カードに抽選番号 ${rec.label}: ${t}`);
  assert.ok(t.includes(rec.prizeName), `結果カードに景品名 ${rec.prizeName}: ${t}`);
  assert.ok(t.includes(rec.categoryName), `結果カードに賞の名称 ${rec.categoryName}: ${t}`);
  return rec;
}

/** 一般の方：区分選択 → アンケート（Q1 → Q2）→ 舵輪の手前まで */
async function startGuest({ age = 'college', triggers = ['sns'] } = {}) {
  await waitScreen('choose');
  await page.click(tid('choose-guest'));
  await waitScreen('survey-age');
  await page.click(tid(`age-${age}`));
  await waitScreen('survey-trigger');
  for (const t of triggers) await page.click(tid(`trigger-${t}`));
  await page.click(tid('survey-next'));
}
async function startStudent(id) {
  await waitScreen('choose');
  await page.click(tid('choose-student'));
  await waitScreen('student');
  await pressKeys('tenkey', id);
  await page.click(tid('tenkey-ok'));
}
/** 結果が出ていれば確認し、スタッフ画面が開いていれば閉じて、待機画面まで戻る */
async function backToChoose() {
  if (await has('admin')) await closeAdmin();
  if (await has('ok-button')) await confirmResult();
  await waitScreen('choose');
}

// ---------- 端末 A（汎用テンプレートの端末。[1] のセットアップで作り、[2]〜[5][7] で使い回す）----------
const NAME = {
  brand: 'テストがちゃ', latin: 'TEST GACHA', event: 'テスト祭', label: 'テスト祭', eventLatin: 'TEST FES',
};
/** [1] で入力する本数（日 × 景品）。景品 id は汎用テンプレートの grand-1 / rare-1 / basic-1 と、追加した景品（add） */
const COUNTS = { day1: { 'grand-1': 2, 'rare-1': 3, 'basic-1': 5, add: 7 }, day2: { 'grand-1': 1, 'rare-1': 4, 'basic-1': 6, add: 8 } };
const PRIZE_RENAMED = '特賞テスト景品';
const PRIZE_ADDED = 'おまけ景品';
let A = null;   // { …dev, ready:true } [1] が最後まで通ったとき、または ensureA() が代わりに作ったとき

/** 端末 A を使う。[1] が通っていない（単独実行・[1] の失敗）ときは、同じ内容を画面を通さずに直接作る */
async function ensureA() {
  if (A?.ready) {
    use(A);
    // 前のシナリオ（[5] の全初期化など）が途中で失敗して、端末が未設定のままになっていないか
    const alive = await page.evaluate(async () => (await import('/js/db.js')).isSetUp()).catch(() => false);
    if (alive) return A;
    A.ready = false;
  }
  const dev = use(A && A.page ? A : await newDevice({ name: 'A' }));
  A = dev;
  await page.goto(URL_FAST);
  await page.evaluate(async ({ pinHash, name, counts }) => {
    const t = await import('/js/templates.js'); const prof = await import('/js/profile.js'); const m = await import('/js/db.js');
    await m.wipeAll();
    const tpl = t.templateConfig('generic');
    const c = tpl.config;
    Object.assign(c.brand, { name: name.brand, nameLatin: name.latin, eventLabel: name.label, eventLatin: name.eventLatin });
    c.eventName = name.event; c.theme = { preset: 'umi', custom: null }; c.motif = 'gear';
    c.days = [{ id: 'day1', label: '1日目' }, { id: 'day2', label: '2日目' }];
    c.prizes[0].name = name.renamed;
    c.prizes.push({ id: 'p-fixture', categoryId: 'basic', name: name.added, countUnknown: false });
    const cfg = prof.normalizeConfig(c); cfg.pinHash = pinHash;
    const initials = {};
    for (const d of Object.keys(counts)) initials[d] = { 'grand-1': counts[d]['grand-1'], 'rare-1': counts[d]['rare-1'], 'basic-1': counts[d]['basic-1'], 'p-fixture': counts[d].add };
    await m.initialize({ config: cfg, activeDayId: 'day1', initials });
  }, { pinHash: pinHashOf(PIN), name: { ...NAME, renamed: PRIZE_RENAMED, added: PRIZE_ADDED }, counts: COUNTS });
  await page.goto(URL_FAST);
  await waitScreen('choose');
  dev.ready = true;
  dev.fixture = true;
  dev.pin = PIN;                      // 直接作った設定の PIN は PIN（[5] で変えたあとでも作り直せるように）
  return dev;
}

/** 端末 A を「入口は両方・アンケートあり」にそろえる（前のシナリオが途中で失敗して設定が残っていても、続きのシナリオが意味のある結果を出すため） */
async function normalizeA() {
  await ensureA();
  const fixed = await page.evaluate(async () => {
    const m = await import('./js/db.js');
    const c = await m.getConfig();
    if (c.entry.student.enabled && c.entry.guest.enabled && c.survey.enabled) return false;
    c.entry.student.enabled = true; c.entry.guest.enabled = true; c.survey.enabled = true;
    await m.saveConfig(c, 'config', null);
    return true;
  });
  if (fixed) { await page.reload(); await waitScreen('choose'); }
}

/**
 * フォントの読み込みと、拡縮・文字の割り付けの測り直し（ResizeObserver）が済むまで待つ。
 * 固定の待ち時間だけに頼らず、画面全体の「位置・大きさ・文字の大きさ」の署名が 3 回続けて同じになるまで見る（遅い端末でも測り間違えない）。
 */
const settle = async () => {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const signature = () => page.evaluate(() => {
    const out = [];
    for (const e of document.body.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      out.push(`${Math.round(r.left * 4)},${Math.round(r.top * 4)},${Math.round(r.width * 4)},${Math.round(r.height * 4)},${getComputedStyle(e).fontSize}`);
    }
    return out.join('|');
  });
  await sleep(150);
  let last = await signature();
  let same = 0;
  for (const t0 = Date.now(); same < 3 && Date.now() - t0 < 4000;) {    // 動き続ける飾りがあっても 4 秒で打ち切る
    await sleep(100);
    const now = await signature();
    same = now === last ? same + 1 : 0;
    last = now;
  }
};
const idsOf = (prefix) => page.$$eval(`[data-testid^="${prefix}"]`, (els, p) => els.map((e) => e.getAttribute('data-testid').slice(p.length)), prefix);
const newOf = async (prefix, before, skip = []) => {
  const now = (await idsOf(prefix)).filter((x) => !skip.includes(x));
  const fresh = now.filter((x) => !before.includes(x));
  assert.equal(fresh.length, 1, `${prefix} の新しい欄がちょうど 1 つ: ${fresh}`);
  return fresh[0];
};

/** 在庫タブで、その日のその景品の残数を ±調整の画面で target にする */
async function adjustTo(day, pid, target) {
  const now = Number(await text(`remaining-${day}-${pid}`));
  if (now === target) return;
  await page.click(tid(`adjust-${day}-${pid}`));
  await page.fill(tid('adj-delta'), String(target - now));
  await page.click(tid('dlg-ok'));
  await page.waitForFunction(([dd, pp, tt]) => document.querySelector(`[data-testid="remaining-${dd}-${pp}"]`)?.textContent === String(tt), [day, pid, target]);
}
/** 在庫タブの ±調整で、その日の残数を wants（{景品 id: 本数}）にし、ほかの景品は 0 にする */
async function setStock(day, wants) {
  await gotoTab('inventory');
  const pids = await idsOf(`remaining-${day}-`);
  for (const pid of pids) await adjustTo(day, pid, wants[pid] ?? 0);
}
/** 開催中の日の残り合計が n 未満なら、最後の景品に足して待機画面に戻る（前のシナリオで在庫を使い切っていても続けられるように） */
async function restock(n = 6) {
  let d = await dumpDb();
  const day = metaVal(d, 'activeDayId');
  const left = d.inventory.filter((r) => r.dayId === day).reduce((t, r) => t + r.remaining, 0);
  if (left < n) {
    const pid = metaVal(d, 'config').prizes.at(-1).id;
    await openAdmin('inventory');
    await adjustTo(day, pid, Number(await text(`remaining-${day}-${pid}`)) + n);
    await closeAdmin();
  }
  d = await dumpDb();
  if (metaVal(d, 'pendingDrawId')) { await page.reload(); await page.waitForSelector(tid('ok-button')); }
  await backToChoose();
}

// =====================================================================
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-e2e-custom-'));   // 書き出したファイルの置き場（終わりに消す）
try {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  console.log(`E2E (custom) root: ${ROOT}\nURL: ${BASE}\n`);

  // ===================================================================
  await step('[1] 汎用テンプレートでセットアップ（名前・配色・回すもの・2日・景品）→ 画面・CSS 変数・DB・一般の方の抽選', async () => {
    const dev = use(await newDevice({ name: 'A' }));
    A = dev;
    await page.goto(URL_FAST);

    // --- 1. はじめかた：テンプレートを選ぶ ---
    await page.waitForSelector(tid('setup-next'));
    assert.equal(squash(await text('setup-step')), '1/6 はじめかた');
    assert.equal(await attr('setup-template-denpasai-2026', 'aria-pressed'), 'true', '既定は電波祭2026');
    // テンプレートの札には、そのテンプレートの配色（4色）と回すものの見本が出る
    for (const [tpl, theme, motif] of [['denpasai-2026', 'yosoro', 'helm'], ['generic', 'wakaba', 'capsule']]) {
      assert.deepEqual(await page.$$eval(`[data-testid="setup-template-${tpl}"] .th-chips i`, (els) => els.map((e) => getComputedStyle(e).backgroundColor)),
        ['paper', 'main', 'ink', 'accent'].map((k) => rgbCss(THEMES[theme][k])), `${tpl} の札の配色`);
      assert.deepEqual(await motifsOf(`[data-testid="setup-template-${tpl}"] .motif-svg svg`), [motif], `${tpl} の札の回すもの`);
      assert.ok(await isPreviewOf(`[data-testid="setup-template-${tpl}"] .motif-svg svg`, motif, { size: 72, wc: THEMES[theme].main, hl: THEMES[theme].accent }),
        `${tpl} の札の見本は motifPreviewSvg の出力そのまま（そのテンプレートの配色で描く）`);
    }
    await page.click(tid('setup-template-generic'));
    assert.equal(await attr('setup-template-generic', 'aria-pressed'), 'true');
    assert.equal(await attr('setup-template-denpasai-2026', 'aria-pressed'), 'false');
    await assertTheme(THEMES.wakaba, 'テンプレートを選ぶと、そのテンプレートの配色をスタッフ画面にも見せる');
    await page.click(tid('setup-next'));

    // --- 2. PIN（不一致→やり直しも）---
    await page.waitForSelector(tid('pin-ok'));
    assert.equal(squash(await text('setup-step')), '2/6 PIN');
    await pressKeys('pin', '1234'); await page.click(tid('pin-ok'));
    await pressKeys('pin', '4321'); await page.click(tid('pin-ok'));    // 不一致
    assert.ok((await page.textContent(tid('admin'))).includes('一致しませんでした'));
    await pressKeys('pin', '1234'); await page.click(tid('pin-ok'));
    await pressKeys('pin', '1234'); await page.click(tid('pin-ok'));

    // --- 3. イベントの基本：テンプレートの内容が入っている → 書き換える ---
    await page.waitForSelector(tid('setup-brand-name'));
    assert.equal(squash(await text('setup-step')), '3/6 イベントの基本');
    assert.equal(await val('setup-brand-name'), GENERIC.config.brand.name);
    assert.equal(await val('setup-brand-latin'), GENERIC.config.brand.nameLatin);
    assert.equal(await val('setup-event-name'), GENERIC.config.eventName);
    assert.equal(await val('setup-theme'), 'wakaba');
    assert.equal(await val('setup-motif'), 'capsule');
    assert.equal(await val('setup-days'), '1');
    assert.ok(await page.isChecked(tid('setup-entry-student')) && await page.isChecked(tid('setup-entry-guest')) && await page.isChecked(tid('setup-entry-survey')));
    await page.fill(tid('setup-brand-name'), NAME.brand);
    await page.fill(tid('setup-brand-latin'), NAME.latin);
    await page.fill(tid('setup-event-name'), NAME.event);
    await page.fill(tid('setup-event-label'), NAME.label);
    await page.fill(tid('setup-event-latin'), NAME.eventLatin);
    await page.selectOption(tid('setup-theme'), 'umi');
    await assertTheme(THEMES.umi, '配色を選ぶと、すぐスタッフ画面にも反映');
    await page.selectOption(tid('setup-motif'), 'gear');
    await page.selectOption(tid('setup-days'), '2');
    // 検証：空の名前は進めない
    await page.fill(tid('setup-brand-name'), '');
    await page.click(tid('setup-next'));
    assert.ok((await text('setup-error')).includes('ガチャ名を入力してください'), `空のガチャ名は進めない: ${await text('setup-error')}`);
    assert.equal(squash(await text('setup-step')), '3/6 イベントの基本');
    await page.fill(tid('setup-brand-name'), NAME.brand);
    await page.fill(tid('setup-brand-latin'), 'テスト');
    await page.click(tid('setup-next'));
    assert.ok((await text('setup-error')).includes('半角'), `欧文名に全角は入れられない: ${await text('setup-error')}`);
    await page.fill(tid('setup-brand-latin'), NAME.latin);
    await page.click(tid('setup-next'));

    // --- 4. 景品と本数：全ての日が編集できる ---
    await page.waitForSelector(tid('init-day1-grand-1'));
    assert.equal(squash(await text('setup-step')), '4/6 景品と本数');
    assert.equal(await val('bx-day-day1'), '1日目', '「当日」が日数を増やすと「1日目」になる');
    assert.equal(await val('bx-day-day2'), '2日目');
    for (const p of ['grand-1', 'rare-1', 'basic-1']) {
      assert.equal(await val(`init-day2-${p}`), await val(`init-day1-${p}`), '増やした日の初期本数は1日目と同じ値');
      assert.equal(await page.isDisabled(tid(`init-day1-${p}`)), false, 'セットアップでは全部の日が編集できる');
    }
    await page.fill(tid('bx-pname-grand-1'), PRIZE_RENAMED);
    const prizeIdsBefore = await idsOf('bx-pname-');
    await page.click(tid('bx-padd-basic'));
    const addId = await newOf('bx-pname-', prizeIdsBefore);
    assert.match(addId, /^p-[a-z0-9]+$/, '新しい景品の id は p-… の採番');
    await page.fill(tid(`bx-pname-${addId}`), PRIZE_ADDED);
    const typed = { day1: { ...COUNTS.day1 }, day2: { ...COUNTS.day2 } };
    for (const d of ['day1', 'day2']) {
      for (const p of ['grand-1', 'rare-1', 'basic-1']) await page.fill(tid(`init-${d}-${p}`), String(typed[d][p]));
      await page.fill(tid(`init-${d}-${addId}`), String(typed[d].add));
    }
    assert.match(squash(await text('bx-count')), /賞 3\/12 景品 4\/40 開催日 2\/7/);
    // 戻る→進む で入力が残る（基本の手順へ戻っても、景品の手順へ戻っても）
    await page.click(tid('setup-back'));
    await page.waitForSelector(tid('setup-brand-name'));
    assert.equal(await val('setup-brand-name'), NAME.brand);
    assert.equal(await val('setup-theme'), 'umi');
    assert.equal(await val('setup-motif'), 'gear');
    assert.equal(await val('setup-days'), '2');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid(`init-day2-${addId}`));
    assert.equal(await val('bx-pname-grand-1'), PRIZE_RENAMED);
    assert.equal(await val(`bx-pname-${addId}`), PRIZE_ADDED);
    assert.equal(await val(`init-day2-${addId}`), String(typed.day2.add));
    assert.equal(await val('init-day1-rare-1'), String(typed.day1['rare-1']));
    // 検証：負・小数・空の本数と、空の景品名は進めない
    await page.fill(tid('init-day1-rare-1'), '-1');
    await page.click(tid('setup-next'));
    assert.ok((await text('setup-error')).includes('整数'), `負の本数は進めない: ${await text('setup-error')}`);
    await page.fill(tid('init-day1-rare-1'), '2.5');
    await page.click(tid('setup-next'));
    assert.ok((await text('setup-error')).includes('整数'), '小数の本数は進めない');
    await page.fill(tid('init-day1-rare-1'), String(typed.day1['rare-1']));
    await page.fill(tid(`bx-pname-${addId}`), '');
    await page.click(tid('setup-next'));
    assert.ok((await text('setup-error')).includes('景品の名前を入力してください'), `空の景品名は進めない: ${await text('setup-error')}`);
    await page.fill(tid(`bx-pname-${addId}`), PRIZE_ADDED);
    await page.click(tid('setup-next'));

    // --- 5. 学籍番号のルール（学生が有効なので出る）→ 6. 最後の準備 ---
    await page.waitForSelector(tid('rule-min'));
    assert.equal(squash(await text('setup-step')), '5/6 学籍番号のルール');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    assert.equal(squash(await text('setup-step')), '6/6 最後の準備');
    const sum = squash(await text('setup-summary'));
    for (const want of ['テストがちゃ（TEST GACHA）', 'テスト祭', THEMES.umi.label, MOTIFS.gear.label, '学生・一般の方（アンケートあり）', '1日目 17本 / 2日目 19本', '数字7〜7桁', '設定済み']) {
      assert.ok(sum.includes(want), `設定内容に「${want}」: ${sum}`);
    }
    assert.equal(await page.isChecked(tid('start-day1')), true);
    await page.click(tid('setup-persist'));
    await page.click(tid('setup-start'));
    await waitScreen('choose');

    // --- 画面：名前・読み・ロゴ・タブの題名・配色・回すもの ---
    await page.waitForFunction((t) => document.title === t, `${NAME.brand}｜${NAME.event}`);
    assert.equal(await page.getAttribute('meta[name="apple-mobile-web-app-title"]', 'content'), NAME.brand);
    const look = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="screen-choose"]');
      return {
        auto: root.classList.contains('auto'),
        yoLabel: root.querySelector('.yo').getAttribute('aria-label'),
        yoText: [...root.querySelectorAll('.yo .c')].map((c) => c.textContent).join(''),
        yomi: root.querySelector('.yomi')?.textContent,
        tag: root.querySelector('.tag')?.textContent,
        mid: root.querySelector('.meta .mm').textContent,
        logoLabel: document.getElementById('logo').getAttribute('aria-label'),
        logoText: document.querySelector('#logo .logo-text').textContent,
        rows: [...root.querySelectorAll('.row')].map((r) => [r.dataset.testid, r.querySelector('.n').textContent, r.querySelector('.t').textContent, r.querySelector('.s')?.textContent]),
      };
    });
    assert.equal(look.auto, true, '手詰めでない名前は自動割り付け');
    assert.equal(look.yoLabel, NAME.brand);
    assert.equal(look.yoText, NAME.brand);
    assert.equal(look.yomi, NAME.latin);
    assert.equal(look.tag, GENERIC.config.brand.tagline);
    assert.equal(look.mid, `${NAME.latin} — ${NAME.brand}`);
    assert.equal(look.logoLabel, NAME.brand);
    assert.equal(look.logoText, `${NAME.label} / ${NAME.eventLatin}`);
    assert.deepEqual(look.rows, [
      ['choose-student', '01', GENERIC.config.entry.student.title, GENERIC.config.entry.student.sub],
      ['choose-guest', '02', GENERIC.config.entry.guest.title, GENERIC.config.entry.guest.sub],
    ]);
    await assertTheme(THEMES.umi, '待機画面の配色');
    assert.deepEqual(await motifsInSymbol(), ['gear'], '#wheel の中身は歯車');
    assert.equal(await page.evaluate(() => document.getElementById('stage').style.getPropertyValue('--day')), '"1日目 / DAY 1"', 'ヘッダの開催日は設定した日の名前');

    // --- DB：config v2 と在庫 ---
    let d = await dumpDb();
    const cfg = metaVal(d, 'config');
    assert.equal(cfg.schemaVersion, 2);
    assert.equal(cfg.eventId, GENERIC.config.eventId);
    assert.equal(cfg.eventName, NAME.event);
    assert.deepEqual(cfg.brand, { name: NAME.brand, nameLatin: NAME.latin, eventLabel: NAME.label, eventLatin: NAME.eventLatin, tagline: GENERIC.config.brand.tagline, prizeWord: GENERIC.config.brand.prizeWord, wordmark: null });
    assert.deepEqual(cfg.theme, { preset: 'umi', custom: null });
    assert.equal(cfg.motif, 'gear');
    assert.deepEqual(cfg.entry, GENERIC.config.entry);
    assert.deepEqual(cfg.survey, GENERIC.config.survey, 'アンケートはテンプレートのまま（Q2 は熊本高専なしの 7 個）');
    assert.deepEqual(cfg.days, [{ id: 'day1', label: '1日目' }, { id: 'day2', label: '2日目' }]);
    assert.deepEqual(cfg.categories, GENERIC.config.categories);
    assert.deepEqual(cfg.prizes, [
      { id: 'grand-1', categoryId: 'grand', name: PRIZE_RENAMED, countUnknown: false },
      { id: 'rare-1', categoryId: 'rare', name: GENERIC.config.prizes[1].name, countUnknown: false },
      { id: 'basic-1', categoryId: 'basic', name: GENERIC.config.prizes[2].name, countUnknown: false },
      { id: addId, categoryId: 'basic', name: PRIZE_ADDED, countUnknown: false },
    ]);
    assert.ok(cfg.pinHash === pinHashOf(PIN) && cfg.pinHash !== PIN, 'PIN はハッシュで保存');
    assert.equal(metaVal(d, 'activeDayId'), 'day1');
    assert.equal(d.inventory.length, 8, '日 2 × 景品 4');
    const want = {};
    for (const day of ['day1', 'day2']) {
      for (const [p, n] of Object.entries(typed[day])) want[`${day}:${p === 'add' ? addId : p}`] = [n, n];
    }
    assert.deepEqual(invCounts(d), Object.fromEntries(Object.entries(want).sort(([a], [b]) => (a < b ? -1 : 1))), '在庫は入力した本数');
    assert.ok(d.inventory.every((r) => r.adjust === 0));
    assert.equal(d.draws.length, 0);
    A.addId = addId;

    // --- 一般の方：アンケートの選択肢はテンプレートのもの（熊本高専なし）→ 舵輪の文言 → 結果の賞の欧文 ---
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    assert.equal(squash(await page.textContent('.scr-survey .meta .mm')), `${NAME.latin} — SURVEY`);
    assert.deepEqual(await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent)), TPL.SURVEY_AGES.map((a) => a.label));
    await page.click(tid('age-college'));
    await waitScreen('survey-trigger');
    const q2 = await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent));
    assert.deepEqual(q2, GENERIC.config.survey.q2.options.map((o) => o.label));
    assert.equal(q2.length, 7);
    assert.ok(!q2.some((l) => l.includes('熊本高専')), 'Q2 に熊本高専はない');
    const q2Text = await text('screen-survey-trigger');
    for (const w of ['このイベントに来場したきっかけを教えてください。', '（複数選択可）', 'アンケート 2/2', '次へ（歯車へ）', '回答は個人が分からない形で集計し、イベントの運営に使います。']) {
      assert.ok(q2Text.includes(w), `Q2 の画面に「${w}」: ${q2Text}`);
    }
    assert.ok(!q2Text.includes('電波祭') && !q2Text.includes('協賛企業') && !q2Text.includes('舵輪'), '電波祭の文言が残っていない');
    await page.click(tid('trigger-sns'));
    await page.click(tid('trigger-poster'));
    await page.click(tid('survey-next'));
    await waitScreen('wheel');
    const w = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="screen-wheel"]');
      return {
        h2: el.querySelector('h2').textContent, step: el.querySelector('.step').textContent, sub: el.querySelector('.sub').textContent,
        aria: el.querySelector('[data-testid="wheel"]').getAttribute('aria-label'), rot: el.querySelector('.wheelwrap .wm').style.transform,
        mid: el.querySelector('.meta .mm').textContent,
      };
    });
    assert.equal(w.h2, `歯車を回して、${GENERIC.config.brand.prizeWord}を引こう！`);
    assert.equal(squash(w.step), 'DRAW TURN THE GEAR');
    assert.equal(w.sub, '歯車をぐるっと回すか、タップでまわすを押してください。');
    assert.equal(w.aria, '歯車（タップするか、ぐるっと回します）');
    assert.equal(w.rot, `rotate(${MOTIFS.gear.angle}deg)`, '歯車の最初の向き');
    assert.equal(w.mid, `${NAME.latin} — ${NAME.brand}`);
    const rec = await spinAndWaitResult();
    assert.equal(rec.label, '1-0001');
    assert.equal(rec.kind, 'guest');
    assert.equal(rec.eventId, 'gacha-event');
    assert.deepEqual(rec.survey, {
      v: 1, age: 'college', triggers: ['sns', 'poster'], ageLabel: '大学生・専門学生',
      triggerLabels: [GENERIC.config.survey.q2.options.find((o) => o.id === 'sns').label, GENERIC.config.survey.q2.options.find((o) => o.id === 'poster').label],
    });
    d = await dumpDb();
    const cat = metaVal(d, 'config').categories.find((c) => c.id === rec.categoryId);
    assert.equal(await resultMid(), cat.latin, `結果のヘッダ中央は設定した賞の欧文（${cat.latin}）`);
    assert.ok(!['SPONSOR AWARD', 'RARE STICKER', 'STICKER'].includes(await resultMid()), '電波祭の既定の欧文ではない');
    assert.equal(squash(await page.textContent('#result .plabel span')), GENERIC.config.brand.prizeWord, '景品の呼び方が「景品」なら PRIZE ラベルは「景品」だけ');
    assert.equal(await page.textContent('#result .stamp .s3'), NAME.eventLatin, 'スタンプの下の欧文');
    assert.ok(await page.evaluate((t) => document.getElementById('stage').classList.contains(`t-${t}`), rec.tier), '結果の系統の class');
    await confirmResult();
    await waitScreen('choose');

    // --- 再読み込みしても同じ（保存した設定から起動する経路）---
    await page.reload();
    await waitScreen('choose');
    await page.waitForFunction((t) => document.title === t, `${NAME.brand}｜${NAME.event}`);
    await assertTheme(THEMES.umi, '再読み込み後の配色');
    assert.deepEqual(await motifsInSymbol(), ['gear'], '再読み込み後も歯車');
    assert.equal(await page.getAttribute('.scr-choose .yo', 'aria-label'), NAME.brand);
    assert.equal(await page.textContent('.scr-choose .yomi'), NAME.latin);
    A.ready = true;
  });

  // ===================================================================
  await step('[1] 汎用テンプレート（学生なし・アンケートなし・7日間）：学籍番号の手順が出ない・短い PIN は進めない・開始日を3日目にして始める', async () => {
    use(await newDevice({ name: 'D' }));
    await page.goto(URL_FAST);
    await page.waitForSelector(tid('setup-next'));
    await page.click(tid('setup-template-generic'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('pin-ok'));
    await pressKeys('pin', '123');
    await page.click(tid('pin-ok'));
    assert.ok((await text('setup-pin-error')).includes('4桁以上'), '3桁の PIN は進めない');
    await pressKeys('pin', '4');
    await page.click(tid('pin-ok'));
    await typePin(PIN);
    await page.waitForSelector(tid('setup-brand-name'));
    assert.equal(squash(await text('setup-step')), '3/6 イベントの基本');
    await page.setChecked(tid('setup-entry-student'), false);
    await page.setChecked(tid('setup-entry-survey'), false);
    await page.selectOption(tid('setup-days'), String(LIMITS.days.max));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('init-day1-grand-1'));
    assert.equal(squash(await text('setup-step')), '4/5 景品と本数', '学生がいないので学籍番号の手順は無い（全5手順）');
    assert.deepEqual((await idsOf('bx-day-')).filter((x) => /^day\d+$/.test(x)), Array.from({ length: 7 }, (_, i) => `day${i + 1}`));
    for (let i = 1; i <= 7; i++) assert.equal(await val(`bx-day-day${i}`), `${i}日目`);
    assert.match(squash(await text('bx-count')), /開催日 7\/7/);
    assert.equal(await page.isDisabled(tid('bx-day-add')), true, '開催日は 7 日まで');
    assert.equal(await page.isDisabled(tid('bx-day-remove')), false);
    assert.equal(await val('init-day7-grand-1'), await val('init-day1-grand-1'), '増やした日の初期本数は1日目と同じ値');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    assert.equal(squash(await text('setup-step')), '5/5 最後の準備');
    const sum = squash(await text('setup-summary'));
    assert.ok(sum.includes('一般の方（アンケートなし）') && !sum.includes('学籍番号') && !sum.includes('学生'), `設定内容: ${sum}`);
    await page.click(tid('setup-back'));       // 戻ると学籍番号の手順を飛ばして景品の手順へ
    await page.waitForSelector(tid('init-day1-grand-1'));
    assert.equal(squash(await text('setup-step')), '4/5 景品と本数');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('start-day3'));
    await page.click(tid('start-day3'));
    await page.dblclick(tid('setup-start'));            // 二度押しでも、保存は1回だけ
    await waitScreen('choose');
    const d = await dumpDb();
    const cfg = metaVal(d, 'config');
    assert.equal(d.logs.filter((l) => l.type === 'setup').length, 1, 'セットアップの保存は1回');
    assert.equal(metaVal(d, 'activeDayId'), 'day3');
    assert.deepEqual(cfg.days.map((x) => x.id), Array.from({ length: 7 }, (_, i) => `day${i + 1}`));
    assert.equal(d.inventory.length, 7 * cfg.prizes.length);
    assert.deepEqual([cfg.entry.student.enabled, cfg.entry.guest.enabled, cfg.survey.enabled], [false, true, false]);
    assert.deepEqual(cfg.studentIdRule, { charset: 'digits', minLength: 7, maxLength: 7 }, '使わない学籍番号のルールは既定のまま');
    assert.equal(await page.evaluate(() => document.getElementById('stage').style.getPropertyValue('--day')), '"3日目 / DAY 3"', 'ヘッダの開催日');
    assert.deepEqual(await page.$$eval('[data-testid="screen-choose"] .row', (rs) => rs.map((r) => [r.dataset.testid, r.querySelector('.n').textContent])), [['choose-guest', '01']]);
    await page.click(tid('choose-guest'));
    const rec = await spinAndWaitResult();              // アンケートなし：そのまま抽選
    assert.match(rec.label, /^3-0001$/, '抽選番号の先頭は開催日の並び（3番目）');
    assert.equal(rec.dayId, 'day3');
    assert.equal('survey' in rec, false);
    await confirmResult();
    await waitScreen('choose');
  });

  // ===================================================================
  await step('[1] 汎用テンプレート（英数字の学籍番号 5〜8桁）：学籍番号のルールの手順の検証・英数字の入力欄・大文字にそろえた参加済みの判定', async () => {
    use(await newDevice({ name: 'D2' }));
    await page.goto(URL_FAST);
    await page.waitForSelector(tid('setup-next'));
    await page.click(tid('setup-template-generic'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('pin-ok'));
    await typePin(PIN);
    await typePin(PIN);
    await page.waitForSelector(tid('setup-brand-name'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('init-day1-grand-1'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('rule-min'));
    assert.equal(squash(await text('setup-step')), '5/6 学籍番号のルール');
    assert.deepEqual([await val('rule-charset'), await val('rule-min'), await val('rule-max')], ['digits', '7', '7'], 'テンプレートのルールが入っている');
    await page.selectOption(tid('rule-charset'), 'alnum');
    await page.fill(tid('rule-min'), '9');
    await page.fill(tid('rule-max'), '8');
    await page.click(tid('setup-next'));
    assert.ok((await text('setup-error')).includes('桁数は 1〜20 で、最小 ≦ 最大'), await text('setup-error'));
    assert.equal(squash(await text('setup-step')), '5/6 学籍番号のルール', '最小が最大より大きいと進めない');
    await page.fill(tid('rule-min'), '5');
    await page.fill(tid('rule-max'), '8');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    assert.ok(squash(await text('setup-summary')).includes('英数字5〜8桁'), await text('setup-summary'));
    await page.click(tid('setup-start'));
    await waitScreen('choose');
    assert.deepEqual(metaVal(await dumpDb(), 'config').studentIdRule, { charset: 'alnum', minLength: 5, maxLength: 8 });
    await page.click(tid('choose-student'));
    await waitScreen('student');
    assert.equal(await count('tenkey-1'), 0, '英数字のときはテンキーではなく入力欄');
    assert.equal(await attr('student-input', 'maxlength'), '8');
    await page.fill(tid('student-input'), 'ab');
    await page.click(tid('student-submit'));
    assert.ok((await text('student-error')).includes('5〜8桁の英数字'), await text('student-error'));
    await page.fill(tid('student-input'), 'a1b2c');
    await page.click(tid('student-submit'));
    const rec = await spinAndWaitResult();
    assert.equal(rec.studentId, 'A1B2C', '英字は大文字にそろえて保存される');
    assert.deepEqual((await dumpDb()).students.map((x) => x.studentId), ['A1B2C']);
    await confirmResult();
    await waitScreen('choose');
    await page.click(tid('choose-student'));
    await waitScreen('student');
    await page.fill(tid('student-input'), 'ａ１ｂ２ｃ');      // 全角・小文字でも同じ学籍番号
    await page.click(tid('student-submit'));
    await page.waitForFunction(() => document.querySelector('[data-testid="student-error"]')?.textContent.includes('参加済み'));
    assert.equal((await dumpDb()).draws.length, 1, '参加済みの番号では抽選しない');
  });

  // ===================================================================
  await step('[1] 新しく作る設定は、カムジャ麺への名称移行の対象にしない：セットアップで景品 bulldak を「ブルダック炒め麺」にしても、書き換えられない', async () => {
    const OLD = 'ブルダック炒め麺';
    const MIGRATED = 'カムジャ麺';
    use(await newDevice({ name: 'G' }));
    await page.goto(URL_FAST);
    await page.waitForSelector(tid('setup-next'));
    await page.click(tid('setup-next'));               // 既定のテンプレート（電波祭2026）のまま
    await page.waitForSelector(tid('pin-ok'));
    await typePin(PIN); await typePin(PIN);
    await page.waitForSelector(tid('setup-brand-name'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('bx-pname-bulldak'));
    assert.equal(await val('bx-pname-bulldak'), MIGRATED, '（前提）テンプレートの景品名はカムジャ麺');
    await page.fill(tid('bx-pname-bulldak'), OLD);     // 新しいイベントが、あえて旧い名前を使う
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('rule-min'));       // 学生が有効なので学籍番号のルールの手順がある
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    await page.click(tid('setup-start'));
    await waitScreen('choose');                         // 起動時の refresh() は移行を呼ぶ
    const bulldak = async () => metaVal(await dumpDb(), 'config').prizes.find((p) => p.id === 'bulldak').name;
    let d = await dumpDb();
    assert.equal(await bulldak(), OLD, '新しく作った設定の景品名は書き換えられない');
    assert.equal(metaVal(d, 'migration:gamja-prize-name-v1'), true, 'セットアップが「移行済み」の印を付ける');
    assert.equal(d.logs.some((l) => l.type === 'prize-name-migration'), false, '名称移行のログは無い');
    await page.reload();
    await waitScreen('choose');
    assert.equal(await bulldak(), OLD, '再読み込み（起動時の移行）でも書き換えられない');
    assert.equal(metaVal(await dumpDb(), 'migration:gamja-prize-name-v1'), true);
  });

  // ===================================================================
  await step('[2] 参加の方法（イベントタブ）：学生だけ／一般の方だけ（アンケートなし）／両方オフは保存できない', async () => {
    await ensureA();
    await backToChoose();
    const rows = () => page.$$eval('[data-testid="screen-choose"] .row', (rs) => rs.map((r) => ({
      id: r.dataset.testid, n: r.querySelector('.n').textContent, t: r.querySelector('.t').textContent, s: r.querySelector('.s')?.textContent ?? null, blue: r.classList.contains('a'),
    })));
    const before = await rows();
    assert.deepEqual(before.map((r) => [r.id, r.n]), [['choose-student', '01'], ['choose-guest', '02']], '最初は両方の入口');
    const d0 = await dumpDb();
    const entry0 = metaVal(d0, 'config').entry;

    // --- 学生だけ ---
    await openAdmin('event');
    assert.ok(await page.isChecked(tid('entry-student')) && await page.isChecked(tid('entry-guest')) && await page.isChecked(tid('entry-survey')));
    await page.setChecked(tid('entry-guest'), false);
    assert.ok(await page.isDisabled(tid('entry-guest-title')) && await page.isDisabled(tid('entry-guest-sub')), '使わない行の文言は編集できない');
    assert.ok(await page.isDisabled(tid('entry-survey')), '一般の方を使わないならアンケートの選択も出来ない');
    await page.fill(tid('entry-student-title'), '在校生');
    await page.fill(tid('entry-student-sub'), 'まず学籍番号を入力');
    await page.click(tid('entry-save'));
    await toastIs(/保存しました/);
    let d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').entry, {
      student: { enabled: true, title: '在校生', sub: 'まず学籍番号を入力' },
      guest: { enabled: false, title: entry0.guest.title, sub: entry0.guest.sub },
    }, '使わない行の文言は今のまま残る');
    assert.equal(metaVal(d, 'config').survey.enabled, true);
    assert.deepEqual(lastLog(d, 'entry').detail, { student: true, guest: false, survey: true });
    await closeAdmin();
    await waitScreen('choose');
    assert.equal(await count('choose-guest'), 0, '一般の方の入口は出ない');
    assert.deepEqual(await rows(), [{ id: 'choose-student', n: '01', t: '在校生', s: 'まず学籍番号を入力', blue: true }], '1つだけなら1行（群青の行・番号 01）');
    // 学生の抽選は今までどおり（survey を持たない）
    await startStudent('2412345');
    let rec = await spinAndWaitResult();
    assert.equal(rec.kind, 'student');
    assert.equal(rec.studentId, '2412345');
    assert.equal('survey' in rec, false, '学生の抽選に survey はない');
    assert.equal(rec.eventId, GENERIC.config.eventId);
    await confirmResult();
    await waitScreen('choose');
    // DB 層も同じ判定（使わない方法の抽選は何も書かずに断る）
    const guestOk = { v: 1, age: 'age-20s', triggers: ['sns'] };
    d = await dumpDb();
    const code1 = await page.evaluate(async (ok) => { const m = await import('./js/db.js'); try { await m.draw({ kind: 'guest', survey: ok }); return 'NO_ERROR'; } catch (e) { return `${e.code}:${e.detail}`; } }, guestOk);
    assert.equal(code1, 'BAD_REQUEST:entry');
    assert.deepEqual(await dumpDb(), d, '断られた抽選は何も書かない');

    // --- 一般の方だけ（アンケートなし）---
    await openAdmin('event');
    await page.setChecked(tid('entry-guest'), true);
    await page.setChecked(tid('entry-student'), false);
    await page.setChecked(tid('entry-survey'), false);
    await page.fill(tid('entry-guest-title'), 'ご来場の方');
    await page.fill(tid('entry-guest-sub'), 'そのまま抽選できます');
    await page.click(tid('entry-save'));
    await toastIs(/保存しました/);
    d = await dumpDb();
    assert.equal(metaVal(d, 'config').entry.student.enabled, false);
    assert.deepEqual(metaVal(d, 'config').entry.guest, { enabled: true, title: 'ご来場の方', sub: 'そのまま抽選できます' });
    assert.equal(metaVal(d, 'config').survey.enabled, false);
    assert.deepEqual(lastLog(d, 'entry').detail, { student: false, guest: true, survey: false });
    await closeAdmin();
    await waitScreen('choose');
    assert.equal(await count('choose-student'), 0, '学生の入口は出ない');
    assert.deepEqual(await rows(), [{ id: 'choose-guest', n: '01', t: 'ご来場の方', s: 'そのまま抽選できます', blue: true }]);
    await page.click(tid('choose-guest'));
    await waitScreen('wheel');
    assert.equal(await page.locator('[data-testid^="screen-survey"]').count(), 0, 'アンケートを使わないので、そのまま舵輪（歯車）へ');
    await page.click(tid('back'));
    await waitScreen('choose');     // 戻る先は待機（Q2 ではない）
    await page.click(tid('choose-guest'));
    rec = await spinAndWaitResult();
    assert.equal(rec.kind, 'guest');
    assert.equal('survey' in rec, false, '保存された抽選に survey はない');
    await confirmResult();
    await waitScreen('choose');
    // DB 層：アンケートを使わない設定では survey を付けた抽選も、使わない学生の抽選も断る
    d = await dumpDb();
    const codes = await page.evaluate(async (ok) => {
      const m = await import('./js/db.js');
      const e = async (p) => { try { await p; return 'NO_ERROR'; } catch (x) { return `${x.code}:${x.detail}`; } };
      return [await e(m.draw({ kind: 'guest', survey: ok })), await e(m.draw({ kind: 'student', studentId: '2499999' }))];
    }, guestOk);
    assert.deepEqual(codes, ['BAD_REQUEST:survey', 'BAD_REQUEST:entry']);
    assert.deepEqual(await dumpDb(), d, '断られた抽選は何も書かない（参加済み番号も増えない）');
    // アンケートのタブ：使わない設定の旨が出る。集計は記録のぶん（survey の無い一般の抽選は「未回答」）
    await openAdmin('survey');
    assert.ok((await text('sv-disabled-note')).includes('アンケートを使わない設定'), 'アンケートを使わない旨の表示');
    assert.ok(await has('sv-edit-save'), '使わない設定でも質問は直せる');
    const guests = d.draws.filter((x) => x.kind === 'guest');
    const num = async (id) => Number(await page.textContent(`${tid(id)} b`));
    assert.equal(await num('sv-total'), guests.length);
    assert.equal(await num('sv-answered'), guests.filter((x) => x.survey).length);
    assert.equal(await num('sv-unanswered'), guests.filter((x) => !x.survey).length);
    assert.ok(await num('sv-unanswered') >= 1, 'アンケートなしの抽選は未回答として数える');
    await closeAdmin();
    await waitScreen('choose');

    // --- 両方オフは保存できない（何も保存されない）---
    await openAdmin('event');
    d = await dumpDb();
    const cfgBefore = metaVal(d, 'config');
    await page.setChecked(tid('entry-student'), false);
    await page.setChecked(tid('entry-guest'), false);
    await page.click(tid('entry-save'));
    assert.equal(await text('entry-error'), '学生と一般の方の、少なくとも一方は選んでください');
    assert.equal(await attr('entry-student', 'aria-invalid'), 'true', '誤りの欄に印が付く');
    await sleep(300);
    assert.equal(await count('toast'), 0, '保存のトーストは出ない');
    const dAfter = await dumpDb();
    assert.deepEqual(metaVal(dAfter, 'config'), cfgBefore, 'config は変わらない');
    assert.equal(dAfter.logs.filter((l) => l.type === 'entry').length, d.logs.filter((l) => l.type === 'entry').length, 'ログも増えない');
    // 欄の文言の検証（空・長すぎる）
    await page.setChecked(tid('entry-student'), true);
    await page.fill(tid('entry-student-title'), '');
    await page.click(tid('entry-save'));
    assert.ok((await text('entry-error')).includes('学生の見出しを入力してください'), await text('entry-error'));
    assert.deepEqual(metaVal(await dumpDb(), 'config'), cfgBefore, '誤りのまま保存されない');
    // 文字数の上限は入力欄が受け付けない（maxlength は LIMITS と同じ値）
    assert.equal(await attr('entry-student-title', 'maxlength'), String(LIMITS.entryTitle));
    assert.equal(await attr('entry-student-sub', 'maxlength'), String(LIMITS.entrySub));
    await page.fill(tid('entry-student-title'), 'あ'.repeat(LIMITS.entryTitle + 5));
    assert.equal(len(await val('entry-student-title')), LIMITS.entryTitle, '上限を超える字は入らない');

    // --- 元に戻す（両方＋アンケート）---
    await page.fill(tid('entry-student-title'), '在校生');
    await page.setChecked(tid('entry-guest'), true);
    await page.setChecked(tid('entry-survey'), true);
    await page.fill(tid('entry-guest-sub'), '');     // 補足は空でもよい（行に説明が出ない）
    await page.click(tid('entry-save'));
    await toastIs(/保存しました/);
    d = await dumpDb();
    assert.equal(metaVal(d, 'config').entry.student.enabled && metaVal(d, 'config').entry.guest.enabled && metaVal(d, 'config').survey.enabled, true);
    await closeAdmin();
    await waitScreen('choose');
    assert.deepEqual((await rows()).map((r) => [r.id, r.n, r.t, r.s]), [['choose-student', '01', '在校生', 'まず学籍番号を入力'], ['choose-guest', '02', 'ご来場の方', null]], '補足が空の行には説明が出ない');
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');   // アンケートが戻った
    await page.click(tid('back'));
    await waitScreen('choose');
  });

  // ===================================================================
  await step('[3] 景品・日程の規則（抽選後）：削除不可・0本・±調整・日の追加と削除・賞の追加（BONUS／rare）', async () => {
    await normalizeA();
    await backToChoose();
    const drawGuest = async (answer) => {
      await waitScreen('choose');
      await page.click(tid('choose-guest'));
      await page.waitForSelector(`${tid('screen-survey-age')}, ${tid('screen-wheel')}`);
      if (await has('screen-survey-age')) {
        const a = { age: 'college', triggers: ['sns'], ...answer };
        await page.click(tid(`age-${a.age}`));
        await waitScreen('survey-trigger');
        for (const t of a.triggers) await page.click(tid(`trigger-${t}`));
        await page.click(tid('survey-next'));
      }
      return spinAndWaitResult();
    };
    const saveTab = async () => {
      await page.click(tid('prizes-save'));
      await toastIs(/保存しました/);
      await page.waitForFunction(() => !document.querySelector('[data-testid="tab-prizes"]')?.textContent.includes('読み込み中'));   // 保存した内容を読み直し終わるまで
    };

    // --- 抽選が始まった日（1日目）をつくる ---
    const first = await drawGuest();
    assert.equal(first.dayId, 'day1');
    await confirmResult();
    await waitScreen('choose');
    let d = await dumpDb();
    let cfg = metaVal(d, 'config');
    const drawn = new Set(d.draws.map((x) => x.prizeId));

    // --- (a) 抽選済みの景品は削除できない／1日目の本数は編集できない ---
    await openAdmin('prizes');
    assert.ok(squash(await text('bx-locked')).includes('1日目は抽選が始まっているため、初期本数は変更できません'), await text('bx-locked'));
    for (const p of cfg.prizes) {
      assert.equal(await page.isDisabled(tid(`bx-pdel-${p.id}`)), drawn.has(p.id), `${p.name}：抽選済みの景品だけ削除ボタンが押せない`);
      assert.equal(await page.isDisabled(tid(`pinit-day1-${p.id}`)), true, '抽選が始まった日の初期本数は編集できない');
      assert.equal(await page.isDisabled(tid(`pinit-day2-${p.id}`)), false, 'まだ抽選の無い日は編集できる');
    }
    assert.ok((await attr(`bx-pdel-${first.prizeId}`, 'title')).includes('抽選済みのため削除できません'), '理由が付く');
    assert.ok(squash(await text(`bx-pwhy-${first.prizeId}`)).includes('抽選済みの景品です'), '理由は title だけでなく画面にも出る');
    for (const p of cfg.prizes) assert.equal(await count(`bx-pwhy-${p.id}`), drawn.has(p.id) ? 1 : 0, `${p.name}：理由が出るのは削除できない景品だけ`);
    assert.equal(await page.locator('.bx-lock').count() > 0, true, '「変更不可」の札');
    assert.equal(await page.isDisabled(tid('bx-day-remove')), false, '抽選の無い最後の日（2日目）は消せる');

    // --- (b) 新しい景品：1日目は 0 本（編集不可）、2日目は入力した本数 ---
    const day2Before = Object.fromEntries(cfg.prizes.map((p) => [p.id, invMap(d)[`day2:${p.id}`].initial]));
    for (const p of cfg.prizes) assert.equal(await val(`pinit-day2-${p.id}`), String(day2Before[p.id]), '保存済みの本数が入っている');
    let before = await idsOf('pname-');
    await page.click(tid('bx-padd-basic'));
    const np = await newOf('pname-', before);
    assert.equal(await val(`pinit-day1-${np}`), '0');
    assert.equal(await page.isDisabled(tid(`pinit-day1-${np}`)), true, '新しい景品の1日目（抽選のある日）は 0 本・編集不可');
    assert.equal(await page.isDisabled(tid(`pinit-day2-${np}`)), false);
    assert.equal(await page.isDisabled(tid(`bx-pdel-${np}`)), false, 'まだ保存していない景品は消せる');
    assert.equal(await page.isHidden(tid('prizes-dirty')), false, '未保存の変更の表示');
    await page.fill(tid(`pname-${np}`), 'あとから足した景品');
    await page.fill(tid(`pinit-day2-${np}`), '9');
    await page.setChecked(tid(`bx-unk-${np}`), true);
    assert.ok((await page.textContent(tid('tab-prizes'))).includes('本数が未定です'), '本数未定の警告が行に出る');
    await saveTab();
    d = await dumpDb();
    let inv = invMap(d);
    assert.deepEqual([inv[`day1:${np}`].initial, inv[`day1:${np}`].remaining, inv[`day1:${np}`].adjust], [0, 0, 0], '1日目は 0 本');
    assert.deepEqual([inv[`day2:${np}`].initial, inv[`day2:${np}`].remaining], [9, 9], '2日目は入力した本数');
    for (const p of cfg.prizes) {
      assert.equal(inv[`day2:${p.id}`].initial, day2Before[p.id], '既存の景品の本数は変わらない');
    }
    assert.equal(d.inventory.length, (cfg.prizes.length + 1) * 2, '日 × 景品の行がそろう');
    cfg = metaVal(d, 'config');
    assert.deepEqual(cfg.prizes.at(-1), { id: np, categoryId: 'basic', name: 'あとから足した景品', countUnknown: true });
    const lg = lastLog(d, 'box-settings');
    assert.ok(lg.detail.some((c) => c.prize === np && c.add === 'あとから足した景品' && c.categoryId === 'basic' && c.initials?.day2 === 9), `ログに差分: ${JSON.stringify(lg.detail)}`);
    assert.equal(await page.isHidden(tid('prizes-dirty')), true, '保存すると未保存の表示は消える');
    await gotoTab('status');
    const st = squash(await text('tab-status'));
    assert.ok(st.includes('本数が未定の景品') && st.includes('あとから足した景品（1日目 0本 / 2日目 9本）'), `状態タブに本数未定の景品: ${st}`);
    await gotoTab('inventory');
    assert.ok((await text(`inv-day2-${np}`)).includes('本数未定'), '在庫タブにも「本数未定」');
    await gotoTab('prizes');
    // 保存していない追加は、保存の前なら消せる。保存した抽選の無い景品は、あとからでも消せる（全部の日の行が消える）
    before = await idsOf('pname-');
    await page.click(tid('bx-padd-rare'));
    const tmp = await newOf('pname-', before);
    await page.fill(tid(`pname-${tmp}`), 'ひとまずの景品');
    await page.fill(tid(`pinit-day2-${tmp}`), '1');
    await saveTab();
    d = await dumpDb();
    assert.deepEqual([invMap(d)[`day1:${tmp}`]?.initial, invMap(d)[`day2:${tmp}`]?.initial], [0, 1]);
    await page.click(tid(`bx-pdel-${tmp}`));
    assert.equal(await count(`pname-${tmp}`), 0, '一覧から消える');
    await saveTab();
    d = await dumpDb();
    assert.equal(d.inventory.some((r) => r.prizeId === tmp), false, '全部の日の在庫の行が消える');
    assert.equal(metaVal(d, 'config').prizes.some((p) => p.id === tmp), false);
    assert.ok(lastLog(d, 'box-settings').detail.some((c) => c.prize === tmp && c.remove === 'ひとまずの景品'));
    assert.equal(d.inventory.length, (cfg.prizes.length) * 2);

    // --- (c) 在庫の ±調整で、新しい景品だけに在庫を入れて（ほかは 0）、1日目に抽選 → その景品が出る ---
    await setStock('day1', { [np]: 3 });
    d = await dumpDb();
    assert.deepEqual(sortBy(d.inventory.filter((r) => r.dayId === 'day1'), 'key').map((r) => [r.prizeId, r.remaining]).filter(([, n]) => n > 0), [[np, 3]]);
    assert.equal(invMap(d)[`day1:${np}`].initial, 0, '初期本数は 0 のまま、調整で残数だけ増える');
    assert.equal(invMap(d)[`day1:${np}`].adjust, 3);
    await closeAdmin();
    await waitScreen('choose');
    const rec = await drawGuest({ age: 'age-30s', triggers: ['website'] });
    assert.equal(rec.prizeId, np, '在庫を入れた景品が当たる');
    assert.equal(rec.prizeName, 'あとから足した景品');
    assert.equal(await resultMid(), 'PRIZE', '参加賞の欧文');
    await confirmResult();
    await waitScreen('choose');
    assert.equal(invMap(await dumpDb())[`day1:${np}`].remaining, 2);

    // --- (c1) 開催日の名前を変える（id・在庫の行は変わらない。ヘッダ・状態タブ・在庫タブに出る）---
    await openAdmin('prizes');
    const invBefore = invCounts(await dumpDb());
    await page.fill(tid('bx-day-day1'), '');
    await page.click(tid('prizes-save'));
    assert.ok((await text('prizes-error')).includes('開催日の名前を入力してください'), await text('prizes-error'));
    assert.deepEqual(invCounts(await dumpDb()), invBefore, '誤りのまま保存されない');
    await page.fill(tid('bx-day-day1'), '土曜');
    await page.fill(tid('bx-day-day2'), '日曜');
    assert.ok((await page.textContent(tid('bx-card-grand'))).includes('土曜'), '表の列の見出しも書き換えに追従する');
    await saveTab();
    d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').days, [{ id: 'day1', label: '土曜' }, { id: 'day2', label: '日曜' }]);
    assert.ok(lastLog(d, 'box-settings').detail.some((c) => c.day === 'day1' && c.from === '1日目' && c.to === '土曜'));
    assert.deepEqual(invCounts(d), invBefore, '名前を変えても在庫は変わらない');
    await gotoTab('status');
    assert.equal(await text('day-day1'), '土曜');
    assert.equal(await attr('day-day1', 'aria-pressed'), 'true');
    await gotoTab('inventory');
    assert.ok(squash(await text('tab-inventory')).includes('土曜（開催中）'), '在庫タブのカードの題名');
    await closeAdmin();
    await waitScreen('choose');
    assert.equal(await page.evaluate(() => document.getElementById('stage').style.getPropertyValue('--day')), '"土曜 / DAY 1"', 'ヘッダの開催日が新しい名前');

    // --- (d) 日を追加して保存 → 全ての景品の行ができる（開催日は 7 日まで）---
    await openAdmin('prizes');
    cfg = metaVal(await dumpDb(), 'config');
    await page.click(tid('bx-day-add'));
    assert.equal(await val('bx-day-day3'), '3日目');
    assert.match(squash(await text('bx-count')), /開催日 3\/7/);
    for (let i = 3; i < LIMITS.days.max; i++) await page.click(tid('bx-day-add'));
    assert.equal(await page.isDisabled(tid('bx-day-add')), true, `開催日は ${LIMITS.days.max} 日まで`);
    assert.ok((await text('bx-day-why')).includes(`開催日は最大${LIMITS.days.max}日までです`), await text('bx-day-why'));
    for (let i = LIMITS.days.max; i > 3; i--) await page.click(tid('bx-day-remove'));   // 保存していない日は消せる
    assert.equal(await count('bx-day-day4'), 0);
    assert.match(squash(await text('bx-count')), /開催日 3\/7/);
    const typed3 = {};
    cfg.prizes.forEach((p, i) => { typed3[p.id] = 11 + i; });
    for (const p of cfg.prizes) await page.fill(tid(`pinit-day3-${p.id}`), String(typed3[p.id]));
    await saveTab();
    d = await dumpDb();
    cfg = metaVal(d, 'config');
    assert.deepEqual(cfg.days.map((x) => x.id), ['day1', 'day2', 'day3']);
    for (const p of cfg.prizes) assert.deepEqual([invMap(d)[`day3:${p.id}`]?.initial, invMap(d)[`day3:${p.id}`]?.remaining, invMap(d)[`day3:${p.id}`]?.adjust], [typed3[p.id], typed3[p.id], 0], `3日目の行 ${p.id}`);
    assert.equal(d.inventory.length, cfg.prizes.length * 3);
    assert.ok(lastLog(d, 'box-settings').detail.some((c) => c.day === 'day3' && c.add === '3日目'));

    // --- (d2) 開催中の日は消せない（状態タブで別の日に切り替えると消せる）---
    await gotoTab('status');
    await page.click(tid('day-day3'));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="day-day3"]')?.getAttribute('aria-pressed') === 'true');
    await gotoTab('prizes');
    assert.equal(await page.isDisabled(tid('bx-day-remove')), true, '開催中の最後の日は消せない');
    assert.ok((await text('bx-day-why')).includes('開催中です'), await text('bx-day-why'));
    d = await dumpDb();
    const lockedCode = await page.evaluate(async () => {
      const m = await import('./js/db.js');
      const c = await m.getConfig();
      try { await m.saveBoxSettings({ days: c.days.slice(0, -1), categories: c.categories, prizes: c.prizes, initials: {} }); return 'NO_ERROR'; } catch (e) { return `${e.code}:${e.detail}`; }
    });
    assert.equal(lockedCode, 'DAY_LOCKED:day3', 'DB 層でも開催中の日は消せない');
    assert.deepEqual(await dumpDb(), d);
    await gotoTab('status');
    await page.click(tid('day-day1'));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="day-day1"]')?.getAttribute('aria-pressed') === 'true');
    await gotoTab('prizes');

    // --- (e) 抽選の無い最後の日は消せる → その日の行が消える ---
    assert.equal(await page.isDisabled(tid('bx-day-remove')), false);
    await page.click(tid('bx-day-remove'));
    assert.equal(await count('bx-day-day3'), 0);
    await saveTab();
    d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').days.map((x) => x.id), ['day1', 'day2']);
    assert.equal(d.inventory.some((r) => r.dayId === 'day3'), false, '3日目の在庫の行が消える');
    assert.ok(lastLog(d, 'box-settings').detail.some((c) => c.day === 'day3' && c.remove === '3日目'));

    // --- (f) 抽選のある日は消せない（2日目で抽選する）---
    await gotoTab('status');
    await page.click(tid('day-day2'));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="day-day2"]')?.getAttribute('aria-pressed') === 'true');
    await closeAdmin();
    await waitScreen('choose');
    const rec2 = await drawGuest();
    assert.equal(rec2.dayId, 'day2');
    assert.match(rec2.label, /^2-0001$/);
    await confirmResult();
    await waitScreen('choose');
    await openAdmin('prizes');
    assert.equal(await page.isDisabled(tid('bx-day-remove')), true, '抽選のある最後の日は消せない');
    assert.ok((await text('bx-day-why')).includes('日曜は抽選があるため削除できません'), await text('bx-day-why'));
    assert.ok(squash(await text('bx-locked')).includes('土曜・日曜'), '抽選のある日が両方、変更不可');
    // DB 層も同じ判定（失敗したら何も書かない）
    d = await dumpDb();
    cfg = metaVal(d, 'config');
    const drawnNow = d.draws[0].prizeId;
    const out = await page.evaluate(async (drawnId) => {
      const m = await import('./js/db.js');
      const c = await m.getConfig();
      const base = { days: c.days, categories: c.categories, prizes: c.prizes, initials: {} };
      const e = async (p) => { try { await p; return 'NO_ERROR'; } catch (x) { return `${x.code}:${x.detail}`; } };
      return {
        removeDrawnDay: await e(m.saveBoxSettings({ ...base, days: c.days.slice(0, 1) })),
        emptyDays: await e(m.saveBoxSettings({ ...base, days: [] })),
        newPrizeOnDrawnDay: await e(m.saveBoxSettings({ ...base, prizes: [...c.prizes, { id: 'zz-new', categoryId: c.categories[0].id, name: 'x', countUnknown: false }], initials: { day1: { 'zz-new': 5 } } })),
        changeInitialOnDrawnDay: await e(m.saveBoxSettings({ ...base, initials: { day1: { [c.prizes[0].id]: 99 } } })),
        removeDrawnPrize: await e(m.saveBoxSettings({ ...base, prizes: c.prizes.filter((p) => p.id !== drawnId) })),
        removeCategoryWithPrizes: await e(m.saveBoxSettings({ ...base, categories: c.categories.slice(1) })),
      };
    }, drawnNow);
    assert.deepEqual(out, {
      removeDrawnDay: 'DAY_LOCKED:day2', emptyDays: 'BAD_REQUEST:days', newPrizeOnDrawnDay: 'DAY_HAS_DRAWS:day1',
      changeInitialOnDrawnDay: 'DAY_HAS_DRAWS:day1', removeDrawnPrize: `PRIZE_HAS_DRAWS:${drawnNow}`, removeCategoryWithPrizes: 'BAD_REQUEST:prize-category',
    });
    assert.deepEqual(await dumpDb(), d, '断られた保存は何も書かない');

    // --- (g) 賞を追加（演出 rare・欧文 BONUS）と景品 → それだけに在庫を入れて抽選 → ヘッダ BONUS・#stage.t-rare ---
    before = await idsOf('cat-');                      // 景品の無い賞は、保存の前なら消せる（クリックして確かめる）
    await page.click(tid('bx-cat-add'));
    const tmpc = await newOf('cat-', before);
    await page.click(tid(`bx-cdel-${tmpc}`));
    assert.equal(await count(`cat-${tmpc}`), 0, '賞の欄が消える');
    before = await idsOf('cat-');
    await page.click(tid('bx-cat-add'));
    const nc = await newOf('cat-', before);
    assert.match(nc, /^c-[a-z0-9]+$/, '新しい賞の id は c-… の採番');
    assert.equal(await page.isDisabled(tid(`bx-cdel-${nc}`)), false, '景品の無い新しい賞は消せる');
    await page.click(tid('prizes-save'));
    assert.ok((await text('prizes-error')).includes('賞の名前を入力してください'), await text('prizes-error'));
    await page.fill(tid(`cat-${nc}`), 'ボーナス賞');
    assert.equal(await val(`bx-tier-${nc}`), 'sticker', '新しい賞の演出の既定は通常');
    assert.equal(await attr(`bx-latin-${nc}`, 'placeholder'), TPL.TIER_LATIN.sticker);
    await page.selectOption(tid(`bx-tier-${nc}`), 'rare');
    assert.equal(await attr(`bx-latin-${nc}`, 'placeholder'), TPL.TIER_LATIN.rare, '欧文の欄の薄い文字は演出の既定に追従');
    await page.fill(tid(`bx-latin-${nc}`), 'BONUS');
    before = await idsOf('pname-');
    await page.click(tid(`bx-padd-${nc}`));
    const bp = await newOf('pname-', before);
    await page.fill(tid(`pname-${bp}`), 'ボーナス景品');
    assert.equal(await page.isDisabled(tid(`bx-cdel-${nc}`)), true, '景品のある賞は消せない');
    // 欧文は半角だけ（日本語は保存できない）
    await page.fill(tid(`bx-latin-${nc}`), 'ボーナス');
    const nLogs = (await dumpDb()).logs.filter((l) => l.type === 'box-settings').length;
    await page.click(tid('prizes-save'));
    assert.ok((await text('prizes-error')).includes('半角'), await text('prizes-error'));
    d = await dumpDb();
    assert.equal(d.logs.filter((l) => l.type === 'box-settings').length, nLogs, '誤りのまま保存されない');
    assert.equal(metaVal(d, 'config').categories.some((c) => c.id === nc), false);
    await page.fill(tid(`bx-latin-${nc}`), 'BONUS');
    await saveTab();
    d = await dumpDb();
    cfg = metaVal(d, 'config');
    assert.deepEqual(cfg.categories.at(-1), { id: nc, name: 'ボーナス賞', tier: 'rare', latin: 'BONUS' });
    assert.deepEqual(cfg.prizes.at(-1), { id: bp, categoryId: nc, name: 'ボーナス景品', countUnknown: false });
    assert.deepEqual([invMap(d)[`day1:${bp}`].initial, invMap(d)[`day2:${bp}`].initial], [0, 0], '抽選のある日に増える景品は 0 本から');
    await setStock('day2', { [bp]: 1 });   // 開催中は2日目
    await closeAdmin();
    await waitScreen('choose');
    const bonus = await drawGuest({ age: 'age-50s', triggers: ['annual'] });
    assert.equal(bonus.prizeId, bp);
    assert.equal(bonus.tier, 'rare');
    assert.equal(bonus.categoryId, nc);
    assert.equal(bonus.categoryName, 'ボーナス賞');
    assert.equal(await resultMid(), 'BONUS', '結果のヘッダ中央は設定した欧文');
    assert.ok(await page.evaluate(() => document.getElementById('stage').classList.contains('t-rare')), '#stage に t-rare');
    assert.ok(!(await page.evaluate(() => document.getElementById('stage').classList.contains('t-sponsor'))));

    // --- (g2) 結果が未確認のまま賞の欧文・名前・演出を変える → 再表示（再読み込み）では、欧文は今の設定・賞の名前と系統は抽選記録のまま ---
    await openAdmin('prizes');
    await page.fill(tid(`bx-latin-${nc}`), 'EXTRA');
    await page.fill(tid(`cat-${nc}`), 'ボーナス賞改');
    await page.selectOption(tid(`bx-tier-${nc}`), 'sponsor');
    await saveTab();
    await closeAdmin();
    assert.ok(await has('ok-button'), '未確認の結果はそのまま');
    await page.reload();
    await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
    assert.equal(await resultMid(), 'EXTRA', '賞の欧文は今の設定から');
    const shown = await page.evaluate(() => ({ cat: document.getElementById('cat').textContent, t: [...document.getElementById('stage').classList].filter((c) => c.startsWith('t-')) }));
    assert.equal(shown.cat, 'ボーナス賞', '賞の名前は抽選記録（保存時）のまま');
    assert.deepEqual(shown.t, ['t-rare'], '演出の系統も抽選記録のまま');
    assert.equal((await dumpDb()).draws.find((x) => x.id === bonus.id).categoryName, 'ボーナス賞', '記録は書き換わらない');
    // 賞の欧文を空にすると、演出の系統の既定（いまの系統は「特別」＝ SPECIAL PRIZE）
    await openAdmin('prizes');
    await page.fill(tid(`bx-latin-${nc}`), '');
    await saveTab();
    await closeAdmin();
    await page.reload();
    await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
    assert.equal(await resultMid(), TPL.TIER_LATIN.sponsor, '欧文が空なら演出の系統の既定');
    await confirmResult();
    await waitScreen('closed');     // 在庫が空になった
    assert.equal(squash(await page.textContent('.scr-info .meta .mm')), `${NAME.latin} — ${NAME.brand}`, '終了の画面のヘッダ中央も設定した名前');

    // --- (c6) 本番リセット：履歴・参加済み番号・ログを消し、在庫は初期本数へ（調整は 0）。設定・PIN・開催中の日は残る ---
    d = await dumpDb();
    cfg = metaVal(d, 'config');
    assert.ok(d.draws.length >= 4 && d.logs.length > 5);
    await openAdmin('data');
    await page.click(tid('reset-production'));
    await page.fill(tid('danger-word'), 'リセット');
    await page.fill(tid('danger-pin'), cur.pin);
    await page.click(tid('dlg-ok'));
    await toastIs(/本番リセットしました/);
    const after = await dumpDb();
    assert.deepEqual([after.draws, after.students], [[], []], '履歴・参加済み番号は空');
    assert.deepEqual(after.logs.map((l) => l.type), ['production-reset'], 'ログは消え、リセットの記録だけが残る');
    assert.deepEqual(invCounts(after), Object.fromEntries(sortBy(d.inventory, 'key').map((r) => [r.key, [r.initial, r.initial]])), '在庫は初期本数に戻る');
    assert.ok(after.inventory.every((r) => r.adjust === 0));
    assert.deepEqual(metaVal(after, 'config'), cfg, '設定はそのまま');
    assert.deepEqual([metaVal(after, 'activeDayId'), metaVal(after, 'drawSeq'), metaVal(after, 'pendingDrawId'), metaVal(after, 'lastBackupAt')], ['day2', {}, undefined, undefined]);
    await closeAdmin();
    await waitScreen('choose');          // 在庫が戻ったので待機画面
  });

  // ===================================================================
  await step('[3] 景品・日程の下書き：最後の日を消してから日を足しても消した日の id を使い回さない（残数・調整を引き継がない）／景品が最後の1つのとき、消せない理由を画面に出す', async () => {
    use(await newDevice({ name: 'F' }));
    await page.goto(URL_FAST);
    // 既定（電波祭2026：2日・景品7つ）を直接作る。2日とも同じ初期本数＝日を足すときにコピーされる1日目の値が、消す2日目の値と一致する（引き継ぎが起きやすい形）
    await page.evaluate(async ({ pinHash }) => {
      const c = await import('/js/config.js'); const m = await import('/js/db.js');
      const config = c.createDefaultConfig(); config.pinHash = pinHash;
      await m.initialize({ config, activeDayId: 'day1', initials: c.createDefaultInitials() });
    }, { pinHash: pinHashOf(PIN) });
    await page.goto(URL_FAST);
    await waitScreen('choose');
    let d = await dumpDb();
    const cfg = metaVal(d, 'config');
    const pid = cfg.prizes[0].id;
    for (const p of cfg.prizes) assert.equal(invMap(d)[`day2:${p.id}`].initial, invMap(d)[`day1:${p.id}`].initial, `（前提）2日の初期本数は同じ ${p.id}`);

    // 2日目（最後の日・抽選なし・開催中でもない）の残数を ±調整する：調整 +5・残数 8。これが「消した日の行」
    await openAdmin('inventory');
    await adjustTo('day2', pid, invMap(d)[`day2:${pid}`].initial + 5);
    d = await dumpDb();
    assert.deepEqual([invMap(d)[`day2:${pid}`].remaining, invMap(d)[`day2:${pid}`].adjust], [invMap(d)[`day2:${pid}`].initial + 5, 5], '（前提）調整済みの行');

    // 最後の日を消して、日を足してから保存する：新しい日の id は day2 ではなく day3
    await gotoTab('prizes');
    await page.click(tid('bx-day-remove'));
    assert.equal(await count('bx-day-day2'), 0, '最後の日（day2）が下書きから消えた');
    await page.click(tid('bx-day-add'));
    assert.equal(await count('bx-day-day2'), 0, '消した日の id（day2）を使い回さない');
    assert.equal(await count('bx-day-day3'), 1, '新しい日は day3');
    assert.equal(await val('bx-day-day3'), '2日目');
    for (const p of cfg.prizes) assert.equal(await val(`pinit-day3-${p.id}`), await val(`pinit-day1-${p.id}`), `初期本数は1日目と同じ値から ${p.id}`);
    await page.click(tid('prizes-save'));
    await toastIs(/保存しました/);
    await page.waitForFunction(() => !document.querySelector('[data-testid="tab-prizes"]')?.textContent.includes('読み込み中'));
    d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').days, [{ id: 'day1', label: '1日目' }, { id: 'day3', label: '2日目' }]);
    assert.equal(d.inventory.some((r) => r.dayId === 'day2'), false, '消した日の在庫の行は残らない');
    assert.equal(d.inventory.length, cfg.prizes.length * 2);
    for (const p of cfg.prizes) {
      const r = invMap(d)[`day3:${p.id}`];
      const n = invMap(d)[`day1:${p.id}`].initial;
      assert.deepEqual([r.initial, r.remaining, r.adjust], [n, n, 0], `新しい日は新品の行（残数＝初期本数・調整 0）${p.id}`);
    }
    const lg = lastLog(d, 'box-settings').detail;
    assert.ok(lg.some((c) => c.day === 'day3' && c.add === '2日目') && lg.some((c) => c.day === 'day2' && c.remove === '2日目'), `日の追加と削除がログに残る: ${JSON.stringify(lg)}`);

    // 景品が最後の1つになった下書き（保存はしない）：削除できない理由を、ボタンの title だけでなく画面にも出す（iPad は title を見られない）
    const ids = cfg.prizes.map((p) => p.id);
    for (const other of ids.slice(1)) {
      assert.equal(await count(`bx-pwhy-${other}`), 0, '景品が複数あるうちは理由は出ない');
      await page.click(tid(`bx-pdel-${other}`));
    }
    const why = `景品は${LIMITS.prizes.min}つ以上必要です`;
    assert.equal(await page.isDisabled(tid(`bx-pdel-${pid}`)), true, '最後の1つは削除できない');
    assert.equal(squash(await text(`bx-pwhy-${pid}`)), why, '理由が画面に出る');
    assert.equal(await page.isVisible(tid(`bx-pwhy-${pid}`)), true);
    assert.equal(await attr(`bx-pdel-${pid}`, 'title'), why, 'title にも同じ理由');
    assert.equal(await page.locator(`${tid(`bx-card-${cfg.prizes[0].categoryId}`)} ${tid(`bx-pwhy-${pid}`)}`).count(), 1, '理由はその景品の行にある');
  });

  // ===================================================================
  /**
   * アンケートタブの集計が、DB の一般の抽選の回答と一致することを確かめる（スコープは「全日程」か日の id）。
   * 選択肢の行は「今の選択肢」→「記録にだけ残る旧選択肢（保存時のラベル・「旧選択肢」の札）」の順。
   */
  async function checkSurveyAgg(scope = 'all') {
    const d = await dumpDb();
    const cfg = metaVal(d, 'config');
    const guests = d.draws.filter((x) => x.kind === 'guest' && (scope === 'all' || x.dayId === scope));
    const ans = guests.filter((x) => x.survey);
    const num = async (id) => Number(await page.textContent(`${tid(id)} b`));
    if (scope !== 'all') await page.click(tid(`sv-scope-${scope}`)); else await page.click(tid('sv-scope-all'));
    assert.equal(await num('sv-total'), guests.length, `${scope} 一般の抽選`);
    assert.equal(await num('sv-answered'), ans.length, `${scope} 回答あり`);
    assert.equal(await num('sv-unanswered'), guests.length - ans.length, `${scope} 未回答`);
    const rows = (opts, ids, labelAt) => {
      const out = opts.map((o) => ({ id: o.id, label: o.label, retired: false }));
      for (const g of ans) ids(g).forEach((id, i) => { if (!out.some((r) => r.id === id)) out.push({ id, label: labelAt(g, i) || id, retired: true }); });
      return out;
    };
    const ages = rows(cfg.survey.q1.options, (g) => [g.survey.age], (g) => g.survey.ageLabel);
    const trigs = rows(cfg.survey.q2.options, (g) => g.survey.triggers, (g, i) => g.survey.triggerLabels?.[i]);
    for (const [prefix, list, has1] of [['sv-age-', ages, (g, id) => g.survey.age === id], ['sv-trig-', trigs, (g, id) => g.survey.triggers.includes(id)]]) {
      assert.deepEqual(await idsOf(prefix), list.map((r) => r.id), `${scope} ${prefix} の行と順番（今の選択肢 → 旧選択肢）`);
      for (const r of list) {
        const n = ans.filter((g) => has1(g, r.id)).length;
        assert.equal(await attr(`${prefix}${r.id}`, 'data-count'), String(n), `${scope} ${prefix}${r.id} の人数`);
        const t = await text(`${prefix}${r.id}`);
        assert.ok(t.includes(r.label), `${scope} ${prefix}${r.id} のラベル「${r.label}」: ${t}`);
        assert.equal(t.includes('旧選択肢'), r.retired, `${scope} ${prefix}${r.id} の旧選択肢の札: ${t}`);
        const p = ans.length ? (Math.round((n / ans.length) * 1000) / 10).toFixed(1) : '0.0';
        assert.ok(t.includes(`${p}%`), `${scope} ${prefix}${r.id} の割合 ${p}%: ${t}`);
      }
    }
    for (const a of ages) for (const t of trigs) {
      const c = ans.filter((g) => g.survey.age === a.id && g.survey.triggers.includes(t.id)).length;
      assert.equal(await text(`sv-cross-${a.id}-${t.id}`), String(c), `${scope} クロス ${a.id}×${t.id}`);
    }
    await page.click(tid('sv-scope-all'));
  }

  await step('[4] アンケートの編集：選択肢の追加→ゲスト画面→集計・削除（旧選択肢）・重複や空の拒否・名前変更・上限', async () => {
    await normalizeA();
    await restock(6);
    // 編集の前の回答を1件つくる（あとで「名前を変えても、前の記録のラベルは変わらない」を確かめる）
    await startGuest({ age: 'college', triggers: ['sns', 'poster'] });
    await spinAndWaitResult();
    await confirmResult();
    await waitScreen('choose');
    const surveyReady = () => page.waitForFunction(() => !document.querySelector('[data-testid="tab-survey"]')?.textContent.includes('読み込み中'));
    const saveSurvey = async () => { await page.click(tid('sv-edit-save')); await toastIs(/保存しました/); await surveyReady(); };
    let d = await dumpDb();
    let cfg = metaVal(d, 'config');
    const q1Before = cfg.survey.q1;
    const q2Before = cfg.survey.q2;

    // --- 編集欄の初期値は今の設定 ---
    await openAdmin('survey');
    for (const [k, q] of [['q1', q1Before], ['q2', q2Before]]) {
      assert.equal(await val(`sv-edit-${k}-heading`), q.heading);
      assert.equal(await val(`sv-edit-${k}-short`), q.short);
      assert.deepEqual(await page.$$eval(`[data-testid^="sv-edit-${k}-opt-"]`, (els) => els.map((e) => e.value)), q.options.map((o) => o.label));
    }
    assert.equal(await val('sv-edit-notice'), cfg.survey.notice);
    assert.equal(await attr('sv-edit-q1-heading', 'maxlength'), String(LIMITS.surveyHeading));
    assert.equal(await attr('sv-edit-q2-opt-0', 'maxlength'), String(LIMITS.optionLabel));
    await checkSurveyAgg();          // [1][2][3] の一般の抽選の回答が集計されている

    // --- 「質問と選択肢を編集」ボタン：画面の下にある編集欄まで移動する ---
    const editorTop = () => page.evaluate(() => ({ top: document.querySelector('[data-testid="sv-edit-q1-heading"]').getBoundingClientRect().top, h: window.innerHeight }));
    const beforeJump = await editorTop();
    assert.ok(beforeJump.top > beforeJump.h, `編集欄は集計の下にあって、初めは画面の外: ${JSON.stringify(beforeJump)}`);
    await page.click(tid('sv-edit-jump'));
    await page.waitForFunction(() => { const r = document.querySelector('[data-testid="sv-edit-q1-heading"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, null, { timeout: 5000 });

    // --- 編集：Q2 に選択肢を追加、見出し・短い名前・注意書きを書き換えて保存 ---
    const nOld = q2Before.options.length;
    await page.click(tid('sv-edit-q2-add'));
    assert.equal(await val(`sv-edit-q2-opt-${nOld}`), '', '追加した選択肢は空');
    await page.fill(tid(`sv-edit-q2-opt-${nOld}`), '友達に誘われて');
    await page.fill(tid('sv-edit-q1-heading'), '年齢を/お知らせ/ください');
    await page.fill(tid('sv-edit-q1-short'), '年代');
    await page.fill(tid('sv-edit-q2-heading'), '今日の/ご来場の/理由を/教えてください。');
    await page.fill(tid('sv-edit-q2-short'), 'ご来場の理由');
    await page.fill(tid('sv-edit-notice'), '集計にだけ使います。');
    await saveSurvey();
    d = await dumpDb();
    cfg = metaVal(d, 'config');
    const newOpt = cfg.survey.q2.options.at(-1);
    assert.match(newOpt.id, /^q2-[a-z0-9]+$/, '新しい選択肢の id は q2-… の採番');
    assert.deepEqual(cfg.survey.q2.options.slice(0, nOld), q2Before.options, '既存の選択肢の id・名前は変わらない');
    assert.equal(newOpt.label, '友達に誘われて');
    assert.deepEqual(cfg.survey.q1, { ...q1Before, heading: '年齢を/お知らせ/ください', short: '年代' });
    assert.equal(cfg.survey.q2.heading, '今日の/ご来場の/理由を/教えてください。');
    assert.equal(cfg.survey.q2.short, 'ご来場の理由');
    assert.equal(cfg.survey.notice, '集計にだけ使います。');
    assert.deepEqual(lastLog(d, 'survey-edit').detail, { q1: q1Before.options.length, q2: nOld + 1 });
    assert.equal(await val(`sv-edit-q2-opt-${nOld}`), '友達に誘われて', '保存後の編集欄にも入っている');

    // --- ゲスト画面：新しい見出し・注意書き・選択肢 → 答えて抽選 ---
    await closeAdmin();
    await waitScreen('choose');
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    assert.equal(squash(await page.textContent('.scr-survey .sv-h')), 'Q1. 年齢をお知らせください', '「/」は表示されない');
    assert.equal(await text('survey-notice'), '集計にだけ使います。');
    await page.click(tid('age-age-40s'));
    await waitScreen('survey-trigger');
    assert.equal(squash(await page.textContent('.scr-survey .sv-h')), 'Q2. 今日のご来場の理由を教えてください。（複数選択可）');
    const labels = await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels, cfg.survey.q2.options.map((o) => o.label), '追加した選択肢が最後に出る');
    assert.equal(labels.length, nOld + 1);
    await page.click(tid(`trigger-${newOpt.id}`));
    await page.click(tid('trigger-sns'));
    await page.click(tid('survey-next'));
    const rec = await spinAndWaitResult();
    assert.deepEqual(rec.survey, {
      v: 1, age: 'age-40s', triggers: ['sns', newOpt.id], ageLabel: '40代',
      triggerLabels: [q2Before.options.find((o) => o.id === 'sns').label, '友達に誘われて'],
    }, '選択肢の並び順で保存され、ラベルも写される');
    await confirmResult();
    await waitScreen('choose');

    // --- アンケートタブ：新しい選択肢が数えられる／見出しは短い名前 ---
    await openAdmin('survey');
    const tab = squash(await text('tab-survey'));
    for (const w of ['Q1 年代', 'Q2 ご来場の理由（複数選択可）', '年代 × ご来場の理由（人数）']) assert.ok(tab.includes(w), `集計の見出し「${w}」`);
    assert.equal(await attr(`sv-trig-${newOpt.id}`, 'data-count'), '1');
    assert.equal(await attr('sv-age-age-40s', 'data-count'), String((await dumpDb()).draws.filter((x) => x.survey?.age === 'age-40s').length), '40代の人数');
    await checkSurveyAgg();
    await checkSurveyAgg('day1');

    // --- 保存できない入力：同じ名前・空・（余白だけの違いも同じ）---
    d = await dumpDb();
    const cfgKept = metaVal(d, 'config');
    const nLog = d.logs.filter((l) => l.type === 'survey-edit').length;
    const refused = async (re, why) => {
      await page.click(tid('sv-edit-save'));
      const e = await text('sv-edit-error');
      assert.match(e, re, `${why}: ${e}`);
      const d2 = await dumpDb();
      assert.deepEqual(metaVal(d2, 'config'), cfgKept, `${why}：config は変わらない`);
      assert.equal(d2.logs.filter((l) => l.type === 'survey-edit').length, nLog, `${why}：ログも増えない`);
    };
    const dup = cfgKept.survey.q2.options[0].label;
    await page.fill(tid(`sv-edit-q2-opt-${nOld}`), dup);
    await refused(/Q2（複数選択）に同じ名前の選択肢があります/, 'Q2 に同じ名前の選択肢');
    assert.equal(await attr(`sv-edit-q2-opt-${nOld}`, 'aria-invalid'), 'true', '直す欄に印が付く');
    await page.fill(tid(`sv-edit-q2-opt-${nOld}`), `${dup} `);
    await refused(/同じ名前の選択肢があります/, '余白だけ違う名前も同じ');
    await page.fill(tid(`sv-edit-q2-opt-${nOld}`), '');
    await refused(new RegExp(`Q2（複数選択）の選択肢${nOld + 1}を入力してください`), '空の選択肢');
    await page.fill(tid(`sv-edit-q2-opt-${nOld}`), '友達に誘われて');
    await page.fill(tid('sv-edit-q1-opt-1'), await val('sv-edit-q1-opt-0'));
    await refused(/Q1（単一選択）に同じ名前の選択肢があります/, 'Q1 に同じ名前の選択肢');
    await page.fill(tid('sv-edit-q1-opt-1'), q1Before.options[1].label);
    await page.fill(tid('sv-edit-q2-short'), '');
    await refused(/Q2（複数選択）の短い名前を入力してください/, '空の短い名前');
    await page.fill(tid('sv-edit-q2-short'), 'ご来場の理由');

    // --- 回答のある選択肢を削除 → 集計に「旧選択肢」として残る（保存時のラベルで）。Q2 の追加した選択肢と、Q1 の「40代」---
    await page.click(tid(`sv-edit-q2-del-${nOld}`));
    await page.click(tid(`sv-edit-q1-del-${q1Before.options.findIndex((o) => o.id === 'age-40s')}`));
    await saveSurvey();
    d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').survey.q2.options, q2Before.options, '選択肢が元の数に戻る');
    assert.deepEqual(metaVal(d, 'config').survey.q1.options, q1Before.options.filter((o) => o.id !== 'age-40s'), 'Q1 は「40代」だけが無くなる');
    assert.equal(await attr('sv-age-age-40s', 'data-count'), String(d.draws.filter((x) => x.survey?.age === 'age-40s').length), '40代の回答は残る');
    assert.ok((await text('sv-age-age-40s')).includes('40代') && (await text('sv-age-age-40s')).includes('旧選択肢'), await text('sv-age-age-40s'));
    assert.equal((await idsOf('sv-age-')).at(-1), 'age-40s', '旧選択肢は今の選択肢の後ろ');
    assert.equal(await attr(`sv-trig-${newOpt.id}`, 'data-count'), '1', '回答は残る');
    assert.ok((await text(`sv-trig-${newOpt.id}`)).includes('友達に誘われて') && (await text(`sv-trig-${newOpt.id}`)).includes('旧選択肢'), await text(`sv-trig-${newOpt.id}`));
    assert.equal(await text('sv-cross-age-40s-' + newOpt.id), '1', 'クロス表にも残る');
    await checkSurveyAgg();
    // 名前の変更：id はそのまま、集計の行の名前は新しい名前。過去の記録に写したラベルは変わらない
    const snsLabel = q2Before.options.find((o) => o.id === 'sns').label;
    const idx = q2Before.options.findIndex((o) => o.id === 'sns');
    await page.fill(tid(`sv-edit-q2-opt-${idx}`), 'ソーシャルメディア');
    await saveSurvey();
    d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').survey.q2.options[idx], { id: 'sns', label: 'ソーシャルメディア' });
    const snsDraws = d.draws.filter((x) => x.survey?.triggers.includes('sns'));
    assert.ok(snsDraws.length >= 2);
    assert.ok(snsDraws.every((x) => x.survey.triggerLabels[x.survey.triggers.indexOf('sns')] === snsLabel), '過去の記録のラベルは保存時のまま');
    assert.ok((await text('sv-trig-sns')).includes('ソーシャルメディア'));
    await checkSurveyAgg();
    // CSV：見出しは短い名前・旧選択肢の行も出る。履歴の CSV には保存時のラベルが入る
    const [dl1] = await Promise.all([page.waitForEvent('download'), page.click(tid('sv-csv'))]);
    const csvPath1 = path.join(downloadDir, 'survey-custom.csv');
    await dl1.saveAs(csvPath1);
    const csv1 = fs.readFileSync(csvPath1, 'utf8').replace(/^\uFEFF/, '').split('\r\n');
    assert.ok(csv1[0].startsWith('来場者アンケート集計（'), csv1[0]);
    for (const w of ['Q1 年代,', 'Q2 ご来場の理由（', '年代 × ご来場の理由（人数）', 'ソーシャルメディア,', '友達に誘われて,1,']) assert.ok(csv1.some((l) => l.startsWith(w)), `集計 CSV に「${w}」`);
    await gotoTab('data');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click(tid('csv-masked'))]);
    const csvPath2 = path.join(downloadDir, 'draws-custom.csv');
    await dl2.saveAs(csvPath2);
    const lines2 = fs.readFileSync(csvPath2, 'utf8').replace(/^\uFEFF/, '').split('\r\n');
    assert.deepEqual(lines2[0].split(',').slice(-2), ['年代', 'ご来場の理由'], '履歴 CSV の見出しは短い名前');
    const row2 = lines2.find((l) => l.startsWith(`${rec.label},`));
    assert.ok(row2.endsWith(`,40代,${snsLabel}／友達に誘われて`), `履歴 CSV の行は保存時のラベル: ${row2}`);
    await gotoTab('survey');

    // --- 注意書きを空にすると出ない／ゲスト画面は 7 個に戻る ---
    await page.fill(tid('sv-edit-notice'), '');
    await page.fill(tid('sv-edit-q2-heading'), 'ご来場のきっかけを教えてください。');      // 「/」が無い見出しは自動で折り返す
    await saveSurvey();
    assert.equal(metaVal(await dumpDb(), 'config').survey.notice, '');
    await closeAdmin();
    await waitScreen('choose');
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    assert.equal(await count('survey-notice'), 0, '注意書きが空なら出ない');
    await page.click(tid('age-college'));
    await waitScreen('survey-trigger');
    assert.equal(await count('survey-notice'), 0);
    const labels2 = await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent));
    assert.equal(labels2.length, nOld);
    assert.ok(labels2.includes('ソーシャルメディア') && !labels2.includes('友達に誘われて'));
    assert.equal(squash(await page.textContent('.scr-survey .sv-h')), 'Q2. ご来場のきっかけを教えてください。（複数選択可）');
    await page.click(tid('back'));
    await waitScreen('survey-age');
    await page.click(tid('back'));
    await waitScreen('choose');

    // --- 選択肢の数の上限・下限（ボタンが押せなくなる）。保存はしない ---
    await openAdmin('survey');
    for (let i = q2Before.options.length; i < LIMITS.q2Options.max; i++) await page.click(tid('sv-edit-q2-add'));
    assert.equal(await page.isDisabled(tid('sv-edit-q2-add')), true, `Q2 は ${LIMITS.q2Options.max} 個まで`);
    assert.ok((await page.textContent(tid('tab-survey'))).includes(`${LIMITS.q2Options.min}〜${LIMITS.q2Options.max}個（いま${LIMITS.q2Options.max}個）`));
    for (let n = (await idsOf('sv-edit-q1-opt-')).length; n > LIMITS.q1Options.min; n--) await page.click(tid('sv-edit-q1-del-0'));
    assert.equal(await page.isDisabled(tid('sv-edit-q1-del-0')), true, `Q1 は ${LIMITS.q1Options.min} 個を下回れない`);
    assert.equal(await page.isDisabled(tid('sv-edit-q1-del-1')), true);
    assert.equal(await page.isDisabled(tid('sv-edit-q1-add')), false);
    await closeAdmin();
    await waitScreen('choose');

    // --- 最大の構成（Q1 12個・Q2 10個・24字の選択肢・40字の見出し）でも、3つの画面の大きさで全部の選択肢が収まる ---
    const lbl = (k, i) => `${k}の${i + 1}番の長い名前の選択肢です`.padEnd(LIMITS.optionLabel, 'ー').slice(0, LIMITS.optionLabel);
    const heading40 = 'ご来場のきっかけをお知らせください。'.repeat(3).slice(0, LIMITS.surveyHeading);
    assert.equal(len(heading40), LIMITS.surveyHeading);
    await openAdmin('survey');
    const idsBefore = { q1: metaVal(await dumpDb(), 'config').survey.q1.options.map((o) => o.id), q2: metaVal(await dumpDb(), 'config').survey.q2.options.map((o) => o.id) };
    for (let i = idsBefore.q1.length; i < LIMITS.q1Options.max; i++) await page.click(tid('sv-edit-q1-add'));
    for (let i = idsBefore.q2.length; i < LIMITS.q2Options.max; i++) await page.click(tid('sv-edit-q2-add'));
    for (const [k, n] of [['q1', LIMITS.q1Options.max], ['q2', LIMITS.q2Options.max]]) {
      for (let i = 0; i < n; i++) await page.fill(tid(`sv-edit-${k}-opt-${i}`), lbl(k, i));
      await page.fill(tid(`sv-edit-${k}-heading`), heading40);
    }
    await saveSurvey();
    d = await dumpDb();
    cfg = metaVal(d, 'config');
    assert.deepEqual([cfg.survey.q1.options.length, cfg.survey.q2.options.length], [LIMITS.q1Options.max, LIMITS.q2Options.max]);
    assert.deepEqual(cfg.survey.q1.options.slice(0, idsBefore.q1.length).map((o) => o.id), idsBefore.q1, '既存の選択肢の id は変わらない');
    assert.deepEqual(cfg.survey.q2.options.slice(0, idsBefore.q2.length).map((o) => o.id), idsBefore.q2);
    assert.equal(new Set([...cfg.survey.q1.options, ...cfg.survey.q2.options].map((o) => o.id)).size, LIMITS.q1Options.max + LIMITS.q2Options.max, 'id は重ならない');
    assert.deepEqual(cfg.survey.q1.options.map((o) => o.label), Array.from({ length: LIMITS.q1Options.max }, (_, i) => lbl('q1', i)));
    await checkSurveyAgg();
    await closeAdmin();
    await waitScreen('choose');
    const fitProblems = (expectN) => page.evaluate((n) => {
      const vw = innerWidth; const vh = innerHeight; const bad = [];
      const boxes = [...document.querySelectorAll('.chip, .sv-foot > *, .sv-h, .sv-step')].map((el) => ({ el, r: el.getBoundingClientRect() }));
      for (const { el, r } of boxes) {
        const name = el.className || el.tagName;
        if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) bad.push(`out:${name}`);
        if (el.classList.contains('chip')) {
          const lb = el.querySelector('.lb');
          if (lb.scrollWidth > lb.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) bad.push(`clip:${el.dataset.id}`);
          if (r.height < 63.5) bad.push(`short:${el.dataset.id}:${r.height.toFixed(0)}`);
        }
      }
      const g = document.querySelector('.sv-grid').getBoundingClientRect();
      const f = document.querySelector('.sv-foot').getBoundingClientRect();
      const hd = document.querySelector('.sv-h').getBoundingClientRect();
      if (g.bottom > f.top + 0.5) bad.push('grid/foot overlap');
      if (hd.bottom > g.top + 0.5) bad.push('heading/grid overlap');
      const chips = [...document.querySelectorAll('.chip')].map((c) => c.getBoundingClientRect());
      for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) {
        const a = chips[i]; const b = chips[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`chips overlap ${i}/${j}`);
      }
      if (chips.length !== n) bad.push(`chips ${chips.length} != ${n}`);
      if (document.documentElement.scrollHeight > vh + 1) bad.push('scroll');
      return bad;
    }, expectN);
    const gridVars = () => page.$eval('.sv-grid', (el) => Object.fromEntries(['--cl', '--rl', '--rp', '--lbs', '--rows'].map((k) => [k, el.style.getPropertyValue(k)])));
    for (const [w, h] of [[1180, 820], [1024, 768], [820, 1180]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      await waitScreen('choose');
      await page.click(tid('choose-guest'));
      await waitScreen('survey-age');
      await settle();
      assert.deepEqual(await fitProblems(LIMITS.q1Options.max), [], `最大の構成 Q1 ${w}×${h}`);
      // 列・行の数と字の大きさの CSS 変数は選択肢の個数から（Q1 は 12 個＝2 行 × 6 列・ラベル 165÷6≒28px、Q2 は 10 個＝5 行）
      assert.deepEqual(await gridVars(), { '--cl': '6', '--rl': '2', '--rp': '6', '--lbs': '28px', '--rows': '' }, `Q1 の列・行の変数 ${w}×${h}`);
      await page.click(tid(`age-${cfg.survey.q1.options[0].id}`));
      await waitScreen('survey-trigger');
      await settle();
      assert.deepEqual(await fitProblems(LIMITS.q2Options.max), [], `最大の構成 Q2 ${w}×${h}`);
      assert.deepEqual(await gridVars(), { '--cl': '', '--rl': '', '--rp': '', '--lbs': '', '--rows': '5' }, `Q2 の行の変数 ${w}×${h}`);
      await page.click(tid('back'));
      await waitScreen('survey-age');
      await page.click(tid('back'));
      await waitScreen('choose');
    }
    await page.setViewportSize({ width: 1180, height: 820 });
  });

  // ===================================================================
  // [5] 設定ファイルの書き出し → 履歴があると読み込めない → 全初期化 → セットアップで読み込み → 一致 → スタッフ画面からの読み込み
  const CUSTOM = { paper: '#f4efe3', main: '#17493a', ink: '#101510', accent: '#e2571f' };
  async function setCustomTheme(colors) {
    for (const [k, v] of Object.entries(colors)) await page.fill(tid(`theme-c-${k}`), v);
  }
  const profilePath = path.join(downloadDir, 'profile.json');
  await step('[5] 設定ファイル：書き出し（履歴・PINなし）→ 履歴があれば読み込めない → 全初期化 → セットアップで読み込み → 一致 → スタッフ画面から読み込み', async () => {
    await normalizeA();
    await restock(8);
    // 履歴があり、配色はカスタム、効果音はオフ、残数は初期本数と違う（調整済み）端末にする
    await openAdmin('event');
    await setCustomTheme(CUSTOM);
    await page.click(tid('theme-custom-apply'));
    await toastIs(/カスタムの配色を適用しました/);
    await gotoTab('settings');
    await page.setChecked(tid('sound-enabled'), false);
    await page.waitForFunction(async () => { const m = await import('./js/db.js'); return (await m.getConfig()).sound.enabled === false; });
    await closeAdmin();
    await waitScreen('choose');
    await startGuest({ age: 'age-20s', triggers: ['website'] });
    await spinAndWaitResult();
    await confirmResult();
    await waitScreen('choose');
    let d = await dumpDb();
    let cfg = metaVal(d, 'config');
    assert.equal(cfg.sound.enabled, false, '効果音のオフが保存されている');
    assert.deepEqual(cfg.theme.custom, CUSTOM);
    assert.ok(d.inventory.some((r) => r.remaining !== r.initial), '残数が初期本数と違う（そのとき書き出しは初期本数を使う）');
    assert.ok(d.draws.length >= 1);

    // --- 書き出し（ダウンロード）---
    await openAdmin('data');
    await page.click(tid('profile-export'));
    await page.waitForSelector(tid('profile-save'));
    const msg = await text('profile-msg');
    assert.ok(msg.includes(`${cfg.brand.name}・開催日 ${cfg.days.length}日・景品 ${cfg.prizes.length}個`) && msg.includes(cfg.eventId) && msg.includes('.json'), msg);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(tid('profile-save'))]);
    assert.ok(msg.includes(dl.suggestedFilename()), 'ダウンロードのファイル名が表示と同じ');
    await dl.saveAs(profilePath);
    const raw = fs.readFileSync(profilePath, 'utf8');
    const file = JSON.parse(raw);
    assert.deepEqual(Object.keys(file).sort(), ['app', 'exportedAt', 'kind', 'profile', 'profileVersion']);
    assert.deepEqual([file.app, file.kind, file.profileVersion], ['yosoro-gacha', 'profile', 1]);
    assert.deepEqual(Object.keys(file.profile).sort(), ['config', 'initials']);
    assert.ok(!raw.includes('pinHash') && !raw.includes(cfg.pinHash), 'PIN のハッシュは入らない');
    assert.ok(!('sound' in file.profile.config), '効果音の設定は入らない');
    for (const k of ['draws', 'students', 'logs', 'meta', 'inventory']) assert.ok(!raw.includes(`"${k}"`), `${k} は入らない`);
    assert.ok(!raw.includes(d.draws[0].label) && !raw.includes('2412345'), '抽選番号・学籍番号は入らない');
    assert.deepEqual(file.profile.config, omit(cfg, ['pinHash', 'sound']), '今の設定そのもの（PIN・効果音を除く）');
    for (const dd of cfg.days) for (const p of cfg.prizes) {
      assert.equal(file.profile.initials[dd.id][p.id], invMap(d)[`${dd.id}:${p.id}`].initial, `初期本数（残数ではない）${dd.id}:${p.id}`);
    }
    await page.evaluate(() => document.querySelectorAll('[data-testid="toast"]').forEach((t) => t.remove()));

    // --- 履歴があると読み込めない（画面・DB 層とも何も変わらない）---
    d = await dumpDb();
    await page.setInputFiles(tid('profile-file'), profilePath);
    await page.waitForSelector(tid('dialog'));
    const refusal = squash(await text('dialog'));
    assert.ok(refusal.includes(`抽選履歴が ${d.draws.length} 件あるため、設定ファイルは読み込めません`) && refusal.includes('本番リセット'), `わかりやすい理由: ${refusal}`);
    assert.equal(await count('profile-summary'), 0, '確認の画面には進まない');
    await page.click(tid('dlg-ok'));
    assert.deepEqual(await dumpDb(), d, '何も変わらない');
    const code = await page.evaluate(async (f) => { const m = await import('./js/db.js'); try { await m.importProfile(f); return 'NO_ERROR'; } catch (e) { return e.code; } }, file);
    assert.equal(code, 'HAS_DRAWS');
    assert.deepEqual(await dumpDb(), d, 'DB 層でも何も変わらない');
    const exportedAt0 = metaVal(d, 'lastBackupAt');
    assert.equal(exportedAt0, undefined, '設定ファイルの書き出しはバックアップの記録に数えない');

    // --- 全初期化 → セットアップ画面で読み込む ---
    await page.click(tid('reset-wipe'));
    await page.fill(tid('danger-word'), '初期化');
    await page.fill(tid('danger-pin'), cur.pin);
    await page.click(tid('dlg-ok'));
    await page.waitForSelector(tid('setup-restore'), { timeout: 10000 });
    assert.equal(await attr('setup-template-denpasai-2026', 'aria-pressed'), 'true');
    await assertTheme(THEMES.yosoro, '全初期化のあとのセットアップは、選ばれている既定のテンプレート（よーそろ）の配色で始まる（前のイベントのカスタム配色を引きずらない）');
    await page.setInputFiles(tid('setup-profile-file'), profilePath);
    await page.waitForFunction(() => !document.querySelector('[data-testid="setup-profile-info"]').hidden);
    assert.equal(squash(await text('setup-profile-info')), `設定ファイルを読み込みました：${cfg.brand.name}（${cfg.eventName}）・開催日 ${cfg.days.length}日・景品 ${cfg.prizes.length}個`);
    assert.equal(await attr('setup-template-denpasai-2026', 'aria-pressed'), 'false', '設定ファイルを読み込むとテンプレートの選択は外れる');
    assert.equal(await attr('setup-template-generic', 'aria-pressed'), 'false');
    await assertTheme(CUSTOM, '設定ファイルのカスタム配色をセットアップ画面にも見せる');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('pin-ok'));
    cur.pin = '5678';                 // PIN は設定ファイルに入っていない：ここで新しく決める
    await typePin(cur.pin); await typePin(cur.pin);
    await page.waitForSelector(tid('setup-brand-name'));
    assert.equal(await val('setup-brand-name'), cfg.brand.name);
    assert.equal(await val('setup-brand-latin'), cfg.brand.nameLatin);
    assert.equal(await val('setup-event-name'), cfg.eventName);
    assert.equal(await val('setup-event-label'), cfg.brand.eventLabel);
    assert.equal(await val('setup-event-latin'), cfg.brand.eventLatin);
    assert.equal(await val('setup-theme'), '__custom', 'カスタム配色が選ばれている');
    await page.selectOption(tid('setup-theme'), 'umi');
    await assertTheme(THEMES.umi, 'ウィザードで別の配色を選ぶ');
    await page.selectOption(tid('setup-theme'), '__custom');
    await assertTheme(CUSTOM, '設定ファイルのカスタム配色に戻せる');
    assert.equal(await val('setup-motif'), cfg.motif);
    assert.equal(await val('setup-days'), String(cfg.days.length));
    assert.equal(await page.isChecked(tid('setup-entry-student')), cfg.entry.student.enabled);
    assert.equal(await page.isChecked(tid('setup-entry-guest')), cfg.entry.guest.enabled);
    assert.equal(await page.isChecked(tid('setup-entry-survey')), cfg.survey.enabled);
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('init-day1-grand-1'));
    for (const dd of cfg.days) {
      assert.equal(await val(`bx-day-${dd.id}`), dd.label);
      for (const p of cfg.prizes) assert.equal(await val(`init-${dd.id}-${p.id}`), String(file.profile.initials[dd.id][p.id]), `手順の本数 ${dd.id}:${p.id}`);
    }
    for (const p of cfg.prizes) assert.equal(await val(`bx-pname-${p.id}`), p.name);
    for (const c of cfg.categories) assert.equal(await val(`bx-latin-${c.id}`), c.latin);
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('rule-min'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    await page.click(tid('setup-start'));
    await waitScreen('choose');

    // --- 読み込んだ内容と一致 ---
    d = await dumpDb();
    const cfg2 = metaVal(d, 'config');
    assert.deepEqual(omit(cfg2, ['pinHash', 'sound']), file.profile.config, '設定（名前・配色・回すもの・入口・アンケート・日・賞・景品）が書き出したものと一致');
    assert.equal(cfg2.pinHash, pinHashOf('5678'), 'PIN は新しく決めたもの');
    assert.notEqual(cfg2.pinHash, cfg.pinHash);
    assert.equal(cfg2.sound.enabled, true, '効果音は設定ファイルに入っていないので既定');
    assert.equal(d.inventory.length, cfg.days.length * cfg.prizes.length);
    for (const dd of cfg.days) for (const p of cfg.prizes) {
      const r = invMap(d)[`${dd.id}:${p.id}`];
      assert.deepEqual([r.initial, r.remaining, r.adjust], [file.profile.initials[dd.id][p.id], file.profile.initials[dd.id][p.id], 0], `在庫 ${dd.id}:${p.id}`);
    }
    assert.equal(d.draws.length + d.students.length, 0, '履歴・参加済み番号は空');
    assert.equal(metaVal(d, 'activeDayId'), 'day1');
    await page.waitForFunction((t) => document.title === t, `${cfg.brand.name}｜${cfg.eventName}`);
    await assertTheme(CUSTOM, '読み込んだ配色');
    assert.deepEqual(await motifsInSymbol(), [cfg.motif]);
    // 新しい PIN でスタッフ画面に入れる（古い PIN は使えない）
    await openAdmin('status');
    await closeAdmin();

    // --- スタッフ画面からの読み込み（抽選履歴が無いとき）：在庫・開催日・バックアップの記録は作り直し、PIN・効果音は今のまま ---
    await openAdmin('event');
    await page.fill(tid('brand-name'), 'まちがい名');
    await page.click(tid('brand-save'));
    await toastIs(/保存しました/);
    await gotoTab('status');
    await page.click(tid('day-day2'));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="day-day2"]')?.getAttribute('aria-pressed') === 'true');
    await gotoTab('inventory');
    await adjustTo('day1', cfg.prizes[0].id, 40);
    await gotoTab('data');
    await page.click(tid('backup-export'));
    await page.waitForSelector(tid('backup-save'));
    await Promise.all([page.waitForEvent('download'), page.click(tid('backup-save'))]);
    await page.waitForFunction(() => document.body.textContent.includes('以降の抽選 0 件'));
    d = await dumpDb();
    assert.ok(metaVal(d, 'lastBackupAt') > 0 && metaVal(d, 'activeDayId') === 'day2');
    assert.equal(metaVal(d, 'config').brand.name, 'まちがい名');
    await gotoTab('settings');
    await page.setChecked(tid('sound-enabled'), false);
    await page.waitForFunction(async () => { const m = await import('./js/db.js'); return (await m.getConfig()).sound.enabled === false; });
    await gotoTab('data');
    await page.setInputFiles(tid('profile-file'), profilePath);
    await page.waitForSelector(tid('profile-summary'));
    const sum = squash(await text('profile-summary'));
    assert.ok(sum.includes(cfg.brand.name) && sum.includes(cfg.eventName) && sum.includes(`${cfg.days.length}日`) && sum.includes(`景品 ${cfg.prizes.length}個`), `読み込む内容の確認: ${sum}`);
    await page.click(tid('dlg-ok'));
    await toastIs(/設定ファイルを読み込みました/);
    d = await dumpDb();
    const cfg3 = metaVal(d, 'config');
    assert.deepEqual(omit(cfg3, ['pinHash', 'sound']), file.profile.config, 'ファイルの内容に戻る');
    assert.equal(cfg3.pinHash, pinHashOf('5678'), 'PIN は今のまま');
    assert.equal(cfg3.sound.enabled, false, '効果音の設定は今のまま');
    assert.equal(metaVal(d, 'activeDayId'), 'day1', '開催日は最初の日に戻る');
    assert.equal(metaVal(d, 'lastBackupAt'), undefined, '最終バックアップの記録は消える');
    for (const dd of cfg.days) for (const p of cfg.prizes) {
      const r = invMap(d)[`${dd.id}:${p.id}`];
      assert.deepEqual([r.initial, r.remaining, r.adjust], [file.profile.initials[dd.id][p.id], file.profile.initials[dd.id][p.id], 0], `在庫を初期本数で作り直し ${dd.id}:${p.id}`);
    }
    assert.deepEqual(lastLog(d, 'profile-import').detail, { eventId: cfg.eventId, days: cfg.days.length, prizes: cfg.prizes.length });
    // 知らない配色・回すものの id（新しい版で作った設定ファイルなど）：既定（よーそろ・舵輪）で表示し、id はそのまま保存する
    const unknown = JSON.parse(raw);
    unknown.profile.config.theme = { preset: 'future-theme', custom: null };
    unknown.profile.config.motif = 'future-motif';
    const unknownPath = path.join(downloadDir, 'profile-unknown-ids.json');
    fs.writeFileSync(unknownPath, JSON.stringify(unknown));
    await page.setInputFiles(tid('profile-file'), unknownPath);
    await page.waitForSelector(tid('profile-summary'));
    await page.click(tid('dlg-ok'));
    await toastIs(/設定ファイルを読み込みました/);
    d = await dumpDb();
    assert.deepEqual([metaVal(d, 'config').theme, metaVal(d, 'config').motif], [{ preset: 'future-theme', custom: null }, 'future-motif'], 'id はそのまま保存される');
    await assertTheme(THEMES.yosoro, '知らない配色はよーそろで表示');
    await closeAdmin();
    await waitScreen('choose');
    await assertTheme(THEMES.yosoro, 'プレイヤー画面（知らない配色）');
    assert.deepEqual(await motifsInSymbol(), ['helm'], '知らない回すものは舵輪で表示');
    await openAdmin('event');
    assert.deepEqual(await page.$$eval('[data-testid^="theme-"][aria-pressed="true"], [data-testid^="motif-"][aria-pressed="true"]', (els) => els.map((e) => e.dataset.testid)), ['theme-yosoro', 'motif-helm']);
    await gotoTab('data');
    await page.setInputFiles(tid('profile-file'), profilePath);     // 元のファイルを読み込み直す
    await page.waitForSelector(tid('profile-summary'));
    await page.click(tid('dlg-ok'));
    await toastIs(/設定ファイルを読み込みました/);
    assert.deepEqual(omit(metaVal(await dumpDb(), 'config'), ['pinHash', 'sound']), file.profile.config, '読み込み直すと元に戻る');
    await closeAdmin();
    await waitScreen('choose');
    await page.waitForFunction((t) => document.title === t, `${cfg.brand.name}｜${cfg.eventName}`);
    assert.equal(await page.textContent('.scr-choose .yomi'), cfg.brand.nameLatin);

    // --- バックアップ（v2）の往復：カスタムの設定・履歴・未確認の抽選がそのまま戻る ---
    await startGuest({ age: 'age-30s', triggers: ['poster'] });
    const recB = await spinAndWaitResult();          // 未確認のまま
    await openAdmin('data');
    await page.click(tid('backup-export'));
    await page.waitForSelector(tid('backup-save'));
    const [dlb] = await Promise.all([page.waitForEvent('download'), page.click(tid('backup-save'))]);
    const backupPath = path.join(downloadDir, 'backup-custom.json');
    await dlb.saveAs(backupPath);
    const bk = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(bk.schemaVersion, 2);
    d = await dumpDb();
    assert.deepEqual(bk.meta.find((m) => m.key === 'config').value, metaVal(d, 'config'), 'バックアップの config は v2 の今の設定');
    const snap = (x) => ({ config: metaVal(x, 'config'), active: metaVal(x, 'activeDayId'), seq: metaVal(x, 'drawSeq'), pending: metaVal(x, 'pendingDrawId'), inv: invCounts(x), draws: sortBy(x.draws, 'id'), students: x.students });
    const before = snap(d);
    assert.equal(before.pending, recB.id);
    await page.click(tid('reset-wipe'));
    await page.fill(tid('danger-word'), '初期化');
    await page.fill(tid('danger-pin'), cur.pin);
    await page.click(tid('dlg-ok'));
    await page.waitForSelector(tid('setup-restore'), { timeout: 10000 });
    await page.setInputFiles(tid('setup-restore-file'), backupPath);
    await page.click(tid('dlg-ok'));                 // 復元の確認
    await page.waitForSelector(tid('ok-button'), { timeout: 15000 });
    const shownB = await text('result-card');
    assert.ok(shownB.includes(recB.label) && shownB.includes(recB.prizeName), '未確認の結果が復元される');
    assert.deepEqual(snap(await dumpDb()), before, '設定・在庫・履歴・連番・未確認の抽選が一致');
    await page.waitForFunction((t) => document.title === t, `${cfg.brand.name}｜${cfg.eventName}`);
    await assertTheme(CUSTOM, '復元した配色');
    assert.deepEqual(await motifsInSymbol(), [cfg.motif]);
    await confirmResult();
    await waitScreen('choose');
  });

  // ===================================================================
  // [6] v1 のバックアップ → セットアップの「バックアップから復元」→ よーそろがちゃに戻る
  const v1Backup = (pin) => {
    const prizes = [
      { id: 'greenland', categoryId: 'sponsor', name: 'グリーンランド招待券', countUnknown: false },
      { id: 'ezo', categoryId: 'sponsor', name: 'E・ZO FUKUOKA招待券', countUnknown: false },
      { id: 'bulldak', categoryId: 'sponsor', name: 'カムジャ麺', countUnknown: false },
      { id: 'rare-ibaraki', categoryId: 'rare', name: '茨城コラボステッカー〈レア〉', countUnknown: true },
      { id: 'rare-denpasai', categoryId: 'rare', name: '電波祭ステッカー〈レア〉', countUnknown: false },
      { id: 'sticker-ibaraki', categoryId: 'sticker', name: '茨城コラボステッカー', countUnknown: true },
      { id: 'sticker-denpasai', categoryId: 'sticker', name: '電波祭ステッカー', countUnknown: false },
    ];
    const days = [{ id: 'day1', label: '1日目' }, { id: 'day2', label: '2日目' }];
    const stock = (p) => (p === 'greenland' ? 3 : 0);     // 協賛特別賞（グリーンランド）だけ在庫がある
    return {
      app: 'yosoro-gacha', schemaVersion: 1, exportedAt: 1790000000000,
      meta: [
        // v1 の config：brand / theme / motif / entry / survey は無く、賞に latin も無い
        { key: 'config', value: {
          schemaVersion: 1, eventId: 'denpasai-2026', eventName: '電波祭2026', days,
          categories: [
            { id: 'sponsor', name: '協賛特別賞', tier: 'sponsor' }, { id: 'rare', name: 'レアステッカー賞', tier: 'rare' }, { id: 'sticker', name: 'ステッカー賞', tier: 'sticker' },
          ],
          prizes, studentIdRule: { charset: 'digits', minLength: 7, maxLength: 7 }, pinHash: pinHashOf(pin), sound: { enabled: true, volume: 0.7 },
        } },
        { key: 'activeDayId', value: 'day1' }, { key: 'schemaVersion', value: 1 }, { key: 'drawSeq', value: {} },
      ],
      inventory: days.flatMap((dd) => prizes.map((p) => ({ key: `${dd.id}:${p.id}`, dayId: dd.id, prizeId: p.id, initial: stock(p.id), remaining: stock(p.id), adjust: 0 }))),
      draws: [], students: [], logs: [],
    };
  };
  await step('[6] v1 バックアップをセットアップの「バックアップから復元」→ よーそろがちゃ（YOSORO GACHA・#1A33E0・舵輪・SPONSOR AWARD）', async () => {
    const dev = use(await newDevice({ name: 'B', real: true }));   // この端末だけ、実際の 3 秒長押し
    dev.pin = '4321';
    const v1 = v1Backup(dev.pin);
    assert.ok(!('brand' in v1.meta[0].value) && !('theme' in v1.meta[0].value) && !('motif' in v1.meta[0].value) && !('entry' in v1.meta[0].value) && !('survey' in v1.meta[0].value));
    assert.ok(v1.meta[0].value.categories.every((c) => !('latin' in c)));
    const v1Path = path.join(downloadDir, 'v1-backup.json');
    fs.writeFileSync(v1Path, JSON.stringify(v1));
    const gen = TPL.templateConfig('generic');
    const profileObj = { app: 'yosoro-gacha', kind: 'profile', profileVersion: 1, exportedAt: 1790000000000, profile: { config: gen.config, initials: gen.initials } };
    const put = (name, obj) => { const f = path.join(downloadDir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
    await page.goto(URL_FAST);
    await page.waitForSelector(tid('setup-restore'));
    const refuse = async (inputId, file, re, title) => {
      await page.setInputFiles(tid(inputId), file);
      await page.waitForSelector(tid('dialog'));
      const t = squash(await text('dialog'));
      assert.match(t, re, `${title}: ${t}`);
      await page.click(tid('dlg-ok'));
      await page.waitForSelector(tid('dialog'), { state: 'detached' });
      assert.equal(squash(await text('setup-step')), '1/6 はじめかた', '手順は進まない');
    };
    // 取り違えは、行き先を案内して断る
    await refuse('setup-restore-file', put('profile-for-restore.json', profileObj), /これは設定ファイルです（バックアップではありません）。「設定ファイルを読み込む」から読み込んでください/, '設定ファイルをバックアップの復元に');
    await refuse('setup-profile-file', v1Path, /これはバックアップです（設定ファイルではありません）。バックアップの復元から読み込んでください/, 'バックアップを設定ファイルの読み込みに');
    await refuse('setup-profile-file', put('profile-v2.json', { ...profileObj, profileVersion: 2 }), /新しいバージョンの設定ファイルです。アプリを更新してください/, '新しい版の設定ファイル');
    await refuse('setup-restore-file', put('backup-v3.json', { ...v1, schemaVersion: 3 }), /新しいバージョンのバックアップです。アプリを更新してください/, '新しい版のバックアップ');
    const broken = path.join(downloadDir, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    await refuse('setup-profile-file', broken, /JSONとして読み込めませんでした/, '壊れた JSON（設定ファイル）');
    await refuse('setup-restore-file', broken, /JSONとして読み込めませんでした/, '壊れた JSON（バックアップ）');
    const badCat = JSON.parse(JSON.stringify(profileObj));
    badCat.profile.config.prizes[0].categoryId = 'nope';
    await refuse('setup-profile-file', put('profile-bad-category.json', badCat), /景品の1番目の賞が見つかりません/, '賞の無い景品');
    const badInit = JSON.parse(JSON.stringify(profileObj));
    badInit.profile.initials.day1['grand-1'] = -1;
    await refuse('setup-profile-file', put('profile-bad-initial.json', badInit), /本数は0〜100000の整数にしてください/, '負の本数');
    assert.deepEqual((await dumpDb()).meta, [], '断られたものは何も書かない');
    // 復元
    await page.setInputFiles(tid('setup-restore-file'), v1Path);
    await page.waitForSelector(tid('dlg-ok'));
    assert.ok((await text('dialog')).includes('抽選 0 件・参加済み 0 件'));
    await page.click(tid('dlg-ok'));
    await waitScreen('choose');

    // --- 見た目：よーそろがちゃ（手詰めの名前）---
    await page.waitForFunction((t) => document.title === t, 'よーそろがちゃ｜電波祭2026');
    const look = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="screen-choose"]');
      return {
        auto: root.classList.contains('auto'), label: root.querySelector('.yo').getAttribute('aria-label'),
        gaps: [...root.querySelectorAll('.yo .c')].map((c) => c.style.getPropertyValue('--g')),
        yomi: root.querySelector('.yomi').textContent, yomiLs: root.querySelector('.yomi').style.getPropertyValue('--yl'),
        tag: root.querySelector('.tag').textContent, mid: root.querySelector('.meta .mm').textContent,
        logo: document.querySelector('#logo .logo-text').textContent, logoLabel: document.getElementById('logo').getAttribute('aria-label'),
        rows: [...root.querySelectorAll('.row')].map((r) => [r.dataset.testid, r.querySelector('.n').textContent, r.querySelector('.t').textContent, r.querySelector('.s').textContent]),
      };
    });
    assert.equal(look.auto, false, '手詰めの名前の経路');
    assert.equal(look.label, 'よーそろがちゃ');
    assert.deepEqual(look.gaps, DENPASAI.config.brand.wordmark.gaps.map((g) => `${g}em`), '字ごとの手詰めの字間');
    assert.equal(look.yomi, 'YOSORO GACHA');
    assert.equal(look.yomiLs, `${DENPASAI.config.brand.wordmark.yomiSpacing.l}em`);
    assert.equal(look.tag, 'おひとり1回・参加無料');
    assert.equal(look.mid, 'YOSORO GACHA — よーそろがちゃ');
    assert.equal(look.logo, '電波祭 2026 / DENPASAI 2026');
    assert.equal(look.logoLabel, 'よーそろがちゃ');
    assert.deepEqual(look.rows, [['choose-student', '01', '本校の学生', '学籍番号を入力します'], ['choose-guest', '02', '本校学生以外の方', '入力不要・参加後に印をつけます']]);
    assert.equal((await cssVar('--main')).toUpperCase(), '#1A33E0');
    await assertTheme(THEMES.yosoro, 'よーそろ');
    assert.deepEqual(await motifsInSymbol(), ['helm'], '#wheel の中身は舵輪');
    // --- DB：v2 に正規化されて入っている（PIN はバックアップのもの）---
    let d = await dumpDb();
    const cfg = metaVal(d, 'config');
    assert.equal(cfg.schemaVersion, 2);
    assert.deepEqual(omit(cfg, ['pinHash', 'sound']), { schemaVersion: 2, ...JSON.parse(JSON.stringify(DENPASAI.config)) }, 'v1 → よーそろ（電波祭2026）の v2');
    assert.equal(cfg.pinHash, pinHashOf('4321'));
    assert.deepEqual(cfg.categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER']);
    assert.equal(metaVal(d, 'schemaVersion'), 2);
    assert.equal(metaVal(d, 'lastBackupAt'), 1790000000000, '復元した内容はバックアップ済み');
    assert.equal(d.inventory.length, 14);

    // --- 実際の 3 秒長押しで、バックアップの PIN で入れる ---
    await openAdmin('status');
    await closeAdmin();
    await waitScreen('choose');

    // --- 一般の方の抽選：よーそろのアンケートの文言・選択肢 → 協賛特別賞（在庫はグリーンランドだけ）---
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    assert.deepEqual(await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent)), TPL.SURVEY_AGES.map((a) => a.label));
    assert.equal(squash(await page.textContent('.scr-survey .meta .mm')), 'YOSORO GACHA — SURVEY');
    await page.click(tid('age-high-school'));
    await waitScreen('survey-trigger');
    assert.deepEqual(await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent)), TPL.SURVEY_TRIGGERS.map((t) => t.label), 'Q2 に熊本高専もある');
    const q2t = await text('screen-survey-trigger');
    for (const w of ['電波祭に来場したきっかけを教えてください。', '次へ（舵輪へ）', '回答は個人が分からない形で集計し、電波祭の運営と協賛企業への来場者層の説明に使います。']) assert.ok(q2t.includes(w), w);
    await page.click(tid('trigger-kosen-interest'));
    await page.click(tid('survey-next'));
    await waitScreen('wheel');
    const wh = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="screen-wheel"]');
      return { h2: el.querySelector('h2').textContent, step: el.querySelector('.step').textContent, rot: el.querySelector('.wheelwrap .wm').style.transform };
    });
    assert.equal(wh.h2, '舵輪を回して、お宝を引こう！');
    assert.equal(squash(wh.step), 'DRAW TURN THE WHEEL');
    assert.equal(wh.rot, `rotate(${MOTIFS.helm.angle}deg)`);
    const rec = await spinAndWaitResult();
    assert.equal(rec.prizeId, 'greenland');
    assert.equal(rec.tier, 'sponsor');
    assert.equal(rec.categoryName, '協賛特別賞');
    assert.equal(rec.eventId, 'denpasai-2026');
    assert.equal(await resultMid(), 'SPONSOR AWARD', '賞の欧文（v1 の賞は電波祭の呼び名）');
    const card = await page.evaluate(() => ({
      a: document.querySelector('#card .cap.a').textContent, b: document.querySelector('#card .cap.b').textContent, c: document.querySelector('#card .cap.c').textContent,
      prize: document.querySelector('#result .plabel span').textContent, stamp: document.querySelector('#result .stamp .s3').textContent, sponsor: document.getElementById('stage').classList.contains('t-sponsor'),
    }));
    assert.deepEqual(card, { a: 'SPONSOR AWARD', b: `電波祭 2026 / ${rec.label}`, c: 'YOSORO GACHA — SPONSOR AWARD', prize: 'お宝 / 景品', stamp: 'DENPASAI 2026', sponsor: true });
    // 未確認のまま再読み込み → 演出なしの結果（静止表示）にも SPONSOR AWARD
    await page.reload();
    await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
    assert.equal(await resultMid(), 'SPONSOR AWARD', '静止表示の結果');
    assert.ok(await page.evaluate(() => document.getElementById('stage').classList.contains('t-sponsor')));
    assert.equal(await page.textContent('#card .cap.a'), 'SPONSOR AWARD');
    await confirmResult();
    await waitScreen('choose');          // グリーンランドはまだ 2 本ある
    assert.equal(invMap(await dumpDb())['day1:greenland'].remaining, 2);
  });

  // ===================================================================
  await step('[6] 既設の iPad（v1 の保存データがそのまま入っている）を新しい版で開く：見た目・動きはそのまま、保存すると v2（賞の欧文も保たれる）', async () => {
    const dev = use(await newDevice({ name: 'B2' }));
    dev.pin = '4321';
    const v1 = v1Backup(dev.pin);
    await page.goto(`${BASE}icons/icon.svg`);
    await page.evaluate(async ({ meta, inventory }) => {
      const m = await import('/js/db.js');
      await m.getDb();      // ストアを作らせてから、db.js を通さずに v1 の行をそのまま書く（既設の端末の状態）
      await new Promise((res, rej) => {
        const r = indexedDB.open('yosoro-gacha');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['meta', 'inventory'], 'readwrite');
          for (const x of meta) tx.objectStore('meta').put(x);
          for (const x of inventory) tx.objectStore('inventory').put(x);
          tx.oncomplete = () => { db.close(); res(); };
          tx.onerror = () => rej(tx.error);
        };
      });
    }, { meta: v1.meta, inventory: v1.inventory });
    await page.goto(URL_FAST);
    await waitScreen('choose');
    await page.waitForFunction((t) => document.title === t, 'よーそろがちゃ｜電波祭2026');
    assert.equal(await page.getAttribute('.scr-choose .yo', 'aria-label'), 'よーそろがちゃ');
    assert.equal(await page.textContent('.scr-choose .yomi'), 'YOSORO GACHA');
    assert.equal((await page.$$('.scr-choose .row')).length, 2);
    await assertTheme(THEMES.yosoro, '既設の端末');
    assert.deepEqual(await motifsInSymbol(), ['helm']);
    let d = await dumpDb();
    assert.equal(metaVal(d, 'config').schemaVersion, 1, '開いただけではディスクの中身は v1 のまま');
    // 一般の方の抽選（v1 の config で判定される）→ 協賛特別賞・SPONSOR AWARD
    await startGuest({ age: 'age-20s', triggers: ['sns'] });
    const rec = await spinAndWaitResult();
    assert.equal(rec.tier, 'sponsor');
    assert.equal(rec.eventId, 'denpasai-2026');
    assert.equal(await resultMid(), 'SPONSOR AWARD');
    await confirmResult();
    await waitScreen('choose');
    assert.equal(metaVal(await dumpDb(), 'config').schemaVersion, 1, '抽選でも config は書き換わらない');
    // スタッフ画面で回すものを変えて保存 → v2。賞の欧文は電波祭の呼び名のまま（SPECIAL PRIZE などにならない）
    await openAdmin('event');
    await page.click(tid('motif-gear'));
    await toastIs(/回すものを変えました/);
    d = await dumpDb();
    const c1 = metaVal(d, 'config');
    assert.equal(c1.schemaVersion, 2, '保存すると v2');
    assert.equal(c1.motif, 'gear');
    assert.deepEqual(c1.categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER'], 'v1 の賞の欧文は保たれる');
    assert.deepEqual(omit(c1, ['motif', 'pinHash', 'sound']), omit({ schemaVersion: 2, ...JSON.parse(JSON.stringify(DENPASAI.config)) }, ['motif']), 'ほかの設定は電波祭2026のまま');
    assert.equal(c1.pinHash, pinHashOf('4321'));
    // 景品・日程の保存も、v1 のまま残っていた config を正しく v2 にする（賞の欧文・景品 id・在庫は変わらない）
    await gotoTab('prizes');
    await page.fill(tid('pname-bulldak'), 'カムジャ麺（大盛り）');
    await page.click(tid('prizes-save'));
    await toastIs(/保存しました/);
    d = await dumpDb();
    assert.deepEqual(metaVal(d, 'config').categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER']);
    assert.equal(metaVal(d, 'config').prizes.find((p) => p.id === 'bulldak').name, 'カムジャ麺（大盛り）');
    assert.equal(d.inventory.length, 14);
    assert.equal(invMap(d)['day1:greenland'].remaining, 2, '在庫は変わらない（1本出た）');
    await closeAdmin();
    await waitScreen('choose');
    assert.deepEqual(await motifsInSymbol(), ['gear'], '回すものが歯車になる');
    assert.equal(await page.textContent('.scr-choose .yomi'), 'YOSORO GACHA', '名前はそのまま');
  });

  // ===================================================================
  await step('[7] 配色：全プリセット／コントラストが足りない色は警告（data-ok=false）でも適用でき --main が変わる／プリセットで戻る', async () => {
    await normalizeA();
    await restock(6);
    const themeOf = async () => metaVal(await dumpDb(), 'config').theme;
    const pressed = () => page.$$eval('[data-testid^="theme-"][aria-pressed="true"]', (els) => els.map((e) => e.dataset.testid.slice('theme-'.length)));
    const warnKeys = () => page.$$eval('[data-testid="theme-warn"] li.is-ng', (els) => els.map((e) => e.dataset.key));
    const setColors = async (c) => { for (const [k, v] of Object.entries(c)) await page.fill(tid(`theme-c-${k}`), v); };
    const previewVar = (name) => page.evaluate((n) => getComputedStyle(document.querySelector('[data-testid="theme-preview"]')).getPropertyValue(n).trim(), name);
    const waitState = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="theme-state"]')?.textContent || ''), re.source);
    const ids = Object.keys(THEMES);
    let d;
    const cfgGuestTitle0 = metaVal(await dumpDb(), 'config').entry.guest.title;

    await openAdmin('event');
    // 回すものの見本は motifPreviewSvg の出力そのまま（色は 'var(--main)' / 'var(--accent)' を渡して描かせる＝そのときの配色で描かれる。作ったあとに style を書き足さない）
    for (const id of Object.keys(MOTIFS)) {
      assert.ok(await isPreviewOf(`[data-testid="motif-${id}"] .motif-svg svg`, id, { size: 72, wc: 'var(--main)', hl: 'var(--accent)' }), `${id}：回すものの見本`);
    }
    assert.ok(await isPreviewOf('[data-testid="theme-preview"] .motif-svg svg', metaVal(await dumpDb(), 'config').motif, { size: 96, wc: 'var(--main)', hl: 'var(--accent)' }), '配色の見本の中の回すもの');
    // --- 全プリセット：タップですぐ保存・反映（スタッフ画面の配色も変わる）---
    for (const id of ids) {
      await page.click(tid(`theme-${id}`));
      await waitState(new RegExp(THEMES[id].label.replace(/[（）()]/g, '.')));
      await assertTheme(THEMES[id], `プリセット ${id}`);
      assert.deepEqual(await pressed(), [id], '選択中の札は1つだけ');
      assert.deepEqual(await themeOf(), { preset: id, custom: null });
      assert.equal(await attr('theme-warn', 'data-ok'), 'true', `プリセット ${id} はコントラストの条件を満たす`);
      assert.deepEqual(await warnKeys(), []);
      assert.equal(await val('theme-c-main'), THEMES[id].main.toLowerCase(), 'カスタムの入力欄は今の色から始まる');
      assert.equal((await previewVar('--main')).toLowerCase(), THEMES[id].main.toLowerCase(), '見本の色');
      assert.deepEqual(await page.$$eval(`[data-testid="theme-${id}"] .th-chips i`, (els) => els.map((e) => getComputedStyle(e).backgroundColor)),
        ['paper', 'main', 'ink', 'accent'].map((k) => rgbCss(THEMES[id][k])), `プリセット ${id} の札の4色`);
      // 回すものの見本は、いまの配色で描かれる（本体＝主色、目印＝差し色）
      assert.deepEqual(await page.$$eval('[data-testid="motif-gear"] svg > g', (gs) => gs.map((g) => getComputedStyle(g).fill)), [rgbCss(THEMES[id].main), rgbCss(THEMES[id].accent)], `プリセット ${id} での回すものの見本の色`);
      await page.evaluate(() => document.querySelectorAll('[data-testid="toast"]').forEach((t) => t.remove()));
    }
    await page.click(tid('theme-wakaba'));
    await waitState(/若葉/);

    // --- カスタム：足りない色は警告（保存はできる）---
    const GREY = { paper: '#777777', main: '#777777', ink: '#777777', accent: '#777777' };
    await setColors(GREY);
    assert.equal(await attr('theme-warn', 'data-ok'), 'false');
    assert.deepEqual(await warnKeys(), ['paper/main', 'paper/accent', 'ink/accent', 'ink/paper'], '4 つとも不合格');
    assert.deepEqual(await page.$$eval('[data-testid="theme-warn"] li', (els) => els.map((e) => [e.dataset.key, e.querySelector('.th-w-n').textContent])),
      [['paper/main', '1.00（4.5以上）'], ['paper/accent', '1.00（3以上）'], ['ink/accent', '1.00（4.5以上）'], ['ink/paper', '1.00（12以上）']]);
    assert.ok((await text('theme-warn')).includes('注意'));
    assert.equal((await previewVar('--main')).toLowerCase(), '#777777', '見本には入力中の色がすぐ出る');
    assert.equal((await cssVar('--main')).toLowerCase(), THEMES.wakaba.main.toLowerCase(), '適用するまで画面全体の配色は変わらない');
    assert.deepEqual(await themeOf(), { preset: 'wakaba', custom: null }, '保存もされない');
    // 1 つだけ足りない色：どの条件が不合格かが分かる
    const ONE = { paper: '#EEEADB', main: '#1A33E0', ink: '#0A0E33', accent: '#F7F7F7' };
    await setColors(ONE);
    const expectNg = contrastReport(ONE).filter((r) => !r.ok).map((r) => r.key);
    assert.deepEqual(expectNg, ['paper/accent'], '（この色の組は、紙色の文字が差し色の面で読めないだけ）');
    assert.deepEqual(await warnKeys(), expectNg);
    assert.equal(await attr('theme-warn', 'data-ok'), 'false');
    // 足りている色：警告なし
    const GOOD = { paper: '#F4EFE3', main: '#17493A', ink: '#101510', accent: '#E2571F' };
    await setColors(GOOD);
    assert.deepEqual(contrastReport(GOOD).filter((r) => !r.ok), [], '（フィクスチャの確認）');
    assert.equal(await attr('theme-warn', 'data-ok'), 'true');
    assert.deepEqual(await warnKeys(), []);

    // --- 警告が出ていても適用でき、保存されて --main が変わる ---
    await setColors(GREY);
    assert.equal(await attr('theme-warn', 'data-ok'), 'false');
    await page.click(tid('theme-custom-apply'));
    await toastIs(/カスタムの配色を適用しました/);
    await assertTheme(GREY, '適用したカスタム');
    assert.equal(await text('theme-state'), 'いまはカスタムの配色です');
    assert.deepEqual(await pressed(), [], 'カスタムのときはプリセットの選択中の札は無い');
    assert.deepEqual(await themeOf(), { preset: 'wakaba', custom: GREY }, 'プリセットは残したままカスタムを保存');
    assert.equal(await attr('theme-warn', 'data-ok'), 'false', '保存後も警告は続く');
    await closeAdmin();
    await waitScreen('choose');
    await assertTheme(GREY, 'プレイヤー画面にも反映');
    await openAdmin('event');
    assert.equal(await val('theme-c-main'), '#777777', '開き直してもカスタムの色');
    assert.equal(await text('theme-state'), 'いまはカスタムの配色です');

    // --- プリセットを選ぶと戻る ---
    await page.click(tid('theme-sakura'));
    await waitState(/桜/);
    await assertTheme(THEMES.sakura, 'プリセットに戻る');
    assert.deepEqual(await themeOf(), { preset: 'sakura', custom: null }, 'カスタムは外れる');
    assert.deepEqual(await pressed(), ['sakura']);
    assert.equal(await attr('theme-warn', 'data-ok'), 'true');
    // 「プリセットに戻す」：カスタムだけ外し、プリセットはそのまま
    await setColors(GOOD);
    await page.click(tid('theme-custom-apply'));
    await toastIs(/カスタムの配色を適用しました/);
    await assertTheme(GOOD, '良いカスタム');
    assert.deepEqual(await themeOf(), { preset: 'sakura', custom: { paper: '#f4efe3', main: '#17493a', ink: '#101510', accent: '#e2571f' } }, '<input type=color> の値は小文字で保存される');
    assert.equal(await attr('theme-warn', 'data-ok'), 'true');
    await page.click(tid('theme-custom-reset'));
    await toastIs(/プリセットの配色に戻しました/);
    await assertTheme(THEMES.sakura, 'プリセットに戻す');
    assert.deepEqual(await themeOf(), { preset: 'sakura', custom: null });
    assert.deepEqual(await pressed(), ['sakura']);
    assert.equal(await text('theme-error'), '');
    await closeAdmin();
    await waitScreen('choose');
    await assertTheme(THEMES.sakura, 'プレイヤー画面');
    // 再読み込み（保存した設定から起動）でも同じ
    await page.reload();
    await waitScreen('choose');
    await assertTheme(THEMES.sakura, '再読み込み後');
    // 後続のため元の海に戻す
    await openAdmin('event');
    await page.click(tid('theme-umi'));
    await waitState(/海/);
    await closeAdmin();
    await waitScreen('choose');
    await assertTheme(THEMES.umi, '海');

    // --- 別のカードの保存がほぼ同時に走っても（2本指で同時にタップ等）、どちらの変更も失われない（保存は順番に行う）---
    await openAdmin('event');
    await page.fill(tid('entry-guest-title'), '同時に保存した見出し');
    await page.evaluate(() => {
      for (const id of ['theme-wakaba', 'motif-pinwheel', 'entry-save']) document.querySelector(`[data-testid="${id}"]`).click();    // 同じ tick で 3 つ
    });
    await page.waitForFunction(async () => {
      const m = await import('./js/db.js');
      const c = await m.getConfig();
      return c.entry.guest.title === '同時に保存した見出し';
    }, null, { timeout: 8000 });
    await sleep(500);
    d = await dumpDb();
    assert.deepEqual([metaVal(d, 'config').theme, metaVal(d, 'config').motif, metaVal(d, 'config').entry.guest.title], [{ preset: 'wakaba', custom: null }, 'pinwheel', '同時に保存した見出し'],
      '配色・回すもの・参加の方法の3つとも保存されている');
    await assertTheme(THEMES.wakaba, 'ほぼ同時に保存した配色');
    await page.fill(tid('entry-guest-title'), cfgGuestTitle0);
    await page.click(tid('entry-save'));
    await toastIs(/保存しました/);
    await page.click(tid('theme-umi'));
    await waitState(/海/);
    await page.click(tid('motif-gear'));
    await toastIs(/回すものを変えました/);
    await closeAdmin();
    await waitScreen('choose');

    // --- 結果を表示したまま（未確認）配色・回すものを変えてスタッフ画面を閉じる → 結果の飾り（ハーフトーンのインク・回すもの）も新しいものになる ---
    await openAdmin('inventory');
    const active = metaVal(await dumpDb(), 'activeDayId');
    await setStock(active, { 'grand-1': 2 });       // 協賛特別賞（演出 sponsor）だけ
    await closeAdmin();
    await waitScreen('choose');
    await startGuest();
    const rec = await spinAndWaitResult();
    assert.equal(rec.tier, 'sponsor');
    // 協賛特別賞（演出 sponsor）のタイトルカードの文言：賞の欧文・イベントの小見出し・ガチャ名の欧文は設定から
    const cfgNow = metaVal(await dumpDb(), 'config');
    const grandLatin = cfgNow.categories.find((c) => c.id === rec.categoryId).latin;
    assert.deepEqual(await page.evaluate(() => ({ a: document.querySelector('#card .cap.a').textContent, b: document.querySelector('#card .cap.b').textContent, c: document.querySelector('#card .cap.c').textContent })),
      { a: grandLatin, b: `${cfgNow.brand.eventLabel} / ${rec.label}`, c: `${cfgNow.brand.nameLatin} — ${grandLatin}` }, 'タイトルカードの文言');
    const halftoneInk = () => page.evaluate(() => {
      const c = document.querySelector('#ht canvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 250) return `rgb(${px[i]}, ${px[i + 1]}, ${px[i + 2]})`;
      return null;
    });
    assert.equal(await halftoneInk(), rgbCss(THEMES.umi.ink), '結果のハーフトーンは今の配色のインク');
    await openAdmin('event');
    await page.click(tid('theme-sakura'));
    await waitState(/桜/);
    await page.click(tid('motif-pinwheel'));
    await toastIs(/回すものを変えました/);
    await closeAdmin();
    assert.ok(await has('ok-button'), '未確認の結果はそのまま');
    await assertTheme(THEMES.sakura, '結果を表示したまま変えた配色');
    await eventually(motifsInSymbol, ['pinwheel'], '結果の飾りの回すもの');
    await eventually(halftoneInk, rgbCss(THEMES.sakura.ink), '結果のハーフトーンも新しいインクの色で描き直される');
    await openAdmin('event');
    await page.click(tid('theme-umi'));
    await waitState(/海/);
    await page.click(tid('motif-gear'));
    await toastIs(/回すものを変えました/);
    await closeAdmin();
    await confirmResult();
    await waitScreen('choose');
  });

  // ===================================================================
  // [8] 文字の収まり：長い名前・長い呼び名・長い入口の文言でも、3つの画面の大きさではみ出さない・重ならない
  const SIZES = [[1180, 820], [1024, 768], [820, 1180]];
  const LONG = {
    brand: 'オープンキャンパス2026がちゃ', latin: 'OPEN CAMPUS 2026 GACHA', event: 'オープンキャンパス2026（八代キャンパス）',
    label: 'オープンキャンパス 2026', eventLatin: 'OPEN CAMPUS 2026', tagline: '参加無料・おひとり1回・なくなり次第終了', prizeWord: 'お土産',
    stuTitle: '本校の在校生・卒業生の方', stuSub: '学籍番号を入れるだけですぐに抽選できます', gstTitle: '一般のお客様・保護者の方', gstSub: '入力不要。参加後にスタッフが印をつけます',
    catName: '長い名前'.repeat(10), prizeName: '長い景品名'.repeat(12), catLatin: 'W'.repeat(LIMITS.categoryLatin),
  };
  /** ロゴの文字が最長（和文 20 字＋いちばん幅の広い字の欧文 24 字） */
  const LOGO_MAX = { label: 'オープンキャンパス2026春の特別開催日', latin: 'W'.repeat(LIMITS.eventLatin) };
  assert.equal(len(LOGO_MAX.label), LIMITS.eventLabel, 'フィクスチャ：ロゴの和文は上限ちょうど');
  for (const [k, max] of [['brand', LIMITS.brandName], ['latin', LIMITS.nameLatin], ['event', LIMITS.eventName], ['label', LIMITS.eventLabel], ['eventLatin', LIMITS.eventLatin], ['tagline', LIMITS.tagline],
    ['prizeWord', LIMITS.prizeWord], ['stuTitle', LIMITS.entryTitle], ['gstTitle', LIMITS.entryTitle], ['stuSub', LIMITS.entrySub], ['gstSub', LIMITS.entrySub], ['catName', LIMITS.categoryName], ['prizeName', LIMITS.prizeName]]) {
    assert.ok(len(LONG[k]) <= max, `フィクスチャ ${k} は上限（${max}字）以内: ${len(LONG[k])}字`);
  }
  assert.ok(len(LONG.brand) === LIMITS.brandName && len(LONG.catName) === LIMITS.categoryName && len(LONG.prizeName) === LIMITS.prizeName
    && len(LONG.stuTitle) === LIMITS.entryTitle && len(LONG.gstTitle) === LIMITS.entryTitle && len(LONG.stuSub) === LIMITS.entrySub && len(LONG.gstSub) === LIMITS.entrySub, '名前・賞・景品・入口の文言は上限ちょうどの長さ');

  /** ステージの論理座標（拡縮を戻した値）で要素の位置を測る。b = 箱、ink = 文字の範囲 */
  const MEASURE = `(() => {
    const st = document.getElementById('stage'); const sr = st.getBoundingClientRect(); const s = sr.width / st.offsetWidth;
    const rel = (r) => ({ l: (r.left - sr.left) / s, r: (r.right - sr.left) / s, t: (r.top - sr.top) / s, b: (r.bottom - sr.top) / s });
    const box = (el) => (el ? rel(el.getBoundingClientRect()) : null);
    // 文字の範囲。overflow を隠している要素（「…」で省略したヘッダの画面名など）の外にはみ出した分は、見えないので数えない
    const ink = (el) => {
      if (!el) return null;
      const g = document.createRange(); g.selectNodeContents(el);
      const r = rel(g.getBoundingClientRect());
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        if (getComputedStyle(e).overflowX === 'visible') continue;
        const b = rel(e.getBoundingClientRect());
        r.l = Math.max(r.l, b.l); r.r = Math.min(r.r, b.r);
      }
      return r;
    };
    const union = (rs) => (rs.length ? { l: Math.min(...rs.map((r) => r.l)), r: Math.max(...rs.map((r) => r.r)), t: Math.min(...rs.map((r) => r.t)), b: Math.max(...rs.map((r) => r.b)) } : null);
    return { st, s, box, ink, union, W: st.offsetWidth, H: st.offsetHeight, portrait: st.dataset.o === 'p' };
  })()`;
  const measureChoose = () => page.evaluate(`(() => {
    const M = ${MEASURE}; const { st, box, ink, union } = M;
    const root = st.querySelector('[data-testid="screen-choose"]');
    return {
      W: M.W, H: M.H, portrait: M.portrait, lines: root.dataset.lines || '1', fs: root.style.getPropertyValue('--yo-fs'),
      mmText: root.querySelector('.meta .mm').textContent,
      logo: box(document.getElementById('logo')), meta: box(root.querySelector('.meta')), mm: ink(root.querySelector('.meta .mm')), hr: box(root.querySelector('.meta .r')),
      yo: union([...root.querySelectorAll('.yo .c')].map(box)), yomi: box(root.querySelector('.yomi')), tag: box(root.querySelector('.tag')),
      rows: [...root.querySelectorAll('.row')].map((row) => ({ id: row.dataset.testid, row: box(row), tx: box(row.querySelector('.tx')), t: ink(row.querySelector('.t')), s: ink(row.querySelector('.s')) })),
    };
  })()`);
  const measureWheel = () => page.evaluate(`(() => {
    const M = ${MEASURE}; const { st, box, ink } = M;
    const root = st.querySelector('[data-testid="screen-wheel"]');
    const dial = box(root.querySelector('.dial')); const arc = box(root.querySelector('.arc'));
    const lines = (el) => { const g = document.createRange(); g.selectNodeContents(el); return [...g.getClientRects()].filter((r) => r.width > 0.5).map((r) => ({ l: (r.left - M.st.getBoundingClientRect().left) / M.s, r: (r.right - M.st.getBoundingClientRect().left) / M.s, t: (r.top - M.st.getBoundingClientRect().top) / M.s, b: (r.bottom - M.st.getBoundingClientRect().top) / M.s })); };
    return {
      W: M.W, H: M.H, portrait: M.portrait, h2font: getComputedStyle(root.querySelector('h2')).fontSize,
      subLines: lines(root.querySelector('.sub')), h2Lines: lines(root.querySelector('h2')),
      disk: { cx: (arc.l + arc.r) / 2, cy: (arc.t + arc.b) / 2, R: (arc.r - arc.l) / 2 + 4 * (dial.r - dial.l) / 720 },
      logo: box(document.getElementById('logo')), meta: box(root.querySelector('.meta')), mm: ink(root.querySelector('.meta .mm')), hr: box(root.querySelector('.meta .r')),
      h2: ink(root.querySelector('h2')), sub: box(root.querySelector('.sub')), step: box(root.querySelector('.step')), go: box(root.querySelector('.go')), readout: box(root.querySelector('.readout')), back: box(root.querySelector('.back')),
      dial, ringL: arc.l - 4 * (dial.r - dial.l) / 720, ringR: arc.r + 4 * (dial.r - dial.l) / 720, ringT: arc.t - 4 * (dial.r - dial.l) / 720,
    };
  })()`);
  const fmt = (r) => (r ? `x ${r.l.toFixed(1)}..${r.r.toFixed(1)} y ${r.t.toFixed(1)}..${r.b.toFixed(1)}` : 'なし');
  function headerProblems(m) {
    const bad = [];
    if (m.mm.l < m.logo.r - 0.5) bad.push(`画面名がロゴに重なる（ロゴ右端 ${m.logo.r.toFixed(1)} / 画面名 ${m.mm.l.toFixed(1)}）`);
    if (m.mm.r > m.hr.l + 0.5) bad.push(`画面名が右の開催日に重なる（画面名右端 ${m.mm.r.toFixed(1)} / 開催日 ${m.hr.l.toFixed(1)}）`);
    if (m.mm.l < -0.5 || m.mm.r > m.W + 0.5) bad.push(`画面名がステージの外 ${fmt(m.mm)}`);
    const logoCap = m.W * (m.portrait ? 0.5 : 0.42);      // docs/DESIGN.md：ロゴの右端は画面幅の 42%（縦置きは 50%）まで（それ以上は字を小さく・「…」で省略）
    if (m.logo.r > logoCap + 1) bad.push(`ロゴが画面幅の ${m.portrait ? 50 : 42}% を超える（右端 ${m.logo.r.toFixed(1)} / ${logoCap.toFixed(1)}）`);
    return bad;
  }
  /**
   * 結果のスタンプの下の欧文（.s3）が、スタンプの円（リング）の内側に収まる。傾き（-7度）と登場の動きを外して素の位置で測り、
   * 文字の箱（Range）の四隅がリングの線の内側の縁（から 1px 以内）に入るかを見る。スタンプはいちばん小さい円（通常の系統・直径 230px）でも収まる。
   */
  const measureStamp = () => page.evaluate(() => {
    const st = document.getElementById('stage'); const s = st.getBoundingClientRect().width / st.offsetWidth;
    const stamp = st.querySelector('#result .stamp');
    const saved = [stamp.style.transform, stamp.style.animation];
    stamp.style.transform = 'none'; stamp.style.animation = 'none';
    try {
      const foot = stamp.querySelector('.s3');
      if (foot.hidden) return { hidden: true };
      const ring = stamp.querySelector('.ringl'); const rr = ring.getBoundingClientRect();
      const g = document.createRange(); g.selectNodeContents(foot);
      const t = g.getBoundingClientRect();
      const cx = (rr.left + rr.right) / 2; const cy = (rr.top + rr.bottom) / 2;
      const inner = rr.width / 2 - parseFloat(getComputedStyle(ring).borderTopWidth) * s;
      const worst = Math.max(...[[t.left, t.top], [t.right, t.top], [t.left, t.bottom], [t.right, t.bottom]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
      return { hidden: false, text: foot.textContent, fs: getComputedStyle(foot).fontSize, inner: inner / s, worst: worst / s, tier: [...st.classList].find((c) => c.startsWith('t-')) };
    } finally { stamp.style.transform = saved[0]; stamp.style.animation = saved[1]; }
  });
  function stampProblems(m) {
    if (m.hidden) return ['スタンプの下の欧文が出ていない'];
    return m.worst <= m.inner + 1 ? [] : [`スタンプの下の欧文「${m.text}」が円からはみ出す（四隅の最大半径 ${m.worst.toFixed(1)} / 輪の内側 ${m.inner.toFixed(1)}・字 ${m.fs}・${m.tier}）`];
  }
  /**
   * 結果の賞の名前（1行）と景品名（1行か、文節で折り返した複数行）：画面の余白（左右 40px）の中に収まり、網点の絵（協賛特別賞）・パネルに重ならない。
   * 賞の名前は上限の 40 字でも収まる（縦置きの幅 740px では 18px まで縮める）。
   */
  const measureCatPrize = () => page.evaluate(`(() => {
    const M = ${MEASURE}; const { st, box } = M; const sr = st.getBoundingClientRect();
    const rel = (r) => ({ l: (r.left - sr.left) / M.s, r: (r.right - sr.left) / M.s, t: (r.top - sr.top) / M.s, b: (r.bottom - sr.top) / M.s });
    const spanOf = (el) => {
      const g = document.createRange(); g.selectNodeContents(el);
      const rs = [...g.getClientRects()].filter((r) => r.width > 0.5).map(rel);
      return { l: Math.min(...rs.map((r) => r.l)), r: Math.max(...rs.map((r) => r.r)), t: Math.min(...rs.map((r) => r.t)), b: Math.max(...rs.map((r) => r.b)) };
    };
    const cat = document.getElementById('cat'); const prize = document.getElementById('prize'); const ht = document.getElementById('ht');
    return {
      W: M.W, H: M.H, portrait: M.portrait, tier: [...st.classList].find((c) => c.startsWith('t-')),
      cat: spanOf(cat), catFs: getComputedStyle(cat).fontSize, catText: cat.textContent,
      ht: getComputedStyle(ht).display === 'none' ? null : box(ht),
      prize: box(prize), prizeInk: spanOf(prize), prizeFs: getComputedStyle(prize).fontSize, prizeOverflow: prize.scrollWidth > prize.clientWidth + 1,
      panel: box(st.querySelector('#result .panel')),
    };
  })()`);
  function catPrizeProblems(m) {
    const bad = [];
    const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
    const ctx = `${m.tier}・${m.W}×${m.H}`;
    if (m.cat.l < -0.5 || m.cat.r > m.W - 40 + 1) bad.push(`賞の名前が画面の余白の中に収まらない（${m.cat.l.toFixed(0)}..${m.cat.r.toFixed(0)} / 右の余白の内側 ${m.W - 40}・字 ${m.catFs}・${ctx}）`);
    if (m.ht && hit(m.cat, m.ht)) bad.push(`賞の名前が網点の絵に重なる（賞の名前 右端 ${m.cat.r.toFixed(0)} / 絵 左端 ${m.ht.l.toFixed(0)}・${ctx}）`);
    if (m.prizeInk.l < -0.5 || m.prizeInk.r > m.W - 40 + 1 || m.prizeOverflow) bad.push(`景品名が画面の余白の中に収まらない（${m.prizeInk.l.toFixed(0)}..${m.prizeInk.r.toFixed(0)} / ${m.W - 40}・字 ${m.prizeFs}・${ctx}）`);
    if (m.prize.b > m.panel.t + 0.5) bad.push(`景品名の下端 ${m.prize.b.toFixed(0)} がパネルの上端 ${m.panel.t.toFixed(0)} より下（${ctx}）`);
    return bad;
  }
  function chooseProblems(m) {
    const bad = [...headerProblems(m)];
    const inside = (n, r) => { if (r && (r.l < -0.5 || r.r > m.W + 0.5 || r.t < -0.5 || r.b > m.H + 0.5)) bad.push(`${n} がステージの外: ${fmt(r)}（${m.W}×${m.H}）`); };
    inside('名前', m.yo); inside('読み', m.yomi); inside('帯', m.tag); m.rows.forEach((r, i) => inside(`行${i + 1}`, r.row));
    // 縦の並びは 名前 → 読み → 帯 → 行 で、重ならない。名前はヘッダ（ロゴ・画面名の帯）に重ならない
    const chain = [['名前', m.yo], ['読み', m.yomi], ['帯', m.tag], ...m.rows.map((r, i) => [`行${i + 1}`, r.row])].filter(([, r]) => r);
    for (let i = 0; i + 1 < chain.length; i++) {
      const [an, a] = chain[i]; const [bn, b] = chain[i + 1];
      if (a.b > b.t + 0.5) bad.push(`${an} が ${bn} に重なる（${an} 下端 ${a.b.toFixed(1)} / ${bn} 上端 ${b.t.toFixed(1)}）`);
    }
    if (m.yo.t < Math.max(m.meta.b, m.logo.b) - 0.5) bad.push(`名前がヘッダに重なる（名前 上端 ${m.yo.t.toFixed(1)} / ヘッダ 下端 ${Math.max(m.meta.b, m.logo.b).toFixed(1)}）`);
    // 行の題名・説明は列の幅に収まる
    for (const r of m.rows) for (const [n, x] of [['題名', r.t], ['説明', r.s]]) {
      if (x && (x.r > r.tx.r + 0.5 || x.l < r.tx.l - 0.5)) bad.push(`${r.id} の${n}が列からはみ出す（文字 ${x.l.toFixed(1)}..${x.r.toFixed(1)} / 列 ${r.tx.l.toFixed(1)}..${r.tx.r.toFixed(1)}）`);
    }
    // 名前の字は 12px 未満にならない（読める大きさ）
    if (parseFloat(m.fs) < 12) bad.push(`名前の字が小さすぎる ${m.fs}`);
    return bad;
  }
  /** edge=false：見出しの右端を「輪の左端（高さ中央の一番左）」とは比べず、円との重なりだけを見る（景品の呼び方が上限の6字のとき） */
  function wheelProblems(m, { edge = true } = {}) {
    const bad = [...headerProblems(m)];
    const inside = (n, r) => { if (r.l < -0.5 || r.r > m.W + 0.5 || r.t < -0.5 || r.b > m.H + 0.5) bad.push(`${n} がステージの外: ${fmt(r)}（${m.W}×${m.H}）`); };
    for (const [n, r] of [['見出し', m.h2], ['説明', m.sub], ['ボタン', m.go], ['戻る', m.back]]) inside(n, r);
    if (!m.portrait && edge) {
      if (m.h2.r > m.ringL + 0.5) bad.push(`見出しの右端がダイヤルの輪に重なる（見出し ${m.h2.r.toFixed(1)} / 輪の左端 ${m.ringL.toFixed(1)}）`);
      if (m.sub.r > m.ringL + 0.5) bad.push(`説明の右端がダイヤルの輪に重なる（説明 ${m.sub.r.toFixed(1)} / 輪の左端 ${m.ringL.toFixed(1)}）`);
    } else if (m.portrait && m.h2.b > m.sub.t + 0.5) bad.push(`見出しが説明に重なる（見出し下端 ${m.h2.b.toFixed(1)} / 説明上端 ${m.sub.t.toFixed(1)}）`);
    // 文字の行（箱ではなく）がダイヤルの円（輪の外側）に入り込まない
    const hits = (r) => { const dx = Math.max(r.l - m.disk.cx, 0, m.disk.cx - r.r); const dy = Math.max(r.t - m.disk.cy, 0, m.disk.cy - r.b); return Math.hypot(dx, dy) < m.disk.R - 0.5; };
    for (const [n, ls] of [['見出し', m.h2Lines], ['説明', m.subLines]]) for (const r of ls) if (hits(r)) bad.push(`${n}の文字がダイヤルに重なる ${fmt(r)}（円 中心 ${m.disk.cx.toFixed(0)},${m.disk.cy.toFixed(0)} 半径 ${m.disk.R.toFixed(0)}）`);
    for (const [n, r] of [['ボタン', m.go], ['進み具合', m.readout], ['戻る', m.back]]) if (hits(r)) bad.push(`${n}がダイヤルに重なる ${fmt(r)}`);
    if (m.h2.t < Math.max(m.meta.b, m.logo.b) - 0.5) bad.push('見出しがヘッダに重なる');
    return bad;
  }
  /** スタッフ画面（今のタブ・セットアップ）で、横にはみ出す要素が無い（表の枠は中で横にスクロールするので、枠の中は見ない） */
  async function adminOverflow() {
    return page.evaluate(() => {
      const out = [];
      const adm = document.querySelector('.admin');
      if (!adm) return ['スタッフ画面が開いていない'];
      const vw = document.documentElement.clientWidth;
      const ar = adm.getBoundingClientRect();
      if (ar.left < -0.5 || ar.right > vw + 0.5) out.push(`画面の箱が ${Math.round(ar.left)}..${Math.round(ar.right)}（幅 ${vw}）`);
      for (const sel of ['.admin-head', '.admin-scroll', '.admin-foot', '.wizard-nav']) {
        const el = adm.querySelector(sel);
        if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel} が横にあふれる（${el.scrollWidth} > ${el.clientWidth}）`);
      }
      const name = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}.${String(el.className).split(' ')[0]}`;
      for (const el of adm.querySelectorAll('.admin-head *, .admin-scroll *, .admin-foot *, .wizard-nav *')) {
        if (el.closest('.tbl-wrap') || el.closest('svg')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) { out.push(`${name(el)} が画面の外 ${Math.round(r.left)}..${Math.round(r.right)}（幅 ${vw}）`); continue; }
        if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && cs.overflowX === 'visible') out.push(`${name(el)} の文字があふれる（${el.scrollWidth} > ${el.clientWidth}）`);
      }
      return out.slice(0, 10);
    });
  }
  /** 表の枠（.tbl-wrap）が、初期の設定（2日・数個の景品）で横スクロールを要しない */
  const tableScroll = () => page.$$eval('.admin .tbl-wrap', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.closest('[data-testid]')?.dataset.testid ?? ''} ${e.scrollWidth}>${e.clientWidth}`));
  const debug = (...a) => { if (process.env.E2E_DEBUG) console.log('   [debug]', ...a); };

  await step('[8] 文字の収まり：長い名前・呼び名・入口の文言でも 1180×820 / 1024×768 / 820×1180 ではみ出さず重ならない（待機・抽選・スタッフ画面の全タブ）', async () => {
    const dev = use(await newDevice({ name: 'C' }));
    await page.goto(URL_FAST);
    // --- セットアップ（既定のテンプレートのまま進める）。セットアップの画面も、3つの画面の大きさで横にはみ出さない ---
    const wizardOverflow = async (label) => {
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await settle();
        assert.deepEqual(await adminOverflow(), [], `${label} ${w}×${h}`);
      }
      await page.setViewportSize({ width: 1180, height: 820 });
    };
    await page.waitForSelector(tid('setup-next'));
    await wizardOverflow('セットアップ 1（はじめかた）');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('pin-ok'));
    await wizardOverflow('セットアップ 2（PIN）');
    await typePin(PIN); await typePin(PIN);
    await page.waitForSelector(tid('setup-brand-name'));
    await wizardOverflow('セットアップ 3（イベントの基本）');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('init-day1-greenland'));
    await wizardOverflow('セットアップ 4（景品と本数）');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('rule-min'));
    await wizardOverflow('セットアップ 5（学籍番号のルール）');
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    await wizardOverflow('セットアップ 6（最後の準備）');
    await page.click(tid('setup-start'));
    await waitScreen('choose');

    // --- イベントタブで長い名前に（保存の検証も確かめる）---
    await openAdmin('event');
    await page.fill(tid('brand-name'), '');
    await page.click(tid('brand-save'));
    assert.ok((await text('brand-error')).includes('ガチャ名を入力してください'), await text('brand-error'));
    await page.fill(tid('brand-name'), LONG.brand);
    await page.fill(tid('brand-latin'), 'テスト');
    await page.click(tid('brand-save'));
    assert.ok((await text('brand-error')).includes('半角'), await text('brand-error'));
    await page.fill(tid('brand-latin'), LONG.latin);
    await page.fill(tid('brand-prize-word'), '');
    await page.click(tid('brand-save'));
    assert.ok((await text('brand-error')).includes('景品の呼び方を入力してください'), await text('brand-error'));
    assert.equal(metaVal(await dumpDb(), 'config').brand.name, DENPASAI.config.brand.name, '誤りのまま保存されない');
    for (const [id, k, v] of [['event-name', 'eventName', LONG.event], ['brand-event-label', 'eventLabel', LONG.label], ['brand-event-latin', 'eventLatin', LONG.eventLatin], ['brand-tagline', 'tagline', LONG.tagline], ['brand-prize-word', 'prizeWord', LONG.prizeWord]]) {
      await page.fill(tid(id), v);
      assert.equal(await val(id), v, `${k} が入力欄に入る`);
    }
    await page.click(tid('brand-save'));
    await toastIs(/保存しました/);
    let cfg = metaVal(await dumpDb(), 'config');
    assert.deepEqual([cfg.eventName, cfg.brand.name, cfg.brand.nameLatin, cfg.brand.eventLabel, cfg.brand.eventLatin, cfg.brand.tagline, cfg.brand.prizeWord],
      [LONG.event, LONG.brand, LONG.latin, LONG.label, LONG.eventLatin, LONG.tagline, LONG.prizeWord]);
    assert.equal(cfg.brand.wordmark.for, 'よーそろがちゃ|YOSORO GACHA', '手詰めの設定は残るが、名前が違うので使われない');
    await page.click(tid('motif-roulette'));
    await toastIs(/回すものを変えました/);
    assert.equal(metaVal(await dumpDb(), 'config').motif, 'roulette');
    assert.deepEqual(await page.$$eval('[data-testid^="motif-"][aria-pressed="true"]', (els) => els.map((e) => e.dataset.testid)), ['motif-roulette']);
    await page.fill(tid('entry-student-title'), LONG.stuTitle);
    await page.fill(tid('entry-student-sub'), LONG.stuSub);
    await page.fill(tid('entry-guest-title'), LONG.gstTitle);
    await page.fill(tid('entry-guest-sub'), LONG.gstSub);
    await page.click(tid('entry-save'));
    await toastIs(/保存しました/);
    // 長い賞の名前・景品名（60字）
    await gotoTab('prizes');
    for (const c of ['sponsor', 'rare', 'sticker']) {
      await page.fill(tid(`cat-${c}`), LONG.catName);
      await page.fill(tid(`bx-latin-${c}`), LONG.catLatin);     // いちばん幅の広い字の 24 字
    }
    for (const id of await idsOf('pname-')) await page.fill(tid(`pname-${id}`), LONG.prizeName);     // どの景品が当たっても 60 字
    await page.click(tid('prizes-save'));
    await toastIs(/保存しました/);
    await page.waitForFunction(() => !document.querySelector('[data-testid="tab-prizes"]')?.textContent.includes('読み込み中'));
    await closeAdmin();
    await waitScreen('choose');
    assert.equal(await page.title(), `${LONG.brand}｜${LONG.event}`);
    assert.deepEqual(await motifsInSymbol(), ['roulette']);

    // --- 待機画面：3つの画面の大きさ（その大きさで開き直す）---
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      await waitScreen('choose');
      await settle();
      const m = await measureChoose();
      debug(`choose ${w}x${h}`, JSON.stringify(m));
      assert.deepEqual(chooseProblems(m), [], `待機画面 ${w}×${h}`);
      assert.equal(m.rows.length, 2);
      assert.equal(Number(m.lines) >= 1, true);
    }
    // --- 同じことを、画面の向き・大きさが変わったとき（開いたまま）にも ---
    for (const [w, h] of [[820, 1180], [1024, 768], [1180, 820], [820, 1180]]) {
      await page.setViewportSize({ width: w, height: h });
      await settle();
      const m = await measureChoose();
      assert.deepEqual(chooseProblems(m), [], `待機画面（サイズ変更）${w}×${h}`);
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.reload();
    await waitScreen('choose');

    // --- 学籍番号・アンケートの画面のヘッダ帯：3つの画面の大きさで重ならない（待機・抽選・結果と同じ測り方）---
    const measureHeaderOf = (screen) => page.evaluate(`(() => {
      const M = ${MEASURE}; const { st, box, ink } = M; const root = st.querySelector('[data-testid="screen-${screen}"]');
      return { W: M.W, H: M.H, portrait: M.portrait, logo: box(document.getElementById('logo')), mm: ink(root.querySelector('.meta .mm')), hr: box(root.querySelector('.meta .r')), meta: box(root.querySelector('.meta')) };
    })()`);
    const headerAtAllSizes = async (screen) => {
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await settle();
        assert.deepEqual(headerProblems(await measureHeaderOf(screen)), [], `${screen} のヘッダ ${w}×${h}`);
      }
      await page.setViewportSize({ width: 1180, height: 820 });
      await settle();
    };
    await page.click(tid('choose-student'));
    await waitScreen('student');
    await headerAtAllSizes('student');
    await page.click(tid('back'));
    await waitScreen('choose');
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    await headerAtAllSizes('survey-age');
    await page.click(tid('age-college'));
    await waitScreen('survey-trigger');
    await headerAtAllSizes('survey-trigger');
    await page.click(tid('back'));
    await waitScreen('survey-age');
    await page.click(tid('back'));
    await waitScreen('choose');

    // --- 抽選画面：見出しの右端はダイヤルの輪より左 ---
    const toWheel = async () => {
      await waitScreen('choose');
      await page.click(tid('choose-guest'));
      await waitScreen('survey-age');
      await page.click(tid('age-college'));
      await waitScreen('survey-trigger');
      await page.click(tid('trigger-sns'));
      await page.click(tid('survey-next'));
      await waitScreen('wheel');
    };
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      await toWheel();
      await settle();
      const m = await measureWheel();
      debug(`wheel ${w}x${h}`, JSON.stringify(m));
      assert.deepEqual(wheelProblems(m), [], `抽選画面 ${w}×${h}`);
      const t = await page.evaluate(() => document.querySelector('[data-testid="screen-wheel"] h2').textContent);
      assert.equal(t, `ルーレットを回して、${LONG.prizeWord}を引こう！`);
      await page.click(tid('back'));
      await waitScreen('survey-trigger');
      await page.click(tid('back'));
      await waitScreen('survey-age');
      await page.click(tid('back'));
      await waitScreen('choose');
    }
    // 開いたままの向きの変更（待機 → 抽選）
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.reload();
    await toWheel();
    for (const [w, h] of [[1180, 820], [1024, 768], [820, 1180]]) {
      await page.setViewportSize({ width: w, height: h });
      await settle();
      assert.deepEqual(wheelProblems(await measureWheel()), [], `抽選画面（サイズ変更）${w}×${h}`);
    }
    // --- 結果画面：系統ごとに、3つの画面の大きさで確かめる。ステッカー賞＝スタンプがいちばん小さい円、協賛特別賞＝網点の絵があって賞の名前の幅がいちばん狭い ---
    const onlyTier = (want) => page.evaluate(async (t) => {      // その系統の景品だけに在庫を入れる（ほかは 0）
      const m = await import('./js/db.js');
      const c = await m.getConfig(); const day = await m.getActiveDayId();
      const tierOf = (prizeId) => c.categories.find((x) => x.id === c.prizes.find((p) => p.id === prizeId).categoryId).tier;
      for (const r of (await m.listInventory()).filter((x) => x.dayId === day)) {
        const n = tierOf(r.prizeId) === t ? Math.max(r.remaining, 3) : 0;
        if (n !== r.remaining) await m.adjustInventory(day, r.prizeId, n - r.remaining, 'e2e');
      }
    }, want);
    // 結果画面のヘッダ（ロゴ・賞の欧文・開催日）
    const measureResultHeader = () => page.evaluate(`(() => {
      const M = ${MEASURE}; const { st, box, ink } = M; const root = st.querySelector('#result');
      return { W: M.W, H: M.H, portrait: M.portrait, logo: box(document.getElementById('logo')), mm: ink(root.querySelector('.meta .mm')), hr: box(root.querySelector('.meta .r')), meta: box(root.querySelector('.meta')) };
    })()`);
    const checkResult = async (label) => {
      await settle();
      assert.deepEqual(headerProblems(await measureResultHeader()), [], `結果画面のヘッダ ${label}`);
      assert.deepEqual(stampProblems(await measureStamp()), [], `結果のスタンプの下の欧文 ${label}`);
      assert.deepEqual(catPrizeProblems(await measureCatPrize()), [], `結果の賞の名前・景品名 ${label}`);
    };
    for (const tier of ['sticker', 'sponsor']) {
      if (tier !== 'sticker') {                       // 2つ目の系統：縦置きの抽選画面からやり直す
        await page.setViewportSize({ width: 820, height: 1180 });
        await page.reload();
        await toWheel();
      }
      await onlyTier(tier);
      const rec = await spinAndWaitResult();
      assert.equal(rec.tier, tier, `${tier} の結果`);
      cfg = metaVal(await dumpDb(), 'config');
      assert.equal(await resultMid(), cfg.categories.find((c) => c.id === rec.categoryId).latin, '結果のヘッダ中央は賞の欧文');
      assert.equal(await resultMid(), LONG.catLatin);
      assert.equal(squash(await page.textContent('#result .plabel span')), `${LONG.prizeWord} / 景品`);
      assert.equal(await page.textContent('#result .stamp .s3'), LONG.eventLatin);
      assert.equal(await page.textContent('#cat'), LONG.catName, '賞の名前は 40 字のまま（縮めても切らない）');
      assert.equal(squash(await page.textContent('#prize')), LONG.prizeName, '景品名も 60 字のまま');
      // 縦置きのまま結果を出した直後：大きさの変更（resize）での再調整に頼らず、結果を出したときの調整だけで収まる
      await checkResult(`（${tier}・縦置きで結果を出した直後）`);
      for (const [w, h] of [[1180, 820], [1024, 768], [820, 1180]]) {
        await page.setViewportSize({ width: w, height: h });
        await checkResult(`（${tier}）${w}×${h}`);
      }
      // 画面の大きさを変えて開き直す（結果は未確認のまま残る）：静止表示で組み直した結果も収まる
      for (const [w, h] of [[1024, 768], [820, 1180], [1180, 820]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await page.waitForSelector(tid('ok-button'));
        await page.waitForSelector(tid('result-card'), { state: 'visible' });
        assert.equal(await resultMid(), LONG.catLatin);
        await checkResult(`（${tier}・開き直し）${w}×${h}`);
      }
      if (tier === 'sticker') {
        // 結果が未確認のまま、イベントの欧文を最長（24字・いちばん幅の広い字）に変えて閉じる：結果は新しい欧文で組み直され、ヘッダもスタンプの下の文字も収まる
        await openAdmin('event');
        await page.fill(tid('brand-event-latin'), LOGO_MAX.latin);
        await page.click(tid('brand-save'));
        await toastIs(/保存しました/);
        await closeAdmin();
        assert.ok(await has('ok-button'), '未確認の結果はそのまま');
        await eventually(() => page.textContent('#result .stamp .s3'), LOGO_MAX.latin, 'スタンプの下の欧文は新しい欧文になる');
        for (const [w, h] of [[820, 1180], [1024, 768], [1180, 820]]) {
          await page.setViewportSize({ width: w, height: h });
          await checkResult(`（最長の欧文）${w}×${h}`);
        }
        await openAdmin('event');
        await page.fill(tid('brand-event-latin'), LONG.eventLatin);
        await page.click(tid('brand-save'));
        await toastIs(/保存しました/);
        await closeAdmin();
        await eventually(() => page.textContent('#result .stamp .s3'), LONG.eventLatin, 'スタンプの下の欧文は元の欧文に戻る');
      }
      await confirmResult();
      await waitScreen('choose');
    }
    // 学生の抽選も1件（履歴・集計に行を作る）
    await startStudent('2412345');
    await spinAndWaitResult();
    await confirmResult();
    await waitScreen('choose');

    // --- スタッフ画面の全タブ：3つの画面の大きさで、横にはみ出さない ---
    const TABS = ['status', 'inventory', 'prizes', 'event', 'history', 'survey', 'data', 'settings'];
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await settle();
      await openAdmin();
      for (const tab of TABS) {
        await gotoTab(tab);
        await sleep(120);
        const o = await adminOverflow();
        debug(`admin ${tab} ${w}x${h}`, JSON.stringify(o), JSON.stringify(await tableScroll()));
        assert.deepEqual(o, [], `スタッフ画面「${tab}」 ${w}×${h}`);
        assert.deepEqual(await tableScroll(), [], `スタッフ画面「${tab}」 ${w}×${h}：表が横スクロールを要する`);
      }
      await closeAdmin();
      await waitScreen('choose');
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // --- 名前の変種（自動割り付け）：欧文名・帯が空／半角の名前／短い名前と最長の欧文名 ---
    const editBrand = async (fields) => {
      await openAdmin('event');
      for (const [id, v] of Object.entries(fields)) await page.fill(tid(id), v);
      await page.click(tid('brand-save'));
      await toastIs(/保存しました/);
      await closeAdmin();
      await waitScreen('choose');
    };
    const chooseAtAllSizes = async (label, check = () => {}) => {
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await waitScreen('choose');
        await settle();
        const m = await measureChoose();
        assert.deepEqual(chooseProblems(m), [], `${label} ${w}×${h}`);
        check(m, `${label} ${w}×${h}`);
      }
      await page.setViewportSize({ width: 1180, height: 820 });
    };
    // 欧文名が空：読みの行は出ず、帯が名前の下に詰まる
    await editBrand({ 'brand-latin': '' });
    await chooseAtAllSizes('欧文名が空', (m, l) => {
      assert.equal(m.yomi, null, `${l}：読みの行は出さない`);
      assert.ok(m.tag && m.tag.t - m.yo.b < 90, `${l}：帯は名前のすぐ下（${m.tag && (m.tag.t - m.yo.b).toFixed(1)}px）`);
      assert.equal(m.mmText, LONG.brand, `${l}：画面名は名前だけ`);
    });
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    assert.equal(squash(await page.textContent('.scr-survey .meta .mm')), `${LONG.brand} — SURVEY`, 'アンケートの画面名は、欧文名が空なら名前');
    await page.click(tid('back'));
    await waitScreen('choose');
    // 帯も空
    await editBrand({ 'brand-tagline': '' });
    await chooseAtAllSizes('欧文名も帯も空', (m, l) => { assert.deepEqual([m.yomi, m.tag], [null, null], `${l}：読みも帯も出ない`); });
    // 半角の名前（欧文の書体）
    const ASCII = { name: 'GACHA OPEN DAY 6', latin: 'GACHA OPEN DAY 2026' };
    assert.ok(len(ASCII.name) <= LIMITS.brandName && len(ASCII.latin) <= LIMITS.nameLatin);
    await editBrand({ 'brand-name': ASCII.name, 'brand-latin': ASCII.latin, 'brand-tagline': LONG.tagline });
    await chooseAtAllSizes('半角の名前', (m, l) => { assert.equal(m.mmText, `${ASCII.latin} — ${ASCII.name}`, l); });
    // 短い名前・いちばん幅の広い字の欧文名（24字）・24字の帯
    const WIDE = { name: 'ガチャ', latin: 'W'.repeat(LIMITS.nameLatin), tagline: '参加無料・おひとり1回・先着順・なくなり次第終了' };
    assert.equal(len(WIDE.tagline), LIMITS.tagline);
    await editBrand({ 'brand-name': WIDE.name, 'brand-latin': WIDE.latin, 'brand-tagline': WIDE.tagline });
    await chooseAtAllSizes('短い名前＋最長の欧文名', (m, l) => { assert.ok(m.yomi, `${l}：読みの行`); });

    // 記号を含む名前・欧文名・帯・ロゴ（HTML として解釈されず、そのまま文字で出る）
    const SPECIAL = { name: '<b>"&\'ガチャ', latin: '<svg onload=1> & "x"', tagline: '<i>帯</i>&amp;', label: '<u>祭</u>' };
    assert.ok(len(SPECIAL.name) <= LIMITS.brandName && len(SPECIAL.latin) <= LIMITS.nameLatin);
    await editBrand({ 'brand-name': SPECIAL.name, 'brand-latin': SPECIAL.latin, 'brand-tagline': SPECIAL.tagline, 'brand-event-label': SPECIAL.label });
    await chooseAtAllSizes('記号を含む名前', () => {});
    const sp = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="screen-choose"]');
      return {
        label: root.querySelector('.yo').getAttribute('aria-label'), name: [...root.querySelectorAll('.yo .c')].map((c) => c.textContent).join(''),
        yomi: root.querySelector('.yomi').textContent, tag: root.querySelector('.tag').textContent, mid: root.querySelector('.meta .mm').textContent,
        logo: document.querySelector('#logo .logo-text').textContent, title: document.title,
        // 名前・読み・帯・画面名・ロゴの文字は、文字だけ（名前は字ごとの .c/.ci、ロゴの .jp 以外の要素は無い）
        injected: document.querySelectorAll('.scr-choose .yo *:not(.c):not(.ci), .scr-choose .yomi *, .scr-choose .tag *, .scr-choose .meta .mm *, #logo .logo-text *:not(.jp)').length,
      };
    });
    assert.deepEqual(sp, {
      label: SPECIAL.name, name: SPECIAL.name, yomi: SPECIAL.latin, tag: SPECIAL.tagline, mid: `${SPECIAL.latin} — ${SPECIAL.name}`, logo: `${SPECIAL.label} / ${LONG.eventLatin}`,
      title: `${SPECIAL.name}｜${LONG.event}`, injected: 0,
    }, '記号はそのまま文字として出る（要素として解釈されない）');
    // ロゴの文字：欧文だけ／和文だけ／どちらも空（ロゴの印は残り、長押しで入れる）
    await editBrand({ 'brand-event-label': '', 'brand-event-latin': LONG.eventLatin });
    await chooseAtAllSizes('ロゴの文字が欧文だけ', () => {});
    assert.equal(await page.textContent('#logo .logo-text'), LONG.eventLatin);
    await editBrand({ 'brand-event-label': LONG.label, 'brand-event-latin': '' });
    await chooseAtAllSizes('ロゴの文字が和文だけ', () => {});
    assert.equal(await page.textContent('#logo .logo-text'), LONG.label);
    assert.equal(await page.getAttribute('#result .stamp .s3', 'hidden'), '', 'スタンプの下の欧文は空なら出さない');
    await editBrand({ 'brand-event-label': '' });
    await chooseAtAllSizes('ロゴの文字が空', () => {});
    assert.equal(await page.textContent('#logo .logo-text'), '');
    assert.ok((await page.locator('#logo').boundingBox()).width >= 24, 'ロゴの印は残る');
    // ロゴの文字が最長（和文 20 字＋欧文 24 字）：字を小さくし、それでも収まらなければ「…」で省略して、画面の半分より右に出ない（中身は省略されない）
    await editBrand({ 'brand-event-label': LOGO_MAX.label, 'brand-event-latin': LOGO_MAX.latin });
    await chooseAtAllSizes('ロゴの文字が最長', () => {});
    assert.equal(await page.textContent('#logo .logo-text'), `${LOGO_MAX.label} / ${LOGO_MAX.latin}`, '省略は見た目だけ（中身は全部入っている）');

    // よーそろがちゃの名前（手詰め）に戻しても、長い入口の文言・24字の帯が収まる（手詰めの経路でも fitRows が働く）
    await editBrand({ 'brand-name': DENPASAI.config.brand.name, 'brand-latin': DENPASAI.config.brand.nameLatin, 'brand-tagline': WIDE.tagline, 'brand-event-label': LONG.label, 'brand-event-latin': LONG.eventLatin });
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="screen-choose"]').classList.contains('auto')), false, '手詰めの名前の経路');
    await chooseAtAllSizes('手詰めの名前＋長い入口の文言', (m, l) => { assert.equal(m.rows.length, 2, l); });

    // --- 景品の呼び方が上限（6字）のとき：見出しは最小 40px。輪の左端（高さ中央）は少し越えるが、円には重ならない ---
    await editBrand({ 'brand-prize-word': 'お土産セット' });
    assert.equal(len('お土産セット'), LIMITS.prizeWord);
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      await toWheel();
      await settle();
      const m = await measureWheel();
      assert.deepEqual(wheelProblems(m, { edge: false }), [], `景品の呼び方が6字の抽選画面 ${w}×${h}`);
      debug(`6字の呼び方 ${w}x${h}：見出しの右端 ${m.h2.r.toFixed(1)} / 輪の左端 ${m.ringL.toFixed(1)} / 字 ${m.h2font}`);
      await page.click(tid('back')); await waitScreen('survey-trigger');
      await page.click(tid('back')); await waitScreen('survey-age');
      await page.click(tid('back')); await waitScreen('choose');
    }
    await page.setViewportSize({ width: 1180, height: 820 });
  });

  // ===================================================================
  await step('[10] 上限いっぱいの構成（賞12・景品40・開催日7）：追加の上限・保存・在庫タブ・スタッフ画面の横はみ出し・抽選', async () => {
    use(await newDevice({ name: 'E' }));
    await page.goto(`${BASE}icons/icon.svg`);
    const L = { cats: LIMITS.categories.max, prizes: LIMITS.prizes.max, days: LIMITS.days.max };
    await page.evaluate(async ({ pinHash, L }) => {
      const t = await import('/js/templates.js'); const prof = await import('/js/profile.js'); const m = await import('/js/db.js');
      const c = t.templateConfig('generic').config;
      c.days = Array.from({ length: L.days - 1 }, (_, i) => ({ id: `day${i + 1}`, label: `${i + 1}日目` }));
      c.categories = Array.from({ length: L.cats - 1 }, (_, i) => ({ id: `cat${i + 1}`, name: `賞${i + 1}`, tier: ['sponsor', 'rare', 'sticker'][i % 3], latin: `PRIZE ${i + 1}` }));
      c.prizes = Array.from({ length: L.prizes - 1 }, (_, i) => ({ id: `pz${i + 1}`, categoryId: `cat${(i % (L.cats - 1)) + 1}`, name: `景品${i + 1}`, countUnknown: false }));
      const cfg = prof.normalizeConfig(c);
      cfg.pinHash = pinHash;
      const initials = {};
      for (const d of cfg.days) { initials[d.id] = {}; for (const p of cfg.prizes) initials[d.id][p.id] = 1; }
      await m.initialize({ config: cfg, activeDayId: 'day1', initials });
    }, { pinHash: pinHashOf(PIN), L });
    await page.goto(URL_FAST);
    await waitScreen('choose');
    await openAdmin('prizes');
    assert.match(squash(await text('bx-count')), new RegExp(`賞 ${L.cats - 1}/${L.cats} 景品 ${L.prizes - 1}/${L.prizes} 開催日 ${L.days - 1}/${L.days}`));
    // 1つずつ足して上限に（上限になると追加のボタンが押せなくなり、理由が出る）
    let before = await idsOf('cat-');
    await page.click(tid('bx-cat-add'));
    const nc = await newOf('cat-', before);
    assert.equal(await page.isDisabled(tid('bx-cat-add')), true, `賞は ${L.cats} 個まで`);
    assert.ok((await text('tab-prizes')).includes(`賞は最大${L.cats}個までです`));
    await page.fill(tid(`cat-${nc}`), '最後の賞');
    before = await idsOf('pname-');
    await page.click(tid(`bx-padd-${nc}`));
    const np = await newOf('pname-', before);
    await page.fill(tid(`pname-${np}`), '最後の景品');
    for (const c of await idsOf('bx-padd-')) assert.equal(await page.isDisabled(tid(`bx-padd-${c}`)), true, `景品は ${L.prizes} 個まで（${c}）`);
    assert.ok((await text('tab-prizes')).includes(`景品は最大${L.prizes}個までです`));
    await page.click(tid('bx-day-add'));
    assert.equal(await page.isDisabled(tid('bx-day-add')), true, `開催日は ${L.days} 日まで`);
    assert.match(squash(await text('bx-count')), new RegExp(`賞 ${L.cats}/${L.cats} 景品 ${L.prizes}/${L.prizes} 開催日 ${L.days}/${L.days}`));
    // 景品が 1 つも無い賞は、先に景品を消さないと…（新しい賞に景品を足したので消せない）。景品を消すと賞は消せる
    assert.equal(await page.isDisabled(tid(`bx-cdel-${nc}`)), true);
    await page.fill(tid(`pinit-day${L.days}-${np}`), String(LIMITS.initialMax + 1));
    await page.click(tid('prizes-save'));
    assert.ok((await text('prizes-error')).includes(`0〜${LIMITS.initialMax}の整数`), await text('prizes-error'));
    assert.equal(metaVal(await dumpDb(), 'config').prizes.length, L.prizes - 1, '上限を超える本数は保存されない');
    await page.fill(tid(`pinit-day${L.days}-${np}`), String(LIMITS.initialMax));
    await page.click(tid('prizes-save'));
    await toastIs(/保存しました/);
    await page.waitForFunction(() => !document.querySelector('[data-testid="tab-prizes"]')?.textContent.includes('読み込み中'));
    let d = await dumpDb();
    let cfg = metaVal(d, 'config');
    assert.deepEqual([cfg.categories.length, cfg.prizes.length, cfg.days.length], [L.cats, L.prizes, L.days]);
    assert.equal(d.inventory.length, L.prizes * L.days, '日 × 景品の行');
    assert.equal(invMap(d)[`day${L.days}:${np}`].initial, LIMITS.initialMax, '本数の上限ちょうど（10 万）は保存できる');
    assert.equal(invMap(d)[`day${L.days}:pz1`].initial, 1, '新しい日の既存の景品の本数は1日目と同じ値');
    // スタッフ画面：どのタブも、3つの画面の大きさで横にはみ出さない（表の枠の中は横スクロール）
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await settle();
      for (const tab of ['prizes', 'inventory', 'status', 'history', 'survey']) {
        await gotoTab(tab);
        await sleep(150);
        assert.deepEqual(await adminOverflow(), [], `上限の構成 「${tab}」 ${w}×${h}`);
      }
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    await gotoTab('inventory');
    assert.equal((await idsOf('inv-day1-')).length, L.prizes, '在庫タブの1日分は全部の景品');
    assert.equal((await idsOf('inv-day7-')).length, L.prizes);
    // 抽選（どの景品にも在庫がある）
    await closeAdmin();
    await waitScreen('choose');
    await startGuest();
    const rec = await spinAndWaitResult();
    assert.ok(cfg.prizes.some((p) => p.id === rec.prizeId));
    await confirmResult();
    await waitScreen('choose');
  });

  // ===================================================================
  await step('[11] 回すもの 7 種：文言（呼び名・小見出し・最初の向き・「次へ（○○へ）」）・#wheel の中身・本体と目印の2色で描ける', async () => {
    await normalizeA();
    await restock(10);
    // どの図形も、2色（本体・目印）で実際に描ける（ブラウザで描いて、画素の色を数える）
    const drawn = await page.evaluate(async (ids) => {
      const m = await import('/js/motifs.js');
      const out = {};
      for (const id of ids) {
        const svg = m.motifPreviewSvg(id, { size: 300, wc: '#0000ff', hl: '#ff0000' });
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
        const c = document.createElement('canvas'); c.width = c.height = 300;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 300, 300);
        const px = g.getImageData(0, 0, 300, 300).data;
        let body = 0; let hl = 0; let other = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 200) continue;
          if (px[i + 2] > 200 && px[i] < 60) body++; else if (px[i] > 200 && px[i + 2] < 60) hl++; else other++;
        }
        out[id] = { body: body / 90000, hl: hl / 90000, other: other / 90000 };
      }
      return out;
    }, Object.keys(MOTIFS));
    for (const [id, r] of Object.entries(drawn)) {
      assert.ok(r.body > 0.03, `${id}：本体の色で描かれる（${(r.body * 100).toFixed(1)}%）`);
      assert.ok(r.hl > 0.002, `${id}：目印の色で描かれる（${(r.hl * 100).toFixed(2)}%）`);
      assert.ok(r.body + r.hl > 0.04 && r.body + r.hl < 0.8, `${id}：枠に収まる大きさ（${((r.body + r.hl) * 100).toFixed(1)}%）`);
    }
    for (const [id, mo] of Object.entries(MOTIFS)) {
      await openAdmin('event');
      await page.click(tid(`motif-${id}`));
      await toastIs(/回すものを変えました/);
      assert.equal(metaVal(await dumpDb(), 'config').motif, id);
      await closeAdmin();
      await waitScreen('choose');
      assert.deepEqual(await motifsInSymbol(), [id], `${id}：#wheel の中身`);
      await startGuest({ age: 'age-20s', triggers: ['website'] }).then(() => waitScreen('wheel'));
      const w = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="screen-wheel"]');
        return { h2: el.querySelector('h2').textContent, step: el.querySelector('.step').textContent, sub: el.querySelector('.sub').textContent, aria: el.querySelector('[data-testid="wheel"]').getAttribute('aria-label'), rot: el.querySelector('.wheelwrap .wm').style.transform };
      });
      const prizeWord = metaVal(await dumpDb(), 'config').brand.prizeWord;
      assert.equal(w.h2, `${mo.noun}を回して、${prizeWord}を引こう！`, `${id}：見出し`);
      assert.equal(squash(w.step), `DRAW ${mo.stepLatin}`, `${id}：小見出し`);
      assert.equal(w.sub, `${mo.noun}をぐるっと回すか、タップでまわすを押してください。`, `${id}：説明`);
      assert.equal(w.aria, `${mo.noun}（タップするか、ぐるっと回します）`, `${id}：aria-label`);
      assert.equal(w.rot, `rotate(${mo.angle}deg)`, `${id}：最初の向き`);
      await page.click(tid('back'));
      await waitScreen('survey-trigger');
      assert.ok((await text('survey-next')).includes(`次へ（${mo.noun}へ）`), `${id}：「次へ」の文言: ${await text('survey-next')}`);
      await page.reload();
      await waitScreen('choose');
    }
    // 元の歯車に戻す
    await openAdmin('event');
    await page.click(tid('motif-gear'));
    await toastIs(/回すものを変えました/);
    await closeAdmin();
    await waitScreen('choose');
  });

  // ===================================================================
  await step('[9] 静的な確認と、全シナリオを通して JS エラー・console.error が一度も出ていない', async () => {
    // アプリが実際に読み込んだファイルは、すべて sw.js の PRECACHE にある（新しいモジュールの載せ忘れで、オフラインで動かなくなるのを防ぐ）
    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const raw = new Function(`return ${/const PRECACHE = (\[[\s\S]*?\]);/.exec(swSrc)[1]}`)();
    const urls = raw.map((u) => new URL(u, 'http://example.invalid/app/sw.js').pathname.slice('/app/'.length));   // sw.js からの相対（'./' は ''、'./js/a.js' と 'js/a.js' は同じ）
    assert.equal(new Set(urls).size, urls.length, 'PRECACHE に同じ項目が2回ない（Cache.addAll が失敗してオフラインで動かなくなる）');
    assert.deepEqual(urls.filter((u) => u && !fs.existsSync(path.join(ROOT, u))), [], 'PRECACHE の項目はすべて実在する（1つでも 404 だと Cache.addAll が失敗してオフラインで動かなくなる）');
    const list = urls.map((u) => u || 'index.html');       // './' も index.html を指す
    assert.ok(fetched.size >= 20, `読み込んだファイルを取れている（${fetched.size}）`);
    const missing = [...fetched].filter((f) => f !== 'sw.js' && !list.includes(f));
    assert.deepEqual(missing, [], '読み込んだのに PRECACHE に無いファイル');
    for (const m of ['js/profile.js', 'js/templates.js', 'js/theme.js', 'js/motifs.js']) assert.ok(fetched.has(m) && list.includes(m), `${m} は読み込まれ、PRECACHE にもある`);
    assert.deepEqual(errors, [], 'JS エラー・console.error・学籍番号の漏えい');
  });

  // ===== SCENARIOS-END =====
} finally {
  await browser?.close();
  server.close();
  fs.rmSync(downloadDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
