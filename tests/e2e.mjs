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
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.E2E_ROOT || path.join(HERE, '..'));
const PIN = '1234';
// 選択肢（アンケート）は config.js のデータをそのまま期待値に使う（ラベルを直しても追従する）
const CFG = await import(pathToFileURL(path.join(ROOT, 'js/config.js')).href);
const AGE_LABEL = Object.fromEntries(CFG.SURVEY_AGES.map((a) => [a.id, a.label]));
const TRIG_LABEL = Object.fromEntries(CFG.SURVEY_TRIGGERS.map((t) => [t.id, t.label]));

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
  draws: sortBy(d.draws, 'id').map((x) => [x.id, x.prizeId, x.confirmedAt ? 1 : 0, x.studentId ?? null, x.survey ? JSON.stringify(x.survey) : null]),
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
  if (rec.kind === 'guest') {
    // 直前に答えたアンケートが、同じ抽選レコードに選択肢の並び順＋ラベルつきで保存されている
    assert.ok(lastSurvey, 'アンケートに答えてから抽選している');
    const want = CFG.SURVEY_TRIGGERS.map((t) => t.id).filter((id) => lastSurvey.triggers.includes(id));
    assert.deepEqual(rec.survey, {
      v: 1, age: lastSurvey.age, triggers: want,
      ageLabel: AGE_LABEL[lastSurvey.age], triggerLabels: want.map((id) => TRIG_LABEL[id]),
    });
    surveyLog.push({ ...lastSurvey, triggers: want, dayId: rec.dayId });
  } else {
    assert.ok(!('survey' in rec), '学生の抽選に survey は付かない');
  }
  return rec;
}

async function confirmResult() {
  await longPressOk();
  await page.waitForSelector(tid('ok-button'), { state: 'detached', timeout: 10000 });
}

