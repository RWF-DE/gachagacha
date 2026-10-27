// node --test tests/   イベント設定 config v2（js/profile.js）：正規化・設定ファイル・景品/日程の変更計画、
// バックアップ検証（v1/v2/v3/設定ファイル）、選択肢を差し替えたアンケート。docs/CUSTOMIZE.md §2〜§4
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONFIG_VERSION, PROFILE_VERSION, LIMITS, normalizeConfig, newId, nextDayId, planBoxSettings, exportProfile, validateProfileFile,
  len, inRange, PRINTABLE, hasOwn,
} from '../js/profile.js';
import { TEMPLATES, templateConfig, TIER_LATIN, YOSORO_TIER_LATIN, SURVEY_AGES, SURVEY_TRIGGERS } from '../js/templates.js';
import {
  SCHEMA_VERSION, SURVEY_VERSION, SURVEY_NOTICE, DEFAULT_INITIALS, createDefaultConfig, createDefaultInitials,
} from '../js/config.js';
import { validateBackup } from '../js/db.js';
import { normalizeSurvey, aggregateSurvey, ageLabelOf, triggerLabelsOf } from '../js/survey.js';

// ---------- 道具 ----------
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const T = () => templateConfig('denpasai-2026').config;
const cp = (s) => [...s].length;

/** 電波祭2026 で iPad に保存されていた v1 の config そのもの（v1 の js/config.js createDefaultConfig() の出力） */
function v1Config() {
  return {
    schemaVersion: 1,
    eventId: 'denpasai-2026',
    eventName: '電波祭2026',
    days: [
      { id: 'day1', label: '1日目' },
      { id: 'day2', label: '2日目' },
    ],
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
    studentIdRule: { charset: 'digits', minLength: 7, maxLength: 7 },
    pinHash: null,
    sound: { enabled: true, volume: 0.7 },
  };
}

/** 正規化後の config が §2 の制約を満たすか（構造の整合＝id の参照などは見ない） */
function assertValidConfig(c, label = '') {
  const at = (m) => `${label} ${m}`;
  const slug = /^[a-z0-9-]{1,40}$/;
  const lat = /^[\x20-\x7E]*$/;
  assert.deepEqual(Object.keys(c).sort(), ['brand', 'categories', 'days', 'entry', 'eventId', 'eventName', 'motif', 'pinHash', 'prizes', 'schemaVersion', 'sound', 'studentIdRule', 'survey', 'theme'], at('keys'));
  assert.equal(c.schemaVersion, 2);
  assert.match(c.eventId, /^[a-z0-9][a-z0-9-]{0,39}$/);
  const len = (s, min, max, what) => { assert.equal(typeof s, 'string', at(what)); assert.ok(cp(s) >= min && cp(s) <= max, at(`${what} 文字数 ${cp(s)}`)); assert.equal(s, s.trim(), at(`${what} trim`)); };
  len(c.eventName, 1, 30, 'eventName');
  len(c.brand.name, 1, 16, 'brand.name');
  len(c.brand.nameLatin, 0, 24, 'nameLatin'); assert.match(c.brand.nameLatin, lat);
  len(c.brand.eventLabel, 0, 20, 'eventLabel');
  len(c.brand.eventLatin, 0, 24, 'eventLatin'); assert.match(c.brand.eventLatin, lat);
  len(c.brand.tagline, 0, 24, 'tagline');
  len(c.brand.prizeWord, 1, 6, 'prizeWord');
  const w = c.brand.wordmark;
  if (w !== null) {
    assert.equal(typeof w.for, 'string');
    assert.ok(Array.isArray(w.gaps) && w.gaps.length >= 1 && w.gaps.length <= 16 && w.gaps.every(Number.isFinite));
    assert.ok(Number.isInteger(w.breakAt) && w.breakAt >= 0);
    assert.ok(Number.isFinite(w.yomiSpacing.l) && Number.isFinite(w.yomiSpacing.p));
  }
  assert.match(c.theme.preset, /^[a-z0-9-]{1,32}$/);
  if (c.theme.custom !== null) for (const k of ['paper', 'main', 'ink', 'accent']) assert.match(c.theme.custom[k], /^#[0-9A-Fa-f]{6}$/);
  assert.match(c.motif, /^[a-z0-9-]{1,32}$/);
  for (const k of ['student', 'guest']) {
    assert.equal(typeof c.entry[k].enabled, 'boolean');
    len(c.entry[k].title, 1, 12, `${k}.title`);
    len(c.entry[k].sub, 0, 20, `${k}.sub`);
  }
  assert.ok(c.entry.student.enabled || c.entry.guest.enabled, at('参加の方法は少なくとも一方が有効'));
  assert.equal(typeof c.survey.enabled, 'boolean');
  len(c.survey.notice, 0, 80, 'notice');
  for (const [k, max] of [['q1', 12], ['q2', 10]]) {
    const q = c.survey[k];
    len(q.heading, 1, 40, `${k}.heading`);
    len(q.short, 1, 10, `${k}.short`);
    assert.ok(q.options.length >= 2 && q.options.length <= max, at(`${k} 選択肢の数 ${q.options.length}`));
    assert.equal(new Set(q.options.map((o) => o.id)).size, q.options.length, at(`${k} id 重複なし`));
    for (const o of q.options) { assert.match(o.id, slug); len(o.label, 1, 24, `${k} label`); assert.deepEqual(Object.keys(o).sort(), ['id', 'label']); }
  }
  for (const [k, list] of [['days', c.days], ['categories', c.categories], ['prizes', c.prizes]]) {
    assert.ok(Array.isArray(list) && list.length >= 1, at(`${k} は空でない`));
    for (const x of list) assert.equal(typeof x.id, 'string');
  }
  for (const d of c.days) { len(d.label, 1, 12, 'day.label'); assert.deepEqual(Object.keys(d).sort(), ['id', 'label']); }
  for (const x of c.categories) {
    len(x.name, 1, 40, 'category.name'); len(x.latin, 0, 24, 'category.latin'); assert.match(x.latin, lat);
    assert.ok(['sponsor', 'rare', 'sticker'].includes(x.tier), at('tier'));
    assert.deepEqual(Object.keys(x).sort(), ['id', 'latin', 'name', 'tier']);
  }
  for (const p of c.prizes) {
    len(p.name, 1, 60, 'prize.name'); assert.equal(typeof p.countUnknown, 'boolean'); assert.equal(typeof p.categoryId, 'string');
    assert.deepEqual(Object.keys(p).sort(), ['categoryId', 'countUnknown', 'id', 'name']);
  }
  const r = c.studentIdRule;
  assert.ok(['digits', 'alnum'].includes(r.charset) && Number.isInteger(r.minLength) && Number.isInteger(r.maxLength) && r.minLength >= 1 && r.minLength <= r.maxLength && r.maxLength <= 20, at('studentIdRule'));
  assert.ok(c.pinHash === null || typeof c.pinHash === 'string');
  assert.equal(typeof c.sound.enabled, 'boolean');
  assert.ok(Number.isFinite(c.sound.volume) && c.sound.volume >= 0 && c.sound.volume <= 1);
}

// ---------- 定数・既定 ----------
test('定数：config の版は 2、SCHEMA_VERSION・設定ファイルの版と一致', () => {
  assert.equal(CONFIG_VERSION, 2);
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(PROFILE_VERSION, 1);
  assert.equal(SURVEY_VERSION, 1);
  assert.equal(Object.isFrozen(LIMITS), true, 'LIMITS は書き換えられない');
  assert.deepEqual(
    [LIMITS.q1Options, LIMITS.q2Options, LIMITS.days, LIMITS.categories, LIMITS.prizes],
    [{ min: 2, max: 12 }, { min: 2, max: 10 }, { min: 1, max: 7 }, { min: 1, max: 12 }, { min: 1, max: 40 }],
  );
});

test('config.js：既定はテンプレート denpasai-2026 を正規化したもの（毎回新しい複製）', () => {
  const a = createDefaultConfig();
  const b = createDefaultConfig();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.equal(a.pinHash, null);
  assert.deepEqual(a.sound, { enabled: true, volume: 0.7 });
  assert.deepEqual({ ...a, schemaVersion: undefined, pinHash: undefined, sound: undefined }, { ...T(), schemaVersion: undefined, pinHash: undefined, sound: undefined });
  a.prizes[0].name = '書き換え';
  assert.notEqual(createDefaultConfig().prizes[0].name, '書き換え');
  assert.deepEqual(DEFAULT_INITIALS, TEMPLATES['denpasai-2026'].initials);
  assert.deepEqual(createDefaultInitials(), DEFAULT_INITIALS);
  assert.notEqual(createDefaultInitials(), createDefaultInitials());
  assert.equal(SURVEY_NOTICE, T().survey.notice);
});

test('テンプレート：どちらも正規化で何も変わらない（上限に収まっている）・設定ファイルとして有効', () => {
  for (const id of Object.keys(TEMPLATES)) {
    const { config, initials } = templateConfig(id);
    const n = normalizeConfig(config);
    assertValidConfig(n, id);
    assert.deepEqual(n, { schemaVersion: 2, ...config, pinHash: null, sound: { enabled: true, volume: 0.7 } }, `${id} は正規化で変わらない`);
    const file = exportProfile(n, Object.entries(initials).flatMap(([dayId, per]) => Object.entries(per).map(([prizeId, initial]) => ({ key: `${dayId}:${prizeId}`, dayId, prizeId, initial, remaining: 0 }))));
    const v = validateProfileFile(JSON.parse(JSON.stringify(file)));
    assert.equal(v.ok, true, `${id}: ${v.error}`);
    assert.deepEqual(v.initials, initials, `${id} の本数`);
  }
});

// ---------- 正規化：v1 → v2 ----------
test('normalizeConfig：v1 の既定 config → 電波祭2026 のテンプレートの値で補って v2（見た目は今のまま）', () => {
  const v1 = v1Config();
  const n = normalizeConfig(v1);
  const t = T();
  assert.equal(n.schemaVersion, 2);
  for (const k of ['brand', 'theme', 'motif', 'entry', 'survey']) assert.deepEqual(n[k], t[k], k);
  assert.deepEqual(n.categories.map((c) => [c.id, c.tier, c.latin]), [
    ['sponsor', 'sponsor', 'SPONSOR AWARD'], ['rare', 'rare', 'RARE STICKER'], ['sticker', 'sticker', 'STICKER'],
  ]);
  for (const k of ['eventId', 'eventName', 'days', 'prizes', 'studentIdRule', 'pinHash', 'sound']) assert.deepEqual(n[k], v1[k], k);
  assert.deepEqual(n.categories.map(({ id, name, tier }) => ({ id, name, tier })), v1.categories);
  assert.equal(n.prizes.find((p) => p.id === 'bulldak').name, 'カムジャ麺');
  assertValidConfig(n, 'v1');
  assert.deepEqual(n, createDefaultConfig(), 'createDefaultConfig() と同じ');
});

test('normalizeConfig：v1 の PIN・効果音・景品名の編集・学籍番号ルールは残る', () => {
  const v1 = v1Config();
  Object.assign(v1, { pinHash: 'abcdef0123', sound: { enabled: false, volume: 0.25 }, studentIdRule: { charset: 'alnum', minLength: 4, maxLength: 9 } });
  v1.categories[0].name = '特別賞';
  v1.prizes[2].name = '編集した景品';
  v1.prizes[3].countUnknown = false;
  const n = normalizeConfig(v1);
  assert.equal(n.pinHash, 'abcdef0123');
  assert.deepEqual(n.sound, { enabled: false, volume: 0.25 });
  assert.deepEqual(n.studentIdRule, { charset: 'alnum', minLength: 4, maxLength: 9 });
  assert.equal(n.categories[0].name, '特別賞');
  assert.equal(n.prizes[2].name, '編集した景品');
  assert.equal(n.prizes[3].countUnknown, false);
  assert.equal(n.categories[0].latin, 'SPONSOR AWARD', 'v1 の賞は電波祭2026 の呼び名');
});

test('normalizeConfig：latin が無い賞の補い方（v1 は電波祭2026 の呼び名、v2 は新しい賞の既定）', () => {
  const cats = [{ id: 'a', name: 'A賞', tier: 'sponsor' }, { id: 'b', name: 'B賞', tier: 'rare' }, { id: 'c', name: 'C賞', tier: 'sticker' }, { id: 'd', name: 'D賞', tier: 'gold' }];
  const base = { ...v1Config(), categories: cats };
  assert.deepEqual(normalizeConfig({ ...base, schemaVersion: 1 }).categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER', 'STICKER']);
  assert.deepEqual(normalizeConfig({ ...base, schemaVersion: undefined }).categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER', 'STICKER']);
  assert.deepEqual(normalizeConfig({ ...base, schemaVersion: 2 }).categories.map((c) => c.latin), [TIER_LATIN.sponsor, TIER_LATIN.rare, TIER_LATIN.sticker, TIER_LATIN.sticker]);
  assert.deepEqual(normalizeConfig({ ...base, schemaVersion: 2 }).categories.map((c) => c.tier), ['sponsor', 'rare', 'sticker', 'sticker'], '知らない tier は sticker');
  // 空の latin は「欧文なし」として残す（文字列として有効）。日本語だけなら空になる
  const given = normalizeConfig({ ...base, schemaVersion: 2, categories: [{ ...cats[0], latin: '' }, { ...cats[1], latin: '日本語' }, { ...cats[2], latin: 'My Prize' }] });
  assert.deepEqual(given.categories.map((c) => c.latin), ['', '', 'My Prize']);
  assert.deepEqual(TIER_LATIN, { sponsor: 'SPECIAL PRIZE', rare: 'RARE PRIZE', sticker: 'PRIZE' });
  assert.deepEqual(YOSORO_TIER_LATIN, { sponsor: 'SPONSOR AWARD', rare: 'RARE STICKER', sticker: 'STICKER' });
});

test('normalizeConfig：v2 の config は変わらない（べき等）', () => {
  const samples = [
    v1Config(), createDefaultConfig(), templateConfig('generic').config, {}, undefined,
    { ...createDefaultConfig(), pinHash: 'x', theme: { preset: 'my-theme', custom: { paper: '#ffffff', main: '#000000', ink: '#111111', accent: '#ff0000' } }, motif: 'sakura' },
  ];
  for (const s of samples) {
    const once = normalizeConfig(s);
    assert.deepEqual(normalizeConfig(once), once);
    assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(once))), once, 'JSON を経由しても同じ');
  }
});

