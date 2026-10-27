// IndexedDB ラッパ（DESIGN.md §5/§6）。
// 重要: draw() は単一の readwrite トランザクション内で完結させ、
//       transaction の complete を待ってから resolve する。
//       トランザクション中に IDB 以外の非同期処理（await 等）を挟まない。
import { DB_NAME, SCHEMA_VERSION, createDefaultConfig } from './config.js';
import { pickPrize, normalizeStudentId, validateStudentId } from './lottery.js';
import { normalizeSurvey, isStoredSurvey } from './survey.js';
import { normalizeConfig, planBoxSettings, exportProfile, validateProfileFile } from './profile.js';

const STORES = ['meta', 'inventory', 'draws', 'students', 'logs'];

/**
 * 型付きエラー。code: ALREADY_USED / BOX_EMPTY / PENDING_EXISTS / NOT_SETUP / DB_ERROR など。
 * 景品・日程の保存の DAY_HAS_DRAWS / PRIZE_HAS_DRAWS / DAY_LOCKED / BAD_REQUEST は detail に対象の id、
 * INVALID_PROFILE は detail に理由（日本語）が入る。
 */
export class DbError extends Error {
  constructor(code, detail) {
    super(code + (detail ? `: ${detail}` : ''));
    this.name = 'DbError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

// ---------- 接続 ----------
let dbPromise = null;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new DbError('DB_ERROR', 'indexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      // 追加のみ（既存データは消さない）
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('inventory')) db.createObjectStore('inventory', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('draws')) db.createObjectStore('draws', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('students')) db.createObjectStore('students', { keyPath: 'studentId' });
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      const reset = () => { dbPromise = null; };
      db.onclose = reset;               // iOS がメモリ逼迫で接続を閉じた場合に再接続できるように
      db.onversionchange = () => { db.close(); reset(); };
      resolve(db);
    };
    req.onerror = () => reject(new DbError('DB_ERROR', req.error?.name));
    req.onblocked = () => reject(new DbError('DB_ERROR', 'blocked'));
  });
}

export function getDb() {
  if (!dbPromise) dbPromise = openDb().catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

/** トランザクション作成。接続が閉じていたら一度だけ再接続する。 */
async function beginTx(stores, mode) {
  for (let attempt = 0; ; attempt++) {
    const db = await getDb();
    try {
      return db.transaction(stores, mode, { durability: 'strict' });
    } catch (e) {
      dbPromise = null;
      if (attempt >= 1) throw new DbError('DB_ERROR', e?.name);
    }
  }
}

/** 完了（oncomplete）まで待つ Promise。run(tx) は同期的に IDB リクエストを発行する。 */
async function runTx(stores, mode, run) {
  const tx = await beginTx(stores, mode);
  return new Promise((resolve, reject) => {
    let result;
    let failure = null;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || new DbError('DB_ERROR', tx.error?.name));
    tx.onerror = () => {}; // 続けて abort が来る
    const fail = (code, detail) => {
      failure = failure || new DbError(code, detail);
      try { tx.abort(); } catch { /* 既に終了 */ }
    };
    try {
      run(tx, (v) => { result = v; }, fail);
    } catch (e) {
      fail('DB_ERROR', e?.name);
    }
  });
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(new DbError('DB_ERROR', req.error?.name));
});

/** 複数リクエストが全て成功したら cb を同期的に呼ぶ（トランザクション内で使う）。 */
function whenAll(reqs, cb) {
  let left = reqs.length;
  if (left === 0) return cb();
  for (const r of reqs) {
    r.onsuccess = () => { if (--left === 0) cb(); };
  }
}

const metaMap = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.value]));
const pad4 = (n) => String(n).padStart(4, '0');
const addLog = (tx, type, detail) => tx.objectStore('logs').add({ at: Date.now(), type, detail: detail ?? null });
const GAMJA_PRIZE_NAME_MIGRATION = 'migration:gamja-prize-name-v1';

// ---------- 永続化 ----------
export async function requestPersist() {
  try { return (await navigator.storage?.persist?.()) === true; } catch { return false; }
}
export async function persisted() {
  try { return (await navigator.storage?.persisted?.()) === true; } catch { return false; }
}

// ---------- 設定・メタ ----------
export async function getMeta(key) {
  const tx = await beginTx(['meta'], 'readonly');
  const row = await reqP(tx.objectStore('meta').get(key));
  return row ? row.value : undefined;
}