// 一般の方：区分選択 → アンケート（Q1 年齢 → Q2 きっかけ）→ 舵輪の手前まで
const ANSWERS = [
  ['college', ['sns', 'referral']], ['age-40s', ['annual']], ['elementary', ['poster', 'website', 'event-interest']],
  ['age-40s', ['sns', 'kosen-interest']], ['high-school', ['other']], ['age-60plus', ['website']],
];
let answerNo = 0;
let lastSurvey = null;       // 直前の startGuest で答えた内容（期待値）
const surveyLog = [];        // 保存に成功した一般の抽選の回答（アンケートタブの期待値用。DB とは独立に数える）
async function startGuest(answer = ANSWERS[answerNo++ % ANSWERS.length]) {
  await waitScreen('choose');
  await page.click(tid('choose-guest'));
  await waitScreen('survey-age');
  await page.click(tid(`age-${answer[0]}`));          // 選ぶと約250ms後に Q2 へ自動で進む
  await waitScreen('survey-trigger');
  for (const t of answer[1]) await page.click(tid(`trigger-${t}`));
  await page.click(tid('survey-next'));
  lastSurvey = { age: answer[0], triggers: answer[1] };
}
const checked = (id) => page.getAttribute(tid(id), 'aria-checked');
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
  page.on('console', (m) => { const t = m.text(); if (/2412345|2454321|2499999/.test(t)) errors.push(`student id leaked to console: ${t}`); });
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

    // 既設端末を再現し、更新後の起動で表示名だけが変わり在庫キーは残ることを確認。
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('yosoro-gacha');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        const store = tx.objectStore('meta');
        const configReq = store.get('config');
        configReq.onsuccess = () => {
          const config = configReq.result.value;
          config.prizes.find((p) => p.id === 'bulldak').name = 'ブルダック炒め麺';
          store.put({ key: 'config', value: config });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    const inventoryBeforeMigration = invSummary(d);
    await page.reload();
    await waitScreen('choose');
    const migrated = await dumpDb();
    const migratedConfig = metaVal(migrated, 'config');
    assert.equal(migratedConfig.prizes.find((p) => p.id === 'bulldak').name, 'カムジャ麺');
    assert.deepEqual(invSummary(migrated), inventoryBeforeMigration, '在庫と prizeId は維持される');
    assert.ok(migrated.logs.some((l) => l.type === 'prize-name-migration'), '名称変更がログに残る');
  });

  await step('プレイヤー画面に残数・確率が出ない', async () => {
    const txt = await page.textContent('body');
    assert.ok(!/残り|残数|確率|%/.test(await page.textContent('#panel')), 'panel に残数/確率なし');
    assert.ok(!txt.includes('6本'));
  });

  await step('アンケート：Q1→Q2、必須・自動で進む・戻ると回答が残る・戻っても何も保存されない', async () => {
    await waitScreen('choose');
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    const q1 = await page.textContent(tid('screen-survey-age'));
    assert.ok(q1.includes('Q1. 年齢を教えてください') && q1.includes('アンケート 1/2'), `Q1 の見出しと段階表示: ${q1.slice(0, 80)}`);
    assert.ok(q1.includes('回答は個人が分からない形で集計し、電波祭の運営と協賛企業への来場者層の説明に使います。'), '集計の注意書き');
    assert.equal(await page.locator('.chip').count(), CFG.SURVEY_AGES.length);
    assert.deepEqual(await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent)), CFG.SURVEY_AGES.map((a) => a.label), '選択肢は config の順');
    assert.equal(await page.locator('input, textarea').count(), 0, '氏名・連絡先・自由記述の欄はない');
    assert.equal(await page.locator(tid('survey-next')).count(), 0, 'Q1 に「次へ」はない（選ぶと自動で進む）');
    // タップした瞬間は「選んだ」表示で Q1 に留まり、少し待って Q2 へ（同じ tick で確認する）
    const instant = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="age-age-30s"]');
      c.click();
      return { checked: c.getAttribute('aria-checked'), on: c.classList.contains('on'), still: !!document.querySelector('[data-testid="screen-survey-age"]'), mark: !!c.querySelector('.ck') };
    });
    assert.deepEqual(instant, { checked: 'true', on: true, still: true, mark: true }, '選択は反転＋✓で示され、すぐには遷移しない');
    await waitScreen('survey-trigger');
    const q2 = await page.textContent(tid('screen-survey-trigger'));
    assert.ok(q2.includes('電波祭に来場したきっかけを教えてください。') && q2.includes('（複数選択可）') && q2.includes('アンケート 2/2'), 'Q2 の見出しと段階表示');
    assert.ok(q2.includes('次へ（舵輪へ）') && q2.includes('回答は個人が分からない形で集計し'), '次へボタンと注意書き');
    assert.deepEqual(await page.$$eval('.chip .lb', (els) => els.map((e) => e.textContent)), CFG.SURVEY_TRIGGERS.map((t) => t.label));
    // 必須：0件では「次へ」が押せない（押しても進まない）
    assert.equal(await page.locator(tid('survey-next')).isDisabled(), true, '0件では次へ無効');
    await page.locator(tid('survey-next')).click({ force: true, timeout: 1000 }).catch(() => {});
    assert.ok(await page.locator(tid('screen-survey-trigger')).isVisible(), '0件のまま進めない');
    // 複数選択：トグル。1件以上で有効
    await page.click(tid('trigger-sns'));
    assert.equal(await page.locator(tid('survey-next')).isDisabled(), false);
    await page.click(tid('trigger-sns'));
    assert.equal(await checked('trigger-sns'), 'false');
    assert.equal(await page.locator(tid('survey-next')).isDisabled(), true, '全部外すとまた無効');
    await page.click(tid('trigger-referral'));
    await page.click(tid('trigger-website'));
    assert.deepEqual([await checked('trigger-referral'), await checked('trigger-website'), await checked('trigger-sns')], ['true', 'true', 'false']);
    // 戻る → Q1 に回答（30代）が残る → もう一度選ぶと Q2 へ、Q2 の選択も残っている
    await page.click(tid('back'));
    await waitScreen('survey-age');
    assert.equal(await checked('age-age-30s'), 'true', '戻っても Q1 の回答が残る');
    assert.equal(await page.locator('.chip.on').count(), 1);
    await page.click(tid('age-age-30s'));
    await waitScreen('survey-trigger');
    assert.deepEqual([await checked('trigger-referral'), await checked('trigger-website')], ['true', 'true'], 'Q2 の選択も残る');
    // 舵輪から戻ると Q2（回答は残る）
    await page.click(tid('survey-next'));
    await waitScreen('wheel');
    await page.click(tid('back'));
    await waitScreen('survey-trigger');
    assert.equal(await checked('trigger-referral'), 'true');
    // Q2 → Q1 → 区分選択まで戻る。何も保存されず、次の人には回答が残らない
    await page.click(tid('back'));
    await waitScreen('survey-age');
    await page.click(tid('back'));
    await waitScreen('choose');
    let d = await dumpDb();
    assert.equal(d.draws.length, 0, '途中でやめても抽選は作られない');
    assert.ok(d.inventory.filter((r) => r.dayId === 'day1').every((r) => r.remaining === r.initial), '在庫は減らない');
    assert.ok(!JSON.stringify(d).includes('age-30s'), '回答は DB のどこにも書かれていない');
    await page.click(tid('choose-guest'));
    await waitScreen('survey-age');
    assert.equal(await page.locator('.chip.on').count(), 0, '前の人の回答は消えている');
    await page.click(tid('back'));
    await waitScreen('choose');
  });

  await step('アンケートの寸法：1180×820・1024×768・820×1180 で全選択肢が収まる（チップ・ボタンは64px以上、重なりなし）', async () => {
    const sizes = [[1180, 820], [1024, 768], [820, 1180]];
    try {
      await waitScreen('choose');
      await page.click(tid('choose-guest'));
      await waitScreen('survey-age');
      for (const [w, h] of sizes) {
        await page.setViewportSize({ width: w, height: h });
        await sleep(150);
        for (const screen of ['age', 'trigger']) {
          if (screen === 'trigger' && (await page.locator(tid('screen-survey-age')).count())) { await page.click(tid(`age-${CFG.SURVEY_AGES[0].id}`)); await waitScreen('survey-trigger'); await sleep(150); }
          const r = await page.evaluate(() => {
            const vw = innerWidth; const vh = innerHeight; const bad = [];
            const boxes = [...document.querySelectorAll('.chip, .sv-foot > *, .sv-h, .sv-step')].map((el) => ({ el, r: el.getBoundingClientRect() }));
            for (const { el, r } of boxes) {
              const name = el.className || el.tagName;
              if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) bad.push(`out:${name}`);
              if (el.classList.contains('chip')) {
                const lb = el.querySelector('.lb');
                if (lb.scrollWidth > lb.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) bad.push(`clip:${el.dataset.id}`);
              }
              if ((el.classList.contains('chip') || el.classList.contains('sv-next') || el.classList.contains('back')) && r.height < 63.5) bad.push(`short:${name}:${r.height}`);
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
            return { bad, n: chips.length, scroll: document.documentElement.scrollHeight > vh + 1 };
          });
          assert.deepEqual(r.bad, [], `${w}x${h} ${screen}: ${r.bad.join(', ')}`);
          assert.equal(r.n, screen === 'age' ? CFG.SURVEY_AGES.length : CFG.SURVEY_TRIGGERS.length);
          assert.equal(r.scroll, false, `${w}x${h} ${screen}: スクロールが必要`);
        }
        // 次のサイズは Q1 から測り直す
        await page.click(tid('back'));
        await waitScreen('survey-age');
      }
    } finally {
      await page.setViewportSize({ width: 1180, height: 820 });
      await sleep(150);
      if (await page.locator(tid('screen-survey-age')).count()) { await page.click(tid('back')); }
      await waitScreen('choose');
    }
  });

  await step('アンケートの検証（DB 層）：一般は survey 必須・不正は拒否・学生は survey を持てない', async () => {
    const out = await page.evaluate(async () => {
      const m = await import('./js/db.js');
      const ok = { v: 1, age: 'age-20s', triggers: ['sns'] };
      const cases = {
        'guest/no-survey': { kind: 'guest' },
        'guest/bad-age': { kind: 'guest', survey: { ...ok, age: 'nope' } },
        'guest/no-triggers': { kind: 'guest', survey: { ...ok, triggers: [] } },
        'guest/bad-trigger': { kind: 'guest', survey: { ...ok, triggers: ['nope'] } },
        'guest/dup-trigger': { kind: 'guest', survey: { ...ok, triggers: ['sns', 'sns'] } },
        'student/with-survey': { kind: 'student', studentId: '2499999', survey: ok },
      };
      const res = {};
      for (const [k, args] of Object.entries(cases)) { try { await m.draw(args); res[k] = 'NO_ERROR'; } catch (e) { res[k] = e.code; } }
      return res;
    });
    for (const [k, v] of Object.entries(out)) assert.equal(v, 'BAD_REQUEST', k);
    const d = await dumpDb();
    assert.equal(d.draws.length, 0);
    assert.equal(d.students.length, 0, '拒否された学生は参加済みにならない');
    assert.equal(metaVal(d, 'pendingDrawId'), undefined);
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
    assert.equal(rec.survey.ageLabel, '大学生・専門学生');
    assert.deepEqual(rec.survey.triggerLabels, ['家族・友人・知人からの紹介', 'SNS（Instagram・Xなど）'], '選択肢の順でラベルが保存される');
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
    assert.equal(await page.locator('[data-testid^="screen-survey"]').count(), 0, '学生にアンケートは出ない');
    await pressKeys('tenkey', '241');
    await page.click(tid('tenkey-ok'));
    assert.ok((await page.textContent(tid('student-error'))).includes('入力してください'), '桁数不足のエラー');
    await pressKeys('tenkey', '2345');
    await page.click(tid('tenkey-ok'));
    assert.equal(await page.locator('[data-testid^="screen-survey"]').count(), 0, '学籍番号のあとも舵輪へ直行（アンケートなし）');
    const rec = await spinAndWaitResult();
    assert.equal(rec.label, '1-0002');
    assert.equal(rec.kind, 'student');
    assert.equal('survey' in rec, false, '学生の抽選レコードに survey がない');
    await confirmResult();
    await waitScreen('choose');
    const d = await dumpDb();
    assert.deepEqual(d.students.map((s) => [s.studentId, s.drawId]), [['2412345', '1-0002']]);
  });

  await step('同じ学籍番号はリロード後も拒否される（抽選は増えない）', async () => {
    await page.reload();
    await startStudent('2412345');
    await page.waitForFunction(() => document.querySelector('[data-testid="student-error"]')?.textContent.includes('参加済み'));
    assert.ok(!(await page.locator(tid('screen-wheel')).count()), '舵輪画面へ進まない');
    const d = await dumpDb();
    assert.equal(d.draws.length, 2);
    await page.click(tid('back'));
    await waitScreen('choose');
  });

  await step('学籍番号を入れて戻っても「参加済み」にならない', async () => {
    await startStudent('2454321');
    await waitScreen('wheel');
    await page.click(tid('back'));
    await waitScreen('choose');
    const d = await dumpDb();
    assert.ok(!d.students.some((s) => s.studentId === '2454321'));
    assert.equal(d.draws.length, 2);
  });

  await step('連打・同時発火でも抽選は1回だけ／未確認中は新規抽選不可', async () => {
    await startStudent('2454321');
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
    assert.equal(d.students.filter((s) => s.studentId === '2454321').length, 1);
    assert.equal(d.inventory.find((r) => r.key === 'day1:sticker-denpasai').remaining, 3);
    // DB 層でも二重抽選を拒否
    const codes = await page.evaluate(async () => {
      const m = await import('./js/db.js');
      const out = [];
      for (const args of [{ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } }, { kind: 'student', studentId: '2499999' }]) {
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
    assert.ok(txt.includes('＊＊＊＊＊45') && !txt.includes('2412345'), '学籍番号は末尾2桁以外を伏せる');
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

  await step('survey なしの旧バックアップも復元できる（未回答として扱われる）', async () => {
    const legacy = JSON.parse(JSON.stringify(backupA));
    assert.ok(legacy.draws.some((x) => x.survey), 'バックアップには survey が入っている');
    for (const x of legacy.draws) delete x.survey;
    const legacyFile = path.join(downloadDir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify(legacy));
    await openAdmin('data');
    await page.setInputFiles(tid('restore-file'), legacyFile);
    await page.click(tid('dlg-ok'));
    await page.waitForFunction(() => document.querySelector('[data-testid="toast"]')?.textContent.includes('復元しました'));
    await closeAdmin();
    await page.waitForSelector(tid('ok-button'));
    const d = await dumpDb();
    assert.ok(d.draws.every((x) => !('survey' in x)), '旧バックアップの抽選に survey はない');
    surveyLog.length = 0;           // 1-0001 は「未回答」になった
    await openAdmin('survey');
    const t = await page.textContent(tid('tab-survey'));
    assert.ok(t.includes('一般の抽選1') && t.includes('回答あり0') && t.includes('未回答1'), `旧データは未回答: ${t.slice(0, 200)}`);
    await closeAdmin();
    await confirmResult();
    await waitScreen('choose');
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
      try { await m.draw({ kind: 'guest', survey: { v: 1, age: 'age-20s', triggers: ['sns'] } }); return 'NO_ERROR'; } catch (e) { return e.code; }
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
    await startStudent('2412345');
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

  await step('アンケートタブ：件数・割合・クロス集計が一般の抽選の回答と一致（全日程／日別）', async () => {
    const d = await dumpDb();
    const guests = d.draws.filter((x) => x.kind === 'guest');
    assert.equal(surveyLog.length, guests.filter((x) => x.survey).length, '保存された回答の数 = 答えた数');
    assert.ok(surveyLog.some((x) => x.dayId === 'day1') && surveyLog.some((x) => x.dayId === 'day2'), '両日にまたがるデータ');
    await openAdmin('survey');
    const num = async (id) => Number(await page.textContent(`${tid(id)} b`));
    const check = async (scope, rows, unanswered) => {
      const answered = rows.length;
      assert.equal(await num('sv-answered'), answered, `${scope} 回答あり`);
      assert.equal(await num('sv-unanswered'), unanswered, `${scope} 未回答`);
      assert.equal(await num('sv-total'), answered + unanswered, `${scope} 一般の抽選`);
      for (const a of CFG.SURVEY_AGES) {
        const n = rows.filter((r) => r.age === a.id).length;
        assert.equal(await page.getAttribute(tid(`sv-age-${a.id}`), 'data-count'), String(n), `${scope} 年齢 ${a.label}`);
        const txt = await page.textContent(tid(`sv-age-${a.id}`));
        const p = answered ? (Math.round((n / answered) * 1000) / 10).toFixed(1) : '0.0';
        assert.ok(txt.includes(a.label) && txt.includes(`${p}%`), `${scope} ${a.label} の割合 ${p}%: ${txt}`);
      }
      for (const t of CFG.SURVEY_TRIGGERS) {
        const n = rows.filter((r) => r.triggers.includes(t.id)).length;
        assert.equal(await page.getAttribute(tid(`sv-trig-${t.id}`), 'data-count'), String(n), `${scope} きっかけ ${t.label}`);
        for (const a of CFG.SURVEY_AGES) {
          const c = rows.filter((r) => r.age === a.id && r.triggers.includes(t.id)).length;
          assert.equal(await page.textContent(tid(`sv-cross-${a.id}-${t.id}`)), String(c), `${scope} クロス ${a.label}×${t.label}`);
        }
      }
    };
    const day1 = surveyLog.filter((r) => r.dayId === 'day1');
    const day2 = surveyLog.filter((r) => r.dayId === 'day2');
    await check('全日程', surveyLog, 1);          // 未回答 1 件 = 旧バックアップから復元した 1-0001
    await page.click(tid('sv-scope-day1'));
    await check('1日目', day1, 1);
    await page.click(tid('sv-scope-day2'));
    await check('2日目', day2, 0);
    // 学生は集計に入らない
    assert.ok(d.draws.some((x) => x.kind === 'student'));
    await page.click(tid('sv-scope-all'));
    // 集計CSV
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(tid('sv-csv'))]);
    const csvPath = path.join(downloadDir, 'survey.csv');
    await dl.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.ok(csv.startsWith('\uFEFF'), 'BOM つき（Excel で文字化けしない）');
    assert.ok(csv.includes('Q1 年齢') && csv.includes('Q2 きっかけ') && csv.includes('年齢 × きっかけ（人数）'));
    const ageRow = csv.split('\r\n').find((l) => l.startsWith('40代,'));
    assert.equal(ageRow.split(',')[1], String(surveyLog.filter((r) => r.age === 'age-40s').length), 'CSV の 40代 の人数');
    await closeAdmin();
  });

  await step('履歴CSV（確認用）に 年齢・きっかけ の列が入る（一般のみ・／区切り）', async () => {
    await openAdmin('data');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(tid('csv-masked'))]);
    const csvPath = path.join(downloadDir, 'draws.csv');
    await dl.saveAs(csvPath);
    const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split('\r\n');
    const head = lines[0].split(',');
    assert.deepEqual(head.slice(-2), ['年齢', 'きっかけ']);
    const d = await dumpDb();
    const row = (label) => lines.find((l) => l.startsWith(`${label},`));
    const withSv = d.draws.find((x) => x.kind === 'guest' && x.survey && x.survey.triggers.length > 1);
    const r1 = row(withSv.label);
    assert.ok(r1.includes(`,${withSv.survey.ageLabel},`) && r1.includes(withSv.survey.triggerLabels.join('／')), `回答つきの行: ${r1}`);
    const noSv = d.draws.find((x) => x.kind === 'guest' && !x.survey);
    assert.ok(row(noSv.label).endsWith('未回答,未回答'), '旧データは未回答');
    const stu = d.draws.find((x) => x.kind === 'student');
    assert.ok(row(stu.label).endsWith(',,'), '学生は空欄');
    await closeAdmin();
  });

  await step('アンケートの放置でも待機に戻る（アイドル）／操作中は戻らない', async () => {
    // 90秒は待てないので、サービスワーカー無しの別コンテキストで config.js の IDLE_RESET_MS だけ 1.2 秒に差し替える
    const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
    const p2 = await ctx2.newPage();
    try {
      await p2.route('**/js/config.js', async (route) => {
        const resp = await route.fetch();
        const body = (await resp.text()).replace(/IDLE_RESET_MS = 90 \* 1000/, 'IDLE_RESET_MS = 1200');
        assert.ok(body.includes('IDLE_RESET_MS = 1200'), 'config.js の差し替えに失敗');
        await route.fulfill({ response: resp, body });
      });
      await p2.goto(`${BASE}icons/icon.svg`);
      await p2.evaluate(async () => {
        const c = await import('/js/config.js'); const m = await import('/js/db.js');
        const cfg = c.createDefaultConfig(); cfg.pinHash = 'x';
        await m.initialize({ config: cfg, activeDayId: 'day1', initials: c.createDefaultInitials() });
      });
      await p2.goto(URL_FAST);
      const w2 = (name) => p2.waitForSelector(tid(`screen-${name}`), { timeout: 8000 });
      await w2('choose');
      await p2.click(tid('choose-guest'));
      await w2('survey-age');
      await w2('choose');                                    // Q1 で放置 → 待機へ
      await p2.click(tid('choose-guest'));
      await w2('survey-age');
      await p2.click(tid('age-age-20s'));
      await w2('survey-trigger');
      for (let i = 0; i < 4; i++) { await sleep(700); await p2.click(tid('trigger-sns')); }   // 操作中は 1.2 秒を超えても戻らない
      assert.ok(await p2.locator(tid('screen-survey-trigger')).isVisible(), '操作のたびにタイマーが延びる');
      await w2('choose');                                    // Q2 で放置 → 待機へ
      await p2.click(tid('choose-guest'));
      await w2('survey-age');
      assert.equal(await p2.locator('.chip.on').count(), 0, '放置で戻ると回答は消える');
      const n = await p2.evaluate(() => new Promise((resolve) => {
        const r = indexedDB.open('yosoro-gacha');
        r.onsuccess = () => { const q = r.result.transaction('draws').objectStore('draws').count(); q.onsuccess = () => { r.result.close(); resolve(q.result); }; };
      }));
      assert.equal(n, 0, '放置では何も保存されない');
    } finally {
      await ctx2.close();
    }
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