test('normalizeConfig：入力を変更せず、結果は入力・テンプレートと参照を共有しない', () => {
  const frozen = deepFreeze(v1Config());
  const a = normalizeConfig(frozen);
  const frozen2 = deepFreeze(JSON.parse(JSON.stringify(createDefaultConfig())));
  const b = normalizeConfig(frozen2);
  for (const n of [a, b]) {
    n.brand.name = '書き換え';
    n.brand.wordmark.gaps.push(9);
    n.survey.q1.options[0].label = '書き換え';
    n.survey.q1.options.push({ id: 'zz', label: 'zz' });
    n.days[0].label = '書き換え';
    n.categories[0].latin = '書き換え';
    n.prizes[0].name = '書き換え';
    n.entry.guest.title = '書き換え';
    n.theme.preset = 'zzz';
    n.studentIdRule.maxLength = 1;
    n.sound.volume = 0;
  }
  assert.deepEqual(normalizeConfig({}), createDefaultConfig(), 'テンプレートの既定は汚れない');
  assert.equal(normalizeConfig(v1Config()).brand.name, 'よーそろがちゃ');
  assert.equal(SURVEY_AGES.length, 10);
  assert.equal(SURVEY_AGES[0].label, '未就学児');
});

test('normalizeConfig：壊れた値は電波祭2026 の既定になる', () => {
  const dflt = createDefaultConfig();
  for (const g of [undefined, null, 'x', 42, true, [], [1, 2], () => 1, {}, { schemaVersion: 2 }, { days: 'x', categories: null, prizes: 5 }]) {
    assert.deepEqual(normalizeConfig(g), dflt, String(JSON.stringify(g)));
  }
});

// ---------- 正規化：文字列 ----------
test('normalizeConfig：文字列は前後の空白を除き、コードポイントで上限に切る', () => {
  const emoji = '😀'.repeat(40);
  const n = normalizeConfig({
    ...createDefaultConfig(),
    eventName: `  ${emoji}  `,
    brand: { ...T().brand, name: 'あ'.repeat(20), eventLabel: '　全角の空白　', tagline: 'い'.repeat(30), prizeWord: '宝物の景品です' },
  });
  assert.equal(n.eventName, '😀'.repeat(30), 'サロゲートペアを割らない');
  assert.equal(n.brand.name, 'あ'.repeat(16));
  assert.equal(n.brand.eventLabel, '全角の空白', '全角空白も除く');
  assert.equal(cp(n.brand.tagline), 24);
  assert.equal(n.brand.prizeWord, '宝物の景品です'.slice(0, 6));
  // 切ったあとの末尾の空白も除く（べき等）
  const cut = normalizeConfig({ ...createDefaultConfig(), brand: { ...T().brand, name: `${'あ'.repeat(15)} ${'い'.repeat(5)}` } });
  assert.equal(cut.brand.name, 'あ'.repeat(15));
  assert.deepEqual(normalizeConfig(cut), cut);
});

test('normalizeConfig：必須の文字列が空・文字列でないなら既定、任意の欄は空のまま残す', () => {
  const t = T();
  const n = normalizeConfig({
    ...createDefaultConfig(),
    eventName: '   ',
    brand: { name: '', nameLatin: '', eventLabel: '', eventLatin: '', tagline: '', prizeWord: ' ' },
    entry: { student: { enabled: true, title: '', sub: '' }, guest: { enabled: true, title: 5, sub: null } },
    survey: { ...t.survey, notice: '', q1: { heading: '', short: '  ', options: t.survey.q1.options } },
  });
  assert.equal(n.eventName, t.eventName);
  assert.equal(n.brand.name, t.brand.name);
  assert.equal(n.brand.prizeWord, t.brand.prizeWord);
  assert.deepEqual([n.brand.nameLatin, n.brand.eventLabel, n.brand.eventLatin, n.brand.tagline], ['', '', '', ''], '任意の欄は空でよい（帯・読みを出さない）');
  assert.equal(n.entry.student.title, t.entry.student.title);
  assert.equal(n.entry.student.sub, '', '説明は空でよい');
  assert.equal(n.entry.guest.title, t.entry.guest.title);
  assert.equal(n.entry.guest.sub, t.entry.guest.sub, '文字列でなければ既定');
  assert.equal(n.survey.notice, '');
  assert.equal(n.survey.q1.heading, t.survey.q1.heading);
  assert.equal(n.survey.q1.short, t.survey.q1.short);
  const num = normalizeConfig({ ...createDefaultConfig(), brand: { ...t.brand, nameLatin: 5, tagline: {} } });
  assert.equal(num.brand.nameLatin, t.brand.nameLatin);
  assert.equal(num.brand.tagline, t.brand.tagline);
});

test('normalizeConfig：欧文の欄は印字可能な ASCII 以外を除く', () => {
  const n = normalizeConfig({
    ...createDefaultConfig(),
    brand: { ...T().brand, nameLatin: 'Hello 世界 World', eventLatin: 'ＤＥＮＰＡＳＡＩ' },
    categories: [{ id: 'a', name: 'A賞', tier: 'rare', latin: 'レア\tRARE\nPRIZE　' }],
    schemaVersion: 2,
  });
  assert.equal(n.brand.nameLatin, 'Hello  World');
  assert.equal(n.brand.eventLatin, '', '全角英字は ASCII ではない');
  assert.equal(n.categories[0].latin, 'RAREPRIZE');
  const long = normalizeConfig({ ...createDefaultConfig(), brand: { ...T().brand, nameLatin: `${'ABCDEFGHIJ'.repeat(3)} あ` } });
  assert.equal(long.brand.nameLatin, 'ABCDEFGHIJ'.repeat(2) + 'ABCD');
});

// ---------- 正規化：参加の方法・アンケート・見た目 ----------
test('normalizeConfig：参加の方法は少なくとも一方を有効にする', () => {
  const off = { enabled: false, title: '学生', sub: '' };
  assert.deepEqual(
    [normalizeConfig({ ...createDefaultConfig(), entry: { student: off, guest: off } }).entry].map((e) => [e.student.enabled, e.guest.enabled]),
    [[true, true]],
  );
  const one = normalizeConfig({ ...createDefaultConfig(), entry: { student: off, guest: { enabled: true, title: '一般', sub: 'x' } } }).entry;
  assert.deepEqual([one.student.enabled, one.guest.enabled, one.student.title, one.guest.title], [false, true, '学生', '一般']);
  const odd = normalizeConfig({ ...createDefaultConfig(), entry: { student: { enabled: 0 }, guest: { enabled: 'yes' } } }).entry;
  assert.deepEqual([odd.student.enabled, odd.guest.enabled], [true, true], '真偽でない値は既定');
});

test('normalizeConfig：アンケートの選択肢（不正な項目は捨て、2つ未満なら既定の一覧）', () => {
  const t = T();
  const q1 = (options) => normalizeConfig({ ...createDefaultConfig(), survey: { ...t.survey, q1: { ...t.survey.q1, options } } }).survey.q1.options;
  assert.deepEqual(q1([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]), [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], '2つで有効');
  assert.deepEqual(q1([{ id: 'a', label: 'A' }]), SURVEY_AGES, '1つだけは既定');
  assert.deepEqual(q1([]), SURVEY_AGES);
  for (const bad of ['x', null, 5, {}, [null, 3, 'x'], [{ id: 'a' }, { label: 'B' }]]) assert.deepEqual(q1(bad), SURVEY_AGES, JSON.stringify(bad));
  // 不正な項目だけ捨てる／id の重複は先のものを残す／label は整える
  assert.deepEqual(q1([
    { id: 'Bad', label: '大文字の id' }, { id: 'has space', label: 'x' }, { id: 'x'.repeat(41), label: 'x' }, { id: '', label: 'x' }, { id: 5, label: 'x' },
    { id: 'ok-1', label: '  　最初　' }, { id: 'ok-1', label: '重複' }, { id: 'ok-2', label: '' }, { id: 'ok-3', label: 'あ'.repeat(30) }, { id: 'ok-4', label: 'Z' },
  ]), [{ id: 'ok-1', label: '最初' }, { id: 'ok-3', label: 'あ'.repeat(24) }, { id: 'ok-4', label: 'Z' }]);
  assert.deepEqual(q1([{ id: 'a', label: '' }, { id: 'a', label: '後から有効' }, { id: 'b', label: 'B' }]), [{ id: 'a', label: '後から有効' }, { id: 'b', label: 'B' }]);
  // 上限（Q1 は 12、Q2 は 10）を超えた分は切る
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `選択肢${i}` }));
  assert.equal(q1(many(12)).length, 12);
  assert.equal(q1(many(15)).length, 12);
  const q2 = (n) => normalizeConfig({ ...createDefaultConfig(), survey: { ...t.survey, q2: { ...t.survey.q2, options: many(n) } } }).survey.q2.options;
  assert.equal(q2(10).length, 10);
  assert.equal(q2(11).length, 10);
  assert.deepEqual(q2(1), SURVEY_TRIGGERS, 'Q2 の既定は SURVEY_TRIGGERS');
  // 見出し・短い名前・注意書き・有効
  const s = normalizeConfig({ ...createDefaultConfig(), survey: { enabled: 'no', notice: 'あ'.repeat(100), q1: { heading: 'あ'.repeat(60), short: 'い'.repeat(15), options: [] }, q2: 5 } }).survey;
  assert.equal(s.enabled, true, '真偽でなければ既定');
  assert.equal(cp(s.notice), 80);
  assert.equal(cp(s.q1.heading), 40);
  assert.equal(cp(s.q1.short), 10);
  assert.deepEqual(s.q2, t.survey.q2);
  assert.equal(normalizeConfig({ ...createDefaultConfig(), survey: { ...t.survey, enabled: false } }).survey.enabled, false);
});