/** 保存されている config（v1 でも v2 でも）を正規化した v2 で返す。無ければ null。保存し直すまでディスクの中身は変えない。 */
export async function getConfig() {
  const raw = await getMeta('config');
  return raw ? normalizeConfig(raw) : null;
}

/**
 * 既設端末の景品設定に残る旧名称を更新する。
 * inventory のキーと抽選履歴は prizeId を使うため id は変えず、在庫と過去の記録を保つ。
 */
export function migrateGamjaPrizeName() {
  return runTx(['meta', 'logs'], 'readwrite', (tx, ok) => {
    const meta = tx.objectStore('meta');
    const reqConfig = meta.get('config');
    const reqMigration = meta.get(GAMJA_PRIZE_NAME_MIGRATION);
    whenAll([reqConfig, reqMigration], () => {
      const config = reqConfig.result?.value;
      if (!config || reqMigration.result?.value === true) return ok(false);
      const prize = config?.prizes?.find((p) => p.id === 'bulldak' && p.name === 'ブルダック炒め麺');
      if (prize) {
        prize.name = 'カムジャ麺';
        meta.put({ key: 'config', value: config });
        addLog(tx, 'prize-name-migration', { prizeId: 'bulldak', from: 'ブルダック炒め麺', to: prize.name });
      }
      meta.put({ key: GAMJA_PRIZE_NAME_MIGRATION, value: true });
      ok(!!prize);
    });
  });
}

export async function isSetUp() {
  const c = await getConfig();
  return !!(c && c.pinHash);
}

export async function getActiveDayId() {
  return (await getMeta('activeDayId')) ?? null;
}

/**
 * 初回セットアップ。config / 在庫 / 開催日を1トランザクションで書く。config は正規化（v2）して保存する。
 * initials: {dayId:{prizeId:count}}
 */
export function initialize({ config: given, activeDayId, initials }) {
  const config = normalizeConfig(given);
  return runTx(STORES, 'readwrite', (tx, ok) => {
    const meta = tx.objectStore('meta');
    const inv = tx.objectStore('inventory');
    meta.put({ key: 'config', value: config });
    meta.put({ key: 'activeDayId', value: activeDayId });
    meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
    meta.put({ key: 'drawSeq', value: {} });
    for (const d of config.days) {
      for (const p of config.prizes) {
        const n = Math.max(0, Math.floor(Number(initials?.[d.id]?.[p.id] ?? 0)));
        inv.put({ key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 });
      }
    }
    addLog(tx, 'setup', { activeDayId });
    ok(true);
  });
}

/**
 * 設定の更新（効果音・学籍番号ルール・PIN・名前や配色など）。正規化（v2）して保存し、変更前後の要約だけログに残す（pinHashは残さない）。
 * 開催日・賞・景品は保存済みのまま変えない（在庫・抽選記録と対応しているため。変えるのは
 * initialize / saveBoxSettings / savePrizeSettings / importProfile / importAll だけ）。何も保存されていなければ渡された config をそのまま保存する。
 */
export function saveConfig(config, logType = 'config', logDetail = null) {
  return runTx(['meta', 'logs'], 'readwrite', (tx, ok, fail) => {
    const meta = tx.objectStore('meta');
    const rc = meta.get('config');
    rc.onsuccess = () => {
      try {
        // 保存済みを先に正規化して使う（v1 のまま残る賞の欧文も SPONSOR AWARD … のまま引き継ぐ）
        const kept = rc.result?.value ? normalizeConfig(rc.result.value) : null;
        const value = normalizeConfig(kept ? { ...config, days: kept.days, categories: kept.categories, prizes: kept.prizes } : config);
        meta.put({ key: 'config', value });
        addLog(tx, logType, logDetail);
        ok(true);
      } catch (e) {
        fail('DB_ERROR', e?.name);
      }
    };
  });
}

export function setActiveDay(dayId) {
  return runTx(['meta', 'logs'], 'readwrite', (tx, ok, fail) => {
    const meta = tx.objectStore('meta');
    const all = meta.getAll();
    all.onsuccess = () => {
      const m = metaMap(all.result);
      if (!m.config?.days?.some((d) => d.id === dayId)) return fail('BAD_REQUEST', 'day');
      if (m.pendingDrawId) return fail('PENDING_EXISTS');
      meta.put({ key: 'activeDayId', value: dayId });
      addLog(tx, 'active-day', { from: m.activeDayId ?? null, to: dayId });
      ok(true);
    };
  });
}

