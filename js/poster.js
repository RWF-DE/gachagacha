// ポスター表現の共有部品：回すもの（モチーフ）のマーク・ヘッダ帯・拡縮・紙の粒子・文字の割り付け
// （DOM に触るのはここと stage.js / screens.js だけ。抽選やDBには一切触れない）
import { getMotif } from './motifs.js';

/**
 * 回すもの（js/motifs.js）と矢印・回転アイコンのシンボル。--wc: 本体色 / --hl: 目印（舵輪なら赤い王様スポーク）の色。
 * ロゴ・待機画面の大きなマーク・抽選画面・結果画面の飾りはすべて <use href="#wheel"> なので、
 * モチーフを替えるときは #wheel の中身だけを入れ替える（stage.setMotif）。
 */
export function defsHtml(motifId) {
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="wheel" viewBox="-300 -300 600 600" overflow="visible">${getMotif(motifId).svg}</symbol>
<symbol id="arrow" viewBox="0 0 48 48"><path d="M4 24h36M26 8l16 16-16 16" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="square"/></symbol>
<symbol id="rot" viewBox="0 0 48 48"><path d="M40 24a16 16 0 1 1-5-11.6" fill="none" stroke="currentColor" stroke-width="6"/><path d="M42 4v14H28z" fill="currentColor"/></symbol>
</defs></svg>`;
}

export const wheelMark = (extra = '') =>
  `<svg class="wm" viewBox="-300 -300 600 600" aria-hidden="true" ${extra}><use href="#wheel" x="-300" y="-300" width="600" height="600"/></svg>`;

/** ヘッダ帯。左はロゴ（固定配置）の場所。中央は画面名（HTML。文字は esc() を通す）、右は開催日（非データの飾り）と色見本 */
export const metaHtml = (mid = '') =>
  `<div class="meta"><span class="ml"></span><span class="mm">${mid}</span><span class="r"><span class="day"></span><span class="sw"><i></i><i></i><i></i></span></span></div>`;

/** ヘッダ中央の文字（docs/CUSTOMIZE.md §7.2）。待機・学籍番号・抽選・情報画面：「{nameLatin} — {name}」（nameLatin が空なら name だけ） */
export const brandMid = (brand) => (brand?.nameLatin ? `${brand.nameLatin} — ${brand.name}` : String(brand?.name ?? ''));
/** アンケート画面：「{nameLatin または name} — SURVEY」 */
export const surveyMid = (brand) => `${brand?.nameLatin || brand?.name || ''} — SURVEY`;

/** 1文字ずつマスクで滑り込ませるための分割。--k は何文字目か */
export function splitChars(str, k0 = 0) {
  let k = k0;
  let out = '';
  for (const ch of str) out += `<span class="ch"><span class="chi" style="--k:${k++}">${esc(ch)}</span></span>`;
  return out;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 開催日の表示（飾り）。「1日目 / DAY 1」 */
export function dayText(config, dayId) {
  const i = config?.days?.findIndex((d) => d.id === dayId) ?? -1;
  if (i < 0) return '';
  return `${config.days[i].label} / DAY ${i + 1}`;
}

// ---------- 拡縮 ----------
/**
 * 横 1180×820 / 縦 820×1180 を基準にして、画面に収まる最大の等倍で拡縮する。
 * 基準より細長い画面では論理サイズ（--W / --H）が基準より大きくなり、各要素は端に固定して広げる。
 * 画面の大きさが前回と同じなら何も書かず、前回と同じ geo オブジェクトを返す（同じ値の再設定でも
 * #stage 配下全体のスタイル再計算が走るため。演出の頭で呼ばれても無害にする）。
 * 呼び出し側は「返り値が前回と同一か」で寸法の変化を判定してよい。
 */
const fitMemo = new WeakMap();
export function fitStage(stageEl) {
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
  const memo = fitMemo.get(stageEl);
  if (memo && memo.vw === vw && memo.vh === vh) return memo.geo;
  const portrait = vh > vw;
  const bw = portrait ? 820 : 1180;
  const bh = portrait ? 1180 : 820;
  const s = Math.min(vw / bw, vh / bh);
  const W = Math.round((vw / s) * 100) / 100;
  const H = Math.round((vh / s) * 100) / 100;
  const st = stageEl.style;
  st.setProperty('--W', `${W}px`);
  st.setProperty('--H', `${H}px`);
  st.setProperty('--ex', `${Math.max(0, H - bh)}px`);
  st.setProperty('--ew', `${Math.max(0, W - bw)}px`);
  st.transform = `scale(${s})`;
  stageEl.dataset.o = portrait ? 'p' : 'l';
  const geo = { W, H, s, portrait };
  fitMemo.set(stageEl, { vw, vh, geo });
  return geo;
}

// ---------- ヘッダ帯の文字が重ならないようにする ----------
const HDR_GAP = 20;       // 文字どうしの最小の空き(px)
const HDR_BASE = 15;      // ヘッダ帯・ロゴの字の大きさ(px。css/poster.css と同じ)
const HDR_MIN = 11;       // これより小さくせず、収まらなければ「…」で省略
/**
 * ヘッダ帯の左（ロゴ）・中央（画面名）・右（開催日）は、長い名前・長いイベント名・長い開催日名のときだけ重なる。
 * 収まるときは何も書かない（今の見た目のまま）。収まらないとき：
 *   ロゴの文字：右端が画面の幅の 42%（縦置きは 50%）を超えるなら字を小さく（11px まで）、それでも超えれば「…」で省略
 *   画面名：中央のまま収まらなければ、ロゴと開催日のあいだの空きの中央へ寄せ、入らなければ字を小さく（11px まで）→「…」で省略
 * 測るのは画面を出したとき・画面の大きさが変わったときだけ（app.js の mount と resize、stage.js の layoutResult）。演出中は呼ばない。
 * scope = 画面名を調整する範囲（既定はステージ全体。結果カードの準備では #result だけ）。ロゴは常に確かめる（右端が要るため）。
 */
export function fitHeader(stageEl, scope = stageEl) {
  const geo = fitStage(stageEl);
  const s = geo.s;
  const logo = stageEl.querySelector('#logo');
  const lt = logo?.querySelector('.logo-text');
  let logoRight = 0;
  if (logo && lt) {
    lt.removeAttribute('style');
    let r = logo.getBoundingClientRect().right / s;
    const cap = geo.W * (geo.portrait ? 0.5 : 0.42);
    if (r > cap) {
      const tw = lt.getBoundingClientRect().width / s;
      const room = Math.max(40, tw - (r - cap));
      const fs = Math.floor((HDR_BASE * room) / tw);
      if (fs >= HDR_MIN) lt.style.fontSize = `${fs}px`;
      else { lt.style.fontSize = `${HDR_MIN}px`; lt.style.maxWidth = `${Math.floor(room)}px`; lt.style.overflow = 'hidden'; lt.style.textOverflow = 'ellipsis'; }
      r = logo.getBoundingClientRect().right / s;
    }
    logoRight = r;
  }
  for (const meta of scope.querySelectorAll('.meta')) {
    const mm = meta.querySelector('.mm');
    const right = meta.querySelector('.r');
    if (!mm || !right) continue;
    mm.removeAttribute('style');
    const box = meta.getBoundingClientRect();
    if (!box.width) continue;   // 表示されていない
    const range = document.createRange();
    range.selectNodeContents(mm);
    const nat = range.getBoundingClientRect().width / s;
    const cx = (box.left + box.right) / 2 / s;
    const lo = Math.max(box.left / s, logoRight) + HDR_GAP;
    const hi = right.getBoundingClientRect().left / s - HDR_GAP;
    if (nat <= 2 * Math.min(cx - lo, hi - cx) + 0.5) continue;   // 中央のまま収まる
    const free = Math.max(60, hi - lo);
    if (nat > free) {
      const fs = Math.floor((HDR_BASE * free) / nat);
      mm.style.lineHeight = `${HDR_BASE * 1.5}px`;   // 小さくした字も、ほかの字と同じ行の高さ（上に浮かない）
      if (fs >= HDR_MIN) mm.style.fontSize = `${fs}px`;
      else { mm.style.fontSize = `${HDR_MIN}px`; mm.style.maxWidth = `${Math.floor(free)}px`; mm.style.overflow = 'hidden'; mm.style.textOverflow = 'ellipsis'; }
    }
    const ir = mm.getBoundingClientRect();
    mm.style.position = 'relative';
    mm.style.left = `${Math.round(lo + free / 2 - (ir.left + ir.right) / 2 / s)}px`;
  }
}

// ---------- 紙の粒子（静止タイル1枚。アニメーション・ブレンドなし） ----------
export function installGrain(stageEl) {
  try {
    const mk = (draw) => {
      const c = document.createElement('canvas');
      c.width = c.height = 200;
      const x = c.getContext('2d');
      const d = x.createImageData(200, 200);
      for (let i = 0; i < d.data.length; i += 4) draw(d.data, i);
      x.putImageData(d, 0, 0);
      return c.toDataURL();
    };
    // 黒の低アルファ＝グレーの multiply と同じ見え方（ブレンドモードを使わずに済む）
    const grain = mk((p, i) => {
      let v = 244 + Math.random() * 11;
      if (Math.random() < 0.012) v = 170 + Math.random() * 50;
      p[i] = p[i + 1] = p[i + 2] = 0;
      p[i + 3] = Math.round(255 - v);
    });
    // スタンプのかすれ用マスク（アルファ）
    const speck = mk((p, i) => {
      let a = 255;
      const r = Math.random();
      if (r < 0.025) a = 110 + Math.random() * 100;
      else if (r < 0.035) a = 0;
      p[i] = p[i + 1] = p[i + 2] = 0;
      p[i + 3] = a;
    });
    stageEl.style.setProperty('--grain', `url(${grain})`);
    stageEl.style.setProperty('--speck', `url(${speck})`);
  } catch { /* 粒子なしでも運用に支障はない */ }
}

/**
 * ハーフトーン（協賛特別賞の飾り）を canvas に1回だけ描く（静止画。SVG の円を数百個ラスタライズし直さないため）。
 * 元の図は 236×168 の座標系で、枠（boxW×boxH）に xMax・yMid の「スライス（はみ出す分は切る）」で収める。
 * scale = 描画の解像度（CSS px あたりの画素数）。ink = 点の色（配色のインク。呼び出し側が --ink を読んで渡す）。
 */
const HT_W = 236; const HT_H = 168;
export function drawHalftone(canvas, boxW, boxH, scale = 2, ink = '#0A0E33', s = 14) {
  const sc = Math.max(1, Math.min(3, scale));
  canvas.width = Math.max(1, Math.round(boxW * sc));
  canvas.height = Math.max(1, Math.round(boxH * sc));
  const g = canvas.getContext('2d');
  if (!g) return;
  const k = Math.max(boxW / HT_W, boxH / HT_H);
  g.setTransform(sc, 0, 0, sc, 0, 0);
  g.clearRect(0, 0, boxW, boxH);
  g.translate(boxW - HT_W * k, (boxH - HT_H * k) / 2);
  g.scale(k, k);
  g.fillStyle = ink;
  g.beginPath();
  for (let r = 0; r * s * 0.866 < HT_H + s; r++) {
    for (let c = -1; c * s < HT_W + s; c++) {
      const x = c * s + (r % 2 ? s / 2 : 0);
      const y = r * s * 0.866 + s / 2;
      const t = Math.max(0, Math.min(1, (x / HT_W) * 0.85 + (1 - y / HT_H) * 0.25));
      const rad = Math.pow(t, 1.1) * s * 0.62;
      if (rad > 0.6 && x < HT_W + 2) { g.moveTo(x + rad, y); g.arc(x, y, rad, 0, Math.PI * 2); }
    }
  }
  g.fill();
}

// ---------- 日本語の文節折り返し ----------
const cls = (ch) => {
  const c = ch.codePointAt(0);
  if (c >= 0x3041 && c <= 0x309f) return 'hira';
  if (c >= 0x30a1 && c <= 0x30ff && c !== 0x30fb) return 'kata';
  if ((c >= 0x4e00 && c <= 0x9fff) || c === 0x3005 || c === 0x3007) return 'kanji';
  if (/[A-Za-z0-9]/.test(ch)) return 'latin';
  return 'sym';
};

/**
 * 景品名などを「文節」に分ける（最後の手段として折り返すときの切れ目）。
 * 切れ目: 空白・「・」「、」の後／開き括弧の前／閉じ括弧の後／文字種（カタカナ・漢字・英数・ひらがな）が変わるところ。
 * ただし 漢字→ひらがな（送り仮名）では切らない。
 */
export function splitPhrases(text) {
  const out = [];
  let cur = '';
  let prev = '';
  for (const ch of String(text)) {
    const c = cls(ch);
    const pc = prev ? cls(prev) : '';
    const brk = cur !== '' && (
      /\s/.test(prev) ||
      /[・、。]/.test(prev) ||
      /[〈（(「『【《]/.test(ch) ||
      (/[〉）)」』】》]/.test(prev) && !/[〉）)」』】》、。]/.test(ch)) ||
      (c !== 'sym' && pc !== 'sym' && c !== pc && !(pc === 'kanji' && c === 'hira'))
    );
    if (brk) { out.push(cur); cur = ''; }
    cur += ch;
    prev = ch;
  }
  if (cur) out.push(cur);
  // 空白だけの文節は前に結合
  return out.reduce((a, p) => { if (/^\s+$/.test(p) && a.length) a[a.length - 1] += p; else a.push(p); return a; }, []);
}

// ---------- 字の大きさの見積り（実測しない＝決まった値になる） ----------
/**
 * 文字列の幅の見積り（em）。全角（かな・漢字・全角記号）は 1em。半角は字種ごとの控えめな値（見出しの Dela は英数が幅広め。W・M は特に広く 1em）。
 * 字体の読み込み前でも、画面の大きさや端末が違っても同じ値になる（長い呼び名のときだけ字を小さくする判断に使う）。
 */
export function emWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) w += /[MWmw]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? 0.8 : /[a-z]/.test(ch) ? 0.7 : /[0-9]/.test(ch) ? 0.72 : ch === ' ' ? 0.32 : 0.5;
    else if (c >= 0xff61 && c <= 0xff9f) w += 0.5;   // 半角カナ
    else w += 1;
  }
  return w;
}

/**
 * 見出し（nowrap の複数行）の字の大きさ(px)。いちばん長い行が maxW(px) に収まる最大のサイズ（base 以下・min 以上の整数）。
 * ls = 字間（em。1字ごとに足す）。base に収まるなら base をそのまま返す（収まる見出しは今のサイズのまま）。
 */
export function headingSize(lines, { base, min, maxW, ls = 0 }) {
  const widest = Math.max(...lines.map((t) => emWidth(t) + ls * [...String(t)].length));
  return Math.max(min, Math.min(base, Math.floor(maxW / widest)));
}

/**
 * 待機画面の大きな名前（ワードマーク）の割り付け計画（docs/CUSTOMIZE.md §7.1）。実測した字送りを渡す純粋関数。
 *   adv[i]      i 文字目の字送り（em）
 *   gap         字間（em。負で詰める）
 *   phraseEnds  文節の終わりの文字位置（累積の文字数。最後は adv.length）＝ 2行にするときの切れ目の候補
 *   availW      1行の幅の上限(px)（行の最後の字の字送りの終わりまで）
 *   maxInk      先頭から字の下端（影を含む）までに使ってよい高さ(px)
 *   cap         字の大きさの上限(px)
 *   twoFirst    1行と2行が同じ大きさなら2行にする（縦置き）
 *   minRatio    2行にするとき、短い方の行は長い方の行の幅のこの割合以上（「…祭」だけの行のような孤立した行を作らない）
 * 1行と2行（文節の切れ目のうち長い方の行がいちばん短くなる位置）を比べて、字が大きくなる方を返す。
 * 字の下端は、先頭の行の上から ((行数-1)×lineStep + inkBottom) em（行送り 0.88em・字の下端 0.976em は今の手詰めを測った値）。
 * 戻り値 { lines: 1|2, split: 2行目の先頭の文字位置（1行なら adv.length）, fs: 整数px, widths: [各行の幅(em)] }
 */
export function planWordmark({ adv, gap, phraseEnds, availW, maxInk, cap, twoFirst = false, minRatio = 0.3, lineStep = 0.88, inkBottom = 0.976 }) {
  const n = adv.length;
  const widthEm = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += adv[i]; return s + gap * (b - a - 1); };
  const sizeFor = (lines, wEm) => Math.max(12, Math.floor(Math.min(cap, availW / wEm, maxInk / ((lines - 1) * lineStep + inkBottom))));
  const w0 = widthEm(0, n);
  let best = { lines: 1, split: n, widths: [w0], fs: sizeFor(1, w0) };
  let two = null;
  for (const e of phraseEnds) {
    if (!(e > 0 && e < n)) continue;
    const w1 = widthEm(0, e); const w2 = widthEm(e, n);
    const m = Math.max(w1, w2);
    if (Math.min(w1, w2) < m * minRatio) continue;   // 孤立した短い行ができる切れ目は使わない
    if (!two || m < two.m) two = { lines: 2, split: e, widths: [w1, w2], m };
  }
  if (two) {
    two.fs = sizeFor(2, two.m);
    if (two.fs > best.fs || (twoFirst && two.fs === best.fs)) best = two;
  }
  return { lines: best.lines, split: best.split, fs: best.fs, widths: best.widths };
}

/** 画面内の文字（Dela など）が読み込み済みになるのを待つ（最大 ms） */
export async function fontsReady(ms = 1200) {
  try {
    if (!document.fonts?.load) return;
    const specs = ['400 100px Dela', '700 20px Zen', '900 100px Arc', '500 16px Mono'];
    await Promise.race([
      Promise.all(specs.map((s) => document.fonts.load(s, '電波祭ABC123'))),
      new Promise((r) => setTimeout(r, ms)),
    ]);
  } catch { /* noop */ }
}
