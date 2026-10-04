// IndexedDB ラッパ（DESIGN.md §5/§6）。
// 重要: draw() は単一の readwrite トランザクション内で完結させ、
//       transaction の complete を待ってから resolve する。
//       トランザクション中に IDB 以外の非同期処理（await 等）を挟まない。
import { DB_NAME, SCHEMA_VERSION, createDefaultConfig } from './config.js';
import { pickPrize, normalizeStudentId, validateStudentId } from './lottery.js';

const STORES = ['meta', 'inventory', 'draws', 'students', 'logs'];

/** 型付きエラー。code: ALREADY_USED / BOX_EMPTY / PENDING_EXISTS / NOT_SETUP / DB_ERROR など */
export class DbError extends Error {
  constructor(code, detail) {
    super(code + (detail ? `: ${detail}` : ''));
    this.name = 'DbError';
    this.code = code;
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

export async function getConfig() {
  return (await getMeta('config')) ?? null;
}

export async function isSetUp() {
  const c = await getConfig();
  return !!(c && c.pinHash);
}

export async function getActiveDayId() {
  return (await getMeta('activeDayId')) ?? null;
}

/**
 * 初回セットアップ。config / 在庫 / 開催日を1トランザクションで書く。
 * initials: {dayId:{prizeId:count}}
 */
export function initialize({ config, activeDayId, initials }) {
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

/** 設定の一部更新（効果音・学籍番号ルール・PINなど）。変更前後の要約だけログに残す（pinHashは残さない）。 */
export function saveConfig(config, logType = 'config', logDetail = null) {
  return runTx(['meta', 'logs'], 'readwrite', (tx, ok) => {
    tx.objectStore('meta').put({ key: 'config', value: config });
    addLog(tx, logType, logDetail);
    ok(true);
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
 * 景品設定の保存（名称・未定フラグ・日別初期本数）。
 * 初期本数は「まだ1回も抽選していない日」だけ変更可。抽選済みの日で値が違えば DAY_HAS_DRAWS。
 * input: {categories:[{id,name}], prizes:[{id,name,countUnknown}], initials:{dayId:{prizeId:n}}}
 */
export function savePrizeSettings(input) {
  return runTx(['meta', 'inventory', 'draws', 'logs'], 'readwrite', (tx, ok, fail) => {
    const meta = tx.objectStore('meta');
    const inv = tx.objectStore('inventory');
    const rc = meta.get('config');
    const ri = inv.getAll();
    const rd = tx.objectStore('draws').getAll();
    whenAll([rc, ri, rd], () => {
      const config = rc.result?.value;
      if (!config) return fail('NOT_SETUP');
      const daysWithDraws = new Set(rd.result.map((d) => d.dayId));
      const changes = [];
      for (const c of input.categories || []) {
        const cat = config.categories.find((x) => x.id === c.id);
        const name = String(c.name ?? '').trim();
        if (!cat || !name || name.length > 40) return fail('BAD_REQUEST', 'category');
        if (cat.name !== name) { changes.push({ category: cat.id, from: cat.name, to: name }); cat.name = name; }
      }
      for (const p of input.prizes || []) {
        const prize = config.prizes.find((x) => x.id === p.id);
        const name = String(p.name ?? '').trim();
        if (!prize || !name || name.length > 60) return fail('BAD_REQUEST', 'prize');
        if (prize.name !== name) { changes.push({ prize: prize.id, from: prize.name, to: name }); prize.name = name; }
        const unk = !!p.countUnknown;
        if (prize.countUnknown !== unk) { changes.push({ prize: prize.id, countUnknown: unk }); prize.countUnknown = unk; }
      }
      const byKey = new Map(ri.result.map((r) => [r.key, r]));
      for (const [dayId, perPrize] of Object.entries(input.initials || {})) {
        for (const [prizeId, raw] of Object.entries(perPrize)) {
          const n = Math.floor(Number(raw));
          if (!Number.isFinite(n) || n < 0 || n > 100000) return fail('BAD_REQUEST', 'initial');
          const rec = byKey.get(`${dayId}:${prizeId}`);
          if (!rec) return fail('NOT_FOUND');
          if (rec.initial === n) continue;
          if (daysWithDraws.has(dayId)) return fail('DAY_HAS_DRAWS');
          changes.push({ dayId, prizeId, initial: { from: rec.initial, to: n } });
          rec.initial = n;
          rec.remaining = n; // 抽選前の日なので残数も揃える
          rec.adjust = 0;
          inv.put(rec);
        }
      }
      meta.put({ key: 'config', value: config });
      if (changes.length) addLog(tx, 'prize-settings', changes);
      ok(config);
    });
  });
}

// ---------- 抽選（最重要） ----------
const DRAW_STORES = ['meta', 'inventory', 'draws', 'students'];

/**
 * 抽選して保存する。resolve は transaction の complete 後。
 * 引数 {kind:'student'|'guest', studentId?}
 * 成功: 保存済みの draw（studentId は含めない）。
 * 失敗: DbError（code: NOT_SETUP / PENDING_EXISTS / INVALID_STUDENT / ALREADY_USED / BOX_EMPTY / BAD_REQUEST / DB_ERROR）
 */
export async function draw({ kind, studentId }) {
  if (kind !== 'student' && kind !== 'guest') throw new DbError('BAD_REQUEST', 'kind');
  const sid = kind === 'student' ? normalizeStudentId(studentId) : null;
  const tx = await beginTx(DRAW_STORES, 'readwrite'); // ← await はトランザクション作成前のみ
  return new Promise((resolve, reject) => {
    let result = null;
    let failure = null;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || new DbError('DB_ERROR', tx.error?.name));
    tx.onerror = () => {};
    const fail = (code) => {
      failure = failure || new DbError(code);
      try { tx.abort(); } catch { /* noop */ }
    };
    try {
      const metaStore = tx.objectStore('meta');
      const invStore = tx.objectStore('inventory');
      const reqMeta = metaStore.getAll();
      const reqInv = invStore.getAll();
      const reqStudent = kind === 'student' ? tx.objectStore('students').get(sid) : null;
      whenAll([reqMeta, reqInv, reqStudent].filter(Boolean), () => {
        // ここから同期処理のみ（pickPrize も同期）
        try {
          const m = metaMap(reqMeta.result);
          const config = m.config;
          if (!config) return fail('NOT_SETUP');
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

/** 全データを JSON 化できるオブジェクトにして返す（1つの readonly tx = 整合したスナップショット）。 */
export async function exportAll() {
  const tx = await beginTx(STORES, 'readonly');
  const [meta, inventory, draws, students, logs] = await Promise.all(
    STORES.map((s) => reqP(tx.objectStore(s).getAll())),
  );
  return {
    app: 'yosoro-gacha',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    meta, inventory, draws, students, logs,
  };
}

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

/** バックアップの検証（純粋関数）。{ok:true, summary} | {ok:false, error} */
export function validateBackup(obj) {
  const bad = (error) => ({ ok: false, error });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('ファイルの形式が正しくありません');
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
  const cfg = m.config;
  if (!cfg || !Array.isArray(cfg.days) || !cfg.days.length || !Array.isArray(cfg.categories)
      || !Array.isArray(cfg.prizes) || !cfg.studentIdRule || typeof cfg.pinHash !== 'string') {
    return bad('設定（config）が正しくありません');
  }
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

/** バックアップから復元（全置換・単一トランザクション）。 */
export async function importAll(obj) {
  const v = validateBackup(obj);
  if (!v.ok) throw new DbError('INVALID_BACKUP', v.error);
  return runTx(STORES, 'readwrite', (tx, ok) => {
    for (const s of STORES) tx.objectStore(s).clear();
    for (const r of obj.meta) {
      if (r.key === 'lastBackupAt') continue;
      tx.objectStore('meta').put({ key: r.key, value: r.value });
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
