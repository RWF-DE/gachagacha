// node --test tests/   来場者アンケート（本校学生以外）の検証・集計・バックアップ検証
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSurvey, isStoredSurvey, aggregateSurvey, ageLabelOf, triggerLabelsOf, pct, UNANSWERED } from '../js/survey.js';
import { validateBackup } from '../js/db.js';
import { SURVEY_AGES, SURVEY_TRIGGERS, SURVEY_VERSION, createDefaultConfig, createDefaultInitials } from '../js/config.js';

test('選択肢：id は重複せず安定、ラベルは仕様どおり', () => {
  for (const list of [SURVEY_AGES, SURVEY_TRIGGERS]) {
    assert.equal(new Set(list.map((o) => o.id)).size, list.length);
    assert.ok(list.every((o) => /^[a-z0-9-]+$/.test(o.id) && o.label));
  }
  assert.deepEqual(SURVEY_AGES.map((a) => a.label), ['未就学児', '小学生', '中学生', '高校生', '大学生・専門学生', '20代', '30代', '40代', '50代', '60代以上']);
  assert.equal(SURVEY_TRIGGERS.length, 8);
  assert.equal(SURVEY_TRIGGERS.at(-1).label, 'その他');
});

test('normalizeSurvey: 正しい回答はラベルつきで整う（きっかけは選択肢の順）', () => {
  const r = normalizeSurvey({ v: 1, age: 'college', triggers: ['sns', 'referral'] });
  assert.deepEqual(r, {
    v: SURVEY_VERSION, age: 'college', triggers: ['referral', 'sns'],
    ageLabel: '大学生・専門学生', triggerLabels: ['家族・友人・知人からの紹介', 'SNS（Instagram・Xなど）'],
  });
  assert.ok(normalizeSurvey({ age: 'age-60plus', triggers: ['other'] }), 'v は省略可');
});

test('normalizeSurvey: 不正な回答は null', () => {
  const ok = { v: 1, age: 'age-20s', triggers: ['poster'] };
  assert.ok(normalizeSurvey(ok));
  for (const bad of [
    undefined, null, 'x', [], {},
    { ...ok, age: 'nope' }, { ...ok, age: null }, { ...ok, age: ['age-20s'] },
    { ...ok, triggers: [] }, { ...ok, triggers: 'poster' }, { ...ok, triggers: ['nope'] },
    { ...ok, triggers: ['poster', 'poster'] }, { ...ok, triggers: [1] }, { ...ok, v: 2 },
  ]) assert.equal(normalizeSurvey(bad), null, JSON.stringify(bad));
});

test('isStoredSurvey: 形だけ見る（旧い id でも通る）', () => {
  assert.equal(isStoredSurvey({ v: 1, age: 'old-id', triggers: ['gone'], ageLabel: '旧', triggerLabels: ['旧2'] }), true);
  assert.equal(isStoredSurvey({ age: 'x', triggers: [] }), true);
  for (const bad of [null, [], { age: 1, triggers: [] }, { age: 'x', triggers: 'y' }, { age: 'x', triggers: [1] }, { age: 'x', triggers: [], ageLabel: 3 }, { age: 'x', triggers: ['a'], triggerLabels: [1] }]) {
    assert.equal(isStoredSurvey(bad), false, JSON.stringify(bad));
  }
});

const g = (id, dayId, survey) => ({ id, label: id, dayId, kind: 'guest', prizeId: 'p', drawnAt: 1, ...(survey ? { survey } : {}) });
const sv = (age, triggers) => normalizeSurvey({ v: 1, age, triggers });

test('aggregateSurvey: 件数・割合の元になる数・クロス集計・未回答・学生の除外', () => {
  const draws = [
    g('1-0001', 'day1', sv('college', ['sns', 'poster'])),
    g('1-0002', 'day1', sv('college', ['sns'])),
    g('1-0003', 'day1', sv('age-40s', ['annual', 'sns'])),
    g('1-0004', 'day1'),                                  // 古い記録（survey なし）
    { id: '1-0005', label: '1-0005', dayId: 'day1', kind: 'student', prizeId: 'p', drawnAt: 1, studentId: '2412345' },
    g('2-0001', 'day2', sv('age-40s', ['other'])),
  ];
  const all = aggregateSurvey(draws);
  assert.equal(all.total, 5);
  assert.equal(all.answered, 4);
  assert.equal(all.unanswered, 1);
  assert.deepEqual(all.ages.map((a) => a.id), SURVEY_AGES.map((a) => a.id), '選択肢の順');
  assert.equal(all.ages.find((a) => a.id === 'college').count, 2);
  assert.equal(all.ages.find((a) => a.id === 'age-40s').count, 2);
  assert.equal(all.ages.reduce((s, a) => s + a.count, 0), 4, 'Q1 は単一選択なので回答数と一致');
  assert.equal(all.triggers.find((t) => t.id === 'sns').count, 3);
  assert.equal(all.triggers.reduce((s, t) => s + t.count, 0), 6, 'Q2 は複数選択');
  assert.equal(all.cross.college.sns, 2);
  assert.equal(all.cross['age-40s'].annual, 1);
  assert.equal(all.cross['age-40s'].other, 1);

  const d1 = aggregateSurvey(draws, { dayId: 'day1' });
  assert.deepEqual([d1.total, d1.answered, d1.unanswered], [4, 3, 1]);
  assert.equal(d1.triggers.find((t) => t.id === 'other').count, 0);
  const d2 = aggregateSurvey(draws, { dayId: 'day2' });
  assert.deepEqual([d2.total, d2.answered, d2.unanswered], [1, 1, 0]);
  assert.deepEqual(aggregateSurvey([]), { ...aggregateSurvey([]), total: 0, answered: 0, unanswered: 0 });
});