// ---------- 在庫 ----------
export async function listInventory() {
  const tx = await beginTx(['inventory'], 'readonly');
  const rows = await reqP(tx.objectStore('inventory').getAll());
  return rows.map((r) => ({ adjust: 0, ...r }));
}

/** 当日の箱の残り合計（プレイヤー画面の「終了」判定用。数値は画面に出さない）。 */
export async function getBoxTotal(dayId) {
  const tx = await beginTx(['inventory', 'meta'], 'readonly');
  const day = dayId ?? (await reqP(tx.objectStore('meta').get('activeDayId')))?.value;
  const rows = await reqP(tx.objectStore('inventory').getAll());
  return rows.filter((r) => r.dayId === day).reduce((s, r) => s + Math.max(0, r.remaining), 0);
}

/** 残数の±調整（理由つきでログに残す）。残数が負になる調整は拒否。 */
export function adjustInventory(dayId, prizeId, delta, reason) {
  const d = Math.trunc(Number(delta));
  if (!Number.isFinite(d) || d === 0) return Promise.reject(new DbError('BAD_REQUEST', 'delta'));
  return runTx(['inventory', 'logs'], 'readwrite', (tx, ok, fail) => {
    const inv = tx.objectStore('inventory');
    const req = inv.get(`${dayId}:${prizeId}`);
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec) return fail('NOT_FOUND');
      const next = rec.remaining + d;
      if (next < 0) return fail('NEGATIVE');
      const from = rec.remaining;
      rec.remaining = next;
      rec.adjust = (rec.adjust || 0) + d;
      inv.put(rec);
      addLog(tx, 'inventory-adjust', { dayId, prizeId, delta: d, from, to: next, reason: String(reason || '') });
      ok(rec);
    };
  });
}

/**
 * 景品・賞・開催日の保存（docs/CUSTOMIZE.md §4.2）。画面の一覧をまるごと渡す。
 * 今の config・在庫・抽選数と比べた判定は js/profile.js planBoxSettings（純粋関数）。
 * 追加・変更・削除を1つのトランザクションで行い、差分をログ box-settings に残す。成功は新しい config。
 * input: {days:[{id,label}], categories:[{id,name,tier,latin}], prizes:[{id,categoryId,name,countUnknown}], initials:{dayId:{prizeId:n}}}
 * 失敗: NOT_SETUP / BAD_REQUEST / DAY_HAS_DRAWS / PRIZE_HAS_DRAWS / DAY_LOCKED（detail に対象の id）
 */
export function saveBoxSettings(input) {
  return boxTx('box-settings', () => ({ input: withNumericInitials(input) }));
}

/** 画面の数値欄の文字列（"12"）は整数にして渡す（判定の planBoxSettings は整数だけを受け付ける）。それ以外の値はそのまま渡して断らせる。 */
function withNumericInitials(input) {
  if (!input || typeof input.initials !== 'object' || input.initials === null) return input;
  const initials = {};
  for (const [dayId, per] of Object.entries(input.initials)) {
    if (!per || typeof per !== 'object') { initials[dayId] = per; continue; }
    initials[dayId] = {};
    for (const [prizeId, v] of Object.entries(per)) {
      initials[dayId][prizeId] = typeof v === 'string' && /^[0-9]{1,7}$/.test(v.trim()) ? Number(v.trim()) : v;
    }
  }
  return { ...input, initials };
}

/**
 * 旧い景品設定の保存（名称・未定フラグ・日別初期本数）。互換のために残す。
 * 渡された一部（変えたい賞・景品・本数）を今の config と在庫から作った一覧に混ぜ、saveBoxSettings と同じ判定・保存を使う。
 * 初期本数は「まだ1回も抽選していない日」だけ変更可。抽選済みの日で値が違えば DAY_HAS_DRAWS。
 * input: {categories:[{id,name}], prizes:[{id,name,countUnknown}], initials:{dayId:{prizeId:n}}}
 */
