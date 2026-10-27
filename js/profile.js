// イベント設定（config v2）の正規化・設定ファイル・景品／日程の変更計画（docs/CUSTOMIZE.md §2〜§4）。
// DOM・IndexedDB に触れない純粋関数だけ。import してよいのは ./templates.js だけ
// （config.js・survey.js・db.js がここを import するので、循環させない）。
// 公開：CONFIG_VERSION / PROFILE_VERSION / LIMITS / normalizeConfig / newId / nextDayId /
//       planBoxSettings / exportProfile / validateProfileFile
//       と、入力の検証に使う小さな道具 len / inRange / PRINTABLE / hasOwn（スタッフ画面も同じものを使う＝データ層と同じ数え方・判定になる）
import { DEFAULT_TEMPLATE_ID, TIER_LATIN, YOSORO_TIER_LATIN, templateConfig } from './templates.js';

export const CONFIG_VERSION = 2;
export const PROFILE_VERSION = 1;

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

/**
 * 入力の上限（§2）。文字数は [...s].length（コードポイント）、件数は {min, max}。
 * 画面の maxLength・件数の判定と、normalizeConfig / planBoxSettings / validateProfileFile が同じ値を見る。
 */
export const LIMITS = deepFreeze({
  eventName: 30,
  brandName: 16, nameLatin: 24, eventLabel: 20, eventLatin: 24, tagline: 24, prizeWord: 6,
  entryTitle: 12, entrySub: 20,
  surveyNotice: 80, surveyHeading: 40, surveyShort: 10, optionLabel: 24,
  q1Options: { min: 2, max: 12 }, q2Options: { min: 2, max: 10 },
  days: { min: 1, max: 7 }, dayLabel: 12,
  categories: { min: 1, max: 12 }, categoryName: 40, categoryLatin: 24,
  prizes: { min: 1, max: 40 }, prizeName: 60,
  studentIdMax: 20,
  initialMax: 100000,
});

const SLUG = /^[a-z0-9-]{1,40}$/;          // 賞・景品・選択肢の id
const KEY32 = /^[a-z0-9-]{1,32}$/;         // theme.preset / motif（知らない id でも形が正しければ残す）
const EVENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DAY_ID = /^day[0-9]{1,3}$/;          // 新しい開催日の id
const HEX = /^#[0-9A-Fa-f]{6}$/;
const NOT_PRINTABLE = /[^\x20-\x7E]/g;     // 欧文の欄に入れられない字（フォントのサブセットに日本語が無い）
export const PRINTABLE = /^[\x20-\x7E]*$/;   // 欧文の欄に入れてよい字（印字可能な ASCII）
const TIERS = ['sponsor', 'rare', 'sticker'];

// ---------- 小さな道具 ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const own = (o, k) => (isObj(o) && hasOwn(o, k) ? o[k] : undefined);   // 'constructor' などの継承プロパティを拾わない
const clone = (v) => JSON.parse(JSON.stringify(v));
export const len = (s) => [...s].length;   // 文字数はコードポイント（LIMITS と同じ数え方）
const clip = (s, max) => (len(s) > max ? [...s].slice(0, max).join('') : s);
export const inRange = (n, r) => n >= r.min && n <= r.max;
const isInitial = (n) => Number.isInteger(n) && n >= 0 && n <= LIMITS.initialMax;
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

