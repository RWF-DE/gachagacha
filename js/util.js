// 共通ユーティリティ（DOM生成・ハッシュ・長押し・ファイル保存など）

/** 小さな DOM ヘルパ。h('div', {class:'x', onclick}, 'text', child) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'inputmode'
             || k === 'colspan' || k === 'autocapitalize' || k === 'autocorrect') { if (v !== false) el.setAttribute(k, v === true ? '' : v); }
    else if (k in el) el[k] = v;
    else if (v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export const clear = (el) => el.replaceChildren();

// ---------- ハッシュ（PIN） ----------
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 非セキュアコンテキスト用の簡易フォールバック（PINは誤操作防止が目的）
  let a = 0x811c9dc5;
  for (const b of data) { a ^= b; a = Math.imul(a, 0x01000193) >>> 0; }
  return 'weak-' + a.toString(16);
}

export const hashPin = (pin) => sha256Hex(`yosoro-gacha:${pin}`);

// ---------- 表示用 ----------
const p2 = (n) => String(n).padStart(2, '0');

export function fmtDateTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function fileStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/** 学籍番号の末尾2桁以外を伏せる */
export function maskId(id) {
  const s = String(id ?? '');
  if (s.length <= 2) return '＊'.repeat(s.length);
  return '＊'.repeat(s.length - 2) + s.slice(-2);
}

export function toCsv(rows) {
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}

// ---------- 長押し ----------
/**
 * el を ms ミリ秒押し続けたら onComplete を1回呼ぶ。
 * 途中で離す・外へ出す・キャンセルされるとリセット。onProgress(0..1) で進捗を通知。
 * 完了判定は setTimeout（描画が止まっても確実）、進捗表示は rAF。
 */
export function longPress(el, { ms, onProgress, onComplete }) {
  let timer = 0, raf = 0, start = 0, active = false;
  const stop = () => {
    active = false;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    onProgress?.(0);
  };
  const frame = () => {
    if (!active) return;
    onProgress?.(Math.min(1, (performance.now() - start) / ms));
    raf = requestAnimationFrame(frame);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (active) return;
    active = true;
    start = performance.now();
    timer = setTimeout(() => {
      if (!active) return;
      cancelAnimationFrame(raf);
      onProgress?.(1);
      active = false;
      onComplete?.();
    }, ms);
    raf = requestAnimationFrame(frame);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return stop;
}

// ---------- ファイル保存 ----------
/**
 * ファイルを共有シート（可能なら）またはダウンロードで保存する。
 * 戻り値: 'shared' | 'downloaded' | 'cancelled'
 * ※共有はユーザー操作の直接のクリックハンドラから呼ぶこと（iOS の制約）。
 */
export async function saveFile(file) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
    // 共有に失敗したらダウンロードへフォールバック
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  return 'downloaded';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