test('normalizeConfig：配色（custom は4色とも正しいときだけ）・配色/回すものの id は形が正しければ知らない id も残す', () => {
  const colors = { paper: '#EEEADB', main: '#1a33e0', ink: '#0A0E33', accent: '#F23B20' };
  const th = (theme) => normalizeConfig({ ...createDefaultConfig(), theme }).theme;
  assert.deepEqual(th({ preset: 'wakaba', custom: colors }), { preset: 'wakaba', custom: colors });
  assert.notEqual(th({ preset: 'wakaba', custom: colors }).custom, colors);
  for (const bad of [{ ...colors, ink: '#12345' }, { ...colors, main: 'red' }, { ...colors, paper: '#GGGGGG' }, { ...colors, accent: '#FFFFFFF' }, { ...colors, ink: 5 }, { paper: '#FFFFFF' }, 'x', [], 7]) {
    assert.equal(th({ preset: 'sakura', custom: bad }).custom, null, JSON.stringify(bad));
  }
  assert.deepEqual(th({ preset: 'sakura' }), { preset: 'sakura', custom: null });
  assert.equal(th({ preset: 'future-theme-2', custom: null }).preset, 'future-theme-2', '知らない id でも残す');
  for (const bad of ['Upper', 'with_underscore', 'x'.repeat(33), '', 5, null, 'a b']) assert.equal(th({ preset: bad }).preset, 'yosoro', String(bad));
  assert.equal(th(undefined).preset, 'yosoro');
  const motif = (m) => normalizeConfig({ ...createDefaultConfig(), motif: m }).motif;
  assert.equal(motif('sakura'), 'sakura');
  assert.equal(motif('brand-new-motif'), 'brand-new-motif');
  for (const bad of ['Helm', 'a_b', 'x'.repeat(33), '', 3, null]) assert.equal(motif(bad), 'helm', String(bad));
});

test('normalizeConfig：ワードマークは形が正しいときだけ残す（無ければ既定・null は null）', () => {
  const good = { for: 'あ|A', gaps: [0, -0.05, 0.1], breakAt: 2, yomiSpacing: { l: 0.1, p: 0.05 } };
  const wm = (w) => normalizeConfig({ ...createDefaultConfig(), brand: { ...T().brand, wordmark: w } }).brand.wordmark;
  assert.deepEqual(wm(good), good);
  assert.notEqual(wm(good), good);
  assert.notEqual(wm(good).gaps, good.gaps);
  assert.deepEqual(wm({ ...good, extra: 1 }), good, '知らないキーは捨てる');
  assert.equal(wm(null), null);
  assert.deepEqual(wm(undefined), T().brand.wordmark, '未指定は既定');
  assert.deepEqual(normalizeConfig({ ...createDefaultConfig(), brand: undefined }).brand.wordmark, T().brand.wordmark);
  assert.deepEqual(wm({ ...good, breakAt: 0 }), { ...good, breakAt: 0 });
  assert.deepEqual(wm({ ...good, gaps: new Array(16).fill(0) }).gaps.length, 16);
  for (const bad of [
    {}, 'x', 5, [], { ...good, for: 5 }, { ...good, for: 'x'.repeat(42) }, { ...good, gaps: [] }, { ...good, gaps: new Array(17).fill(0) },
    { ...good, gaps: [0, 'a'] }, { ...good, gaps: [NaN] }, { ...good, gaps: 'x' }, { ...good, breakAt: -1 }, { ...good, breakAt: 1.5 }, { ...good, breakAt: '1' },
    { ...good, yomiSpacing: null }, { ...good, yomiSpacing: { l: 1 } }, { ...good, yomiSpacing: { l: 'a', p: 1 } },
  ]) assert.equal(wm(bad), null, JSON.stringify(bad));
});

test('normalizeConfig：学籍番号ルール・効果音・PIN・eventId・版・知らないキー', () => {
  const rule = (r) => normalizeConfig({ ...createDefaultConfig(), studentIdRule: r }).studentIdRule;
  const dflt = { charset: 'digits', minLength: 7, maxLength: 7 };
  assert.deepEqual(rule({ charset: 'alnum', minLength: 1, maxLength: 20 }), { charset: 'alnum', minLength: 1, maxLength: 20 });
  assert.deepEqual(rule({ charset: 'digits', minLength: 5, maxLength: 5, extra: 1 }), { charset: 'digits', minLength: 5, maxLength: 5 });
  for (const bad of [
    { charset: 'x', minLength: 1, maxLength: 5 }, { charset: 'digits', minLength: 0, maxLength: 5 }, { charset: 'digits', minLength: 6, maxLength: 5 },
    { charset: 'digits', minLength: 1, maxLength: 21 }, { charset: 'digits', minLength: 1.5, maxLength: 5 }, { charset: 'digits', minLength: '1', maxLength: '5' },
    { charset: 'digits' }, null, 'x', undefined,
  ]) assert.deepEqual(rule(bad), dflt, JSON.stringify(bad));

  const snd = (s) => normalizeConfig({ ...createDefaultConfig(), sound: s }).sound;
  assert.deepEqual(snd({ enabled: false, volume: 0 }), { enabled: false, volume: 0 });
  assert.deepEqual(snd({ enabled: true, volume: 1 }), { enabled: true, volume: 1 });
  assert.equal(snd({ volume: -3 }).volume, 0);
  assert.equal(snd({ volume: 9 }).volume, 1);
  for (const bad of [NaN, Infinity, '0.5', null, undefined]) assert.equal(snd({ volume: bad }).volume, 0.7, String(bad));
  assert.equal(snd({ enabled: 'no' }).enabled, true);
  assert.deepEqual(snd(undefined), { enabled: true, volume: 0.7 });
  assert.deepEqual(snd({ enabled: true, volume: 0.5, extra: 1 }), { enabled: true, volume: 0.5 });

  assert.equal(normalizeConfig({ ...createDefaultConfig(), pinHash: 'abc' }).pinHash, 'abc');
  for (const bad of [5, null, undefined, {}, ['a']]) assert.equal(normalizeConfig({ ...createDefaultConfig(), pinHash: bad }).pinHash, null);

  assert.equal(normalizeConfig({ ...createDefaultConfig(), eventId: 'my-event-2027' }).eventId, 'my-event-2027');
  for (const bad of ['Upper', '-lead', 'a b', 'x'.repeat(41), '', 5]) assert.equal(normalizeConfig({ ...createDefaultConfig(), eventId: bad }).eventId, 'denpasai-2026', String(bad));

  for (const v of [1, 2, 3, 99, '2', null, undefined]) assert.equal(normalizeConfig({ ...createDefaultConfig(), schemaVersion: v }).schemaVersion, 2);
  const extra = normalizeConfig({ ...createDefaultConfig(), foo: 1, bar: { a: 1 }, __proto__: { polluted: true }, ['__proto__x']: 1 });
  assert.equal('foo' in extra || 'bar' in extra || 'polluted' in extra || '__proto__x' in extra, false, '知らない最上位のキーは捨てる');
  assert.deepEqual(extra, createDefaultConfig());
});

test('normalizeConfig：開催日・賞・景品は欄を補って整える（構造の整合は別の検証が見る）', () => {
  const n = normalizeConfig({
    schemaVersion: 2,
    days: [{ id: 'day1', label: '  ' }, { id: 'day9', label: '' }, { id: 'day3', label: 'あ'.repeat(20) }, null, 5, { label: 'x' }, { id: '' }],
    categories: [{ id: 'sponsor', name: '', tier: 'sponsor' }, { id: 'zz', name: '  新しい賞  ', tier: 'unknown' }, 'x', { id: 7 }],
    prizes: [{ id: 'p1', categoryId: 'zz', name: '', countUnknown: 1 }, { id: 'p2', categoryId: 5, name: 'x'.repeat(80) }, { id: 'p3', categoryId: 'zz', name: ' ok ', countUnknown: 'yes' }, {}],
  });
  assert.deepEqual(n.days, [{ id: 'day1', label: '1日目' }, { id: 'day9', label: '2日目' }, { id: 'day3', label: 'あ'.repeat(12) }]);
  assert.deepEqual(n.categories, [
    { id: 'sponsor', name: '協賛特別賞', tier: 'sponsor', latin: TIER_LATIN.sponsor },
    { id: 'zz', name: '新しい賞', tier: 'sticker', latin: TIER_LATIN.sticker },
  ]);
  assert.deepEqual(n.prizes, [
    { id: 'p1', categoryId: 'zz', name: 'p1', countUnknown: true },
    { id: 'p2', categoryId: '', name: 'x'.repeat(60), countUnknown: false },
    { id: 'p3', categoryId: 'zz', name: 'ok', countUnknown: true },
  ]);
  // id の重複・参照の切れは直さない（validateBackup と保存処理が見る）
  const dup = normalizeConfig({ ...createDefaultConfig(), prizes: [{ id: 'a', categoryId: 'nope', name: 'A' }, { id: 'a', categoryId: 'nope', name: 'B' }] });
  assert.deepEqual(dup.prizes.map((p) => [p.id, p.categoryId, p.name]), [['a', 'nope', 'A'], ['a', 'nope', 'B']]);
  // 一覧が無い・全部だめなら、その一覧だけ既定
  const lone = normalizeConfig({ ...createDefaultConfig(), days: [{ id: 'dayX', label: 'X' }], categories: 'x', prizes: [null] });
  assert.deepEqual(lone.days, [{ id: 'dayX', label: 'X' }]);
  assert.deepEqual(lone.categories, T().categories);
  assert.deepEqual(lone.prizes, T().prizes);
});