export function savePrizeSettings(input) {
  return boxTx('prize-settings', (config, rows) => {
    const err = (code, detail) => ({ error: [code, detail] });
    const categories = config.categories.map((c) => ({ ...c }));
    for (const c of input.categories || []) {
      const cat = categories.find((x) => x.id === c.id);
      const name = String(c.name ?? '').trim();
      if (!cat || !name || [...name].length > 40) return err('BAD_REQUEST', 'category');
      cat.name = name;
    }
    const prizes = config.prizes.map((p) => ({ ...p }));
    for (const p of input.prizes || []) {
      const prize = prizes.find((x) => x.id === p.id);
      const name = String(p.name ?? '').trim();
      if (!prize || !name || [...name].length > 60) return err('BAD_REQUEST', 'prize');
      prize.name = name;
      prize.countUnknown = !!p.countUnknown;
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const initials = {};
    for (const d of config.days) {
      initials[d.id] = {};
      for (const p of config.prizes) {
        const r = byKey.get(`${d.id}:${p.id}`);
        if (r) initials[d.id][p.id] = r.initial;
      }
    }
    for (const [dayId, perPrize] of Object.entries(input.initials || {})) {
      for (const [prizeId, raw] of Object.entries(perPrize)) {
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n) || n < 0 || n > 100000) return err('BAD_REQUEST', 'initial');
        if (!byKey.has(`${dayId}:${prizeId}`)) return err('NOT_FOUND');
        (initials[dayId] ||= {})[prizeId] = n;
      }
    }
    return { input: { days: config.days, categories, prizes, initials } };
  });
}

/** saveBoxSettings / savePrizeSettings の共通部分。build(config, 在庫の行) が planBoxSettings の input か {error:[code, detail]} を返す。 */
function boxTx(logType, build) {
  return runTx(['meta', 'inventory', 'draws', 'logs'], 'readwrite', (tx, ok, fail) => {
    const meta = tx.objectStore('meta');
    const inv = tx.objectStore('inventory');
    const rc = meta.get('config');
    const ra = meta.get('activeDayId');
    const ri = inv.getAll();
    const rd = tx.objectStore('draws').getAll();
    whenAll([rc, ra, ri, rd], () => {
      try {
        if (!rc.result?.value) return fail('NOT_SETUP');
        const config = normalizeConfig(rc.result.value);
        const drawsByDay = {};
        const drawsByPrize = {};
        for (const d of rd.result) {
          drawsByDay[d.dayId] = (drawsByDay[d.dayId] || 0) + 1;
          drawsByPrize[d.prizeId] = (drawsByPrize[d.prizeId] || 0) + 1;
        }
        const built = build(config, ri.result);
        if (built.error) return fail(...built.error);
        const plan = planBoxSettings({ config, inventory: ri.result, drawsByDay, drawsByPrize, activeDayId: ra.result?.value ?? null }, built.input);
        if (!plan.ok) return fail(plan.code, plan.detail);
        for (const row of plan.puts) inv.put(row);
        for (const key of plan.deletes) inv.delete(key);
        meta.put({ key: 'config', value: plan.config });   // v1 のまま残っていた config もここで v2 になる
        if (plan.changes.length) addLog(tx, logType, plan.changes);
        ok(plan.config);
      } catch (e) {
        fail('DB_ERROR', e?.name);
      }
    });
  });
}

// ---------- 抽選（最重要） ----------
const DRAW_STORES = ['meta', 'inventory', 'draws', 'students'];

/**
 * 抽選して保存する。resolve は transaction の complete 後。
 * 引数 {kind:'student'|'guest', studentId?, survey?}
 *   参加の方法とアンケートは、トランザクション内で読んだ config（正規化した v2）で判定する（docs/CUSTOMIZE.md §4.1）：
 *   kind が config.entry で無効なら BAD_REQUEST。guest は config.survey.enabled なら survey {age, triggers, v} が必須
 *   （config.survey.q1/q2.options で js/survey.js が検証）、無効なら survey を付けてはいけない。student は survey を持てない。
 *   survey は選択肢のラベルを写して draw レコードに保存する（同じ単一トランザクション。DBのバージョン・ストアは変えない）。
 * 成功: 保存済みの draw（studentId は含めない）。
 * 失敗: DbError（code: NOT_SETUP / PENDING_EXISTS / INVALID_STUDENT / ALREADY_USED / BOX_EMPTY / BAD_REQUEST / DB_ERROR）
 */