/** 前後の空白を除いて上限で切る（切ったあとの末尾の空白も除く＝べき等）。文字列でない・min 未満なら def。 */
function text(v, def, max, min = 0) {
  if (typeof v !== 'string') return def;
  const s = clip(v.trim(), max).trim();
  return len(s) >= min ? s : def;
}
/** 欧文の欄：印字可能な ASCII 以外を除いてから text と同じ。文字列でなければ def（空になっても def にはしない＝空は有効）。 */
function latin(v, def, max) {
  if (typeof v !== 'string') return def;
  return clip(v.replace(NOT_PRINTABLE, '').trim(), max).trim();
}
/** 必須の文字列（1字以上・max 以下）。直さず、だめなら null（保存の検証用）。 */
function required(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && len(s) <= max ? s : null;
}
/** 名前の欄：v が使えなければ、候補を順に（テンプレートの同じ id の名前 → id → 最後の既定）。候補も同じ整形をする（べき等）。 */
function named(v, max, ...fallbacks) {
  for (const x of [v, ...fallbacks]) {
    const s = text(x, '', max, 1);
    if (s) return s;
  }
  return '';
}

// ---------- config v2 の正規化 ----------
// 足りない値は電波祭2026（denpasai-2026）で補う。v1 のデータはすべて電波祭2026 のものなので、見た目は今のまま。
const DEF = templateConfig(DEFAULT_TEMPLATE_ID).config;

function wordmark(v, def) {
  if (v === undefined) return clone(def);       // 未指定は既定（よーそろ。name|nameLatin が合わないとき使われないだけ）
  if (v === null) return null;
  const ok = isObj(v) && typeof v.for === 'string' && len(v.for) <= LIMITS.brandName + 1 + LIMITS.nameLatin   // for は name|nameLatin と同じ長さにしかならない
    && Array.isArray(v.gaps) && v.gaps.length >= 1 && v.gaps.length <= 16 && v.gaps.every(Number.isFinite)
    && Number.isInteger(v.breakAt) && v.breakAt >= 0
    && isObj(v.yomiSpacing) && Number.isFinite(v.yomiSpacing.l) && Number.isFinite(v.yomiSpacing.p);
  if (!ok) return null;
  return { for: v.for, gaps: [...v.gaps], breakAt: v.breakAt, yomiSpacing: { l: v.yomiSpacing.l, p: v.yomiSpacing.p } };
}

function customTheme(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of ['paper', 'main', 'ink', 'accent']) {
    if (typeof v[k] !== 'string' || !HEX.test(v[k])) return null;   // 1色でも不正なら使わない
    out[k] = v[k];
  }
  return out;
}

function entry(v, def) {
  const e = isObj(v) ? v : {};
  const row = (x, d) => {
    const r = isObj(x) ? x : {};
    return { enabled: bool(r.enabled, d.enabled), title: text(r.title, d.title, LIMITS.entryTitle, 1), sub: text(r.sub, d.sub, LIMITS.entrySub) };
  };
  const out = { student: row(e.student, def.student), guest: row(e.guest, def.guest) };
  if (!out.student.enabled && !out.guest.enabled) { out.student.enabled = true; out.guest.enabled = true; }   // 誰も参加できなくなる設定は戻す
  return out;
}

/** 選択肢の一覧：id が形式どおり・label がある項目だけ、id の重複は先のものを残す。有効な項目が2つ未満なら既定。 */
function options(v, def, max) {
  if (!Array.isArray(v)) return clone(def);
  const seen = new Set();
  const out = [];
  for (const o of v) {
    if (!isObj(o) || typeof o.id !== 'string' || !SLUG.test(o.id) || seen.has(o.id)) continue;
    const label = text(o.label, '', LIMITS.optionLabel, 1);
    if (!label) continue;
    seen.add(o.id);
    out.push({ id: o.id, label });
  }
  const list = out.slice(0, max);
  return list.length >= 2 ? list : clone(def);
}

function question(v, def, optionLimit) {
  const q = isObj(v) ? v : {};
  return {
    heading: text(q.heading, def.heading, LIMITS.surveyHeading, 1),
    short: text(q.short, def.short, LIMITS.surveyShort, 1),
    options: options(q.options, def.options, optionLimit.max),
  };
}

