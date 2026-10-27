// DB 層の確認: node tests/db.browser.mjs（npm run test:db）
// js/db.js の抽選・景品/日程の保存・設定ファイル・バックアップ・v1 の保存データの扱いは IndexedDB が要るので、node:test では確かめられない。
// リポジトリ（または E2E_ROOT）を小さな静的サーバで配信し、Playwright(Chromium) の空のページから js/db.js を import して直接呼ぶ（画面は使わない）。
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/db.browser.mjs
// 環境変数: E2E_ROOT（配信ルート）, PLAYWRIGHT_MODULE（playwright の場所）, HEADED=1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.E2E_ROOT || path.join(HERE, '..'));

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
    console.log(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 10).join('\n       ')}`);
  }
}

// ---------- ヘルパ ----------
let browser, page;
const errors = [];

/** ページ内で fn を実行する（ヘルパは window.__）。 */
const inPage = (fn, arg) => page.evaluate(fn, arg);
const dump = () => inPage(() => window.__.dump());

/** 電波祭2026 で iPad に保存されていた v1 の config そのもの（pinHash は設定済み）。 */
const v1Config = () => ({
  schemaVersion: 1, eventId: 'denpasai-2026', eventName: '電波祭2026',
  days: [{ id: 'day1', label: '1日目' }, { id: 'day2', label: '2日目' }],
  categories: [
    { id: 'sponsor', name: '協賛特別賞', tier: 'sponsor' },
    { id: 'rare', name: 'レアステッカー賞', tier: 'rare' },
    { id: 'sticker', name: 'ステッカー賞', tier: 'sticker' },
  ],
  prizes: [
    { id: 'greenland', categoryId: 'sponsor', name: 'グリーンランド招待券', countUnknown: false },
    { id: 'ezo', categoryId: 'sponsor', name: 'E・ZO FUKUOKA招待券', countUnknown: false },
    { id: 'bulldak', categoryId: 'sponsor', name: 'カムジャ麺', countUnknown: false },
    { id: 'rare-ibaraki', categoryId: 'rare', name: '茨城コラボステッカー〈レア〉', countUnknown: true },
    { id: 'rare-denpasai', categoryId: 'rare', name: '電波祭ステッカー〈レア〉', countUnknown: false },
    { id: 'sticker-ibaraki', categoryId: 'sticker', name: '茨城コラボステッカー', countUnknown: true },
    { id: 'sticker-denpasai', categoryId: 'sticker', name: '電波祭ステッカー', countUnknown: false },
  ],
  studentIdRule: { charset: 'digits', minLength: 7, maxLength: 7 }, pinHash: 'pinpin', sound: { enabled: true, volume: 0.7 },
});

/** v1 のデータが iPad に入っている状態を作る（initialize を通さず、生の v1 config を直接書く）。stock で日×景品の本数を上書き。 */
async function seedV1({ stock = {} } = {}) {
  await inPage(async ({ v1, stock }) => {
    const { db, cfgm, putRaw } = window.__;
    await db.wipeAll();
    await putRaw('meta', { key: 'config', value: v1 });
    await putRaw('meta', { key: 'activeDayId', value: 'day1' });
    await putRaw('meta', { key: 'schemaVersion', value: 1 });
    await putRaw('meta', { key: 'drawSeq', value: {} });
    const init = cfgm.createDefaultInitials();
    for (const d of v1.days) for (const p of v1.prizes) {
      const n = stock[`${d.id}:${p.id}`] ?? init[d.id][p.id];
      await putRaw('inventory', { key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 });
    }
  }, { v1: v1Config(), stock });
}

/** v2 の既定の config（PIN 設定済み）を initialize で入れる。edit(config) で書き換えてよい（ページ内で動くので、外の変数は使えない）。 */
async function seedV2(edit = () => {}, initials = null) {
  await inPage(async ({ editSrc, initials }) => {
    const { db, cfgm } = window.__;
    await db.wipeAll();
    const cfg = cfgm.createDefaultConfig();
    cfg.pinHash = 'pinpin';
    (0, eval)(`(${editSrc})`)(cfg);
    await db.initialize({ config: cfg, activeDayId: 'day1', initials: initials || cfgm.createDefaultInitials() });
  }, { editSrc: edit.toString(), initials });
}

const GUEST_OK = { v: 1, age: 'age-20s', triggers: ['sns'] };

// =====================================================================
try {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  console.log(`DB test root: ${ROOT}\nURL: ${BASE}\n`);
  await page.goto(`${BASE}icons/icon.svg`);
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const cfgm = await import('/js/config.js');
    const prof = await import('/js/profile.js');
    const NAMES = ['meta', 'inventory', 'draws', 'students', 'logs'];
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('yosoro-gacha'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    /** 全ストアの中身（db.js とは別の接続で、生のまま読む） */
    const dump = async () => {
      await db.getDb();
      const d = await open();
      const out = {};
      await new Promise((res) => {
        const tx = d.transaction(NAMES, 'readonly');
        let left = NAMES.length;
        for (const n of NAMES) { const q = tx.objectStore(n).getAll(); q.onsuccess = () => { out[n] = q.result; if (--left === 0) res(); }; }
      });
      d.close();
      return out;
    };
    /** db.js を通さずに1行書く（古い形の保存データを作る用） */
    const putRaw = async (store, value) => {
      await db.getDb();
      const d = await open();
      await new Promise((res, rej) => { const tx = d.transaction([store], 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      d.close();
    };
    /** db.js を通さずに1行消す（印が付く前の古い端末の状態を作る用） */
    const delRaw = async (store, key) => {
      await db.getDb();
      const d = await open();
      await new Promise((res, rej) => { const tx = d.transaction([store], 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      d.close();
    };
    const err = async (p) => { try { await p; return 'NO_ERROR'; } catch (e) { return e.code || String(e); } };
    window.__ = { db, cfgm, prof, dump, putRaw, delRaw, err };
  });

  await step('getConfig：保存された v1 の config は v2 に正規化して返す（ディスクの中身は触らない）', async () => {
    await seedV1();
    const r = await inPage(async () => {
      const { db, cfgm, dump } = window.__;
      const cfg = await db.getConfig();
      const d = await dump();
      return { cfg, def: { ...cfgm.createDefaultConfig(), pinHash: 'pinpin' }, rawVersion: d.meta.find((m) => m.key === 'config').value.schemaVersion, setUp: await db.isSetUp() };
    });
    assert.deepEqual(r.cfg, r.def);
    assert.equal(r.rawVersion, 1, '読んだだけではディスクは v1 のまま');
    assert.equal(r.setUp, true);
    assert.equal(await inPage(async () => { await window.__.db.wipeAll(); return window.__.db.getConfig(); }), null);
  });

  await step('draw：v1 の保存データで今までどおり抽選できる（記録の形は変わらない）', async () => {
    await seedV1({ stock: { 'day1:greenland': 0, 'day1:ezo': 0, 'day1:bulldak': 0, 'day1:rare-ibaraki': 0, 'day1:rare-denpasai': 0, 'day1:sticker-ibaraki': 0, 'day1:sticker-denpasai': 1 } });
    const r = await inPage(async (ok) => {
      const { db, dump } = window.__;
      const rec = await db.draw({ kind: 'guest', survey: ok });
      return { rec, d: await dump() };
    }, GUEST_OK);
    assert.deepEqual(Object.keys(r.rec).sort(), ['categoryId', 'categoryName', 'confirmedAt', 'dayId', 'drawnAt', 'eventId', 'id', 'kind', 'label', 'prizeId', 'prizeName', 'seq', 'survey', 'tier'].sort());
    assert.equal(r.rec.label, '1-0001');
    assert.equal(r.rec.eventId, 'denpasai-2026');
    assert.equal(r.rec.prizeId, 'sticker-denpasai');
    assert.equal(r.rec.categoryName, 'ステッカー賞');
    assert.equal(r.rec.tier, 'sticker');
    assert.deepEqual(r.rec.survey, { v: 1, age: 'age-20s', triggers: ['sns'], ageLabel: '20代', triggerLabels: ['SNS（Instagram・Xなど）'] });
    assert.equal(r.d.inventory.find((x) => x.key === 'day1:sticker-denpasai').remaining, 0);
    assert.equal(r.d.meta.find((m) => m.key === 'pendingDrawId').value, '1-0001');
    assert.equal(r.d.meta.find((m) => m.key === 'config').value.schemaVersion, 1, '抽選では config を書き換えない');
  });

  await step('draw：検証は失敗しても何も書かない（entry 無効・survey 不正・survey 無効のとき）', async () => {
    await seedV2((c) => { c.entry.guest.enabled = false; });
    const before = await dump();
    const r = await inPage(async (ok) => {
      const { db, err } = window.__;
      return {
        guestDisabled: await err(db.draw({ kind: 'guest', survey: ok })),
        guestNoSurvey: await err(db.draw({ kind: 'guest' })),
        studentWithSurvey: await err(db.draw({ kind: 'student', studentId: '2412345', survey: ok })),
        badKind: await err(db.draw({ kind: 'other' })),
        student: await err(db.draw({ kind: 'student', studentId: '2412345' })),
      };
    }, GUEST_OK);
    assert.deepEqual(r, { guestDisabled: 'BAD_REQUEST', guestNoSurvey: 'BAD_REQUEST', studentWithSurvey: 'BAD_REQUEST', badKind: 'BAD_REQUEST', student: 'NO_ERROR' });
    const after = await dump();
    assert.equal(after.draws.length, 1, '学生の抽選だけが保存された');
    assert.equal(after.draws[0].kind, 'student');
    // 失敗した 4 回は、在庫・連番・参加済み・保留のどれも動かしていない（学生の1回ぶんだけ変わる）
    const changedInv = after.inventory.filter((x) => x.remaining !== before.inventory.find((b) => b.key === x.key).remaining);
    assert.equal(changedInv.length, 1);
    assert.equal(after.students.length, 1);
  });

  await step('draw：学生の参加が無効なら学生の抽選は BAD_REQUEST、アンケートが無効なら survey 付きは BAD_REQUEST・無しは OK', async () => {
    await seedV2((c) => { c.entry.student.enabled = false; c.survey.enabled = false; });
    const r = await inPage(async (ok) => {
      const { db, err, dump } = window.__;
      const out = {};
      out.studentDisabled = await err(db.draw({ kind: 'student', studentId: '2412345' }));
      out.guestWithSurvey = await err(db.draw({ kind: 'guest', survey: ok }));
      const before = await dump();
      out.noWrites = JSON.stringify(before.draws) === '[]' && before.students.length === 0 && !before.meta.some((m) => m.key === 'pendingDrawId');
      out.rec = await db.draw({ kind: 'guest' });
      return out;
    }, GUEST_OK);
    assert.equal(r.studentDisabled, 'BAD_REQUEST');
    assert.equal(r.guestWithSurvey, 'BAD_REQUEST');
    assert.equal(r.noWrites, true);
    assert.equal('survey' in r.rec, false, 'アンケート無効なら survey は付かない');
    assert.equal(r.rec.kind, 'guest');
  });

  await step('draw：選択肢を差し替えた config では、その選択肢の id だけが有効（ラベルは config のもの）', async () => {
    await seedV2((c) => {
      c.survey.q1.options = [{ id: 'north', label: '北部' }, { id: 'south', label: '南部' }];
      c.survey.q2.options = [{ id: 'bus', label: 'バス' }, { id: 'train', label: '電車' }, { id: 'walk', label: '徒歩' }];
    });
    const r = await inPage(async () => {
      const { db, err } = window.__;
      const out = {};
      out.defaultIds = await err(db.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } }));
      out.mixed = await err(db.draw({ kind: 'guest', survey: { v: 1, age: 'north', triggers: ['sns'] } }));
      out.rec = await db.draw({ kind: 'guest', survey: { v: 1, age: 'south', triggers: ['walk', 'bus'] } });
      return out;
    });
    assert.equal(r.defaultIds, 'BAD_REQUEST');
    assert.equal(r.mixed, 'BAD_REQUEST');
    assert.deepEqual(r.rec.survey, { v: 1, age: 'south', triggers: ['bus', 'walk'], ageLabel: '南部', triggerLabels: ['バス', '徒歩'] });
  });

  await step('draw：新しい賞（欧文・系統）と新しい景品でも、記録に賞名・景品名・系統が写る／pending 中は PENDING_EXISTS', async () => {
    await seedV2((c) => {
      c.categories = [{ id: 'grand', name: '特賞', tier: 'sponsor', latin: 'GRAND' }, { id: 'basic', name: '参加賞', tier: 'sticker', latin: '' }];
      c.prizes = [{ id: 'g1', categoryId: 'grand', name: '特賞の景品', countUnknown: false }, { id: 'b1', categoryId: 'basic', name: '参加賞の景品', countUnknown: false }];
      c.days = [{ id: 'day1', label: '当日' }];
    }, { day1: { g1: 0, b1: 3 } });
    const r = await inPage(async () => {
      const { db, err } = window.__;
      const rec = await db.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } });
      const second = await err(db.draw({ kind: 'student', studentId: '2412345' }));
      await db.confirmDraw(rec.id);
      const rec2 = await db.draw({ kind: 'student', studentId: '2412345' });
      return { rec, second, rec2 };
    });
    assert.deepEqual([r.rec.prizeId, r.rec.categoryId, r.rec.categoryName, r.rec.prizeName, r.rec.tier, r.rec.label], ['b1', 'basic', '参加賞', '参加賞の景品', 'sticker', '1-0001']);
    assert.equal(r.second, 'PENDING_EXISTS');
    assert.equal(r.rec2.label, '1-0002');
    assert.equal('studentId' in r.rec2, false);
  });

  await step('saveBoxSettings：景品・賞・日の追加と変更を1つのトランザクションで（config は v2 で保存・ログに差分）', async () => {
    await seedV1();   // 生の v1 から始める：保存で v2 になる
    const r = await inPage(async () => {
      const { db, dump } = window.__;
      const cfg = await db.getConfig();
      const input = {
        days: [...cfg.days, { id: 'day3', label: '3日目' }],
        categories: [...cfg.categories, { id: 'extra', name: '特別枠', tier: 'rare' }],
        prizes: [...cfg.prizes, { id: 'p-new', categoryId: 'extra', name: '新しい景品', countUnknown: true }],
        initials: { day1: { 'p-new': 4 }, day2: { 'p-new': 5 }, day3: { 'p-new': 6, greenland: 2 } },
      };
      input.prizes[0] = { ...input.prizes[0], name: 'グリーンランド招待券（改）' };
      const saved = await db.saveBoxSettings(input);
      const d = await dump();
      return { saved, d };
    });
    const cfg = r.d.meta.find((m) => m.key === 'config').value;
    assert.deepEqual(r.saved, cfg, '返り値は保存した config');
    assert.equal(cfg.schemaVersion, 2);
    assert.equal(cfg.brand.name, 'よーそろがちゃ');
    assert.deepEqual(cfg.days.map((d) => d.id), ['day1', 'day2', 'day3']);
    assert.equal(cfg.prizes.find((p) => p.id === 'greenland').name, 'グリーンランド招待券（改）');
    assert.equal(cfg.categories.at(-1).latin, 'RARE PRIZE');
    assert.equal(r.d.inventory.length, 3 * 8);
    const row = (k) => r.d.inventory.find((x) => x.key === k);
    assert.deepEqual([row('day1:p-new').initial, row('day2:p-new').remaining, row('day3:p-new').initial, row('day3:greenland').initial, row('day3:ezo').initial], [4, 5, 6, 2, 0]);
    assert.equal(row('day1:greenland').initial, 3, '触っていない行はそのまま');
    const log = r.d.logs.find((l) => l.type === 'box-settings');
    assert.ok(log && Array.isArray(log.detail) && log.detail.length >= 4, JSON.stringify(log));
    assert.ok(log.detail.some((c) => c.prize === 'p-new' && c.add === '新しい景品'));
    assert.ok(log.detail.some((c) => c.day === 'day3' && c.add === '3日目'));
  });

  await step('saveBoxSettings：抽選が始まったあとの規則（DAY_HAS_DRAWS / PRIZE_HAS_DRAWS）と、失敗しても何も変わらない', async () => {
    await seedV2();
    await inPage(async () => {
      const { db } = window.__;
      await db.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } });   // day1 で1件（pending のまま）
    });
    const before = await dump();
    const drawn = before.draws[0].prizeId;
    const r = await inPage(async (drawn) => {
      const { db, err } = window.__;
      const cfg = await db.getConfig();
      const base = () => ({
        days: structuredClone(cfg.days), categories: structuredClone(cfg.categories), prizes: structuredClone(cfg.prizes),
        initials: { day1: {}, day2: {} },
      });
      const out = {};
      // 抽選のあった day1 の初期本数は変えられない（0 以外の新しい景品も同様）
      { const i = base(); i.initials.day1.ezo = 99; out.initialOnDrawnDay = await err(db.saveBoxSettings(i)); }
      { const i = base(); i.prizes.push({ id: 'late', categoryId: 'rare', name: '後から', countUnknown: false }); i.initials.day1.late = 3; out.newPrizeOnDrawnDay = await err(db.saveBoxSettings(i)); }
      // 抽選のあった景品は消せない
      { const i = base(); i.prizes = i.prizes.filter((p) => p.id !== drawn); out.removeDrawnPrize = await err(db.saveBoxSettings(i)); }
      // 形が悪い
      { const i = base(); i.prizes[0].name = ''; out.badName = await err(db.saveBoxSettings(i)); }
      // ここまで全部失敗：何も変わっていないはず
      // 通るもの：抽選のあった日でも 0 本の新しい景品・名前の変更・抽選の無い day2 の本数
      { const i = base(); i.prizes.push({ id: 'late', categoryId: 'rare', name: '後から', countUnknown: false }); i.initials.day2.late = 3; i.initials.day2.ezo = 8; i.days[0].label = '初日'; out.ok = (await db.saveBoxSettings(i)).days[0].label; }
      return out;
    }, drawn);
    assert.deepEqual(r, { initialOnDrawnDay: 'DAY_HAS_DRAWS', newPrizeOnDrawnDay: 'DAY_HAS_DRAWS', removeDrawnPrize: 'PRIZE_HAS_DRAWS', badName: 'BAD_REQUEST', ok: '初日' });
    const after = await dump();
    // 失敗した保存は何も書かない：成功した最後の保存の分（景品 late の2行・day2:ezo の本数・日の名前）だけが変わっている
    assert.equal(after.inventory.length, before.inventory.length + 2);
    assert.deepEqual(after.inventory.filter((x) => !before.inventory.some((b) => JSON.stringify(b) === JSON.stringify(x))).map((x) => x.key).sort(), ['day1:late', 'day2:ezo', 'day2:late']);
    assert.equal(after.logs.filter((l) => l.type === 'box-settings').length, 1, '失敗した保存はログも残さない');
    assert.deepEqual(after.draws, before.draws);
    assert.equal(after.inventory.find((x) => x.key === `day1:${drawn}`).remaining, before.inventory.find((x) => x.key === `day1:${drawn}`).remaining);
  });

  await step('saveBoxSettings：開催中の日・抽選のある最後の日は消せない（DAY_LOCKED）／日を消すと行も消える', async () => {
    await seedV2();
    const r = await inPage(async () => {
      const { db, err, dump } = window.__;
      const cfg = await db.getConfig();
      const input = () => ({ days: cfg.days.slice(0, 1), categories: cfg.categories, prizes: cfg.prizes, initials: {} });
      const out = {};
      await db.setActiveDay('day2');
      out.activeLast = await err(db.saveBoxSettings(input()));
      // day2 の抽選を1件作る（day2 が開催中のまま抽選→確認→day1 に戻す）
      const rec = await db.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } });
      await db.confirmDraw(rec.id);
      await db.setActiveDay('day1');
      out.drawnLast = await err(db.saveBoxSettings(input()));
      out.keys = (await dump()).inventory.length;
      return out;
    });
    assert.deepEqual(r, { activeLast: 'DAY_LOCKED', drawnLast: 'DAY_LOCKED', keys: 14 });
    // 抽選の無い状態に戻して、day2 を消す
    await seedV2();
    const r2 = await inPage(async () => {
      const { db, dump } = window.__;
      const cfg = await db.getConfig();
      const saved = await db.saveBoxSettings({ days: cfg.days.slice(0, 1), categories: cfg.categories, prizes: cfg.prizes, initials: {} });
      const d = await dump();
      return { days: saved.days.map((x) => x.id), inv: d.inventory.map((x) => x.dayId) };
    });
    assert.deepEqual(r2.days, ['day1']);
    assert.equal(r2.inv.length, 7);
    assert.ok(r2.inv.every((d) => d === 'day1'));
  });

  await step('saveBoxSettings：画面の数値欄の文字列（"12"）は整数として扱い、空・小数・負は BAD_REQUEST', async () => {
    await seedV2();
    const r = await inPage(async () => {
      const { db, err, dump } = window.__;
      const cfg = await db.getConfig();
      const input = (initials) => ({ days: cfg.days, categories: cfg.categories, prizes: cfg.prizes, initials });
      const out = {};
      out.empty = await err(db.saveBoxSettings(input({ day2: { greenland: '' } })));
      out.dec = await err(db.saveBoxSettings(input({ day2: { greenland: '2.5' } })));
      out.neg = await err(db.saveBoxSettings(input({ day2: { greenland: '-1' } })));
      out.text = await err(db.saveBoxSettings(input({ day2: { greenland: 'abc' } })));
      out.huge = await err(db.saveBoxSettings(input({ day2: { greenland: '100001' } })));
      out.ok = await err(db.saveBoxSettings(input({ day1: { greenland: '3' }, day2: { greenland: ' 12 ', ezo: '0' } })));
      const d = await dump();
      out.rows = d.inventory.filter((x) => x.dayId === 'day2' && ['greenland', 'ezo'].includes(x.prizeId)).map((x) => [x.prizeId, x.initial, x.remaining]);
      return out;
    });
    assert.deepEqual([r.empty, r.dec, r.neg, r.text, r.huge, r.ok], ['BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'NO_ERROR']);
    assert.deepEqual(r.rows, [['ezo', 0, 0], ['greenland', 12, 12]]);
  });

  await step('DbError.detail：どの日・景品で止まったか／設定ファイルの不正の理由が取れる', async () => {
    await seedV2();
    const r = await inPage(async () => {
      const { db, prof } = window.__;
      await db.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } });
      const cfg = await db.getConfig();
      const caught = async (p) => { try { await p; return null; } catch (e) { return { name: e.name, code: e.code, detail: e.detail, message: e.message }; } };
      const out = {};
      out.day = await caught(db.saveBoxSettings({ days: cfg.days, categories: cfg.categories, prizes: cfg.prizes, initials: { day1: { ezo: 9 } } }));
      out.profile = await caught(db.importProfile({ ...prof.exportProfile(cfg, []), profileVersion: 7 }));
      out.plain = await caught(db.draw({ kind: 'student', studentId: '12' }));
      return out;
    });
    assert.deepEqual(r.day, { name: 'DbError', code: 'DAY_HAS_DRAWS', detail: 'day1', message: 'DAY_HAS_DRAWS: day1' });
    assert.equal(r.profile.code, 'INVALID_PROFILE');
    assert.equal(r.profile.detail, '新しいバージョンの設定ファイルです。アプリを更新してください');
    assert.equal(r.plain.code, 'PENDING_EXISTS');
    assert.equal(r.plain.detail, null);
  });

  await step('saveBoxSettings：景品を消すと全ての日の行が消える／NOT_SETUP', async () => {
    await seedV2();
    const r = await inPage(async () => {
      const { db, dump } = window.__;
      const cfg = await db.getConfig();
      await db.saveBoxSettings({ days: cfg.days, categories: cfg.categories, prizes: cfg.prizes.filter((p) => p.id !== 'bulldak'), initials: {} });
      const d = await dump();
      await db.wipeAll();
      let code = 'NO_ERROR';
      try { await db.saveBoxSettings({ days: cfg.days, categories: cfg.categories, prizes: cfg.prizes, initials: {} }); } catch (e) { code = e.code; }
      return { left: d.inventory.filter((x) => x.prizeId === 'bulldak').length, total: d.inventory.length, code };
    });
    assert.deepEqual(r, { left: 0, total: 12, code: 'NOT_SETUP' });
  });

  await step('saveBoxSettings：名前の整形・本数未定・初期本数（文字列でも）の変更で調整が 0 に戻る／抽選済みの日でも同じ値は通る／同じ内容は何も残さない／長い名前・不正な本数は BAD_REQUEST', async () => {
    await seedV2();
    const r = await inPage(async () => {
      const { db, err, dump } = window.__;
      const out = {};
      // 今の一覧に edit(input) で変更を混ぜて保存する（画面と同じ「一覧をまるごと」の入力）
      const input = async (edit) => {
        const cfg = await db.getConfig();
        const i = { days: cfg.days, categories: structuredClone(cfg.categories), prizes: structuredClone(cfg.prizes), initials: {} };
        edit?.(i);
        return i;
      };
      const save = async (edit) => db.saveBoxSettings(await input(edit));
      const row = (d, day, prize) => d.inventory.find((x) => x.key === `${day}:${prize}`);
      await db.adjustInventory('day2', 'greenland', 4, '追加');   // 2日目の greenland：初期 3・調整 +4・残数 7
      const adjusted = row(await dump(), 'day2', 'greenland');
      out.adjusted = [adjusted.initial, adjusted.remaining, adjusted.adjust];
      const saved = await save((i) => {
        i.categories.find((c) => c.id === 'sponsor').name = '  特別賞  ';
        Object.assign(i.prizes.find((p) => p.id === 'ezo'), { name: 'E・ZO 招待券', countUnknown: true });
        i.initials = { day2: { greenland: '9', 'sticker-ibaraki': 2 } };
      });
      out.cat = saved.categories.find((c) => c.id === 'sponsor').name;
      out.ezo = saved.prizes.find((p) => p.id === 'ezo');
      out.green = saved.prizes.find((p) => p.id === 'greenland').name;
      let d = await dump();
      out.rows = ['greenland', 'sticker-ibaraki'].map((p) => { const x = row(d, 'day2', p); return [p, x.initial, x.remaining, x.adjust]; });
      out.log = d.logs.find((l) => l.type === 'box-settings')?.detail;
      // 同じ内容の保存は、何も書かない（ログも残さない）
      const before = await dump();
      await save();
      const after = await dump();
      out.noop = JSON.stringify(before.inventory) === JSON.stringify(after.inventory) && before.logs.length === after.logs.length;
      // 抽選のあと
      await db.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } });
      out.drawnDay = await err(save((i) => { i.initials = { day1: { greenland: 9 } }; }));
      out.sameValue = await err(save((i) => { i.initials = { day1: { greenland: '3' } }; }));
      out.sameNumber = await err(save((i) => { i.initials = { day1: { greenland: 3 } }; }));
      out.emptyName = await err(save((i) => { i.prizes.find((p) => p.id === 'ezo').name = '  '; }));
      out.longName = await err(save((i) => { i.prizes.find((p) => p.id === 'ezo').name = 'あ'.repeat(61); }));
      out.longCat = await err(save((i) => { i.categories.find((c) => c.id === 'rare').name = 'あ'.repeat(41); }));
      out.maxName = await err(save((i) => { i.prizes.find((p) => p.id === 'ezo').name = 'あ'.repeat(60); i.categories.find((c) => c.id === 'rare').name = 'い'.repeat(40); }));
      out.badInit = await err(save((i) => { i.initials = { day2: { greenland: -1 } }; }));
      out.nanInit = await err(save((i) => { i.initials = { day2: { greenland: 'abc' } }; }));
      out.hugeInit = await err(save((i) => { i.initials = { day2: { greenland: 100001 } }; }));
      // 一覧に無い日・景品の本数は使わない（行も作らない）
      out.unknownIds = await err(save((i) => { i.initials = { day9: { greenland: 1 }, day2: { nope: 1 } }; }));
      d = await dump();
      out.keys = d.inventory.length;
      out.stray = d.inventory.some((x) => x.dayId === 'day9' || x.prizeId === 'nope');
      out.legacy = typeof db.savePrizeSettings;   // 画面から使われなくなった旧い入力は残していない
      return out;
    });
    assert.deepEqual(r.adjusted, [3, 7, 4], '（前提）調整済みの行');
    assert.equal(r.cat, '特別賞', '前後の空白は除く');
    assert.equal(r.ezo.name, 'E・ZO 招待券');
    assert.equal(r.ezo.countUnknown, true);
    assert.equal(r.green, 'グリーンランド招待券');
    assert.deepEqual(r.rows, [['greenland', 9, 9, 0], ['sticker-ibaraki', 2, 2, 0]], '初期本数を変えると残数も同じ値に・調整は 0 に戻る');
    assert.ok(Array.isArray(r.log) && r.log.some((c) => c.dayId === 'day2' && c.prizeId === 'greenland' && c.initial.from === 3 && c.initial.to === 9), JSON.stringify(r.log));
    assert.equal(r.noop, true, '同じ内容の保存は何も書かない');
    assert.deepEqual(
      [r.drawnDay, r.sameValue, r.sameNumber, r.emptyName, r.longName, r.longCat, r.maxName, r.badInit, r.nanInit, r.hugeInit, r.unknownIds],
      ['DAY_HAS_DRAWS', 'NO_ERROR', 'NO_ERROR', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'NO_ERROR', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'NO_ERROR'],
    );
    assert.equal(r.keys, 14);
    assert.equal(r.stray, false);
    assert.equal(r.legacy, 'undefined', 'savePrizeSettings は無い（景品・賞・日程の保存は saveBoxSettings だけ）');
  });

  await step('exportProfileFile → importProfile：抽選履歴があれば HAS_DRAWS（何も変えない）、無ければ作り直す（PIN・効果音は残る）', async () => {
    await seedV2((c) => { c.sound = { enabled: false, volume: 0.3 }; });
    const r = await inPage(async () => {
      const { db, err, dump, prof } = window.__;
      const out = {};
      const file = await db.exportProfileFile();
      out.fileKeys = Object.keys(file).sort();
      out.hasPin = JSON.stringify(file).includes('pinpin');
      out.hasSound = 'sound' in file.profile.config;
      // 別のイベントの設定ファイルに作り替える
      const other = structuredClone(file);
      other.profile.config = {
        ...other.profile.config, eventId: 'spring-fes', eventName: '春祭り',
        days: [{ id: 'day1', label: '当日' }, { id: 'day2', label: '二日目' }, { id: 'day3', label: '三日目' }],
        categories: [{ id: 'grand', name: '特賞', tier: 'sponsor', latin: 'GRAND' }, { id: 'basic', name: '参加賞', tier: 'sticker', latin: 'PRIZE' }],
        prizes: [{ id: 'g1', categoryId: 'grand', name: 'いい景品', countUnknown: false }, { id: 'b1', categoryId: 'basic', name: '参加の景品', countUnknown: true }],
        theme: { preset: 'sakura', custom: null }, motif: 'capsule',
      };
      other.profile.initials = { day1: { g1: 2, b1: 30 }, day2: { g1: 2, b1: 30 }, day3: { g1: 1, b1: 10 } };
      // 先に抽選しておく：履歴があれば読み込めない
      await db.setActiveDay('day2');
      const rec = await db.draw({ kind: 'student', studentId: '2412345' });
      await db.confirmDraw(rec.id);
      await db.markBackup(Date.now());
      const before = await dump();
      out.withDraws = await err(db.importProfile(other));
      const after = await dump();
      out.unchanged = JSON.stringify(before) === JSON.stringify(after);
      // 履歴を消して（本番リセット）から読み込む
      await db.productionReset();
      out.invalid = await err(db.importProfile({ ...other, kind: 'backup' }));
      out.invalidMsg = await db.importProfile({ ...other, profileVersion: 9 }).catch((e) => e.message);
      const cfg = await db.importProfile(other);
      const d = await dump();
      out.cfg = cfg;
      out.stored = d.meta.find((m) => m.key === 'config').value;
      out.meta = Object.fromEntries(d.meta.map((m) => [m.key, m.value]));
      out.inv = d.inventory.map((x) => [x.key, x.initial, x.remaining, x.adjust]).sort();
      out.students = d.students.length;
      out.draws = d.draws.length;
      out.log = d.logs.find((l) => l.type === 'profile-import');
      out.valid = JSON.stringify(prof.normalizeConfig(out.stored)) === JSON.stringify(out.stored);
      return out;
    });
    assert.deepEqual(r.fileKeys, ['app', 'exportedAt', 'kind', 'profile', 'profileVersion']);
    assert.equal(r.hasPin, false);
    assert.equal(r.hasSound, false);
    assert.equal(r.withDraws, 'HAS_DRAWS');
    assert.equal(r.unchanged, true, 'HAS_DRAWS のときは何も書かない');
    assert.equal(r.invalid, 'INVALID_PROFILE');
    assert.match(r.invalidMsg, /新しいバージョンの設定ファイルです/);
    assert.deepEqual(r.cfg, r.stored);
    assert.equal(r.stored.eventName, '春祭り');
    assert.equal(r.stored.pinHash, 'pinpin', '今の PIN は残る');
    assert.deepEqual(r.stored.sound, { enabled: false, volume: 0.3 }, '今の効果音の設定は残る');
    assert.equal(r.stored.theme.preset, 'sakura');
    assert.equal(r.stored.motif, 'capsule');
    assert.equal(r.meta.activeDayId, 'day1', '開催日は最初の日');
    assert.deepEqual(r.meta.drawSeq, {});
    assert.equal('pendingDrawId' in r.meta, false);
    assert.equal('lastBackupAt' in r.meta, false);
    assert.equal(r.meta.schemaVersion, 2);
    assert.deepEqual(r.inv, [['day1:b1', 30, 30, 0], ['day1:g1', 2, 2, 0], ['day2:b1', 30, 30, 0], ['day2:g1', 2, 2, 0], ['day3:b1', 10, 10, 0], ['day3:g1', 1, 1, 0]]);
    assert.equal(r.students, 0);
    assert.equal(r.draws, 0);
    assert.deepEqual(r.log.detail, { eventId: 'spring-fes', days: 3, prizes: 2 });
    assert.equal(r.valid, true);
  });

  await step('importProfile：config が無い（未セットアップ）なら NOT_SETUP', async () => {
    const code = await inPage(async () => {
      const { db, err, prof, cfgm } = window.__;
      await db.wipeAll();
      return err(db.importProfile(prof.exportProfile(cfgm.createDefaultConfig(), [])));
    });
    assert.equal(code, 'NOT_SETUP');
  });

  await step('exportAll：schemaVersion 2・config は v2 に正規化して入る（保存が v1 のままでも）', async () => {
    await seedV1();
    const r = await inPage(async () => {
      const { db, cfgm } = window.__;
      const b = await db.exportAll();
      return { b, def: { ...cfgm.createDefaultConfig(), pinHash: 'pinpin' }, v: db.validateBackup(b), keys: Object.keys(b).sort() };
    });
    assert.equal(r.b.app, 'yosoro-gacha');
    assert.equal(r.b.schemaVersion, 2);
    assert.deepEqual(r.keys, ['app', 'draws', 'exportedAt', 'inventory', 'logs', 'meta', 'schemaVersion', 'students']);
    assert.deepEqual(r.b.meta.find((m) => m.key === 'config').value, r.def);
    assert.equal(r.v.ok, true, r.v.error);
  });

  await step('importAll：v1 のバックアップを復元するとよーそろの v2 設定になる／v2 もそのまま／設定ファイルと v3 は拒否', async () => {
    const r = await inPage(async ({ v1 }) => {
      const { db, cfgm, dump, prof } = window.__;
      const out = {};
      const inv = [];
      const init = cfgm.createDefaultInitials();
      for (const d of v1.days) for (const p of v1.prizes) inv.push({ key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: init[d.id][p.id], remaining: init[d.id][p.id] });   // adjust なしの古い形
      const backupV1 = {
        app: 'yosoro-gacha', schemaVersion: 1, exportedAt: 123,
        meta: [{ key: 'config', value: v1 }, { key: 'activeDayId', value: 'day2' }, { key: 'migration:gamja-prize-name-v1', value: true }],
        inventory: inv, draws: [], students: [], logs: [{ id: 5, at: 1, type: 'x', detail: null }],
      };
      await db.wipeAll();
      out.summary = await db.importAll(backupV1);
      const d = await dump();
      out.stored = d.meta.find((m) => m.key === 'config').value;
      out.def = { ...cfgm.createDefaultConfig(), pinHash: 'pinpin' };
      out.schema = d.meta.find((m) => m.key === 'schemaVersion').value;
      out.active = d.meta.find((m) => m.key === 'activeDayId').value;
      out.lastBackup = d.meta.find((m) => m.key === 'lastBackupAt').value;
      out.adjust = d.inventory.every((x) => x.adjust === 0);
      out.flag = d.meta.find((m) => m.key === 'migration:gamja-prize-name-v1').value;
      // v2 のバックアップ（exportAll）を丸ごと往復
      const b2 = await db.exportAll();
      await db.importAll(b2);
      const d2 = await dump();
      out.roundTrip = JSON.stringify(d2.meta.find((m) => m.key === 'config').value) === JSON.stringify(out.stored);
      // 拒否
      out.profileFile = await db.importAll(prof.exportProfile(cfgm.createDefaultConfig(), [])).catch((e) => [e.code, e.message]);
      out.v3 = await db.importAll({ ...b2, schemaVersion: 3 }).catch((e) => [e.code, e.message]);
      out.unchanged = JSON.stringify((await dump()).meta.find((m) => m.key === 'config').value) === JSON.stringify(out.stored);
      return out;
    }, { v1: v1Config() });
    assert.deepEqual(r.summary, { exportedAt: 123, draws: 0, students: 0, pending: null });
    assert.deepEqual(r.stored, r.def, 'v1 のバックアップ → よーそろの設定');
    assert.equal(r.stored.schemaVersion, 2);
    assert.equal(r.schema, 2);
    assert.equal(r.active, 'day2');
    assert.equal(r.lastBackup, 123);
    assert.equal(r.adjust, true);
    assert.equal(r.flag, true);
    assert.equal(r.roundTrip, true);
    assert.equal(r.profileFile[0], 'INVALID_BACKUP');
    assert.match(r.profileFile[1], /これは設定ファイルです（バックアップではありません）。「設定ファイルを読み込む」から読み込んでください/);
    assert.equal(r.v3[0], 'INVALID_BACKUP');
    assert.match(r.v3[1], /新しいバージョンのバックアップです。アプリを更新してください/);
    assert.equal(r.unchanged, true, '拒否したときは何も書かない');
  });

  await step('initialize / saveConfig：正規化（v2）して保存する', async () => {
    const r = await inPage(async () => {
      const { db, cfgm, dump } = window.__;
      await db.wipeAll();
      const v1ish = { ...cfgm.createDefaultConfig(), schemaVersion: 1, pinHash: 'p', foo: 'bar', eventName: '  電波祭2026  ' };
      delete v1ish.brand; delete v1ish.survey;
      await db.initialize({ config: v1ish, activeDayId: 'day1', initials: cfgm.createDefaultInitials() });
      const a = (await dump()).meta.find((m) => m.key === 'config').value;
      await db.saveConfig({ ...a, motif: 'sakura', extra: 1, sound: { enabled: false, volume: 9 } }, 'config-test', { x: 1 });
      const d = await dump();
      return { a, b: d.meta.find((m) => m.key === 'config').value, log: d.logs.find((l) => l.type === 'config-test'), schema: d.meta.find((m) => m.key === 'schemaVersion').value, inv: d.inventory.length };
    });
    assert.equal(r.a.schemaVersion, 2);
    assert.equal(r.a.eventName, '電波祭2026');
    assert.equal('foo' in r.a, false);
    assert.equal(r.a.brand.name, 'よーそろがちゃ');
    assert.equal(r.b.motif, 'sakura');
    assert.equal('extra' in r.b, false);
    assert.deepEqual(r.b.sound, { enabled: false, volume: 1 });
    assert.deepEqual(r.log.detail, { x: 1 });
    assert.equal(r.schema, 2);
    assert.equal(r.inv, 14);
  });

  await step('saveConfig：開催日・賞・景品は保存済みのまま（渡された config では変わらない）／v1 の賞の欧文も変わらない／未保存なら渡された config を保存', async () => {
    await seedV1();
    const r = await inPage(async () => {
      const { db, prof, dump } = window.__;
      const before = await dump();
      const kept = prof.normalizeConfig(before.meta.find((m) => m.key === 'config').value);   // 生の v1 を正規化したもの（保存済みの箱の構造）
      const cfg = await db.getConfig();
      // 画面から来た config が箱の構造を書き換えていても、保存されるのは設定の変更だけ
      cfg.motif = 'sakura';
      cfg.sound = { enabled: false, volume: 0.2 };
      cfg.days = [{ id: 'day1', label: '改' }, { id: 'day9', label: '別の日' }];
      cfg.categories = [{ id: 'x', name: '別の賞', tier: 'rare', latin: 'X' }];
      cfg.prizes = [{ id: 'y', categoryId: 'x', name: '別の景品', countUnknown: false }];
      await db.saveConfig(cfg, 'config-test', null);
      const after = await dump();
      return {
        kept, stored: after.meta.find((m) => m.key === 'config').value,
        inventoryUnchanged: JSON.stringify(after.inventory) === JSON.stringify(before.inventory),
        logged: after.logs.some((l) => l.type === 'config-test'),
      };
    });
    assert.deepEqual(r.stored.days, r.kept.days);
    assert.deepEqual(r.stored.categories, r.kept.categories);
    assert.deepEqual(r.stored.prizes, r.kept.prizes);
    assert.deepEqual(r.stored.categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER'], 'v1 の賞の欧文が SPECIAL PRIZE … に変わらない');
    assert.equal(r.stored.motif, 'sakura');
    assert.deepEqual(r.stored.sound, { enabled: false, volume: 0.2 });
    assert.equal(r.stored.schemaVersion, 2, '保存で v2 になる');
    assert.equal(r.inventoryUnchanged, true);
    assert.equal(r.logged, true);
    // 何も保存されていなければ、渡された config をそのまま（正規化して）保存する
    const fresh = await inPage(async () => {
      const { db, cfgm, dump } = window.__;
      await db.wipeAll();
      await db.saveConfig({ ...cfgm.createDefaultConfig(), eventName: '新しいイベント', pinHash: 'p', days: [{ id: 'day1', label: '当日' }] }, 'config-test', null);
      return (await dump()).meta.find((m) => m.key === 'config').value;
    });
    assert.equal(fresh.eventName, '新しいイベント');
    assert.equal(fresh.pinHash, 'p');
    assert.deepEqual(fresh.days, [{ id: 'day1', label: '当日' }]);
    assert.equal(fresh.schemaVersion, 2);
  });

  await step('migrateGamjaPrizeName：生の v1 でも v2 でも、旧名だけを一度だけ更新する（E2E と同じ期待）', async () => {
    const r = await inPage(async ({ v1 }) => {
      const { db, dump, putRaw, delRaw, cfgm } = window.__;
      const out = {};
      // 生の v1（旧名）
      await db.wipeAll();
      const old = structuredClone(v1);
      old.prizes.find((p) => p.id === 'bulldak').name = 'ブルダック炒め麺';
      await putRaw('meta', { key: 'config', value: old });
      out.first = await db.migrateGamjaPrizeName();
      let d = await dump();
      const raw = d.meta.find((m) => m.key === 'config').value;
      out.rawName = raw.prizes.find((p) => p.id === 'bulldak').name;
      out.rawVersion = raw.schemaVersion;
      out.flag = d.meta.find((m) => m.key === 'migration:gamja-prize-name-v1')?.value;
      out.log = d.logs.filter((l) => l.type === 'prize-name-migration').length;
      out.viaGet = (await db.getConfig()).prizes.find((p) => p.id === 'bulldak').name;
      // 2 回目は何もしない。名前を旧名に戻しても上書きしない
      const again = await db.migrateGamjaPrizeName();
      raw.prizes.find((p) => p.id === 'bulldak').name = 'ブルダック炒め麺';
      await putRaw('meta', { key: 'config', value: raw });
      const third = await db.migrateGamjaPrizeName();
      out.again = [again, third];
      out.stays = (await dump()).meta.find((m) => m.key === 'config').value.prizes.find((p) => p.id === 'bulldak').name;
      // v2 の保存データでも（initialize が移行済みの印を付けるようになる前に作られた旧い端末を再現するため、印を消す）
      await db.wipeAll();
      const cfg = cfgm.createDefaultConfig(); cfg.pinHash = 'p';
      await db.initialize({ config: cfg, activeDayId: 'day1', initials: cfgm.createDefaultInitials() });
      await delRaw('meta', 'migration:gamja-prize-name-v1');
      const stored = (await dump()).meta.find((m) => m.key === 'config').value;
      stored.prizes.find((p) => p.id === 'bulldak').name = 'ブルダック炒め麺';
      await putRaw('meta', { key: 'config', value: stored });
      out.v2first = await db.migrateGamjaPrizeName();
      d = await dump();
      out.v2 = d.meta.find((m) => m.key === 'config').value;
      return out;
    }, { v1: v1Config() });
    assert.equal(r.first, true);
    assert.equal(r.rawName, 'カムジャ麺');
    assert.equal(r.rawVersion, 1, '移行は生の config をそのまま書き換える');
    assert.equal(r.flag, true);
    assert.equal(r.log, 1);
    assert.equal(r.viaGet, 'カムジャ麺');
    assert.deepEqual(r.again, [false, false]);
    assert.equal(r.stays, 'ブルダック炒め麺');
    assert.equal(r.v2first, true);
    assert.equal(r.v2.prizes.find((p) => p.id === 'bulldak').name, 'カムジャ麺');
    assert.equal(r.v2.schemaVersion, 2);
  });

  await step('initialize / importProfile は「名称移行済み」の印を付ける：旧名称（ブルダック炒め麺）を使う新しい設定を、移行で書き換えない／importAll は印がバックアップのまま', async () => {
    const r = await inPage(async () => {
      const { db, dump, delRaw, cfgm, prof } = window.__;
      const FLAG = 'migration:gamja-prize-name-v1';
      const OLD = 'ブルダック炒め麺';
      const out = {};
      const nameOf = async () => (await db.getConfig()).prizes.find((p) => p.id === 'bulldak').name;
      const flagOf = async () => (await dump()).meta.find((m) => m.key === FLAG)?.value ?? null;
      const migrationLogs = async () => (await dump()).logs.filter((l) => l.type === 'prize-name-migration').length;
      const fresh = () => { const c = cfgm.createDefaultConfig(); c.pinHash = 'p'; return c; };
      // (a) initialize：新しいイベントが、あえて旧名称を使う
      await db.wipeAll();
      const cfg = fresh();
      cfg.prizes.find((p) => p.id === 'bulldak').name = OLD;
      await db.initialize({ config: cfg, activeDayId: 'day1', initials: cfgm.createDefaultInitials() });
      out.init = { flag: await flagOf(), migrated: await db.migrateGamjaPrizeName(), name: await nameOf(), logs: await migrationLogs() };
      // (b) importProfile：印が付く前の旧い端末に、旧名称を使う設定ファイルを読み込む
      const file = prof.exportProfile(cfg, []);
      await db.wipeAll();
      await db.initialize({ config: fresh(), activeDayId: 'day1', initials: cfgm.createDefaultInitials() });
      await delRaw('meta', FLAG);
      out.legacy = await flagOf();
      await db.importProfile(file);
      out.import = { flag: await flagOf(), migrated: await db.migrateGamjaPrizeName(), name: await nameOf(), logs: await migrationLogs() };
      // (c) importAll：印はバックアップの meta のまま（印が無ければ付かず、旧名称は移行される。印が true なら移行されない）
      const backup = async (flagged) => {
        const b = await db.exportAll();
        b.meta = b.meta.filter((m) => m.key !== FLAG).map((m) => (m.key === 'config'
          ? { key: 'config', value: { ...m.value, prizes: m.value.prizes.map((p) => (p.id === 'bulldak' ? { ...p, name: OLD } : p)) } } : m));
        if (flagged) b.meta.push({ key: FLAG, value: true });
        return b;
      };
      await db.importAll(await backup(false));
      out.restoredNoFlag = { flag: await flagOf(), name: await nameOf() };
      out.noFlag = { migrated: await db.migrateGamjaPrizeName(), name: await nameOf(), flag: await flagOf() };
      await db.importAll(await backup(true));
      out.withFlag = { flag: await flagOf(), migrated: await db.migrateGamjaPrizeName(), name: await nameOf() };
      return out;
    });
    assert.deepEqual(r.init, { flag: true, migrated: false, name: 'ブルダック炒め麺', logs: 0 }, 'initialize：旧名称のまま・移行のログなし');
    assert.equal(r.legacy, null, '（前提）印の無い旧い端末');
    assert.deepEqual(r.import, { flag: true, migrated: false, name: 'ブルダック炒め麺', logs: 0 }, 'importProfile：印が付き、旧名称のまま');
    assert.deepEqual(r.restoredNoFlag, { flag: null, name: 'ブルダック炒め麺' }, 'importAll：印の無いバックアップは印が付かない');
    assert.deepEqual(r.noFlag, { migrated: true, name: 'カムジャ麺', flag: true }, '印の無いバックアップ（旧い端末のもの）は、今までどおり一度だけ移行される');
    assert.deepEqual(r.withFlag, { flag: true, migrated: false, name: 'ブルダック炒め麺' }, '印の付いたバックアップは移行されない');
  });

  await step('在庫の調整・日の切替・本番リセット・全初期化は今までどおり（v1 の保存データ）', async () => {
    await seedV1();
    const r = await inPage(async () => {
      const { db, dump, err } = window.__;
      const out = {};
      out.adjust = (await db.adjustInventory('day1', 'greenland', 2, '追加')).remaining;
      out.neg = await err(db.adjustInventory('day1', 'greenland', -99, 'x'));
      await db.setActiveDay('day2');
      out.badDay = await err(db.setActiveDay('day9'));
      const rec = await db.draw({ kind: 'student', studentId: '１２３４５６７' });
      out.label = rec.label;
      out.pending = (await db.getPendingDraw()).id;
      out.total = await db.getBoxTotal('day2');
      out.dupe = await err(db.draw({ kind: 'student', studentId: '1234567' }));
      await db.confirmDraw(rec.id);
      out.dupe2 = await err(db.draw({ kind: 'student', studentId: '1234567' }));
      out.badId = await err(db.draw({ kind: 'student', studentId: '12' }));
      await db.productionReset();
      const d = await dump();
      out.afterReset = [d.draws.length, d.students.length, d.inventory.every((x) => x.remaining === x.initial), d.meta.find((m) => m.key === 'config').value.schemaVersion];
      await db.wipeAll();
      out.afterWipe = await db.getConfig();
      return out;
    });
    assert.equal(r.adjust, 5);
    assert.equal(r.neg, 'NEGATIVE');
    assert.equal(r.badDay, 'BAD_REQUEST');
    assert.equal(r.label, '2-0001');
    assert.equal(r.pending, '2-0001');
    assert.equal(r.total, 50 + 3 + 3 + 25 + 100 - 1);
    assert.equal(r.dupe, 'PENDING_EXISTS');
    assert.equal(r.dupe2, 'ALREADY_USED');
    assert.equal(r.badId, 'INVALID_STUDENT');
    assert.deepEqual(r.afterReset, [0, 0, true, 1]);
    assert.equal(r.afterWipe, null);
  });

  await step('JS エラーがない', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