test('normalizeConfig：でたらめな値を大量に入れても例外なし・結果は §2 の制約を満たしべき等（乱数は固定）', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const strings = ['', ' ', '   ', 'x', 'あ', 'A b', '😀', 'あ'.repeat(70), 'ab'.repeat(40), '#FFFFFF', 'day1', 'sponsor', 'digits', 'a\tb\n', '　', 'ＡＢＣ', '__proto__', 'constructor', 'Helm', 'x-y_z'];
  const junk = (depth = 0) => {
    const r = rnd();
    if (r < 0.1) return undefined;
    if (r < 0.18) return null;
    if (r < 0.26) return rnd() < 0.5;
    if (r < 0.4) return pick([0, 1, -1, 7, 0.5, 20, 21, 1e9, -1e9, NaN, Infinity, 100001]);
    if (r < 0.7) return pick(strings);
    if (depth > 2) return pick(strings);
    if (r < 0.85) return Array.from({ length: Math.floor(rnd() * 5) }, () => junk(depth + 1));
    const o = {};
    for (const k of ['id', 'label', 'name', 'tier', 'latin', 'categoryId', 'countUnknown', 'enabled', 'title', 'sub', 'options', 'heading', 'short']) if (rnd() < 0.4) o[k] = junk(depth + 1);
    return o;
  };
  const corrupt = (v, depth = 0) => {
    if (v && typeof v === 'object' && depth < 4) {
      const out = Array.isArray(v) ? [...v] : { ...v };
      for (const k of Object.keys(out)) {
        const r = rnd();
        if (r < 0.12) out[k] = junk();
        else if (r < 0.2 && !Array.isArray(out)) delete out[k];
        else out[k] = corrupt(out[k], depth + 1);
      }
      if (Array.isArray(out) && rnd() < 0.15) out.push(junk());
      return out;
    }
    return rnd() < 0.1 ? junk() : v;
  };
  const bases = [v1Config(), createDefaultConfig(), templateConfig('generic').config];
  for (let i = 0; i < 600; i++) {
    const input = corrupt(JSON.parse(JSON.stringify(pick(bases))));
    const json = JSON.stringify(input);
    const out = normalizeConfig(input);
    assertValidConfig(out, `#${i} ${json?.slice(0, 120)}`);
    assert.deepEqual(normalizeConfig(out), out, `べき等 #${i}`);
    assert.equal(JSON.stringify(input), json, `入力を変えない #${i}`);
  }
});

// ---------- newId ----------
test('newId：形式どおり・taken（Set でも配列でも）と重ならない・続けて呼んでも重ならない', () => {
  const slug = /^[a-z0-9-]{1,40}$/;
  const a = newId('prize', new Set());
  assert.match(a, slug);
  assert.ok(a.startsWith('prize-'));
  const taken = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newId('cat', taken);
    assert.match(id, slug);
    assert.equal(taken.has(id), false);
    taken.add(id);
  }
  const arr = [];
  for (let i = 0; i < 100; i++) { const id = newId('opt', arr); assert.equal(arr.includes(id), false); arr.push(id); }
  // 候補がふさがっていれば、毎回違う候補を試して、空いたものを返す
  class Busy extends Set {
    seen = [];
    has(id) { this.seen.push(id); return this.seen.length <= 5; }
  }
  const busy = new Busy();
  const got = newId('z', busy);
  assert.equal(busy.seen.length, 6);
  assert.equal(new Set(busy.seen).size, 6, '候補は毎回違う');
  assert.equal(got, busy.seen[5]);
  // Set・配列以外（繰り返せないもの）は「何も使われていない」として扱う
  for (const odd of [5, {}, true, { has: () => true }]) assert.match(newId('x', odd), slug);
  // 接頭辞は整えて使う
  assert.match(newId('Prize Name!', []), /^prize-name-[a-z0-9]+$/);
  assert.match(newId('賞', []), /^id-[a-z0-9]+$/, '使えない字だけなら id-');
  assert.match(newId('', null), slug);
  assert.match(newId(undefined, undefined), slug);
  assert.match(newId('a'.repeat(100), []), slug, '長い接頭辞は切る');
  assert.ok(newId('a'.repeat(100), []).length <= 40);
});

test('nextDayId：day<n> で今の最大の番号の次（空きがなければ最小の空き）', () => {
  assert.equal(nextDayId([{ id: 'day1' }, { id: 'day2' }]), 'day3');
  assert.equal(nextDayId([{ id: 'day1' }]), 'day2');
  assert.equal(nextDayId([]), 'day1');
  assert.equal(nextDayId(undefined), 'day1');
  assert.equal(nextDayId([{ id: 'day1' }, { id: 'day5' }]), 'day6');
  assert.equal(nextDayId([{ id: 'day998' }, { id: 'day999' }]), 'day1', '番号が尽きたら最小の空き');
  assert.equal(nextDayId(Array.from({ length: 999 }, (_, i) => ({ id: `day${i + 1}` }))), null);
  assert.match(nextDayId([{ id: 'other' }, null, { id: 'day2' }]), /^day[0-9]{1,3}$/);
});

test('nextDayId：下書きの日に保存済みの日の id も足して渡せば、消した日の id を返さない（スタッフ画面の「日を追加」）', () => {
  const stored = [{ id: 'day1' }, { id: 'day2' }];
  const draft = [{ id: 'day1' }];                     // 最後の日（day2）を消した下書き
  assert.equal(nextDayId(draft), 'day2', '下書きだけを見ると、消した日の id に戻ってしまう');
  assert.equal(nextDayId([...draft, ...stored]), 'day3', '保存済みの id も数えれば使い回さない');
  assert.equal(nextDayId([...draft, ...stored, { id: 'day3' }]), 'day4', '下書きで足した日があれば、その次');
});

// ---------- 入力の検証に使う小さな道具（スタッフ画面も同じものを使う） ----------
test('len / inRange / PRINTABLE / hasOwn：データ層と同じ数え方・判定。スタッフ画面（admin.js）は自分で定義せずこれを import する', () => {
  assert.equal(len(''), 0);
  assert.equal(len('あいう'), 3);
  assert.equal(len('a😀b'), 3, 'コードポイントで数える（UTF-16 の長さではない）');
  assert.equal('a😀b'.length, 4);
  assert.equal(inRange(LIMITS.days.min, LIMITS.days) && inRange(LIMITS.days.max, LIMITS.days), true);
  assert.equal(inRange(LIMITS.days.min - 1, LIMITS.days) || inRange(LIMITS.days.max + 1, LIMITS.days), false);
  assert.equal(PRINTABLE.test(''), true, '空は有効（欧文の欄は空でもよい）');
  assert.equal(PRINTABLE.test('SPONSOR AWARD ~!'), true);
  assert.equal(PRINTABLE.test('ガチャ') || PRINTABLE.test('a\tb') || PRINTABLE.test('é'), false);
  assert.equal(PRINTABLE.test('abc'), PRINTABLE.test('abc'), 'g フラグが無い＝何度呼んでも同じ');
  assert.equal(hasOwn({ a: 1 }, 'a'), true);
  assert.equal(hasOwn({ a: undefined }, 'a'), true);
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(hasOwn({}, k), false, k);
  assert.equal(hasOwn(Object.create(null), 'x'), false, 'プロトタイプの無い入れ物でも例外なし');
  // admin.js は node では読み込めない（document が要る）ので、ソースの文字で確かめる：自前の定義は無く、profile.js から import している
  const src = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
  const imported = /import \{([^}]*)\} from '\.\/profile\.js'/.exec(src)?.[1] ?? '';
  for (const name of ['len', 'inRange', 'PRINTABLE', 'hasOwn']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(imported), `admin.js は ${name} を profile.js から import する`);
    assert.ok(!new RegExp(`\\b(const|let|var|function)\\s+${name}\\b`).test(src), `admin.js は ${name} を自分で定義しない`);
  }
  assert.ok(!/\b(const|let|var|function)\s+own\b/.test(src), 'admin.js に own（hasOwn の複製）が残っていない');
});

// ---------- planBoxSettings ----------
/** 抽選がまだ無い状態の「今」。初期本数は電波祭2026 の既定（両日とも同じ） */
function world({ drawsByDay = {}, drawsByPrize = {}, activeDayId = 'day1' } = {}) {
  const config = createDefaultConfig();
  const init = createDefaultInitials();
  const inventory = [];
  for (const d of config.days) for (const p of config.prizes) {
    const n = init[d.id][p.id];
    inventory.push({ key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 });
  }
  return { config, inventory, drawsByDay, drawsByPrize, activeDayId };
}
/** 今のとおりの「まるごとの一覧」（何も変えない入力） */
function same(w) {
  const initials = {};
  for (const r of w.inventory) (initials[r.dayId] ||= {})[r.prizeId] = r.initial;
  return structuredClone({ days: w.config.days, categories: w.config.categories, prizes: w.config.prizes, initials });
}
const plan = (w, edit) => { const input = same(w); edit?.(input); return planBoxSettings(w, input); };
const fails = (r, code, detail) => { assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200)); assert.equal(r.code, code, JSON.stringify(r)); if (detail !== undefined) assert.equal(r.detail, detail); };
const rowOf = (r, key) => r.puts.find((x) => x.key === key);

test('planBoxSettings：何も変えなければ何も書かない', () => {
  const w = world();
  const r = plan(w);
  assert.equal(r.ok, true);
  assert.deepEqual([r.puts, r.deletes, r.changes], [[], [], []]);
  assert.deepEqual(r.config, w.config);
  // 抽選が始まっていても同じ
  const r2 = plan(world({ drawsByDay: { day1: 5 }, drawsByPrize: { 'sticker-denpasai': 5 } }));
  assert.deepEqual([r2.ok, r2.puts, r2.deletes, r2.changes], [true, [], [], []]);
  // initials を省いても、既存の行はそのまま
  const r3 = plan(w, (i) => { delete i.initials; });
  assert.deepEqual([r3.ok, r3.puts, r3.deletes], [true, [], []]);
});

test('planBoxSettings：入力も「今」も書き換えない（凍結しても例外なし）', () => {
  const w = world({ drawsByDay: { day1: 1 }, drawsByPrize: { greenland: 1 } });
  deepFreeze(w);
  const input = deepFreeze((() => { const i = same(w); i.days.push({ id: 'day3', label: '3日目' }); i.prizes.push({ id: 'new-1', categoryId: 'rare', name: '新', countUnknown: false }); i.prizes = i.prizes.filter((p) => p.id !== 'bulldak'); return i; })());
  const r = planBoxSettings(w, input);
  assert.equal(r.ok, true, JSON.stringify(r));
  r.puts.forEach((row) => { row.initial = 99; });
  assert.equal(w.inventory.every((x) => x.initial !== 99), true);
});

