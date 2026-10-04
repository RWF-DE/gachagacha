// E2E: node tests/e2e.mjs
// リポジトリ（または E2E_ROOT）を小さな静的サーバで配信し、Playwright(Chromium) で通し確認する。
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e.mjs
// 環境変数: E2E_ROOT（配信ルート）, PLAYWRIGHT_MODULE（playwright の場所）, HEADED=1
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.E2E_ROOT || path.join(HERE, '..'));
const PIN = '1234';

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
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split('\n').join('\n       ')}`);
    try { await page.screenshot({ path: path.join(os.tmpdir(), `e2e-fail-${results.length}.png`) }); } catch { /* noop */ }
  }
}

// ---------- ヘルパ ----------
const tid = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let browser, context, page;

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
const invSummary = (d) => sortBy(d.inventory, 'key').map((r) => [r.key, r.initial, r.remaining]);
const snapshot = (d) => ({
  inventory: invSummary(d),
  students: sortBy(d.students, 'studentId').map((s) => [s.studentId, s.drawId]),
  draws: sortBy(d.draws, 'id').map((x) => [x.id, x.prizeId, x.confirmedAt ? 1 : 0, x.studentId ?? null]),
  pending: metaVal(d, 'pendingDrawId') ?? null,
  seq: metaVal(d, 'drawSeq'),
});

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
  await sleep(3300);
  await page.mouse.up();
  await page.waitForSelector(tid('pin-ok'));
  await typePin(PIN);
  await page.waitForSelector(tid('tab-status'));
  if (tab) { await page.click(tid(`tabbtn-${tab}`)); await page.waitForSelector(tid(`tab-${tab}`)); await page.waitForFunction((t) => !document.querySelector(`[data-testid="tab-${t}"]`)?.textContent.includes('読み込み中'), tab); }
}
async function closeAdmin() {
  await page.click(tid('admin-close'));
  await page.waitForSelector(tid('admin'), { state: 'detached' });
}

async function longPressOk(ms = 1300) {
  const box = await page.locator(tid('ok-button')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

async function waitScreen(name) { await page.waitForSelector(tid(`screen-${name}`), { timeout: 15000 }); }

/** 舵輪画面 → 回す → 結果カード表示まで。表示された draw の label を返す */
async function spinAndWaitResult() {
  await waitScreen('wheel');
  await page.click(tid('spin-button'));
  await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
  await page.waitForSelector(tid('result-card'), { state: 'visible' });
  const d = await dumpDb();
  const pending = metaVal(d, 'pendingDrawId');
  assert.ok(pending, 'pendingDrawId が保存されている');
  const rec = d.draws.find((x) => x.id === pending);
  const text = await page.textContent(tid('result-card'));
  assert.ok(text.includes(rec.label), `結果カードに抽選番号 ${rec.label} がある: ${text}`);
  assert.ok(text.includes(rec.prizeName), `結果カードに景品名 ${rec.prizeName} がある`);
  assert.ok(text.includes(rec.categoryName), '結果カードに賞の名称がある');
  return rec;
}

async function confirmResult() {
  await longPressOk();
  await page.waitForSelector(tid('ok-button'), { state: 'detached', timeout: 10000 });
}

async function startGuest() { await waitScreen('choose'); await page.click(tid('choose-guest')); }
async function startStudent(id) {
  await waitScreen('choose');
  await page.click(tid('choose-student'));
  await waitScreen('student');
  await pressKeys('tenkey', id);
  await page.click(tid('tenkey-ok'));
}

// =====================================================================
try {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  context = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('console', (m) => { const t = m.text(); if (/12345|54321|99999/.test(t)) errors.push(`student id leaked to console: ${t}`); });
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-e2e-'));
  console.log(`E2E root: ${ROOT}\nURL: ${BASE}\n`);

  await step('初回セットアップ（PIN・本数・ルール・開始）', async () => {
    await page.goto(URL_FAST);
    await page.waitForSelector(tid('pin-ok'));
    // PIN 設定（2回入力）。不一致→やり直しも確認
    await pressKeys('pin', '1234'); await page.click(tid('pin-ok'));
    await pressKeys('pin', '9999'); await page.click(tid('pin-ok'));
    await pressKeys('pin', '1234'); await page.click(tid('pin-ok'));
    await pressKeys('pin', '1234'); await page.click(tid('pin-ok'));
    // 景品表：本数未定の警告が見える。day1 はステッカーのみ6本、day2 は3本
    await page.waitForSelector(tid('init-day1-greenland'));
    const txt = await page.textContent(tid('admin'));
    assert.ok(txt.includes('本数が未定です'), '本数未定の警告が表示される');
    for (const day of ['day1', 'day2']) {
      for (const p of ['greenland', 'ezo', 'bulldak', 'rare-ibaraki', 'rare-denpasai', 'sticker-ibaraki']) {
        await page.fill(tid(`init-${day}-${p}`), '0');
      }
      await page.fill(tid(`init-${day}-sticker-denpasai`), day === 'day1' ? '6' : '3');
    }
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('rule-min'));
    await page.click(tid('setup-next'));
    await page.waitForSelector(tid('setup-start'));
    await page.click(tid('setup-persist'));
    await page.click(tid('setup-start'));
    await waitScreen('choose');
    const d = await dumpDb();
    assert.equal(metaVal(d, 'activeDayId'), 'day1');
    assert.equal(d.inventory.length, 14);
    assert.equal(d.inventory.find((r) => r.key === 'day1:sticker-denpasai').remaining, 6);
    assert.ok(metaVal(d, 'config').pinHash && metaVal(d, 'config').pinHash !== PIN, 'PIN はハッシュで保存');
  });

  await step('プレイヤー画面に残数・確率が出ない', async () => {
    const txt = await page.textContent('body');
    assert.ok(!/残り|残数|確率|%/.test(await page.textContent('#panel')), 'panel に残数/確率なし');
    assert.ok(!txt.includes('6本'));
  });

  await step('Service Worker が制御し precache が揃う', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    const names = await page.evaluate(() => caches.keys());
    assert.ok(names.some((n) => n.startsWith('yosoro-gacha-')), `cache names: ${names}`);
  });

  await step('ゲスト抽選 → 結果 → 短押しでは確定しない → 1秒長押しで確定 → 待機', async () => {
    await startGuest();
    const rec = await spinAndWaitResult();
    assert.match(rec.label, /^1-0001$/);
    assert.equal(rec.kind, 'guest');
    assert.equal(rec.studentId, undefined);
    await longPressOk(300); // 短押し
    await sleep(200);
    assert.ok(await page.locator(tid('ok-button')).isVisible(), '短押しでは閉じない');
    assert.equal(metaVal(await dumpDb(), 'pendingDrawId'), rec.id);
    await confirmResult();
    await waitScreen('choose');
    const d = await dumpDb();
    assert.equal(metaVal(d, 'pendingDrawId'), undefined);
    const after = d.draws.find((x) => x.id === rec.id);
    assert.ok(after.confirmedAt > 0, 'confirmedAt が保存される');
    assert.equal(d.inventory.find((r) => r.key === 'day1:sticker-denpasai').remaining, 5);
  });

  await step('学生抽選（学籍番号の形式チェック→抽選→確定）', async () => {
    await waitScreen('choose');
    await page.click(tid('choose-student'));
    await waitScreen('student');
    await pressKeys('tenkey', '123');
    await page.click(tid('tenkey-ok'));
    assert.ok((await page.textContent(tid('student-error'))).includes('入力してください'), '桁数不足のエラー');
    await pressKeys('tenkey', '45');
    await page.click(tid('tenkey-ok'));
    const rec = await spinAndWaitResult();
    assert.equal(rec.label, '1-0002');
    assert.equal(rec.kind, 'student');
    await confirmResult();
    await waitScreen('choose');
    const d = await dumpDb();
    assert.deepEqual(d.students.map((s) => [s.studentId, s.drawId]), [['12345', '1-0002']]);
  });

  await step('同じ学籍番号はリロード後も拒否される（抽選は増えない）', async () => {
    await page.reload();
    await startStudent('12345');
    await page.waitForFunction(() => document.querySelector('[data-testid="student-error"]')?.textContent.includes('参加済み'));
    assert.ok(!(await page.locator(tid('screen-wheel')).count()), '舵輪画面へ進まない');
    const d = await dumpDb();
    assert.equal(d.draws.length, 2);
    await page.click(tid('back'));
    await waitScreen('choose');
  });

  await step('学籍番号を入れて戻っても「参加済み」にならない', async () => {
    await startStudent('54321');
    await waitScreen('wheel');
    await page.click(tid('back'));
    await waitScreen('choose');
    const d = await dumpDb();
    assert.ok(!d.students.some((s) => s.studentId === '54321'));
    assert.equal(d.draws.length, 2);
  });

  await step('連打・同時発火でも抽選は1回だけ／未確認中は新規抽選不可', async () => {
    await startStudent('54321');
    await waitScreen('wheel');
    await page.evaluate(() => {
      const s = document.querySelector('[data-testid="spin-button"]');
      const w = document.querySelector('[data-testid="wheel"]');
      for (let i = 0; i < 8; i++) { s.click(); w && w.click(); }
    });
    await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
    await sleep(500);
    const d = await dumpDb();
    assert.equal(d.draws.length, 3, '抽選は合計3件（連打で増えない）');
    assert.equal(d.students.filter((s) => s.studentId === '54321').length, 1);
    assert.equal(d.inventory.find((r) => r.key === 'day1:sticker-denpasai').remaining, 3);
    // DB 層でも二重抽選を拒否
    const codes = await page.evaluate(async () => {
      const m = await import('./js/db.js');
      const out = [];
      for (const args of [{ kind: 'guest' }, { kind: 'student', studentId: '99999' }]) {
        try { await m.draw(args); out.push('NO_ERROR'); } catch (e) { out.push(e.code); }
      }
      return out;
    });
    assert.deepEqual(codes, ['PENDING_EXISTS', 'PENDING_EXISTS']);
    assert.equal((await dumpDb()).draws.length, 3);
  });

  let reloadRec;
  await step('結果表示中にリロードしても同じ抽選が復元される', async () => {
    const before = await dumpDb();
    reloadRec = before.draws.find((x) => x.id === metaVal(before, 'pendingDrawId'));
    await page.reload();
    await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
    await page.waitForSelector(tid('result-card'), { state: 'visible' });
    const text = await page.textContent(tid('result-card'));
    assert.ok(text.includes(reloadRec.label) && text.includes(reloadRec.prizeName), '同じ番号・景品が表示される');
    const after = await dumpDb();
    assert.equal(after.draws.length, 3, 'リロードで抽選は増えない');
    assert.equal(after.inventory.find((r) => r.key === 'day1:sticker-denpasai').remaining, 3, '再減算されない');
    assert.equal(await page.locator(tid('choose-guest')).isVisible().catch(() => false), false);
  });

  let backupA, snapA, backupFile;
  await step('未確認の抽選がある状態でバックアップ書出し（ダウンロード）', async () => {
    await openAdmin('data');
    await page.click(tid('backup-export'));
    await page.waitForSelector(tid('backup-save'));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(tid('backup-save'))]);
    backupFile = path.join(downloadDir, 'backup.json');
    await dl.saveAs(backupFile);
    backupA = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.equal(backupA.schemaVersion, 1);
    assert.equal(backupA.draws.length, 3);
    await page.waitForFunction(() => document.body.textContent.includes('以降の抽選 0 件'), null, { timeout: 5000 });
    const d = await dumpDb();
    assert.equal(metaVal(d, 'lastBackupAt'), backupA.exportedAt);
    snapA = snapshot(d);
    assert.equal(snapA.pending, reloadRec.id);
    await closeAdmin();
  });

  await step('履歴・在庫タブ：学籍番号マスク／確率表示／未確認の再表示', async () => {
    await openAdmin('history');
    const txt = await page.textContent(tid('tab-history'));
    assert.ok(txt.includes('＊＊＊45') && !txt.includes('12345'), '学籍番号は末尾2桁以外を伏せる');
    assert.ok(txt.includes('未確認'));
    await page.click(tid('tabbtn-inventory'));
    await page.waitForFunction(() => document.querySelector('[data-testid="tab-inventory"]')?.textContent.includes('%'));
    const inv = await page.textContent(tid('tab-inventory'));
    assert.ok(inv.includes('100.0%'), '当日の唯一の景品は100%');
    await closeAdmin();
    assert.ok(await page.locator(tid('ok-button')).isVisible(), '未確認のままなら結果画面が残る');
  });

  await step('スタッフ画面：PIN誤りは拒否される', async () => {
    const box = await page.locator(tid('logo')).boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down(); await sleep(3300); await page.mouse.up();
    await page.waitForSelector(tid('pin-ok'));
    await typePin('0000');
    await page.waitForFunction(() => document.querySelector('[data-testid="pin-error"]')?.textContent.includes('PINが違います'));
    await page.click(tid('pin-cancel'));
    await page.waitForSelector(tid('admin'), { state: 'detached' });
  });

  await step('スタッフ画面の履歴から「確認済みにする」で未確認を解除できる', async () => {
    await openAdmin('history');
    await page.click(tid(`confirm-${reloadRec.id}`));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction((id) => !document.querySelector(`[data-testid="confirm-${id}"]`), reloadRec.id);
    assert.equal(metaVal(await dumpDb(), 'pendingDrawId'), undefined);
    await closeAdmin();
    await waitScreen('choose');
    assert.equal(await page.locator(tid('result-card')).isVisible(), false, '結果オーバーレイが閉じる');
  });

  await step('全初期化 → セットアップ画面からバックアップを復元（在庫・参加済み・未確認が一致）', async () => {
    await openAdmin('data');
    await page.click(tid('reset-wipe'));
    await page.fill(tid('danger-word'), '初期化');
    await page.fill(tid('danger-pin'), PIN);
    await page.click(tid('dlg-ok'));
    await page.waitForSelector(tid('setup-restore'), { timeout: 10000 });
    await page.setInputFiles(tid('setup-restore-file'), backupFile);
    await page.click(tid('dlg-ok')); // 復元の確認
    await page.waitForSelector(tid('ok-button'), { timeout: 15000 });
    const text = await page.textContent(tid('result-card'));
    assert.ok(text.includes(reloadRec.label) && text.includes(reloadRec.prizeName), '未確認の結果が復元される');
    const d = await dumpDb();
    assert.deepEqual(snapshot(d), snapA);
  });

  await step('スタッフ画面の復元（置換）でも同じ状態に戻る', async () => {
    await confirmResult();
    await waitScreen('choose');
    assert.equal(metaVal(await dumpDb(), 'pendingDrawId'), undefined);
    await openAdmin('data');
    await page.setInputFiles(tid('restore-file'), backupFile);
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="toast"]')?.textContent.includes('復元しました'));
    await closeAdmin();
    await page.waitForSelector(tid('ok-button'));
    assert.deepEqual(snapshot(await dumpDb()), snapA);
    await page.reload();
    await page.waitForSelector(tid('ok-button'), { timeout: 20000 });
    assert.deepEqual(snapshot(await dumpDb()), snapA);
    await confirmResult();
    await waitScreen('choose');
  });

  await step('壊れたバックアップは復元されない', async () => {
    const bad = path.join(downloadDir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ app: 'yosoro-gacha', schemaVersion: 1, meta: [], inventory: [], draws: [], students: [] }));
    const before = snapshot(await dumpDb());
    await openAdmin('data');
    await page.setInputFiles(tid('restore-file'), bad);
    await page.waitForSelector(tid('dlg-ok'));
    await page.click(tid('dlg-ok')); // エラー表示を閉じる
    assert.deepEqual(snapshot(await dumpDb()), before);
    await closeAdmin();
  });

  await step('くじ箱が空になると抽選終了・残数はマイナスにならない', async () => {
    let n = 0;
    while (n++ < 12) {
      await page.waitForSelector(`${tid('screen-choose')}, ${tid('screen-closed')}`);
      if (await page.locator(tid('screen-closed')).count()) break;
      await startGuest();
      await spinAndWaitResult();
      await confirmResult();
    }
    await waitScreen('closed');
    assert.ok((await page.textContent(tid('screen-closed'))).includes('本日の抽選は終了しました'));
    const d = await dumpDb();
    assert.equal(d.draws.filter((x) => x.dayId === 'day1').length, 6, '初期本数ぶんだけ抽選された');
    assert.ok(d.inventory.every((r) => r.remaining >= 0));
    assert.equal(d.inventory.filter((r) => r.dayId === 'day1').reduce((s, r) => s + r.remaining, 0), 0);
    const code = await page.evaluate(async () => {
      const m = await import('./js/db.js');
      try { await m.draw({ kind: 'guest' }); return 'NO_ERROR'; } catch (e) { return e.code; }
    });
    assert.equal(code, 'BOX_EMPTY');
    assert.ok((await dumpDb()).inventory.every((r) => r.remaining >= 0));
    await page.reload();
    await waitScreen('closed');
  });

  await step('残数の±調整（理由つき）で再開／日の切替', async () => {
    await openAdmin('inventory');
    await page.click(tid('adjust-day1-sticker-denpasai'));
    await page.click(tid('adj-q1'));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="remaining-day1-sticker-denpasai"]')?.textContent === '1');
    const d = await dumpDb();
    const log = d.logs.find((l) => l.type === 'inventory-adjust');
    assert.ok(log && log.detail.delta === 1 && log.detail.reason, '理由つきでログに残る');
    // マイナスになる調整は拒否
    await page.click(tid('adjust-day1-sticker-denpasai'));
    await page.click(tid('adj-q-5'));
    await page.click(tid('dlg-ok'));
    assert.ok((await page.textContent(tid('dialog'))).includes('マイナス'));
    await page.click(tid('dlg-cancel'));
    await closeAdmin();
    await waitScreen('choose');
    await startGuest();
    await spinAndWaitResult();
    await confirmResult();
    await waitScreen('closed');
    // 2日目へ
    await openAdmin('status');
    await page.click(tid('day-day2'));
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="day-day2"]')?.getAttribute('aria-pressed') === 'true');
    const status = await page.textContent(tid('tab-status'));
    assert.ok(status.includes('オフライン準備完了'), `オフライン準備完了が表示される: ${status.slice(0, 300)}`);
    await closeAdmin();
    await waitScreen('choose');
    // 学生は両日通して1回：1日目に使った学籍番号は2日目も不可
    await startStudent('12345');
    await page.waitForFunction(() => document.querySelector('[data-testid="student-error"]')?.textContent.includes('参加済み'));
    await page.click(tid('back'));
    await waitScreen('choose');
  });

  await step('オフライン（機内モード相当）でリロードしても動き、抽選・保存できる', async () => {
    await context.setOffline(true);
    await page.reload();
    await waitScreen('choose');
    await startGuest();
    const rec = await spinAndWaitResult();
    assert.match(rec.label, /^2-0001$/);
    await confirmResult();
    await waitScreen('choose');
    await page.reload();
    await waitScreen('choose');
    const d = await dumpDb();
    assert.equal(d.draws.filter((x) => x.dayId === 'day2').length, 1);
    await context.setOffline(false);
  });

  await step('保存に失敗したら景品を出さずエラー画面（残数・未確認・参加済みは不変）', async () => {
    // 次に採番される抽選IDを先に占有して、draw のトランザクションを ConstraintError で失敗させる
    await waitScreen('choose');
    const before = await dumpDb();
    const nextLabel = '2-0002';
    await page.evaluate((id) => new Promise((resolve, reject) => {
      const req = indexedDB.open('yosoro-gacha');
      req.onsuccess = () => {
        const tx = req.result.transaction('draws', 'readwrite');
        tx.objectStore('draws').put({ id, seq: 99, label: id, dayId: 'day2', kind: 'guest', prizeId: 'x', drawnAt: 1, confirmedAt: 1 });
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }), nextLabel);
    await startGuest();
    await waitScreen('wheel');
    await page.click(tid('spin-button'));
    await waitScreen('error');
    assert.ok((await page.textContent(tid('screen-error'))).includes('保存できませんでした'));
    assert.equal(await page.locator(tid('ok-button')).count(), 0, '景品（結果）は表示されない');
    const mid = await dumpDb();
    assert.deepEqual(mid.inventory, before.inventory, '残数は減っていない');
    assert.equal(metaVal(mid, 'pendingDrawId'), undefined);
    assert.equal(mid.students.length, before.students.length);
    await page.evaluate((id) => new Promise((resolve) => {
      const req = indexedDB.open('yosoro-gacha');
      req.onsuccess = () => {
        const tx = req.result.transaction('draws', 'readwrite');
        tx.objectStore('draws').delete(id);
        tx.oncomplete = () => { req.result.close(); resolve(); };
      };
    }), nextLabel);
    await page.click(tid('error-back'));
    await waitScreen('choose');
    // 復旧後は通常どおり抽選できる
    await startGuest();
    const rec = await spinAndWaitResult();
    assert.equal(rec.label, '2-0002');
    await confirmResult();
    await waitScreen('choose');
  });

  await step('JS エラー・学籍番号の漏えいがない', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