export async function draw({ kind, studentId, survey }) {
  if (kind !== 'student' && kind !== 'guest') throw new DbError('BAD_REQUEST', 'kind');
  const sid = kind === 'student' ? normalizeStudentId(studentId) : null;
  const tx = await beginTx(DRAW_STORES, 'readwrite'); // ← await はトランザクション作成前のみ
  return new Promise((resolve, reject) => {
    let result = null;
    let failure = null;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || new DbError('DB_ERROR', tx.error?.name));
    tx.onerror = () => {};
    const fail = (code, detail) => {
      failure = failure || new DbError(code, detail);
      try { tx.abort(); } catch { /* noop */ }
    };
    try {
      const metaStore = tx.objectStore('meta');
      const invStore = tx.objectStore('inventory');
      const reqMeta = metaStore.getAll();
      const reqInv = invStore.getAll();
      const reqStudent = kind === 'student' ? tx.objectStore('students').get(sid) : null;
      whenAll([reqMeta, reqInv, reqStudent].filter(Boolean), () => {
        // ここから同期処理のみ（pickPrize も normalizeConfig も同期）
        try {
          const m = metaMap(reqMeta.result);
          if (!m.config) return fail('NOT_SETUP');
          const config = normalizeConfig(m.config); // v1 の保存データも v2 として扱う
          // 参加の方法・アンケートの判定（不正なら、まだ何も書いていないので中止するだけ）
          if (!config.entry[kind].enabled) return fail('BAD_REQUEST', 'entry');
          let svy = null;
          if (kind === 'guest' && config.survey.enabled) {
            svy = normalizeSurvey(survey, { ages: config.survey.q1.options, triggers: config.survey.q2.options });
            if (!svy) return fail('BAD_REQUEST', 'survey');
          } else if (survey != null) {
            return fail('BAD_REQUEST', 'survey');
          }
          if (m.pendingDrawId) return fail('PENDING_EXISTS');
          const dayId = m.activeDayId;
          const dayIndex = config.days.findIndex((d) => d.id === dayId);
          if (dayIndex < 0) return fail('NOT_SETUP');
          if (kind === 'student') {
            if (!validateStudentId(sid, config.studentIdRule).ok) return fail('INVALID_STUDENT');
            if (reqStudent.result) return fail('ALREADY_USED');
          }
          const prizeIds = new Set(config.prizes.map((p) => p.id));
          const items = reqInv.result.filter((r) => r.dayId === dayId && prizeIds.has(r.prizeId));
          const prizeId = pickPrize(items.map((r) => ({ prizeId: r.prizeId, remaining: r.remaining })));
          if (prizeId == null) return fail('BOX_EMPTY');

          const rec = items.find((r) => r.prizeId === prizeId);
          if (!rec || rec.remaining < 1) return fail('BOX_EMPTY'); // 念のため（負数にしない）
          rec.remaining -= 1;
          invStore.put(rec);

          const prize = config.prizes.find((p) => p.id === prizeId);
          const cat = config.categories.find((c) => c.id === prize.categoryId);
          const seqMap = { ...(m.drawSeq || {}) };
          const seq = (seqMap[dayId] || 0) + 1;
          seqMap[dayId] = seq;
          const label = `${dayIndex + 1}-${pad4(seq)}`;
          const now = Date.now();
          const record = {
            id: label, seq, label,
            eventId: config.eventId, dayId, kind,
            prizeId, categoryId: cat.id, tier: cat.tier,
            prizeName: prize.name, categoryName: cat.name,
            drawnAt: now, confirmedAt: null,
          };
          if (kind === 'student') record.studentId = sid;
          if (svy) record.survey = svy;
          tx.objectStore('draws').add(record); // id 重複なら ConstraintError → abort
          if (kind === 'student') tx.objectStore('students').add({ studentId: sid, drawId: label, at: now });
          metaStore.put({ key: 'drawSeq', value: seqMap });
          metaStore.put({ key: 'pendingDrawId', value: label });
          const { studentId: _omit, ...pub } = record; // 呼び出し側には学籍番号を返さない
          result = pub;
        } catch (e) {
          fail('DB_ERROR');
        }
      });
    } catch (e) {
      fail('DB_ERROR');
    }
  });
}