test('aggregateSurvey: 選択肢が後で変わっても、履歴は保存時のラベルで末尾に残る', () => {
  const draws = [
    g('1-0001', 'day1', { v: 1, age: 'retired-age', triggers: ['retired-trig', 'sns'], ageLabel: '旧年齢', triggerLabels: ['旧きっかけ', 'SNS（旧）'] }),
    g('1-0002', 'day1', sv('college', ['sns'])),
  ];
  const a = aggregateSurvey(draws);
  const oldAge = a.ages.at(-1);
  assert.deepEqual([oldAge.id, oldAge.label, oldAge.count, oldAge.retired], ['retired-age', '旧年齢', 1, true]);
  const oldTrig = a.triggers.find((t) => t.id === 'retired-trig');
  assert.deepEqual([oldTrig.label, oldTrig.count, oldTrig.retired], ['旧きっかけ', 1, true]);
  assert.equal(a.triggers.find((t) => t.id === 'sns').count, 2, '現行の id は現行の行へ');
  assert.equal(a.cross['retired-age']['retired-trig'], 1);
});

test('ラベル取得・pct', () => {
  const d = g('1-0001', 'day1', sv('age-30s', ['website', 'kosen-interest']));
  assert.equal(ageLabelOf(d), '30代');
  assert.deepEqual(triggerLabelsOf(d), ['ホームページ', '熊本高専に興味があった']);
  assert.equal(ageLabelOf(g('x', 'day1')), UNANSWERED);
  assert.deepEqual(triggerLabelsOf(g('x', 'day1')), []);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(0, 0), 0);
  assert.equal(pct(3, 3), 100);
});

function backup(draws = []) {
  const cfg = createDefaultConfig(); cfg.pinHash = 'abc';
  const inv = [];
  for (const [dayId, per] of Object.entries(createDefaultInitials())) {
    for (const [prizeId, n] of Object.entries(per)) inv.push({ key: `${dayId}:${prizeId}`, dayId, prizeId, initial: n, remaining: n });
  }
  return {
    app: 'yosoro-gacha', schemaVersion: 1, exportedAt: 1,
    meta: [{ key: 'config', value: cfg }, { key: 'activeDayId', value: 'day1' }],
    inventory: inv, draws, students: [], logs: [],
  };
}

test('validateBackup: survey の有無どちらの guest 抽選も受理（旧バックアップ互換）', () => {
  const plain = g('1-0001', 'day1');
  const withSv = g('1-0002', 'day1', sv('age-20s', ['sns']));
  assert.equal(validateBackup(backup([plain])).ok, true);
  assert.equal(validateBackup(backup([withSv])).ok, true);
  assert.equal(validateBackup(backup([plain, withSv])).ok, true);
  const retired = g('1-0003', 'day1', { v: 1, age: 'retired', triggers: ['gone'], ageLabel: '旧', triggerLabels: ['旧'] });
  assert.equal(validateBackup(backup([retired])).ok, true, '選択肢が変わった後の旧 id でも通る');
});

test('validateBackup: 壊れた survey・学生の survey は拒否', () => {
  const bad1 = g('1-0001', 'day1'); bad1.survey = { age: 5, triggers: [] };
  assert.equal(validateBackup(backup([bad1])).ok, false);
  const bad2 = g('1-0001', 'day1'); bad2.survey = 'yes';
  assert.equal(validateBackup(backup([bad2])).ok, false);
  const stu = { id: '1-0001', label: '1-0001', dayId: 'day1', kind: 'student', prizeId: 'p', drawnAt: 1, survey: sv('age-20s', ['sns']) };
  assert.equal(validateBackup(backup([stu])).ok, false);
});
