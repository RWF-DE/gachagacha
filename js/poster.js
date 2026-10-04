// ポスター表現の共有部品：舵輪マーク・ヘッダ帯・拡縮・紙の粒子・文字の割り付け
// （DOM に触るのはここと stage.js / screens.js だけ。抽選やDBには一切触れない）

/** 舵輪（8本スポーク）と矢印・回転アイコンのシンボル。--wc: 本体色 / --hl: 王様スポーク（赤）の色 */
export const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="wheel" viewBox="-300 -300 600 600" overflow="visible">
 <g fill="var(--wc,#0A0E33)">
  <path fill-rule="evenodd" d="M-206 0a206 206 0 1 0 412 0a206 206 0 1 0 -412 0ZM-170 0a170 170 0 1 1 340 0a170 170 0 1 1 -340 0Z"/>
  <g id="wh-s"><rect x="-11" y="-240" width="22" height="240"/><rect x="-19" y="-292" width="38" height="132" rx="19"/></g>
  <use href="#wh-s" transform="rotate(45)"/><use href="#wh-s" transform="rotate(90)"/><use href="#wh-s" transform="rotate(135)"/>
  <use href="#wh-s" transform="rotate(180)"/><use href="#wh-s" transform="rotate(225)"/><use href="#wh-s" transform="rotate(270)"/><use href="#wh-s" transform="rotate(315)"/>
  <path fill-rule="evenodd" d="M-76 0a76 76 0 1 0 152 0a76 76 0 1 0 -152 0ZM-42 0a42 42 0 1 1 84 0a42 42 0 1 1 -84 0Z"/>
  <circle r="16"/>
 </g>
 <g fill="var(--hl,#F23B20)"><rect x="-19" y="-292" width="38" height="132" rx="19"/><rect x="-11" y="-240" width="22" height="80"/></g>
</symbol>
<symbol id="arrow" viewBox="0 0 48 48"><path d="M4 24h36M26 8l16 16-16 16" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="square"/></symbol>
<symbol id="rot" viewBox="0 0 48 48"><path d="M40 24a16 16 0 1 1-5-11.6" fill="none" stroke="currentColor" stroke-width="6"/><path d="M42 4v14H28z" fill="currentColor"/></symbol>
</defs></svg>`;

export const wheelMark = (extra = '') =>
  `<svg class="wm" viewBox="-300 -300 600 600" aria-hidden="true" ${extra}><use href="#wheel" x="-300" y="-300" width="600" height="600"/></svg>`;

/** ヘッダ帯。左はロゴ（固定配置）の場所。中央は画面名、右は開催日（非データの飾り）と色見本 */
export const metaHtml = (mid = '') =>
  `<div class="meta"><span class="ml"></span><span class="mm">${mid}</span><span class="r"><span class="day"></span><span class="sw"><i></i><i></i><i></i></span></span></div>`;

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
 */
export function fitStage(stageEl) {
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
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
  return { W, H, s, portrait };
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

/** ハーフトーン（協賛特別賞の飾り）。w×h に合わせて生成 */
export function halftone(w, h, s = 14) {
  let out = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMaxYMid slice" xmlns="http://www.w3.org/2000/svg" fill="#0A0E33" aria-hidden="true">`;
  for (let r = 0; r * s * 0.866 < h + s; r++) {
    for (let c = -1; c * s < w + s; c++) {
      const x = c * s + (r % 2 ? s / 2 : 0);
      const y = r * s * 0.866 + s / 2;
      const t = Math.max(0, Math.min(1, (x / w) * 0.85 + (1 - y / h) * 0.25));
      const rad = Math.pow(t, 1.1) * s * 0.62;
      if (rad > 0.6 && x < w + 2) out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}"/>`;
    }
  }
  return `${out}</svg>`;
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