/** スタッフOK。確認済みにして pendingDrawId を消すだけ（冪等・再抽選しない）。 */
export function confirmDraw(id) {
  return runTx(['meta', 'draws'], 'readwrite', (tx, ok, fail) => {
    const draws = tx.objectStore('draws');
    const meta = tx.objectStore('meta');
    const rd = draws.get(id);
    const rp = meta.get('pendingDrawId');
    whenAll([rd, rp], () => {
      const rec = rd.result;
      if (!rec) return fail('NOT_FOUND');
      let already = true;
      if (!rec.confirmedAt) { rec.confirmedAt = Date.now(); draws.put(rec); already = false; }
      if (rp.result?.value === id) meta.delete('pendingDrawId');
      ok({ id, already });
    });
  });
}

/** 未確認の抽選（無ければ null）。学籍番号は含めない。 */
export async function getPendingDraw() {
  const tx = await beginTx(['meta', 'draws'], 'readonly');
  const p = await reqP(tx.objectStore('meta').get('pendingDrawId'));
  if (!p?.value) return null;
  const rec = await reqP(tx.objectStore('draws').get(p.value));
  if (!rec) return null;
  const { studentId: _omit, ...pub } = rec;
  return pub;
}

/** 参加済みか（読み取りのみ。使用済み登録は draw() の中だけ）。 */
export async function isStudentUsed(id) {
  const sid = normalizeStudentId(id);
  const tx = await beginTx(['students'], 'readonly');
  return !!(await reqP(tx.objectStore('students').get(sid)));
}

/** 抽選履歴（新しい順）。管理画面用なので studentId を含む（表示側でマスクする）。 */
export async function listDraws() {
  const tx = await beginTx(['draws'], 'readonly');
  const rows = await reqP(tx.objectStore('draws').getAll());
  return rows.sort((a, b) => b.drawnAt - a.drawnAt || b.seq - a.seq);
}

export async function listLogs() {
  const tx = await beginTx(['logs'], 'readonly');
  const rows = await reqP(tx.objectStore('logs').getAll());
  return rows.sort((a, b) => b.at - a.at);
}

// ---------- バックアップ ----------
export async function getBackupStatus() {
  const tx = await beginTx(['meta', 'draws'], 'readonly');
  const last = (await reqP(tx.objectStore('meta').get('lastBackupAt')))?.value ?? null;
  const draws = await reqP(tx.objectStore('draws').getAll());
  const since = draws.filter((d) => last == null || d.drawnAt > last).length;
  return { lastBackupAt: last, drawsSince: since, drawsTotal: draws.length };
}

/** バックアップ時刻の記録（exportedAt を渡す＝書出し後の抽選も「未バックアップ」に数える）。 */
export function markBackup(at) {
  return runTx(['meta', 'logs'], 'readwrite', (tx, ok) => {
    tx.objectStore('meta').put({ key: 'lastBackupAt', value: at });
    addLog(tx, 'backup', { at });
    ok(true);
  });
}

/** 全データを JSON 化できるオブジェクトにして返す（1つの readonly tx = 整合したスナップショット）。config は v2 に正規化して入れる。 */
export async function exportAll() {
  const tx = await beginTx(STORES, 'readonly');
  const [meta, inventory, draws, students, logs] = await Promise.all(
    STORES.map((s) => reqP(tx.objectStore(s).getAll())),
  );
  return {
    app: 'yosoro-gacha',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    meta: meta.map((r) => (r.key === 'config' && r.value ? { key: 'config', value: normalizeConfig(r.value) } : r)),
    inventory, draws, students, logs,
  };
}

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