test('planBoxSettings：景品・賞・開催日の名前などの変更はいつでもできる（抽選があっても）', () => {
  const w = world({ drawsByDay: { day1: 7, day2: 2 }, drawsByPrize: { greenland: 3, 'sticker-denpasai': 6 }, activeDayId: 'day2' });
  const r = plan(w, (i) => {
    i.days[0].label = '初日';
    i.days[1].label = '  最終日  ';
    const sponsor = i.categories.find((c) => c.id === 'sponsor');
    Object.assign(sponsor, { name: '特別賞', tier: 'rare', latin: 'MY AWARD' });
    const g = i.prizes.find((p) => p.id === 'greenland');
    Object.assign(g, { name: '招待券（改）', countUnknown: true, categoryId: 'sticker' });
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.config.days, [{ id: 'day1', label: '初日' }, { id: 'day2', label: '最終日' }]);
  assert.deepEqual(r.config.categories[0], { id: 'sponsor', name: '特別賞', tier: 'rare', latin: 'MY AWARD' });
  assert.deepEqual(r.config.prizes[0], { id: 'greenland', categoryId: 'sticker', name: '招待券（改）', countUnknown: true });
  assert.deepEqual([r.puts, r.deletes], [[], []], '在庫は動かない');
  assert.deepEqual(r.changes, [
    { day: 'day1', from: '1日目', to: '初日' },
    { day: 'day2', from: '2日目', to: '最終日' },
    { category: 'sponsor', from: '協賛特別賞', to: '特別賞' },
    { category: 'sponsor', tier: { from: 'sponsor', to: 'rare' } },
    { category: 'sponsor', latin: { from: 'SPONSOR AWARD', to: 'MY AWARD' } },
    { prize: 'greenland', from: 'グリーンランド招待券', to: '招待券（改）' },
    { prize: 'greenland', countUnknown: true },
    { prize: 'greenland', categoryId: { from: 'sponsor', to: 'sticker' } },
  ]);
  assert.deepEqual(normalizeConfig(r.config), r.config, '結果は正規化済み');
});

test('planBoxSettings：初期本数の変更は、その日にまだ抽選が無いときだけ（残数も同じ値に・調整は 0 に）', () => {
  const w = world({ drawsByDay: { day1: 4 }, drawsByPrize: { greenland: 4 } });
  // 抽選の無い day2：変えられる。残数も揃い、±調整の履歴は 0 に戻る
  w.inventory.find((r) => r.key === 'day2:ezo').remaining = 1;
  w.inventory.find((r) => r.key === 'day2:ezo').adjust = -2;
  const ok = plan(w, (i) => { i.initials.day2.ezo = 7; i.initials.day2.greenland = 0; });
  assert.equal(ok.ok, true);
  assert.deepEqual(rowOf(ok, 'day2:ezo'), { key: 'day2:ezo', dayId: 'day2', prizeId: 'ezo', initial: 7, remaining: 7, adjust: 0 });
  assert.deepEqual(rowOf(ok, 'day2:greenland'), { key: 'day2:greenland', dayId: 'day2', prizeId: 'greenland', initial: 0, remaining: 0, adjust: 0 });
  assert.equal(ok.puts.length, 2);
  assert.deepEqual(ok.changes, [
    { dayId: 'day2', prizeId: 'greenland', initial: { from: 3, to: 0 } },
    { dayId: 'day2', prizeId: 'ezo', initial: { from: 3, to: 7 } },
  ]);
  // 抽選のあった day1：同じ値なら通る。違う値は DAY_HAS_DRAWS
  assert.equal(plan(w, (i) => { i.initials.day1.ezo = 3; }).ok, true);
  fails(plan(w, (i) => { i.initials.day1.ezo = 4; }), 'DAY_HAS_DRAWS', 'day1');
  fails(plan(w, (i) => { i.initials.day1.ezo = 4; i.initials.day2.ezo = 5; }), 'DAY_HAS_DRAWS', 'day1');
  // 行が一部の日だけ省かれていても、その日の既存の行は変わらない
  assert.equal(plan(w, (i) => { delete i.initials.day1; }).ok, true);
});

test('planBoxSettings：景品を追加すると全ての日に行ができる（抽選が始まった日は 0 本から）', () => {
  const w = world();
  const add = (i) => { i.prizes.push({ id: 'new-prize', categoryId: 'rare', name: '新しい景品', countUnknown: true }); };
  const r = plan(w, (i) => { add(i); i.initials.day1['new-prize'] = 5; i.initials.day2['new-prize'] = 8; });
  assert.equal(r.ok, true);
  assert.deepEqual(r.puts, [
    { key: 'day1:new-prize', dayId: 'day1', prizeId: 'new-prize', initial: 5, remaining: 5, adjust: 0 },
    { key: 'day2:new-prize', dayId: 'day2', prizeId: 'new-prize', initial: 8, remaining: 8, adjust: 0 },
  ]);
  assert.deepEqual(r.config.prizes.at(-1), { id: 'new-prize', categoryId: 'rare', name: '新しい景品', countUnknown: true });
  assert.deepEqual(r.changes, [{ prize: 'new-prize', add: '新しい景品', categoryId: 'rare', initials: { day1: 5, day2: 8 } }]);
  // 本数を渡さなければ 0 本
  const zero = plan(w, add);
  assert.deepEqual(zero.puts.map((x) => [x.key, x.initial, x.remaining]), [['day1:new-prize', 0, 0], ['day2:new-prize', 0, 0]]);
  assert.deepEqual(zero.changes, [{ prize: 'new-prize', add: '新しい景品', categoryId: 'rare' }]);
  // 抽選が始まった day1 は 0 本から。0 以外は DAY_HAS_DRAWS
  const started = world({ drawsByDay: { day1: 2 } });
  const okStarted = plan(started, (i) => { add(i); i.initials.day1['new-prize'] = 0; i.initials.day2['new-prize'] = 9; });
  assert.deepEqual(okStarted.puts.map((x) => [x.key, x.initial]), [['day1:new-prize', 0], ['day2:new-prize', 9]]);
  fails(plan(started, (i) => { add(i); i.initials.day1['new-prize'] = 1; }), 'DAY_HAS_DRAWS', 'day1');
  assert.equal(plan(started, (i) => { add(i); i.initials.day2['new-prize'] = 1; }).ok, true, '抽選の無い日は本数を入れられる');
});

test('planBoxSettings：景品の削除は、その景品の抽選が1件も無いときだけ（全ての日の行を消す）', () => {
  const w = world();
  const drop = (id) => (i) => { i.prizes = i.prizes.filter((p) => p.id !== id); };
  const r = plan(w, drop('bulldak'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.deletes.sort(), ['day1:bulldak', 'day2:bulldak']);
  assert.equal(r.config.prizes.some((p) => p.id === 'bulldak'), false);
  assert.deepEqual(r.puts, []);
  assert.deepEqual(r.changes, [{ prize: 'bulldak', remove: 'カムジャ麺' }]);
  // 抽選が1件でもあれば PRIZE_HAS_DRAWS（その日が今日でなくても・別の日の抽選でも）
  fails(plan(world({ drawsByPrize: { bulldak: 1 }, drawsByDay: { day2: 1 } }), drop('bulldak')), 'PRIZE_HAS_DRAWS', 'bulldak');
  // ほかの景品に抽選があっても、この景品は消せる
  assert.equal(plan(world({ drawsByPrize: { greenland: 9 }, drawsByDay: { day1: 9 } }), drop('bulldak')).ok, true);
  // 消したあと、その景品を参照していた賞は空になるだけ（賞は残る）
  const all = plan(w, (i) => { i.prizes = i.prizes.filter((p) => p.categoryId !== 'rare'); });
  assert.equal(all.ok, true);
  assert.equal(all.deletes.length, 4);
});

test('planBoxSettings：賞の追加・名前/系統/欧文の変更はいつでも、削除は景品が1つも無いときだけ', () => {
  const w = world({ drawsByDay: { day1: 3 }, drawsByPrize: { 'rare-denpasai': 3 } });
  // 追加（欧文を渡さなければ系統の既定）
  const r = plan(w, (i) => { i.categories.push({ id: 'extra', name: ' 特別枠 ', tier: 'rare' }); i.categories.push({ id: 'extra2', name: 'もう一つ', tier: 'sponsor', latin: ' MY EXTRA ' }); });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.categories.slice(-2), [
    { id: 'extra', name: '特別枠', tier: 'rare', latin: 'RARE PRIZE' },
    { id: 'extra2', name: 'もう一つ', tier: 'sponsor', latin: 'MY EXTRA' },
  ]);
  assert.deepEqual(r.puts, []);
  assert.deepEqual(r.changes[0], { category: 'extra', add: '特別枠', tier: 'rare', latin: 'RARE PRIZE' });
  // 欧文を渡さない既存の賞は今の欧文のまま
  const keep = plan(w, (i) => { delete i.categories[0].latin; });
  assert.equal(keep.config.categories[0].latin, 'SPONSOR AWARD');
  // 景品を別の賞へ移し、空になった賞を消す
  const gone = plan(w, (i) => {
    for (const p of i.prizes) if (p.categoryId === 'rare') p.categoryId = 'sticker';
    i.categories = i.categories.filter((c) => c.id !== 'rare');
  });
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.config.categories.map((c) => c.id), ['sponsor', 'sticker']);
  assert.deepEqual(gone.changes.filter((c) => c.category), [{ category: 'rare', remove: 'レアステッカー賞' }]);
  // 景品が残っている賞は消せない
  fails(plan(w, (i) => { i.categories = i.categories.filter((c) => c.id !== 'rare'); }), 'BAD_REQUEST', 'prize-category');
  // 並べ替えは自由
  assert.deepEqual(plan(w, (i) => { i.categories.reverse(); }).config.categories.map((c) => c.id), ['sticker', 'rare', 'sponsor']);
  // 形が悪い賞
  fails(plan(w, (i) => { i.categories[0].tier = 'gold'; }), 'BAD_REQUEST');
  fails(plan(w, (i) => { i.categories[0].latin = '日本語'; }), 'BAD_REQUEST');
  fails(plan(w, (i) => { i.categories[0].latin = 'A'.repeat(25); }), 'BAD_REQUEST');
  fails(plan(w, (i) => { i.categories[0].name = '  '; }), 'BAD_REQUEST');
  fails(plan(w, (i) => { i.categories[0].name = 'あ'.repeat(41); }), 'BAD_REQUEST');
  assert.equal(plan(w, (i) => { i.categories[0].name = 'あ'.repeat(40); i.categories[0].latin = 'A'.repeat(24); }).ok, true);
  fails(plan(w, (i) => { i.categories.push({ id: 'Bad Id', name: 'x', tier: 'rare' }); }), 'BAD_REQUEST');
  fails(plan(w, (i) => { i.categories.push({ ...i.categories[0] }); }), 'BAD_REQUEST', 'category-id');
});