// days / categories / prizes：構造（id の整合・在庫との対応）は validateBackup と保存処理が見る。ここは欄の補完と整形だけ。
// オブジェクトでない・id が無い項目は捨てる。全部だめなら既定の一覧。
function listOf(v, def, build) {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) {
    if (isObj(x) && typeof x.id === 'string' && x.id) out.push(build(x, out.length));
  }
  return out.length ? out : clone(def);
}

const daysOf = (v, def) => listOf(v, def, (d, i) => ({
  id: d.id,
  label: named(d.label, LIMITS.dayLabel, def.find((x) => x.id === d.id)?.label, `${i + 1}日目`),
}));

const categoriesOf = (v, def, v2) => listOf(v, def, (c) => {
  const tier = TIERS.includes(c.tier) ? c.tier : 'sticker';
  return {
    id: c.id,
    name: named(c.name, LIMITS.categoryName, def.find((x) => x.id === c.id)?.name, c.id, '賞'),
    tier,
    // latin が無い：v1 は電波祭2026 の呼び名（SPONSOR AWARD …）、v2 は新しい賞の既定（SPECIAL PRIZE …）
    latin: latin(c.latin, (v2 ? TIER_LATIN : YOSORO_TIER_LATIN)[tier], LIMITS.categoryLatin),
  };
});

const prizesOf = (v, def) => listOf(v, def, (p) => ({
  id: p.id,
  categoryId: typeof p.categoryId === 'string' ? p.categoryId : '',
  name: named(p.name, LIMITS.prizeName, def.find((x) => x.id === p.id)?.name, p.id, '景品'),
  countUnknown: !!p.countUnknown,
}));

function idRule(v, def) {
  const ok = isObj(v) && (v.charset === 'digits' || v.charset === 'alnum')
    && Number.isInteger(v.minLength) && Number.isInteger(v.maxLength)
    && v.minLength >= 1 && v.minLength <= v.maxLength && v.maxLength <= LIMITS.studentIdMax;
  return ok ? { charset: v.charset, minLength: v.minLength, maxLength: v.maxLength } : { ...def };
}

/**
 * v1 / v2 / 壊れた値のどれからでも、完全な config v2 を返す（深いコピー・入力は変えない・べき等）。
 * 「v1」は schemaVersion !== 2 のもの。知らない最上位のキーは捨てる。
 */
export function normalizeConfig(raw) {
  const r = isObj(raw) ? raw : {};
  const b = isObj(r.brand) ? r.brand : {};
  const t = isObj(r.theme) ? r.theme : {};
  const s = isObj(r.survey) ? r.survey : {};
  const snd = isObj(r.sound) ? r.sound : {};
  return {
    schemaVersion: CONFIG_VERSION,
    eventId: typeof r.eventId === 'string' && EVENT_ID.test(r.eventId) ? r.eventId : DEF.eventId,
    eventName: text(r.eventName, DEF.eventName, LIMITS.eventName, 1),
    brand: {
      name: text(b.name, DEF.brand.name, LIMITS.brandName, 1),
      nameLatin: latin(b.nameLatin, DEF.brand.nameLatin, LIMITS.nameLatin),
      eventLabel: text(b.eventLabel, DEF.brand.eventLabel, LIMITS.eventLabel),
      eventLatin: latin(b.eventLatin, DEF.brand.eventLatin, LIMITS.eventLatin),
      tagline: text(b.tagline, DEF.brand.tagline, LIMITS.tagline),
      prizeWord: text(b.prizeWord, DEF.brand.prizeWord, LIMITS.prizeWord, 1),
      wordmark: wordmark(b.wordmark, DEF.brand.wordmark),
    },
    theme: {
      preset: typeof t.preset === 'string' && KEY32.test(t.preset) ? t.preset : DEF.theme.preset,
      custom: customTheme(t.custom),
    },
    motif: typeof r.motif === 'string' && KEY32.test(r.motif) ? r.motif : DEF.motif,
    entry: entry(r.entry, DEF.entry),
    survey: {
      enabled: bool(s.enabled, DEF.survey.enabled),
      notice: text(s.notice, DEF.survey.notice, LIMITS.surveyNotice),
      q1: question(s.q1, DEF.survey.q1, LIMITS.q1Options),
      q2: question(s.q2, DEF.survey.q2, LIMITS.q2Options),
    },
    days: daysOf(r.days, DEF.days),
    categories: categoriesOf(r.categories, DEF.categories, r.schemaVersion === CONFIG_VERSION),
    prizes: prizesOf(r.prizes, DEF.prizes),
    studentIdRule: idRule(r.studentIdRule, DEF.studentIdRule),
    pinHash: typeof r.pinHash === 'string' ? r.pinHash : null,
    sound: { enabled: bool(snd.enabled, true), volume: Number.isFinite(snd.volume) ? Math.min(1, Math.max(0, snd.volume)) : 0.7 },
  };
}

