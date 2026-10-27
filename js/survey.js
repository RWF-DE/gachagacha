// 来場者アンケート（本校学生以外）の検証・ラベル・集計。DOM・DBに触れない純粋関数だけ。
// 保存の形（draw レコードの survey）:
//   { v:1, age:'<id>', triggers:['<id>',...], ageLabel:'<保存時の表示名>', triggerLabels:['<保存時の表示名>',...] }
// 選択肢は呼び出し側が config.survey.q1.options / q2.options を渡す（省略時は電波祭2026 の既定。templates.js）。
// id は保存データに入る「変えない名前」、label は画面表示用（保存時に履歴へも写す）。
// フィールド名は質問の中身が変わっても age（= Q1）・triggers（= Q2）のまま。
// config.js はここから SURVEY_VERSION を再エクスポートする（循環させないため、ここは config.js を import しない）。
import { SURVEY_AGES, SURVEY_TRIGGERS } from './templates.js';

export const SURVEY_VERSION = 1;
export const UNANSWERED = '未回答';

/**
 * 抽選時の入力 {age, triggers, v?} を検証して保存用に整える。
 * 年齢は既知の id 1つ、きっかけは既知の id の重複なし・1つ以上。違えば null。
 * triggers は選択肢の並び順に正規化する（回答の順序で集計がぶれないように）。
 */
export function normalizeSurvey(input, { ages = SURVEY_AGES, triggers = SURVEY_TRIGGERS } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.v != null && input.v !== SURVEY_VERSION) return null;
  const age = ages.find((a) => a.id === input.age);
  if (!age) return null;
  if (!Array.isArray(input.triggers) || input.triggers.length === 0) return null;
  const seen = new Set();
  for (const id of input.triggers) {
    if (typeof id !== 'string' || seen.has(id) || !triggers.some((t) => t.id === id)) return null;
    seen.add(id);
  }
  const picked = triggers.filter((t) => seen.has(t.id));
  return {
    v: SURVEY_VERSION,
    age: age.id,
    triggers: picked.map((t) => t.id),
    ageLabel: age.label,
    triggerLabels: picked.map((t) => t.label),
  };
}

/** バックアップ内の survey の形だけを確かめる（選択肢の id は後で編集されうるので既知かどうかは見ない）。 */
export function isStoredSurvey(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (typeof s.age !== 'string' || !Array.isArray(s.triggers) || !s.triggers.every((x) => typeof x === 'string')) return false;
  if (s.ageLabel != null && typeof s.ageLabel !== 'string') return false;
  if (s.triggerLabels != null && !(Array.isArray(s.triggerLabels) && s.triggerLabels.every((x) => typeof x === 'string'))) return false;
  return true;
}

/** CSV・表示用の年齢ラベル。保存時のスナップショット優先。survey なしは「未回答」。 */
export function ageLabelOf(draw, ages = SURVEY_AGES) {
  const s = draw?.survey;
  if (!s) return UNANSWERED;
  return s.ageLabel || ages.find((a) => a.id === s.age)?.label || s.age;
}

/** 同じくきっかけ（配列）。 */
export function triggerLabelsOf(draw, triggers = SURVEY_TRIGGERS) {
  const s = draw?.survey;
  if (!s) return [];
  return s.triggers.map((id, i) => s.triggerLabels?.[i] || triggers.find((t) => t.id === id)?.label || id);
}

/**
 * 集計。draws のうち kind==='guest'（dayId 指定があればその日だけ）が対象。
 * 行は「現在の選択肢（表示順）」→「履歴にだけ残る旧い選択肢（保存時ラベル）」の順。
 * 戻り値: { total, answered, unanswered, ages:[{id,label,count,retired}], triggers:[...], cross:{[ageId]:{[triggerId]:n}} }
 */
export function aggregateSurvey(draws, { dayId = null, ages = SURVEY_AGES, triggers = SURVEY_TRIGGERS } = {}) {
  const guests = draws.filter((d) => d.kind === 'guest' && (dayId == null || d.dayId === dayId));
  const ageRows = ages.map((a) => ({ id: a.id, label: a.label, count: 0, retired: false }));
  const trigRows = triggers.map((t) => ({ id: t.id, label: t.label, count: 0, retired: false }));
  const ageBy = new Map(ageRows.map((r) => [r.id, r]));
  const trigBy = new Map(trigRows.map((r) => [r.id, r]));
  const cross = {};
  let answered = 0;
  for (const d of guests) {
    const s = d.survey;
    if (!s || typeof s.age !== 'string' || !Array.isArray(s.triggers)) continue;
    answered++;
    let ar = ageBy.get(s.age);
    if (!ar) { ar = { id: s.age, label: s.ageLabel || s.age, count: 0, retired: true }; ageBy.set(ar.id, ar); ageRows.push(ar); }
    ar.count++;
    cross[ar.id] ||= {};
    s.triggers.forEach((tid, i) => {
      let tr = trigBy.get(tid);
      if (!tr) { tr = { id: tid, label: s.triggerLabels?.[i] || tid, count: 0, retired: true }; trigBy.set(tid, tr); trigRows.push(tr); }
      tr.count++;
      cross[ar.id][tid] = (cross[ar.id][tid] || 0) + 1;
    });
  }
  return { total: guests.length, answered, unanswered: guests.length - answered, ages: ageRows, triggers: trigRows, cross };
}

/** 割合（%）。分母 0 は 0。小数1桁。 */
export const pct = (n, of) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);