test('planBoxSettings：開催日の追加は末尾に day<n>（全ての景品に行を作る）、名前の変更はいつでも', () => {
  const w = world({ drawsByDay: { day1: 3, day2: 3 }, activeDayId: 'day2' });
  const r = plan(w, (i) => {
    i.days.push({ id: 'day3', label: '3日目' });
    i.initials.day3 = { greenland: 3, bulldak: 50 };   // 渡さなかった景品は 0
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.config.days, [{ id: 'day1', label: '1日目' }, { id: 'day2', label: '2日目' }, { id: 'day3', label: '3日目' }]);
  assert.equal(r.puts.length, 7);
  assert.deepEqual(rowOf(r, 'day3:greenland'), { key: 'day3:greenland', dayId: 'day3', prizeId: 'greenland', initial: 3, remaining: 3, adjust: 0 });
  assert.deepEqual(rowOf(r, 'day3:bulldak'), { key: 'day3:bulldak', dayId: 'day3', prizeId: 'bulldak', initial: 50, remaining: 50, adjust: 0 });
  assert.equal(rowOf(r, 'day3:ezo').initial, 0);
  assert.deepEqual(r.deletes, []);
  assert.deepEqual(r.changes, [{ day: 'day3', add: '3日目', initials: { greenland: 3, bulldak: 50 } }]);
  // id の形・重複・位置
  fails(plan(w, (i) => { i.days.push({ id: 'third', label: '3日目' }); }), 'BAD_REQUEST', 'day-id');
  fails(plan(w, (i) => { i.days.push({ id: 'day1234', label: '3日目' }); }), 'BAD_REQUEST', 'day-id');
  fails(plan(w, (i) => { i.days.push({ id: 'day2', label: '重複' }); }), 'BAD_REQUEST', 'day-id');
  fails(plan(w, (i) => { i.days.unshift({ id: 'day3', label: '先頭' }); }), 'BAD_REQUEST', 'days-order');
  fails(plan(w, (i) => { i.days.splice(1, 0, { id: 'day3', label: '途中' }); }), 'BAD_REQUEST', 'days-order');
  fails(plan(w, (i) => { i.days.push({ id: 'day3', label: '' }); }), 'BAD_REQUEST', 'day-label');
  assert.equal(plan(w, (i) => { i.days.push({ id: 'day12', label: '3日目' }); }).ok, true, '番号は空いていれば何でもよい');
  // 名前の変更は抽選があっても可。並べ替えは不可
  assert.equal(plan(w, (i) => { i.days[1].label = '二日め'; }).ok, true);
  fails(plan(w, (i) => { i.days.reverse(); }), 'BAD_REQUEST', 'days-order');
  fails(plan(w, (i) => { i.days[0].id = 'day9'; }), 'BAD_REQUEST', 'days-order');
  fails(plan(w, (i) => { i.days[0].label = 'あ'.repeat(13); }), 'BAD_REQUEST', 'day-label');
  assert.equal(plan(w, (i) => { i.days[0].label = 'あ'.repeat(12); }).ok, true);
  // 景品の追加と同時でも、新しい日の行は新しい景品ぶんまで作る
  const both = plan(w, (i) => {
    i.days.push({ id: 'day3', label: '3日目' });
    i.prizes.push({ id: 'p-new', categoryId: 'sticker', name: '新', countUnknown: false });
    i.initials.day3 = { 'p-new': 4 };
  });
  assert.equal(both.ok, true);
  assert.equal(both.puts.length, 3 * 8 - 14, '(日3 × 景品8) − 既存14');
  assert.equal(rowOf(both, 'day3:p-new').initial, 4);
  assert.equal(rowOf(both, 'day1:p-new').initial, 0);
});

test('planBoxSettings：開催日を消せるのは「最後の日」で、抽選が無く、開催中でもないときだけ', () => {
  const dropLast = (i) => { i.days.pop(); };
  const w = world({ activeDayId: 'day1' });
  const r = plan(w, dropLast);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.days, [{ id: 'day1', label: '1日目' }]);
  assert.deepEqual(r.deletes.sort(), ['day2:bulldak', 'day2:ezo', 'day2:greenland', 'day2:rare-denpasai', 'day2:rare-ibaraki', 'day2:sticker-denpasai', 'day2:sticker-ibaraki']);
  assert.deepEqual(r.changes, [{ day: 'day2', remove: '2日目' }]);
  // 抽選があった日・開催中の日は DAY_LOCKED
  fails(plan(world({ drawsByDay: { day2: 1 } }), dropLast), 'DAY_LOCKED', 'day2');
  fails(plan(world({ activeDayId: 'day2' }), dropLast), 'DAY_LOCKED', 'day2');
  // 抽選が前の日だけなら消せる
  assert.equal(plan(world({ drawsByDay: { day1: 9 } }), dropLast).ok, true);
  // 最後の日でない日は消せない（番号 <日>-<連番> が重なる）／全部は消せない／入れ替えは不可
  fails(plan(world(), (i) => { i.days.shift(); }), 'BAD_REQUEST', 'days-order');
  fails(plan(world(), (i) => { i.days = []; }), 'BAD_REQUEST', 'days');
  const three = world();
  const added = planBoxSettings(three, (() => { const i = same(three); i.days.push({ id: 'day3', label: '3日目' }); return i; })());
  const w3 = { ...three, config: added.config, inventory: [...three.inventory, ...added.puts] };
  assert.equal(plan(w3, (i) => { i.days.pop(); }).ok, true, '追加した日は消せる');
  fails(plan(w3, (i) => { i.days.splice(1, 1); }), 'BAD_REQUEST', 'days-order');
  // 最後の2日を一度に消す：どちらも条件を満たすときだけ
  assert.equal(plan(w3, (i) => { i.days.splice(1, 2); }).ok, true);
  fails(plan({ ...w3, drawsByDay: { day2: 1 } }, (i) => { i.days.splice(1, 2); }), 'DAY_LOCKED', 'day2');
  // 消す日の末尾に別の新しい日を足す（置き換え）も、消す日が条件を満たせば可
  const swap = plan(w, (i) => { i.days.pop(); i.days.push({ id: 'day3', label: '三日目' }); });
  assert.equal(swap.ok, true);
  assert.deepEqual(swap.config.days.map((d) => d.id), ['day1', 'day3']);
  assert.equal(swap.puts.length, 7);
  assert.equal(swap.deletes.length, 7);
});

test('planBoxSettings：上限（開催日7・賞12・景品40）と最低1つ', () => {
  const w = world();
  const days = (n) => (i) => { for (let k = 3; k <= n; k++) i.days.push({ id: `day${k}`, label: `${k}日目` }); };
  assert.equal(plan(w, days(7)).ok, true);
  fails(plan(w, days(8)), 'BAD_REQUEST', 'days');
  const cats = (n) => (i) => { for (let k = i.categories.length; k < n; k++) i.categories.push({ id: `c${k}`, name: `賞${k}`, tier: 'sticker' }); };
  assert.equal(plan(w, cats(12)).ok, true);
  fails(plan(w, cats(13)), 'BAD_REQUEST', 'categories');
  const prizes = (n) => (i) => { for (let k = i.prizes.length; k < n; k++) i.prizes.push({ id: `p${k}`, categoryId: 'sticker', name: `景品${k}`, countUnknown: false }); };
  assert.equal(plan(w, prizes(40)).ok, true);
  fails(plan(w, prizes(41)), 'BAD_REQUEST', 'prizes');
  fails(plan(w, (i) => { i.prizes = []; }), 'BAD_REQUEST', 'prizes');
  fails(plan(w, (i) => { i.categories = []; i.prizes = []; }), 'BAD_REQUEST', 'categories');
  // 最大の構成のまま、最後の1つ手前まで減らせる
  const big = world();
  const grown = planBoxSettings(big, (() => { const i = same(big); days(7)(i); cats(12)(i); prizes(40)(i); return i; })());
  assert.equal(grown.ok, true);
  assert.equal(grown.puts.length, 7 * 40 - 14);
  assert.equal(LIMITS.days.max * LIMITS.prizes.max, 280);
});

test('planBoxSettings：id・名前・本数・形の検証（BAD_REQUEST）', () => {
  const w = world();
  const bad = (edit, detail) => fails(plan(w, edit), 'BAD_REQUEST', detail);
  // 景品
  bad((i) => { i.prizes.push({ id: 'Bad Id', categoryId: 'rare', name: 'x' }); }, 'prize-id');
  bad((i) => { i.prizes.push({ id: 'x'.repeat(41), categoryId: 'rare', name: 'x' }); }, 'prize-id');
  bad((i) => { i.prizes.push({ id: '', categoryId: 'rare', name: 'x' }); }, 'prize-id');
  bad((i) => { i.prizes.push({ id: 'greenland', categoryId: 'rare', name: '重複' }); }, 'prize-id');
  bad((i) => { i.prizes.push({ id: 'n1', categoryId: 'nope', name: 'x' }); }, 'prize-category');
  bad((i) => { i.prizes.push({ id: 'n1', name: 'x' }); }, 'prize-category');
  bad((i) => { i.prizes.push({ id: 'n1', categoryId: 'rare', name: '   ' }); }, 'prize-name');
  bad((i) => { i.prizes.push({ id: 'n1', categoryId: 'rare', name: 'あ'.repeat(61) }); }, 'prize-name');
  bad((i) => { i.prizes.push({ id: 'n1', categoryId: 'rare' }); }, 'prize-name');
  bad((i) => { i.prizes.push(null); }, 'prize-id');
  assert.equal(plan(w, (i) => { i.prizes.push({ id: 'n1', categoryId: 'rare', name: 'あ'.repeat(60) }); }).ok, true);
  // 今ある id は、形が今の規則に合わなくても（古いデータ）そのまま使える
  const odd = world();
  odd.config.prizes[0].id = 'Old_Id';
  odd.inventory = odd.inventory.map((r) => (r.prizeId === 'greenland' ? { ...r, key: `${r.dayId}:Old_Id`, prizeId: 'Old_Id' } : r));
  assert.equal(plan(odd).ok, true);
  // 形そのもの
  for (const broken of [undefined, null, 'x', 5, [], {}, { days: [], categories: [], prizes: 'x' }]) fails(planBoxSettings(w, broken), 'BAD_REQUEST');
  for (const cur of [undefined, null, {}, { config: 'x' }]) fails(planBoxSettings(cur, same(w)), 'BAD_REQUEST');
  bad((i) => { i.initials = 'x'; }, 'initials');
  bad((i) => { i.initials = []; }, 'initials');
  // 本数
  for (const v of [-1, 1.5, '3', NaN, Infinity, 100001, true, {}]) bad((i) => { i.initials.day2.greenland = v; }, 'initial');
  assert.equal(plan(w, (i) => { i.initials.day2.greenland = 100000; }).ok, true);
  assert.equal(plan(w, (i) => { i.initials.day2.greenland = 0; }).ok, true);
  assert.equal(plan(w, (i) => { i.initials.day2.greenland = null; }).ok, true, 'null は「渡さない」と同じ');
  // 知らない日・景品の本数は無視する（消した景品の本数が残っていても困らない）
  const ign = plan(w, (i) => { i.initials.day9 = { greenland: 1 }; i.initials.day1.ghost = 5; });
  assert.deepEqual([ign.ok, ign.puts], [true, []]);
  // 'constructor' など継承されるプロパティを本数や抽選数として読まない
  const proto = world();
  proto.config.prizes.push({ id: 'constructor', categoryId: 'rare', name: '名前が constructor', countUnknown: false });
  const pr = planBoxSettings(proto, (() => { const i = same(proto); return i; })());
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.deepEqual(pr.puts.map((x) => [x.key, x.initial]), [['day1:constructor', 0], ['day2:constructor', 0]], '行が無い景品は 0 本の行を作る');
});