/** バックアップの検証（純粋関数）。{ok:true, summary} | {ok:false, error}。schemaVersion 1（v1 の config）と 2 を受け付ける。 */
export function validateBackup(obj) {
  const bad = (error) => ({ ok: false, error });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('ファイルの形式が正しくありません');
  if (obj.kind === 'profile') return bad('これは設定ファイルです（バックアップではありません）。「設定ファイルを読み込む」から読み込んでください');
  if (obj.app !== 'yosoro-gacha') return bad('このアプリのバックアップではありません');
  if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion < 1) return bad('バージョン情報がありません');
  if (obj.schemaVersion > SCHEMA_VERSION) return bad('新しいバージョンのバックアップです。アプリを更新してください');
  for (const k of ['meta', 'inventory', 'draws', 'students']) {
    if (!Array.isArray(obj[k])) return bad(`${k} がありません`);
  }
  if (obj.logs != null && !Array.isArray(obj.logs)) return bad('logs が正しくありません');

  const metaRows = obj.meta;
  if (!metaRows.every((r) => r && typeof r.key === 'string')) return bad('meta が正しくありません');
  const m = metaMap(metaRows);
  const raw = m.config;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.days) || !raw.days.length || !Array.isArray(raw.categories)
      || !Array.isArray(raw.prizes) || !raw.studentIdRule || typeof raw.pinHash !== 'string') {
    return bad('設定（config）が正しくありません');
  }
  // 開催日・賞・景品の整合：id があって重複せず、景品の賞が存在する（v1 の config も同じ見方）
  const uniqueIds = (list) => list.every((x) => x && typeof x.id === 'string' && x.id) && new Set(list.map((x) => x.id)).size === list.length;
  if (!uniqueIds(raw.days) || !uniqueIds(raw.categories) || !uniqueIds(raw.prizes)) return bad('設定（config）が正しくありません');
  const cfg = normalizeConfig(raw); // v1 は v2 に補ってから見る（復元でも同じ正規化をして書く）
  const catIds = new Set(cfg.categories.map((c) => c.id));
  if (!cfg.prizes.every((p) => catIds.has(p.categoryId))) return bad('設定（config）が正しくありません');
  const dayIds = new Set(cfg.days.map((d) => d.id));
  const prizeIds = new Set(cfg.prizes.map((p) => p.id));
  if (!dayIds.has(m.activeDayId)) return bad('開催日の情報が正しくありません');

  const keys = new Set();
  for (const r of obj.inventory) {
    if (!r || !dayIds.has(r.dayId) || !prizeIds.has(r.prizeId) || r.key !== `${r.dayId}:${r.prizeId}`
        || !isNonNegInt(r.initial) || !isNonNegInt(r.remaining) || keys.has(r.key)) {
      return bad('在庫データが正しくありません');
    }
    keys.add(r.key);
  }
  const drawIds = new Set();
  for (const d of obj.draws) {
    if (!d || typeof d.id !== 'string' || typeof d.label !== 'string' || !dayIds.has(d.dayId)
        || typeof d.prizeId !== 'string' || !Number.isFinite(d.drawnAt) || drawIds.has(d.id)
        || (d.kind !== 'student' && d.kind !== 'guest')) {
      return bad('抽選履歴が正しくありません');
    }
    // survey は一般の方の抽選だけ・任意（古い履歴・古いバックアップには無い＝「未回答」）
    if (d.survey != null && (d.kind !== 'guest' || !isStoredSurvey(d.survey))) return bad('アンケートの記録が正しくありません');
    drawIds.add(d.id);
  }
  const sids = new Set();
  for (const s of obj.students) {
    if (!s || typeof s.studentId !== 'string' || sids.has(s.studentId) || !drawIds.has(s.drawId)) {
      return bad('参加済み番号のデータが正しくありません');
    }
    sids.add(s.studentId);
  }
  if (m.pendingDrawId != null) {
    const pd = obj.draws.find((d) => d.id === m.pendingDrawId);
    if (!pd) return bad('未確認抽選の情報が正しくありません');
  }
  return {
    ok: true,
    summary: {
      exportedAt: obj.exportedAt ?? null,
      draws: obj.draws.length,
      students: obj.students.length,
      pending: m.pendingDrawId ?? null,
    },
  };
}

/** バックアップから復元（全置換・単一トランザクション）。config は v2 に正規化して書く（v1 のバックアップは電波祭2026 の設定になる）。 */
export async function importAll(obj) {
  const v = validateBackup(obj);
  if (!v.ok) throw new DbError('INVALID_BACKUP', v.error);
  return runTx(STORES, 'readwrite', (tx, ok) => {
    for (const s of STORES) tx.objectStore(s).clear();
    for (const r of obj.meta) {
      if (r.key === 'lastBackupAt') continue;
      tx.objectStore('meta').put({ key: r.key, value: r.key === 'config' ? normalizeConfig(r.value) : r.value });
    }
    // 復元した内容 = バックアップ時点なので、バックアップ済みとして扱う
    tx.objectStore('meta').put({ key: 'lastBackupAt', value: obj.exportedAt ?? Date.now() });
    tx.objectStore('meta').put({ key: 'schemaVersion', value: SCHEMA_VERSION });
    for (const r of obj.inventory) tx.objectStore('inventory').put({ adjust: 0, ...r });
    for (const r of obj.draws) tx.objectStore('draws').put(r);
    for (const r of obj.students) tx.objectStore('students').put(r);
    for (const r of obj.logs || []) {
      const { id: _id, ...rest } = r; // 連番は振り直す
      tx.objectStore('logs').add(rest);
    }
    addLog(tx, 'restore', { draws: obj.draws.length, students: obj.students.length, exportedAt: obj.exportedAt ?? null });
    ok(v.summary);
  });
}