// ---------- id の採番 ----------
let idSeq = 0;
/**
 * 景品・賞・選択肢の新しい id（/^[a-z0-9-]{1,40}$/）。taken（Set か配列）に無いものを返す。
 * 返した id を taken に足すのは呼び出し側（続けて何個も作るとき）。一度付けた id は変えない（抽選記録が参照する）。
 */
export function newId(prefix, taken) {
  const used = taken instanceof Set ? taken : new Set(taken != null && typeof taken[Symbol.iterator] === 'function' ? taken : []);
  const head = String(prefix ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 20).replace(/-+$/, '') || 'id';
  const stamp = Date.now().toString(36);
  for (;;) {
    const id = `${head}-${stamp}${(idSeq++).toString(36)}`;
    if (!used.has(id)) return id;
  }
}

/** 開催日の新しい id（day<n>）。今の日の最大の番号の次（空いていなければ最小の空き）。999 を超えたら null。 */
export function nextDayId(days) {
  const used = new Set((days ?? []).map((d) => d?.id));
  let max = 0;
  for (const id of used) {
    const m = typeof id === 'string' ? /^day([0-9]{1,3})$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (const from of [max + 1, 1]) {
    for (let n = from; n <= 999; n++) if (!used.has(`day${n}`)) return `day${n}`;
  }
  return null;
}

// ---------- 景品・賞・開催日の変更計画（§4.2。DB に触れない純粋な判定） ----------
/**
 * current = { config(正規化済み), inventory:[{key,dayId,prizeId,initial,remaining,adjust}], drawsByDay:{dayId:n}, drawsByPrize:{prizeId:n}, activeDayId }
 * input   = { days:[{id,label}], categories:[{id,name,tier,latin}], prizes:[{id,categoryId,name,countUnknown}], initials:{dayId:{prizeId:n}} }（一覧はまるごと）
 * 戻り値  = { ok:true, config, puts:[在庫の行], deletes:[key], changes:[ログ用の差分] } | { ok:false, code, detail }
 *   code: BAD_REQUEST（形・上限・id）/ DAY_HAS_DRAWS / PRIZE_HAS_DRAWS / DAY_LOCKED
 */
export function planBoxSettings(current, input) {
  const fail = (code, detail) => ({ ok: false, code, detail });
  const bad = (detail) => fail('BAD_REQUEST', detail);
  if (!isObj(current) || !isObj(current.config) || !isObj(input)) return bad('input');
  if (!Array.isArray(input.days) || !Array.isArray(input.categories) || !Array.isArray(input.prizes)) return bad('input');
  if (input.initials != null && !isObj(input.initials)) return bad('initials');
  const initials = input.initials ?? {};
  const config = normalizeConfig(current.config);
  const inventory = Array.isArray(current.inventory) ? current.inventory : [];
  const drawsOf = (m, id) => { const n = own(m, id); return Number.isFinite(n) ? n : 0; };

  // 開催日：名前の変更・末尾への追加・末尾からの削除だけ（既存の日は今の並びのまま。番号 <日>-<連番> が並び順から作られるため）
  if (!inRange(input.days.length, LIMITS.days)) return bad('days');
  const curDayIds = new Set(config.days.map((d) => d.id));
  const days = [];
  const dayIds = new Set();
  let appended = false;
  for (const d of input.days) {
    if (!isObj(d) || typeof d.id !== 'string' || dayIds.has(d.id)) return bad('day-id');
    const label = required(d.label, LIMITS.dayLabel);
    if (label == null) return bad('day-label');
    if (curDayIds.has(d.id)) {
      if (appended || config.days[days.length]?.id !== d.id) return bad('days-order');
    } else {
      if (!DAY_ID.test(d.id)) return bad('day-id');
      appended = true;
    }
    dayIds.add(d.id);
    days.push({ id: d.id, label });
  }

  // 賞
  if (!inRange(input.categories.length, LIMITS.categories)) return bad('categories');
  const curCats = new Map(config.categories.map((c) => [c.id, c]));
  const cats = [];
  const catIds = new Set();
  for (const c of input.categories) {
    if (!isObj(c) || typeof c.id !== 'string' || catIds.has(c.id)) return bad('category-id');
    const old = curCats.get(c.id);
    if (!old && !SLUG.test(c.id)) return bad('category-id');
    const name = required(c.name, LIMITS.categoryName);
    if (name == null) return bad('category-name');
    if (!TIERS.includes(c.tier)) return bad('category-tier');
    let lat = old?.latin ?? TIER_LATIN[c.tier];
    if (c.latin != null) {
      const l = typeof c.latin === 'string' ? c.latin.trim() : null;
      if (l == null || !PRINTABLE.test(l) || len(l) > LIMITS.categoryLatin) return bad('category-latin');
      lat = l;
    }
    catIds.add(c.id);
    cats.push({ id: c.id, name, tier: c.tier, latin: lat });
  }

  // 景品：賞は入力の一覧の中にあること（＝賞は、景品が1つも無いときだけ消せる）
  if (!inRange(input.prizes.length, LIMITS.prizes)) return bad('prizes');
  const curPrizes = new Map(config.prizes.map((p) => [p.id, p]));
  const prizes = [];
  const prizeIds = new Set();
  for (const p of input.prizes) {
    if (!isObj(p) || typeof p.id !== 'string' || prizeIds.has(p.id)) return bad('prize-id');
    if (!curPrizes.has(p.id) && !SLUG.test(p.id)) return bad('prize-id');
    const name = required(p.name, LIMITS.prizeName);
    if (name == null) return bad('prize-name');
    if (typeof p.categoryId !== 'string' || !catIds.has(p.categoryId)) return bad('prize-category');
    prizeIds.add(p.id);
    prizes.push({ id: p.id, categoryId: p.categoryId, name, countUnknown: !!p.countUnknown });
  }

  // ここから先は「禁止された操作」（形は正しい）
  for (const d of config.days) {
    if (dayIds.has(d.id)) continue;   // 消える日：抽選があった日・開催中の日は消せない
    if (drawsOf(current.drawsByDay, d.id) > 0 || d.id === current.activeDayId) return fail('DAY_LOCKED', d.id);
  }
  for (const p of config.prizes) {
    if (!prizeIds.has(p.id) && drawsOf(current.drawsByPrize, p.id) > 0) return fail('PRIZE_HAS_DRAWS', p.id);
  }

  // 在庫：最終の日 × 景品の行をそろえる
  const rows = new Map(inventory.map((r) => [r.key, r]));
  const puts = [];
  const created = [];
  for (const d of days) {
    const locked = drawsOf(current.drawsByDay, d.id) > 0;   // 抽選が始まった日
    for (const p of prizes) {
      const key = `${d.id}:${p.id}`;
      const want = own(own(initials, d.id), p.id);
      if (want !== undefined && want !== null && !isInitial(want)) return bad('initial');
      const has = want !== undefined && want !== null;
      const row = rows.get(key);
      if (row) {
        if (!has || want === row.initial) continue;
        if (locked) return fail('DAY_HAS_DRAWS', d.id);   // 抽選が始まった日の初期本数は変えない（残数の±調整を使う）
        puts.push({ ...row, key, dayId: d.id, prizeId: p.id, initial: want, remaining: want, adjust: 0 });
      } else {
        const n = has ? want : 0;
        if (locked && n !== 0) return fail('DAY_HAS_DRAWS', d.id);   // 抽選が始まった日に増える景品は 0 本から
        const rec = { key, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 };
        puts.push(rec);
        created.push(rec);
      }
    }
  }
  const deletes = inventory.filter((r) => !dayIds.has(r.dayId) || !prizeIds.has(r.prizeId)).map((r) => r.key);

  // ログ用の差分
  const changes = [];
  const initialsOf = (pick) => { const o = {}; for (const r of created) if (pick(r) && r.initial) o[pick(r)] = r.initial; return o; };
  const withInitials = (e, o) => (Object.keys(o).length ? { ...e, initials: o } : e);
  const oldDays = new Map(config.days.map((d) => [d.id, d]));
  for (const d of days) {
    const old = oldDays.get(d.id);
    if (!old) changes.push(withInitials({ day: d.id, add: d.label }, initialsOf((r) => (r.dayId === d.id ? r.prizeId : null))));
    else if (old.label !== d.label) changes.push({ day: d.id, from: old.label, to: d.label });
  }
  for (const d of config.days) if (!dayIds.has(d.id)) changes.push({ day: d.id, remove: d.label });
  for (const c of cats) {
    const old = curCats.get(c.id);
    if (!old) { changes.push({ category: c.id, add: c.name, tier: c.tier, latin: c.latin }); continue; }
    if (old.name !== c.name) changes.push({ category: c.id, from: old.name, to: c.name });
    if (old.tier !== c.tier) changes.push({ category: c.id, tier: { from: old.tier, to: c.tier } });
    if (old.latin !== c.latin) changes.push({ category: c.id, latin: { from: old.latin, to: c.latin } });
  }
  for (const c of config.categories) if (!catIds.has(c.id)) changes.push({ category: c.id, remove: c.name });
  for (const p of prizes) {
    const old = curPrizes.get(p.id);
    if (!old) { changes.push(withInitials({ prize: p.id, add: p.name, categoryId: p.categoryId }, initialsOf((r) => (r.prizeId === p.id ? r.dayId : null)))); continue; }
    if (old.name !== p.name) changes.push({ prize: p.id, from: old.name, to: p.name });
    if (old.countUnknown !== p.countUnknown) changes.push({ prize: p.id, countUnknown: p.countUnknown });
    if (old.categoryId !== p.categoryId) changes.push({ prize: p.id, categoryId: { from: old.categoryId, to: p.categoryId } });
  }
  for (const p of config.prizes) if (!prizeIds.has(p.id)) changes.push({ prize: p.id, remove: p.name });
  for (const r of puts) {
    if (created.includes(r)) continue;
    changes.push({ dayId: r.dayId, prizeId: r.prizeId, initial: { from: rows.get(r.key).initial, to: r.initial } });
  }

  return { ok: true, config: normalizeConfig({ ...config, days, categories: cats, prizes }), puts, deletes, changes };
}

// ---------- 設定ファイル（抽選履歴・参加済み番号・PIN・効果音を含まない、イベント設定だけの JSON。§3.3） ----------
/** 今の config と在庫の「初期本数」（残数ではない）から設定ファイルの中身を作る。 */
export function exportProfile(config, inventory, now = Date.now()) {
  const { pinHash: _pin, sound: _sound, ...cfg } = normalizeConfig(config);
  const rows = new Map((Array.isArray(inventory) ? inventory : []).map((r) => [r?.key, r]));
  const initials = {};
  for (const d of cfg.days) {
    initials[d.id] = {};
    for (const p of cfg.prizes) {
      const n = rows.get(`${d.id}:${p.id}`)?.initial;
      initials[d.id][p.id] = isInitial(n) ? n : 0;
    }
  }
  return { app: 'yosoro-gacha', kind: 'profile', profileVersion: PROFILE_VERSION, exportedAt: now, profile: { config: cfg, initials } };
}

/** 開催日・賞・景品の構造を、上限どおりか確かめる（読み込むファイルは外から来るので、直さずに断る）。問題の説明か null。 */
function boxProblem(c) {
  if (!Array.isArray(c.days) || !Array.isArray(c.categories) || !Array.isArray(c.prizes)) return '開催日・賞・景品の一覧がありません';
  const lists = [
    ['開催日', '日', c.days, LIMITS.days, DAY_ID, 'label', LIMITS.dayLabel],
    ['賞', '個', c.categories, LIMITS.categories, SLUG, 'name', LIMITS.categoryName],
    ['景品', '個', c.prizes, LIMITS.prizes, SLUG, 'name', LIMITS.prizeName],
  ];
  for (const [what, unit, list, range, idRe, field, max] of lists) {
    if (!inRange(list.length, range)) return `${what}は${range.min}〜${range.max}${unit}にしてください`;
    const seen = new Set();
    for (const [i, x] of list.entries()) {
      const at = `${what}の${i + 1}番目`;
      if (!isObj(x) || typeof x.id !== 'string' || !idRe.test(x.id)) return `${at}の id が正しくありません`;
      if (seen.has(x.id)) return `${at}の id が重複しています`;
      seen.add(x.id);
      if (required(x[field], max) == null) return `${at}の名前は1〜${max}字にしてください`;
    }
  }
  const catIds = new Set(c.categories.map((x) => x.id));
  for (const [i, p] of c.prizes.entries()) {
    if (typeof p.categoryId !== 'string' || !catIds.has(p.categoryId)) return `景品の${i + 1}番目の賞が見つかりません`;
  }
  return null;
}

/** 設定ファイルの検証。{ok:true, config(pinHash は null), initials(全ての日×景品、無ければ 0)} | {ok:false, error} */
export function validateProfileFile(obj) {
  const bad = (error) => ({ ok: false, error });
  if (!isObj(obj)) return bad('ファイルの形式が正しくありません');
  if (obj.app !== 'yosoro-gacha') return bad('このアプリの設定ファイルではありません');
  if (obj.kind !== 'profile') {
    return bad(Array.isArray(obj.meta) ? 'これはバックアップです（設定ファイルではありません）。バックアップの復元から読み込んでください' : 'このアプリの設定ファイルではありません');
  }
  if (!Number.isInteger(obj.profileVersion) || obj.profileVersion < 1) return bad('バージョン情報がありません');
  if (obj.profileVersion > PROFILE_VERSION) return bad('新しいバージョンの設定ファイルです。アプリを更新してください');
  const p = obj.profile;
  if (!isObj(p) || !isObj(p.config) || !isObj(p.initials)) return bad('設定ファイルの中身（profile）が正しくありません');
  const problem = boxProblem(p.config);
  if (problem) return bad(problem);
  const { pinHash: _pin, sound: _sound, ...shared } = p.config;   // PIN・効果音は端末の設定。ファイルに混ざっていても使わない
  const config = normalizeConfig(shared);
  const initials = {};
  for (const d of config.days) {
    initials[d.id] = {};
    for (const pr of config.prizes) {
      const v = own(own(p.initials, d.id), pr.id);
      if (v === undefined) { initials[d.id][pr.id] = 0; continue; }
      if (!isInitial(v)) return bad(`本数は0〜${LIMITS.initialMax}の整数にしてください（${d.label}・${pr.name}）`);
      initials[d.id][pr.id] = v;
    }
  }
  return { ok: true, config, initials };
}