test('planBoxSettings：複数の操作をまとめて行う（追加・削除・名前・本数・日）', () => {
  const w = world({ drawsByDay: { day1: 10 }, drawsByPrize: { 'sticker-denpasai': 10 }, activeDayId: 'day1' });
  const r = plan(w, (i) => {
    i.prizes = i.prizes.filter((p) => p.id !== 'rare-ibaraki');
    i.prizes.push({ id: 'extra-1', categoryId: 'sponsor', name: '追加の景品', countUnknown: false });
    i.categories.push({ id: 'new-cat', name: '新しい賞', tier: 'rare', latin: 'NEW' });
    i.prizes.push({ id: 'extra-2', categoryId: 'new-cat', name: '追加の景品2', countUnknown: true });
    i.initials.day2['sticker-ibaraki'] = 12;
    i.initials.day2['extra-1'] = 2;
    i.days.push({ id: 'day3', label: '3日目' });
    i.initials.day3 = { 'extra-1': 1, 'sticker-denpasai': 30 };
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.deletes.sort(), ['day1:rare-ibaraki', 'day2:rare-ibaraki']);
  assert.equal(r.config.prizes.length, 8);
  assert.equal(r.config.categories.length, 4);
  assert.equal(r.config.days.length, 3);
  const keys = new Set(w.inventory.map((x) => x.key));
  for (const d of r.config.days) for (const p of r.config.prizes) assert.ok(keys.has(`${d.id}:${p.id}`) || rowOf(r, `${d.id}:${p.id}`), `${d.id}:${p.id} の行がある`);
  assert.equal(rowOf(r, 'day2:sticker-ibaraki').initial, 12);
  assert.equal(rowOf(r, 'day2:extra-1').initial, 2);
  assert.equal(rowOf(r, 'day1:extra-1').initial, 0, '抽選が始まった day1 は 0 本から');
  assert.equal(rowOf(r, 'day3:sticker-denpasai').initial, 30);
  assert.deepEqual(normalizeConfig(r.config), r.config);
  assertValidConfig(r.config, 'plan');
  // 結果の config と行を「今」に適用して、もう一度同じ入力を出しても何も変わらない
  const applied = { ...w, config: r.config, inventory: [...w.inventory.filter((x) => !r.deletes.includes(x.key) && !r.puts.some((p) => p.key === x.key)), ...r.puts] };
  const again = planBoxSettings(applied, same(applied));
  assert.deepEqual([again.ok, again.puts, again.deletes, again.changes], [true, [], [], []]);
});

// ---------- 設定ファイル ----------
function profileWorld() {
  const config = { ...createDefaultConfig(), pinHash: 'secret-hash', sound: { enabled: false, volume: 0.1 } };
  const w = world();
  w.inventory.find((r) => r.key === 'day1:greenland').remaining = 0;     // 残数ではなく初期本数が出る
  w.inventory.find((r) => r.key === 'day2:bulldak').adjust = 5;
  return { config, inventory: w.inventory };
}

test('exportProfile：config（pinHash・効果音を除く）と日別の初期本数', () => {
  const { config, inventory } = profileWorld();
  const f = exportProfile(config, inventory, 1790000000000);
  assert.deepEqual(Object.keys(f).sort(), ['app', 'exportedAt', 'kind', 'profile', 'profileVersion']);
  assert.deepEqual([f.app, f.kind, f.profileVersion, f.exportedAt], ['yosoro-gacha', 'profile', 1, 1790000000000]);
  assert.equal('pinHash' in f.profile.config, false);
  assert.equal('sound' in f.profile.config, false);
  assert.equal(f.profile.config.schemaVersion, 2);
  const { pinHash: _p, sound: _s, ...rest } = normalizeConfig(config);
  assert.deepEqual(f.profile.config, rest);
  assert.deepEqual(f.profile.initials, createDefaultInitials(), '初期本数（残数 0 の greenland も 3）');
  assert.equal(JSON.stringify(f).includes('secret-hash'), false);
  assert.equal(typeof exportProfile(config, inventory).exportedAt, 'number', 'now は省略できる');
  // 行が無い日×景品は 0 本。v1 の config でも書き出せる
  const partial = exportProfile(v1Config(), [{ key: 'day1:ezo', dayId: 'day1', prizeId: 'ezo', initial: 9, remaining: 1 }, { key: 'day2:ezo', initial: -5 }, null]);
  assert.equal(partial.profile.initials.day1.ezo, 9);
  assert.equal(partial.profile.initials.day2.ezo, 0, '不正な値は 0');
  assert.equal(partial.profile.initials.day1.greenland, 0);
  assert.deepEqual(Object.keys(partial.profile.initials.day1), v1Config().prizes.map((p) => p.id));
  assert.deepEqual(partial.profile.config.categories.map((c) => c.latin), ['SPONSOR AWARD', 'RARE STICKER', 'STICKER']);
});

test('設定ファイル：書き出し → JSON → 検証で元に戻る（PIN・効果音は含まれず、読み込み側で既定）', () => {
  const { config, inventory } = profileWorld();
  config.eventName = '別のイベント';
  config.brand = { ...config.brand, name: 'べつがちゃ', nameLatin: 'BETSU', wordmark: null };
  config.theme = { preset: 'sakura', custom: null };
  config.motif = 'garapon';
  config.days = [{ id: 'day1', label: '当日' }];
  const inv = inventory.filter((r) => r.dayId === 'day1');
  const text = JSON.stringify(exportProfile(config, inv));
  const v = validateProfileFile(JSON.parse(text));
  assert.equal(v.ok, true, v.error);
  assert.equal(v.config.pinHash, null);
  assert.deepEqual(v.config.sound, { enabled: true, volume: 0.7 });
  assert.deepEqual(v.config, { ...normalizeConfig(config), pinHash: null, sound: { enabled: true, volume: 0.7 } });
  assert.equal(v.config.brand.wordmark, null);
  assert.deepEqual(Object.keys(v.initials), ['day1']);
  assert.deepEqual(v.initials.day1, createDefaultInitials().day1);
  assertValidConfig(v.config, 'profile');
  // 本数の欠けは 0。知らない日・景品の本数は無視
  const f = exportProfile(createDefaultConfig(), []);
  delete f.profile.initials.day2;
  delete f.profile.initials.day1.greenland;
  f.profile.initials.day9 = { x: 1 };
  f.profile.initials.day1.ghost = 99;
  const v2 = validateProfileFile(f);
  assert.equal(v2.ok, true);
  assert.equal(Object.keys(v2.initials).length, 2);
  assert.equal(v2.initials.day1.greenland, 0);
  assert.equal(v2.initials.day2.ezo, 0);
  assert.equal('ghost' in v2.initials.day1, false);
  // ファイルに pinHash・sound が混ざっていても使わない
  const sneaky = exportProfile(createDefaultConfig(), []);
  sneaky.profile.config.pinHash = 'evil';
  sneaky.profile.config.sound = { enabled: false, volume: 0 };
  const v3 = validateProfileFile(sneaky);
  assert.equal(v3.config.pinHash, null);
  assert.deepEqual(v3.config.sound, { enabled: true, volume: 0.7 });
});

test('validateProfileFile：別のファイル・新しい版・壊れた中身は日本語の理由つきで断る', () => {
  const good = () => JSON.parse(JSON.stringify(exportProfile(createDefaultConfig(), [])));
  const err = (obj) => { const v = validateProfileFile(obj); assert.equal(v.ok, false, JSON.stringify(obj)?.slice(0, 120)); assert.equal(typeof v.error, 'string'); assert.ok(v.error.length > 0); return v.error; };
  assert.equal(validateProfileFile(good()).ok, true);
  for (const x of [null, undefined, 'x', 5, [], true]) err(x);
  assert.match(err({ ...good(), app: 'other' }), /設定ファイルではありません/);
  assert.match(err({ ...good(), app: undefined }), /設定ファイルではありません/);
  assert.match(err({ ...good(), kind: 'backup' }), /設定ファイルではありません/);
  assert.match(err({ app: 'yosoro-gacha', schemaVersion: 2, meta: [], inventory: [], draws: [], students: [] }), /バックアップ/, 'バックアップを渡されたら、そう伝える');
  assert.equal(err({ ...good(), profileVersion: 2 }), '新しいバージョンの設定ファイルです。アプリを更新してください');
  assert.equal(err({ ...good(), profileVersion: 99 }), '新しいバージョンの設定ファイルです。アプリを更新してください');
  for (const v of [undefined, 0, -1, 1.5, '1', null]) assert.match(err({ ...good(), profileVersion: v }), /バージョン/, String(v));
  for (const p of [undefined, null, 5, [], {}, { config: {} }, { config: {}, initials: {} }, { initials: {} }, { config: [], initials: {} }, { config: createDefaultConfig(), initials: [] }]) {
    err({ ...good(), profile: p });
  }
  // 開催日・賞・景品の構造
  const withCfg = (edit) => { const f = good(); edit(f.profile.config); return f; };
  err(withCfg((c) => { delete c.days; }));
  err(withCfg((c) => { delete c.categories; }));
  err(withCfg((c) => { c.prizes = 'x'; }));
  err(withCfg((c) => { c.days = []; }));
  err(withCfg((c) => { c.days = Array.from({ length: 8 }, (_, i) => ({ id: `day${i + 1}`, label: `${i + 1}` })); }));
  assert.equal(validateProfileFile(withCfg((c) => { c.days = Array.from({ length: 7 }, (_, i) => ({ id: `day${i + 1}`, label: `${i + 1}` })); })).ok, true);
  err(withCfg((c) => { c.days[0].id = 'first'; }));
  err(withCfg((c) => { c.days[1].id = 'day1'; }));
  err(withCfg((c) => { c.days[0].label = ''; }));
  err(withCfg((c) => { c.days[0].label = 'あ'.repeat(13); }));
  err(withCfg((c) => { c.days[0] = null; }));
  err(withCfg((c) => { c.categories = []; }));
  err(withCfg((c) => { c.categories = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, name: 'x', tier: 'rare' })); c.prizes = [{ id: 'p', categoryId: 'c0', name: 'x' }]; }));
  err(withCfg((c) => { c.categories[1].id = 'sponsor'; }));
  err(withCfg((c) => { c.categories[0].id = 'Bad Id'; }));
  err(withCfg((c) => { c.categories[0].name = ' '; }));
  err(withCfg((c) => { c.categories[0].name = 'あ'.repeat(41); }));
  err(withCfg((c) => { c.prizes = []; }));
  err(withCfg((c) => { c.prizes = Array.from({ length: 41 }, (_, i) => ({ id: `p${i}`, categoryId: 'rare', name: 'x' })); }));
  err(withCfg((c) => { c.prizes[0].categoryId = 'nope'; }));
  err(withCfg((c) => { delete c.prizes[0].categoryId; }));
  err(withCfg((c) => { c.prizes[1].id = c.prizes[0].id; }));
  err(withCfg((c) => { c.prizes[0].name = ''; }));
  err(withCfg((c) => { c.prizes[0].name = 'あ'.repeat(61); }));
  // 本数
  const withInit = (day, prize, v) => { const f = good(); f.profile.initials[day][prize] = v; return f; };
  for (const v of [-1, 1.5, '3', null, 100001, NaN, true, {}]) err(withInit('day1', 'greenland', v));
  assert.equal(validateProfileFile(withInit('day1', 'greenland', 100000)).ok, true);
  assert.equal(validateProfileFile(withInit('day1', 'greenland', 0)).ok, true);
  // 外見の欄は断らず整える（長すぎる名前・不正な色など）
  const lenient = good();
  Object.assign(lenient.profile.config.brand, { name: 'あ'.repeat(30), tagline: 'い'.repeat(50) });
  lenient.profile.config.theme = { preset: 'x', custom: { paper: 'bad' } };
  const lv = validateProfileFile(lenient);
  assert.equal(lv.ok, true);
  assert.equal(cp(lv.config.brand.name), 16);
  assert.equal(lv.config.theme.custom, null);
});

// ---------- バックアップの検証（v1 / v2 / v3 / 設定ファイル） ----------
function backupOf(config, schemaVersion, extra = {}) {
  const cfg = structuredClone(config);
  cfg.pinHash = 'abc';
  const init = createDefaultInitials();
  const inventory = [];
  for (const d of cfg.days) for (const p of cfg.prizes) {
    const n = init[d.id]?.[p.id] ?? 0;
    inventory.push({ key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 });
  }
  return {
    app: 'yosoro-gacha', schemaVersion, exportedAt: 1,
    meta: [{ key: 'config', value: cfg }, { key: 'activeDayId', value: cfg.days[0].id }],
    inventory, draws: [], students: [], logs: [], ...extra,
  };
}