// ---------- 設定ファイル（イベント設定だけの JSON。docs/CUSTOMIZE.md §3.3） ----------
/** 設定ファイルの中身（今の config と在庫の初期本数。js/profile.js exportProfile）。1つの readonly tx = 整合した内容。 */
export async function exportProfileFile() {
  const tx = await beginTx(['meta', 'inventory'], 'readonly');
  const [row, inventory] = await Promise.all([reqP(tx.objectStore('meta').get('config')), reqP(tx.objectStore('inventory').getAll())]);
  if (!row?.value) throw new DbError('NOT_SETUP');
  return exportProfile(normalizeConfig(row.value), inventory);
}

/**
 * 設定ファイルの読み込み（スタッフ画面。抽選履歴が1件も無いときだけ）。成功は新しい config。
 * 今の PIN と効果音の設定は残す。在庫は初期本数で作り直し（残数＝初期本数・調整 0）、開催日は最初の日、連番はリセット。
 * 失敗: INVALID_PROFILE（detail は理由）/ NOT_SETUP / HAS_DRAWS（履歴があれば何も書かない）
 */
export async function importProfile(fileObj) {
  const v = validateProfileFile(fileObj);
  if (!v.ok) throw new DbError('INVALID_PROFILE', v.error);
  return runTx(STORES, 'readwrite', (tx, ok, fail) => {
    const meta = tx.objectStore('meta');
    const rc = meta.get('config');
    const rn = tx.objectStore('draws').count();
    whenAll([rc, rn], () => {
      try {
        if (!rc.result?.value) return fail('NOT_SETUP');
        if (rn.result > 0) return fail('HAS_DRAWS');
        const cur = normalizeConfig(rc.result.value);
        const config = normalizeConfig({ ...v.config, pinHash: cur.pinHash, sound: cur.sound });
        const inv = tx.objectStore('inventory');
        inv.clear();
        for (const d of config.days) {
          for (const p of config.prizes) {
            const n = v.initials[d.id][p.id];
            inv.put({ key: `${d.id}:${p.id}`, dayId: d.id, prizeId: p.id, initial: n, remaining: n, adjust: 0 });
          }
        }
        tx.objectStore('students').clear();
        meta.put({ key: 'config', value: config });
        meta.put({ key: 'activeDayId', value: config.days[0].id });
        meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
        meta.put({ key: 'drawSeq', value: {} });
        meta.delete('pendingDrawId');
        meta.delete('lastBackupAt');
        addLog(tx, 'profile-import', { eventId: config.eventId, days: config.days.length, prizes: config.prizes.length });
        ok(config);
      } catch (e) {
        fail('DB_ERROR', e?.name);
      }
    });
  });
}

// ---------- リセット ----------
/** 本番リセット：履歴・使用済み番号・ログを消し、在庫を初期本数へ戻す。設定とPINは残す。 */
export function productionReset() {
  return runTx(STORES, 'readwrite', (tx, ok) => {
    const inv = tx.objectStore('inventory');
    const meta = tx.objectStore('meta');
    tx.objectStore('draws').clear();
    tx.objectStore('students').clear();
    tx.objectStore('logs').clear();
    meta.delete('pendingDrawId');
    meta.delete('lastBackupAt');
    meta.put({ key: 'drawSeq', value: {} });
    const cur = inv.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        const r = c.value;
        r.remaining = r.initial;
        r.adjust = 0;
        c.update(r);
        c.continue();
      } else {
        addLog(tx, 'production-reset', null);
        ok(true);
      }
    };
  });
}

/** 全初期化（設定も含めて全削除）。 */
export function wipeAll() {
  return runTx(STORES, 'readwrite', (tx, ok) => {
    for (const s of STORES) tx.objectStore(s).clear();
    ok(true);
  });
}

export { createDefaultConfig };
