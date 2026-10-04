// 抽選まわりの純粋関数（DOM/IndexedDB に依存しない。node:test でそのままテストできる）

const TWO_32 = 0x100000000;

/**
 * 0 <= x < n の一様な整数を返す。
 * crypto.getRandomValues + 棄却サンプリングなので剰余バイアスがない。
 */
export function randomInt(n) {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
    throw new RangeError('randomInt: n must be an integer in [1, 2^32]');
  }
  if (n === 1) return 0;
  const limit = TWO_32 - (TWO_32 % n); // この値未満だけを採用する
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/**
 * 残数に比例して景品を1つ選ぶ（残数0は対象外）。
 * items: [{prizeId, remaining}]。選べなければ null。
 * ※ここでは残数を減らさない（減算は呼び出し側＝トランザクション内）。
 */
export function pickPrize(items, randInt = randomInt) {
  let total = 0;
  for (const it of items || []) {
    const r = Number(it.remaining);
    if (Number.isFinite(r) && r > 0) total += Math.floor(r);
  }
  if (total <= 0) return null;
  let ticket = randInt(total);
  for (const it of items) {
    const r = Math.floor(Number(it.remaining));
    if (!(r > 0)) continue;
    if (ticket < r) return it.prizeId;
    ticket -= r;
  }
  return null; // randInt が範囲外を返した場合の保険
}

/** 全角英数→半角、前後空白除去、英字は大文字化。 */
export function normalizeStudentId(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/　/g, ' ').trim();
  return s.toUpperCase();
}

/**
 * 学籍番号の形式チェック。id は正規化済みを渡す。
 * rule: {charset:'digits'|'alnum', minLength, maxLength}
 * 戻り値: {ok:true} | {ok:false, reason:'empty'|'charset'|'too_short'|'too_long'}
 */
export function validateStudentId(id, rule) {
  const s = String(id ?? '');
  if (s.length === 0) return { ok: false, reason: 'empty' };
  const re = rule?.charset === 'alnum' ? /^[0-9A-Z]+$/ : /^[0-9]+$/;
  if (!re.test(s)) return { ok: false, reason: 'charset' };
  const min = rule?.minLength ?? 1;
  const max = rule?.maxLength ?? 64;
  if (s.length < min) return { ok: false, reason: 'too_short' };
  if (s.length > max) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

/** 形式エラーを利用者向け日本語にする。 */
export function describeIdRule(rule) {
  const kind = rule?.charset === 'alnum' ? '英数字' : '数字';
  const min = rule?.minLength ?? 1;
  const max = rule?.maxLength ?? 64;
  return min === max ? `${min}桁の${kind}` : `${min}〜${max}桁の${kind}`;
}