test('validateBackup：v1（旧い config）と v2 のバックアップを受け付ける', () => {
  const v1 = backupOf(v1Config(), 1);
  assert.equal(v1.meta[0].value.schemaVersion, 1);
  assert.equal('brand' in v1.meta[0].value, false);
  const r1 = validateBackup(v1);
  assert.equal(r1.ok, true, r1.error);
  assert.deepEqual(r1.summary, { exportedAt: 1, draws: 0, students: 0, pending: null });
  const v2 = backupOf(createDefaultConfig(), 2);
  assert.equal(v2.meta[0].value.schemaVersion, 2);
  assert.equal(validateBackup(v2).ok, true);
  // 復元時に書かれる config は、どちらも同じ（v1 を復元するとよーそろの設定になる）
  assert.deepEqual(normalizeConfig(v1.meta[0].value), { ...createDefaultConfig(), pinHash: 'abc' });
  assert.deepEqual(normalizeConfig(v2.meta[0].value), { ...createDefaultConfig(), pinHash: 'abc' });
  // 版の取り違え（v2 の中身で schemaVersion 1、v1 の中身で 2）でも、中身で見る
  assert.equal(validateBackup(backupOf(createDefaultConfig(), 1)).ok, true);
  assert.equal(validateBackup(backupOf(v1Config(), 2)).ok, true);
  // 汎用テンプレート由来の v2 も通る（1日・別の賞）
  const generic = { ...normalizeConfig(templateConfig('generic').config) };
  assert.equal(validateBackup(backupOf(generic, 2)).ok, true);
});

test('validateBackup：v3 以上は「新しいバージョン」、設定ファイルは専用の案内で断る', () => {
  for (const sv of [3, 4, 99]) {
    const r = validateBackup(backupOf(createDefaultConfig(), sv));
    assert.deepEqual(r, { ok: false, error: '新しいバージョンのバックアップです。アプリを更新してください' }, String(sv));
  }
  for (const sv of [0, -1, 1.5, '2', null, undefined]) assert.equal(validateBackup({ ...backupOf(createDefaultConfig(), 2), schemaVersion: sv }).error, 'バージョン情報がありません', String(sv));
  const msg = 'これは設定ファイルです（バックアップではありません）。「設定ファイルを読み込む」から読み込んでください';
  const file = exportProfile(createDefaultConfig(), []);
  assert.deepEqual(validateBackup(file), { ok: false, error: msg });
  assert.deepEqual(validateBackup(JSON.parse(JSON.stringify(file))), { ok: false, error: msg });
  assert.deepEqual(validateBackup({ kind: 'profile' }), { ok: false, error: msg });
  assert.deepEqual(validateBackup({ ...backupOf(createDefaultConfig(), 2), kind: 'profile' }), { ok: false, error: msg });
  assert.equal(validateBackup({ ...backupOf(createDefaultConfig(), 2), kind: 'something-else' }).ok, true, 'kind が profile 以外なら関係ない');
  // これまでの理由は変わらない
  assert.equal(validateBackup(null).error, 'ファイルの形式が正しくありません');
  assert.equal(validateBackup([]).error, 'ファイルの形式が正しくありません');
  assert.equal(validateBackup({ ...backupOf(createDefaultConfig(), 2), app: 'other' }).error, 'このアプリのバックアップではありません');
  assert.equal(validateBackup({ app: 'yosoro-gacha', schemaVersion: 2, meta: [] }).error, 'inventory がありません');
});

test('validateBackup：config は正規化したうえで開催日・賞・景品の整合を見る（これまでの拒否は変わらない）', () => {
  const rejects = (edit, what) => {
    const b = backupOf(v1Config(), 1);
    edit(b.meta[0].value, b);
    const r = validateBackup(b);
    assert.equal(r.ok, false, what);
    return r.error;
  };
  assert.equal(rejects((c) => { delete c.pinHash; }, 'PIN なし'), '設定（config）が正しくありません');
  rejects((c) => { c.pinHash = null; }, 'PIN が null');
  rejects((c) => { delete c.days; }, 'days なし');
  rejects((c) => { c.days = []; }, 'days 空');
  rejects((c) => { delete c.categories; }, 'categories なし');
  rejects((c) => { c.prizes = 'x'; }, 'prizes が配列でない');
  rejects((c) => { delete c.studentIdRule; }, 'studentIdRule なし');
  rejects((c) => { c.prizes[1].id = c.prizes[0].id; }, '景品の id 重複');
  rejects((c) => { c.days[1].id = 'day1'; }, '日の id 重複');
  rejects((c) => { c.categories[1].id = 'sponsor'; }, '賞の id 重複');
  rejects((c) => { c.prizes[0].categoryId = 'nope'; }, '存在しない賞');
  rejects((c) => { c.prizes[0] = null; }, '景品が null');
  rejects((c) => { delete c.days[0].id; }, '日に id なし');
  rejects((c, b) => { b.meta[1].value = 'day9'; }, '開催日が config にない');
  rejects((c, b) => { b.inventory[0].dayId = 'day9'; b.inventory[0].key = 'day9:greenland'; }, '在庫が config にない日');
  rejects((c, b) => { b.inventory.push({ ...b.inventory[0] }); }, '在庫の重複');
  rejects((c, b) => { b.inventory[0].remaining = -1; }, '残数が負');
  assert.equal(validateBackup(null).ok, false);
  // 補完できる欠け（v2 の欄が無い・latin が無い）は受け付ける
  const lite = backupOf(v1Config(), 2);
  assert.equal(validateBackup(lite).ok, true);
  const odd = backupOf(createDefaultConfig(), 2);
  odd.meta[0].value.brand.name = 'あ'.repeat(30);
  odd.meta[0].value.theme = 'broken';
  assert.equal(validateBackup(odd).ok, true, '見た目の欄の不正は復元時に整える');
});

// ---------- 選択肢を差し替えたアンケート ----------
test('normalizeSurvey：config の選択肢で検証し、順番・ラベルは config のものが保存される', () => {
  const cfg = normalizeConfig({
    ...createDefaultConfig(),
    survey: {
      ...T().survey,
      q1: { heading: 'どこから？', short: '地域', options: [{ id: 'north', label: '北' }, { id: 'south', label: '南' }, { id: 'abroad', label: '海外' }] },
      q2: { heading: '何で来た？', short: '交通', options: [{ id: 'bus', label: 'バス' }, { id: 'train', label: '電車' }, { id: 'walk', label: '徒歩' }] },
    },
  });
  const lists = { ages: cfg.survey.q1.options, triggers: cfg.survey.q2.options };
  const r = normalizeSurvey({ v: 1, age: 'south', triggers: ['walk', 'bus'] }, lists);
  assert.deepEqual(r, { v: 1, age: 'south', triggers: ['bus', 'walk'], ageLabel: '南', triggerLabels: ['バス', '徒歩'] });
  // 既定の選択肢の id は、差し替えたあとは無効
  assert.equal(normalizeSurvey({ v: 1, age: 'college', triggers: ['bus'] }, lists), null);
  assert.equal(normalizeSurvey({ v: 1, age: 'south', triggers: ['sns'] }, lists), null);
  assert.equal(normalizeSurvey({ v: 1, age: 'south', triggers: [] }, lists), null);
  assert.equal(normalizeSurvey({ v: 1, age: 'south', triggers: ['bus', 'bus'] }, lists), null);
  assert.equal(normalizeSurvey({ v: 2, age: 'south', triggers: ['bus'] }, lists), null);
  // 既定の一覧を渡す（省略）と今までどおり
  assert.ok(normalizeSurvey({ v: 1, age: 'college', triggers: ['sns'] }));
  assert.deepEqual(normalizeSurvey({ v: 1, age: 'college', triggers: ['sns'] }), normalizeSurvey({ v: 1, age: 'college', triggers: ['sns'] }, { ages: T().survey.q1.options, triggers: T().survey.q2.options }));
  // 2つの選択肢でも成り立つ（下限）
  const two = { ages: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], triggers: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] };
  assert.deepEqual(normalizeSurvey({ age: 'b', triggers: ['y', 'x'] }, two), { v: 1, age: 'b', triggers: ['x', 'y'], ageLabel: 'B', triggerLabels: ['X', 'Y'] });
});

test('aggregateSurvey：選択肢を差し替えても、現在の一覧の順 → 履歴にだけ残る旧い選択肢（保存時ラベル）の順で数える', () => {
  const q1 = [{ id: 'north', label: '北' }, { id: 'south', label: '南' }];
  const q2 = [{ id: 'bus', label: 'バス' }, { id: 'train', label: '電車' }];
  const lists = { ages: q1, triggers: q2 };
  const g = (id, dayId, survey) => ({ id, label: id, dayId, kind: 'guest', prizeId: 'p', drawnAt: 1, ...(survey ? { survey } : {}) });
  const draws = [
    g('1-0001', 'day1', normalizeSurvey({ age: 'north', triggers: ['train', 'bus'] }, lists)),
    g('1-0002', 'day1', normalizeSurvey({ age: 'north', triggers: ['bus'] }, lists)),
    g('1-0003', 'day1', normalizeSurvey({ age: 'south', triggers: ['train'] }, lists)),
    g('1-0004', 'day1'),                                                                      // 未回答
    g('2-0001', 'day2', { v: 1, age: 'college', triggers: ['sns', 'bus'], ageLabel: '大学生・専門学生', triggerLabels: ['SNS', 'バス'] }),   // 前の選択肢での回答
    { id: '1-0005', label: '1-0005', dayId: 'day1', kind: 'student', prizeId: 'p', drawnAt: 1, studentId: '2412345' },
  ];
  const a = aggregateSurvey(draws, lists);
  assert.deepEqual([a.total, a.answered, a.unanswered], [5, 4, 1]);
  assert.deepEqual(a.ages.map((x) => [x.id, x.label, x.count, x.retired]), [['north', '北', 2, false], ['south', '南', 1, false], ['college', '大学生・専門学生', 1, true]]);
  assert.deepEqual(a.triggers.map((x) => [x.id, x.label, x.count, x.retired]), [['bus', 'バス', 3, false], ['train', '電車', 2, false], ['sns', 'SNS', 1, true]]);
  assert.equal(a.cross.north.bus, 2);
  assert.equal(a.cross.north.train, 1);
  assert.equal(a.cross.south.train, 1);
  assert.equal(a.cross.college.sns, 1);
  const d1 = aggregateSurvey(draws, { ...lists, dayId: 'day1' });
  assert.deepEqual([d1.total, d1.answered, d1.unanswered], [4, 3, 1]);
  assert.deepEqual(d1.ages.map((x) => x.id), ['north', 'south'], '旧い選択肢は、その日の記録に無ければ出ない');
  // 表示用のラベルは保存時のラベル優先、無ければ現在の選択肢から
  assert.equal(ageLabelOf(draws[0], q1), '北');
  assert.equal(ageLabelOf(draws[4], q1), '大学生・専門学生');
  assert.deepEqual(triggerLabelsOf(draws[4], q2), ['SNS', 'バス']);
  assert.deepEqual(triggerLabelsOf({ survey: { age: 'north', triggers: ['bus', 'gone'] } }, q2), ['バス', 'gone'], 'ラベルの写しが無ければ現在の一覧、それも無ければ id');
  // 選択肢を省くと従来どおり（電波祭2026 の既定の一覧）
  const dflt = aggregateSurvey([g('1-0001', 'day1', normalizeSurvey({ age: 'college', triggers: ['sns'] }))]);
  assert.deepEqual(dflt.ages.map((x) => x.id), SURVEY_AGES.map((x) => x.id));
  assert.deepEqual(dflt.triggers.map((x) => x.id), SURVEY_TRIGGERS.map((x) => x.id));
});
