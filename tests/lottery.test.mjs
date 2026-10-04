// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, pickPrize, normalizeStudentId, validateStudentId } from '../js/lottery.js';
import { validateBackup } from '../js/db.js';
import { createDefaultConfig, createDefaultInitials } from '../js/config.js';

test('randomInt: 範囲内の整数のみ・n=1 は常に 0', () => {
  for (let i = 0; i < 2000; i++) {
    const v = randomInt(7);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 7);
  }
  assert.equal(randomInt(1), 0);
  assert.throws(() => randomInt(0), RangeError);
  assert.throws(() => randomInt(1.5), RangeError);
});

test('randomInt: 一様性（棄却サンプリングの偏りなし）', () => {
  const n = 6, trials = 120000;
  const hist = new Array(n).fill(0);
  for (let i = 0; i < trials; i++) hist[randomInt(n)]++;
  const expected = trials / n;
  const chi = hist.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  // 自由度5, p=0.0001 の臨界値 ≈ 25.7
  assert.ok(chi < 30, `chi-square too large: ${chi} ${hist}`);
});

test('pickPrize: 残数に比例した分布', () => {
  const items = [
    { prizeId: 'a', remaining: 1 },
    { prizeId: 'b', remaining: 3 },
    { prizeId: 'c', remaining: 6 },
  ];
  const trials = 100000;
  const cnt = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < trials; i++) cnt[pickPrize(items)]++;
  assert.ok(Math.abs(cnt.a / trials - 0.1) < 0.01, JSON.stringify(cnt));
  assert.ok(Math.abs(cnt.b / trials - 0.3) < 0.01, JSON.stringify(cnt));
  assert.ok(Math.abs(cnt.c / trials - 0.6) < 0.01, JSON.stringify(cnt));
});

test('pickPrize: 残数0は決して選ばれない', () => {
  const items = [
    { prizeId: 'zero', remaining: 0 },
    { prizeId: 'one', remaining: 1 },
    { prizeId: 'neg', remaining: -3 },
  ];
  for (let i = 0; i < 5000; i++) assert.equal(pickPrize(items), 'one');
});

test('pickPrize: 空・全0なら null', () => {
  assert.equal(pickPrize([]), null);
  assert.equal(pickPrize(undefined), null);
  assert.equal(pickPrize([{ prizeId: 'a', remaining: 0 }]), null);
});

test('pickPrize: 注入した乱数で境界を正しく選ぶ', () => {
  const items = [{ prizeId: 'a', remaining: 2 }, { prizeId: 'b', remaining: 3 }];
  const seq = (n) => (m) => { assert.equal(m, 5); return n; };
  assert.equal(pickPrize(items, seq(0)), 'a');
  assert.equal(pickPrize(items, seq(1)), 'a');
  assert.equal(pickPrize(items, seq(2)), 'b');
  assert.equal(pickPrize(items, seq(4)), 'b');
});

test('pickPrize: くじを引ききると全件ちょうど1回ずつ出る（戻さないくじ）', () => {
  const inv = [{ prizeId: 'a', remaining: 3 }, { prizeId: 'b', remaining: 2 }, { prizeId: 'c', remaining: 5 }];
  const got = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 10; i++) {
    const id = pickPrize(inv);
    assert.ok(id);
    got[id]++;
    inv.find((x) => x.prizeId === id).remaining--;
  }
  assert.deepEqual(got, { a: 3, b: 2, c: 5 });
  assert.equal(pickPrize(inv), null);
});

test('normalizeStudentId: 全角→半角・trim・大文字化', () => {
  assert.equal(normalizeStudentId('１２３４５'), '12345');
  assert.equal(normalizeStudentId('  0012　'), '0012');       // 先頭ゼロ保持・全角空白除去
  assert.equal(normalizeStudentId('ａｂ１２'), 'AB12');
  assert.equal(normalizeStudentId('ab12'), 'AB12');
  assert.equal(normalizeStudentId(null), '');
  assert.equal(normalizeStudentId(undefined), '');
  assert.equal(normalizeStudentId(12345), '12345');
});

test('validateStudentId: 既定ルール（数字のみ 5〜10桁）', () => {
  const rule = { charset: 'digits', minLength: 5, maxLength: 10 };
  assert.deepEqual(validateStudentId('12345', rule), { ok: true });
  assert.deepEqual(validateStudentId('0123456789', rule), { ok: true });
  assert.equal(validateStudentId('1234', rule).reason, 'too_short');
  assert.equal(validateStudentId('12345678901', rule).reason, 'too_long');
  assert.equal(validateStudentId('12a45', rule).reason, 'charset');
  assert.equal(validateStudentId('', rule).reason, 'empty');
  assert.equal(validateStudentId('12 45', rule).reason, 'charset');
});

test('validateStudentId: 英数字ルール', () => {
  const rule = { charset: 'alnum', minLength: 4, maxLength: 8 };
  assert.equal(validateStudentId('AB12', rule).ok, true);
  assert.equal(validateStudentId('ab12', rule).ok, false); // 正規化前の小文字は不可（正規化してから渡す）
  assert.equal(validateStudentId(normalizeStudentId('ａｂ１２'), rule).ok, true);
  assert.equal(validateStudentId('AB-12', rule).reason, 'charset');
});

// ---- バックアップ検証（db.js の純粋関数） ----
function sampleBackup() {
  const config = createDefaultConfig();
  config.pinHash = 'x';
  const inventory = [];
  const init = createDefaultInitials();
  for (const d of config.days) for (const p of config.prizes) {
    const n = init[d.id][p.id];
    inventory.push({ key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 });
  }
  return {
    app: 'yosoro-gacha', schemaVersion: 1, exportedAt: 1,
    meta: [{ key: 'config', value: config }, { key: 'activeDayId', value: 'day1' }],
    inventory, draws: [], students: [], logs: [],
  };
}

test('validateBackup: 正常なバックアップを受理', () => {
  assert.equal(validateBackup(sampleBackup()).ok, true);
});

test('validateBackup: 壊れたデータを拒否', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({}).ok, false);
  const b1 = sampleBackup(); b1.inventory[0].remaining = -1;
  assert.equal(validateBackup(b1).ok, false);
  const b2 = sampleBackup(); b2.schemaVersion = 99;
  assert.equal(validateBackup(b2).ok, false);
  const b3 = sampleBackup(); b3.students.push({ studentId: '1', drawId: 'none' });
  assert.equal(validateBackup(b3).ok, false);
  const b4 = sampleBackup(); b4.meta.push({ key: 'pendingDrawId', value: 'nope' });
  assert.equal(validateBackup(b4).ok, false);
  const b5 = sampleBackup(); b5.meta = b5.meta.filter((r) => r.key !== 'config');
  assert.equal(validateBackup(b5).ok, false);
});
