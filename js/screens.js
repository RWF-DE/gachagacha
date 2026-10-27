// プレイヤー画面のうち、状態を持たない静的な画面（区分選択・学籍番号・アンケート・情報画面）の組み立て。
// 舵輪の画面と結果は js/stage.js。画面遷移・DB・設定の読み込みは js/app.js
// （ここは config も DB も知らず、app.js から渡された brand / entry / survey の文言だけで組み立てる。docs/CUSTOMIZE.md §7）。
import { h } from './util.js';
import {
  metaHtml, wheelMark, splitPhrases, esc, brandMid, surveyMid, fitStage, fontsReady, planWordmark,
} from './poster.js';
import { createTenkey } from './ui.js';

// 日本語の見出し・ボタンは「文節」でだけ折り返す。'/' が文節の区切り（表示はされない）。
export const jp = (...parts) => parts.flatMap((p) => (Array.isArray(p) ? p : String(p).split('/')))
  .filter((t) => t !== '').map((t) => h('span', { class: 'ph' }, t));

/** 設問の見出し：'/' があればそこが折り返してよい位置（jp と同じ）。無ければ splitPhrases で自動 */
const headingNodes = (text) => (String(text).includes('/') ? jp(text) : splitPhrases(text).map((t) => h('span', { class: 'ph' }, t)));

const arrow = () => '<svg class="ar" aria-hidden="true"><use href="#arrow"/></svg>';

// ---------- レイアウトの計測（画面を作ったとき・画面の大きさが変わったときだけ。演出中は呼ばれない） ----------
let measureCtx = null;
const canvasCtx = () => (measureCtx ||= document.createElement('canvas').getContext('2d'));
/** 要素が今の書体・大きさ・字間で描く文字列の幅(px)。レイアウトを使わず canvas で測る（フォントが読み込まれていれば実際の書体） */
function naturalWidth(el, text = el.textContent) {
  const cs = getComputedStyle(el);
  const g = canvasCtx();
  g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return g.measureText(text).width + (parseFloat(cs.letterSpacing) || 0) * [...text].length;
}

/**
 * 部品を「画面が表示されている間」だけ測り直す：作った直後（描画の前）・画面の大きさが変わったとき・フォントの読み込み後に fit() を呼ぶ。
 * 画面が外されたら観察をやめる。ResizeObserver が無い環境では resize イベントで代用する。
 */
function autoFit(el, fit) {
  let ro = null;
  const run = () => {
    if (!el.isConnected) { stop(); return; }
    fit();
  };
  const stop = () => { ro?.disconnect(); removeEventListener('resize', run); };
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(run); ro.observe(el); } else { addEventListener('resize', run); queueMicrotask(run); }
  fontsReady(2500).then(run);
}

// ---------- 区分選択 ----------
// 名前が「手詰めの名前」（brand.wordmark.for と一致。よーそろがちゃ）のときは、字ごとの字間（--g）・縦置きの改行位置・読みの字間を
// 設定の値で組む（見た目は画素まで従来と同じ）。かなは字形の凹凸が違うので、組み合わせごとに「輪郭どうしの最小距離が 0.045em」になる値を
// 測って決めてある（ー の左右は広め、ろ→が は詰め、ち→ゃ は小書きの分だけ大きく詰める）。字や綴りを変えたら測り直す。
// それ以外の名前は自動で割り付ける（fitAuto）。
const tunedOf = (brand) => {
  const w = brand?.wordmark;
  if (!w || w.for !== `${brand.name}|${brand.nameLatin}`) return null;
  const ys = w.yomiSpacing;
  if (!Array.isArray(w.gaps) || !w.gaps.every(Number.isFinite) || !Number.isInteger(w.breakAt) || !ys || !Number.isFinite(ys.l) || !Number.isFinite(ys.p)) return null;
  return w;
};

export function chooseScreen({ intro, brand, entry, onStudent, onGuest }) {
  const tuned = tunedOf(brand);
  const el = h('section', { class: `scr scr-choose ${intro ? 'intro' : 'quick'}${tuned ? '' : ' auto'}`, 'data-testid': 'screen-choose' });
  // 名前：1文字ずつ迫り上がる（.c = overflow:hidden の窓、.ci = 中身）。--k は何文字目か（登場の遅延）。縦置きだけ手詰めは2行（.ln）
  const chars = [...brand.name];
  let yo;
  if (tuned) {
    const cs = chars.map((c, i) => `<span class="c" style="--k:${i};--g:${tuned.gaps[i] ?? 0}em"><span class="ci">${esc(c)}</span></span>`);
    yo = `<h1 class="yo" aria-label="${esc(brand.name)}"><span class="ln">${cs.slice(0, tuned.breakAt).join('')}</span><span class="ln">${cs.slice(tuned.breakAt).join('')}</span></h1>`;
  } else {
    const cs = chars.map((c, i) => `<span class="c" style="--k:${i}"><span class="ci">${c === ' ' ? '&nbsp;' : esc(c)}</span></span>`);
    yo = `<h1 class="yo" aria-label="${esc(brand.name)}">${cs.join('')}</h1>`;
  }
  // 読み（欧文名）：空なら行ごと出さない。帯（tagline）も空なら出さない
  const yomi = brand.nameLatin
    ? `<p class="yomi" aria-hidden="true"${tuned ? ` style="--yl:${tuned.yomiSpacing.l}em;--yp:${tuned.yomiSpacing.p}em"` : ''}>${esc(brand.nameLatin)}</p>` : '';
  const tag = brand.tagline ? `<p class="tag">${esc(brand.tagline)}</p>` : '';
  el.innerHTML = `${metaHtml(esc(brandMid(brand)))}
    <div class="bigw">${wheelMark()}</div>
    ${yo}
    ${yomi}
    ${tag}
    <div class="rows"></div>`;

  // 入口の行：有効な方法だけ。1つだけなら1行（群青の行）で番号は 01
  const row = (cls, n, title, sub, testid, onclick) => h('button', {
    type: 'button', class: `row ${cls}`, 'data-testid': testid, onclick,
  }, h('span', { class: 'wipe' }), h('span', { class: 'n' }, n),
  h('span', { class: 'tx' }, h('span', { class: 't' }, title), sub ? h('span', { class: 's' }, sub) : null),
  (() => { const t = document.createElement('template'); t.innerHTML = arrow(); return t.content.firstChild; })());
  // 各行は .rw で包む（登場のワイプ用：枠と中身を逆向きに transform で動かす。css/poster.css の rwOut / rwIn）
  const wrap = (cls, btn) => h('div', { class: `rw ${cls}` }, btn);
  const ways = [];
  if (entry.student.enabled) ways.push(['choose-student', entry.student, onStudent]);
  if (entry.guest.enabled) ways.push(['choose-guest', entry.guest, onGuest]);
  if (!ways.length) ways.push(['choose-student', entry.student, onStudent], ['choose-guest', entry.guest, onGuest]);   // 設定が壊れていても入口をなくさない
  el.querySelector('.rows').append(...ways.map(([testid, e, fn], i) => {
    const cls = i === 0 ? 'a' : 'b';
    return wrap(cls, row(cls, String(i + 1).padStart(2, '0'), e.title, e.sub, testid, fn));
  }));
  // 登場の間だけ枠で切る（終わったら外す）
  el.classList.add('anim');
  setTimeout(() => el.classList.remove('anim'), intro ? 2200 : 800);

  // 測るのは、画面を作ったとき・画面の大きさが変わったとき・フォント読み込み後だけ
  const nl = document.createElement('br');   // 2行にするときの改行（文字の要素は動かさない＝登場アニメーションを途切れさせない）
  autoFit(el, () => { fitRows(el); if (!tuned) fitAuto(el, brand, nl); });
  return el;
}

/** 入口の行の文字：列の幅に収まらないときだけ字を小さくする（収まるなら CSS の大きさのまま） */
function fitRows(root) {
  for (const tx of root.querySelectorAll('.row .tx')) {
    const avail = tx.clientWidth;   // .tx は min-width:0 の 1fr 列なので、中身が長くても列の幅は変わらない
    if (!avail) continue;
    for (const t of tx.children) {
      t.style.fontSize = '';
      const nat = naturalWidth(t);
      if (nat > avail) t.style.fontSize = `${Math.max(12, Math.floor((parseFloat(getComputedStyle(t).fontSize) * avail) / nat))}px`;
    }
  }
}

/**
 * 名前・読み・帯の自動割り付け（docs/CUSTOMIZE.md §7.1）。今の手詰めを測った寸法を式にしてある：
 *   - 名前（Dela）：字間は一律 -0.04em。箱に収まる最大の大きさ。1行と2行（文節の切れ目）を比べて大きい方（planWordmark）
 *   - 読み（Archivo）：名前の右端（影を含む）に右端がそろうよう字間を計算（0〜0.3em）。それでもはみ出すなら字を小さく
 *   - 縦の並び：名前の字の下端 → 59px → 読みの字 → 59px → 帯（読みが無ければ名前の下に直接）。横置きの余る高さ（--ex）は 0.15 / 0.38 / 0.62 で配分
 * 結果は画面要素の CSS 変数（--yo-* / --yomi-* / --tag-t）に入れる。css/poster.css「名前が手詰めでないとき」
 */
function fitAuto(root, brand, nl) {
  const stageEl = root.closest('#stage');
  const yo = root.querySelector('.yo');
  if (!stageEl || !yo) return;
  const geo = fitStage(stageEl);   // 画面の大きさが前回と同じなら何も書かない
  const P = geo.portrait;
  const cs = [...yo.querySelectorAll('.c')];
  const n = cs.length;
  if (!n) return;
  const GAP = -0.04;               // 字間(em)
  const B = P ? { top: 78, left: 17, maxInk: 400, cap: 199, tagGap: 56 } : { top: 62, left: 26, maxInk: 188, cap: 164, tagGap: 59 };
  const RIGHT = 40;                // 行の最後の字の字送りの終わりから画面の右端まであける幅（字のインクは右の余白ぶんだけさらに内側）
  const availW = geo.W - B.left - RIGHT;

  // 字送り（em）と、字のインクの右端（em）：実際の書体で測る
  const g = canvasCtx();
  g.font = `${getComputedStyle(yo).fontWeight} 100px ${getComputedStyle(yo).fontFamily}`;
  const glyphs = cs.map((c) => c.firstElementChild.textContent);
  const ms = glyphs.map((t) => g.measureText(t));
  const adv = ms.map((m) => m.width / 100);
  const inkR = ms.map((m, i) => (Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : ms[i].width) / 100);
  // 2行にするときの切れ目：文節の切れ目のうち、行の先頭に来てはいけない字（長音・句読点・小書きのかな・閉じ括弧など）の前を除く
  const NO_LINE_START = /^[ー、。，．・）)」』】〉》ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮ！？!?]/;
  const phrases = splitPhrases(brand.name);
  const phraseEnds = [];
  let acc = 0;
  phrases.forEach((p, i) => { acc += [...p].length; if (phrases[i + 1] && !NO_LINE_START.test(phrases[i + 1])) phraseEnds.push(acc); });

  const plan = planWordmark({ adv, gap: GAP, phraseEnds, availW, maxInk: B.maxInk, cap: B.cap, twoFirst: P });
  let fs = plan.fs;
  root.dataset.lines = String(plan.lines);
  if (plan.lines === 2) { if (nl.parentNode !== yo || nl.nextSibling !== cs[plan.split]) yo.insertBefore(nl, cs[plan.split]); } else nl.remove();
  const set = (k, v) => root.style.setProperty(k, v);
  set('--yo-fs', `${fs}px`);
  // 実際の幅を確かめる（canvas と画面の字送りが数 px ずれる環境のための保険。はみ出していれば比例して縮める）
  const lineEnds = plan.lines === 2 ? [plan.split - 1, n - 1] : [n - 1];
  const over = Math.max(...lineEnds.map((i) => cs[i].getBoundingClientRect().right / geo.s - 8 - (geo.W - RIGHT)));
  if (over > 0.5) { fs = Math.max(12, Math.floor((fs * availW) / (availW + over))); set('--yo-fs', `${fs}px`); }

  // 名前の右端（影を含むインクの右端）：いちばん右に出る行の最後の字
  const ranges = plan.lines === 2 ? [[0, plan.split], [plan.split, n]] : [[0, n]];
  const shadowX = Math.max(3, Math.min(5, 0.03 * fs));
  let wmRight = 0;
  for (const [a, b] of ranges) {
    let em = GAP * (b - a - 1);
    for (let i = a; i < b - 1; i++) em += adv[i];
    wmRight = Math.max(wmRight, B.left + (em + inkR[b - 1]) * fs);
  }
  wmRight += shadowX;

  // 縦の並び（字の下端 → 読み → 帯）
  const ex = P ? 0 : Math.max(0, geo.H - 820);
  const wmBottom = B.top + ((plan.lines - 1) * 0.88 + 0.976) * fs;
  let inkBottom = wmBottom;
  set('--yo-l', `${B.left}px`);
  set('--yo-t', `${B.top + ex * 0.15}px`);
  const yomi = root.querySelector('.yomi');
  if (yomi) {
    let yfs = P ? 76 + Math.max(0, geo.W - 820) * 0.1 : 104;
    const cy = getComputedStyle(yomi);
    g.font = `${cy.fontWeight} 100px ${cy.fontFamily}`;
    const text = yomi.textContent;
    const m = g.measureText(text);
    const r100 = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
    const gaps = [...text].length - 1;
    const target = wmRight + 1;      // 今の手詰めも読みの右端は名前の影の右端より 1px 先
    let ls = 0;
    if (r100 > 0) {                  // 空白だけなど、インクが無い文字列は大きさ・字間を触らない
      ls = gaps > 0 ? (target - 40 - (r100 * yfs) / 100) / gaps : 0;
      if (ls < 0) { yfs = Math.max(12, Math.floor(((target - 40) * 100) / r100)); ls = 0; }
      ls = Math.min(ls, 0.3 * yfs);
    }
    const top = wmBottom + 59 - 0.135 * yfs;
    inkBottom = top + 0.827 * yfs;
    set('--yomi-fs', `${yfs}px`);
    set('--yomi-ls', `${(ls / yfs).toFixed(4)}em`);
    set('--yomi-t', `${top + ex * 0.38}px`);
  }
  set('--tag-t', `${inkBottom + B.tagGap + ex * 0.62}px`);
}

// ---------- 学籍番号 ----------
export function studentScreen({ rule, brand, onSubmit, onBack }) {
  const msg = h('p', { class: 'msg msg--error', role: 'alert', 'data-testid': 'student-error' });
  let entry; let keys = null;
  if (rule.charset === 'alnum') {
    // 英数字ルールのときだけシステムキーボードを使う
    const field = h('input', {
      type: 'text', class: 'id-input', maxLength: rule.maxLength, placeholder: '学籍番号を入力',
      inputmode: 'text', autocapitalize: 'characters', autocorrect: 'off', spellcheck: false,
      autocomplete: 'off', 'data-testid': 'student-input',
      onkeydown: (e) => { if (e.key === 'Enter') onSubmit(field.value); },
    });
    entry = h('div', { class: 'id-alnum' }, field,
      h('button', { type: 'button', class: 'btn btn--primary btn--lg', 'data-testid': 'student-submit', onclick: () => onSubmit(field.value) }, '決定'));
  } else {
    const tk = createTenkey({ maxLength: rule.maxLength, placeholder: '学籍番号', onSubmit, testid: 'tenkey' });
    entry = tk.display;
    keys = tk.grid;
  }
  const el = h('section', { class: 'scr scr-student', 'data-testid': 'screen-student' },
    h('div', { class: 'st-left' },
      h('div', { class: 'step' }, h('b', {}, 'ID'), ' STUDENT NUMBER'),
      h('h1', { class: 'h-student' }, jp('学籍番号を'), h('br'), jp('入力してください')),
      entry, msg,
      h('p', { class: 'note' }, jp('学籍番号は/参加済みの確認だけに/使います。')),
      h('button', { type: 'button', class: 'pbtn back', 'data-testid': 'back', onclick: onBack }, h('span', {}, '← 戻る'))),
    h('div', { class: 'st-right' }, keys));
  el.insertAdjacentHTML('afterbegin', metaHtml(esc(brandMid(brand))));
  return { el, msg };
}

// ---------- 来場者アンケート（本校学生以外の方。Q1 → Q2 → 抽選。設問・選択肢・注意書きは config.survey） ----------
const CHECK = '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5.2 5.2L20 6.5" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="square"/></svg>';
/** 文節ごとの span。括弧つきの補足（「（Instagram・Xなど）」）は1つのまとまりにし、入りきらないときだけ中で折り返す。 */
function phrases(text) {
  const parts = splitPhrases(text);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    let j = i;
    if (/^[（(]/.test(parts[i])) while (j < parts.length && !/[）)]$/.test(parts[j])) j++;
    if (j > i && j < parts.length) {
      // 括弧の中の「X」のような1〜2文字の英数は、あとの語（「など）」）と離さない
      const inner = parts.slice(i, j + 1).reduce((a, t) => {
        if (a.length && /^[A-Za-z0-9]{1,2}$/.test(a[a.length - 1])) a[a.length - 1] += t; else a.push(t);
        return a;
      }, []);
      out.push(h('span', { class: 'ph' }, inner.map((t) => h('span', { class: 'ph' }, t))));
      i = j;
    } else {
      out.push(h('span', { class: 'ph' }, parts[i]));
    }
  }
  return out;
}

/** 選択肢のチップ。multi=true はチェックボックス（四角）、false はラジオ（丸）。選択は「反転＋✓」で示す。 */
function chip({ opt, index, multi, selected, testid, onClick }) {
  const b = h('button', {
    type: 'button', class: `chip${selected ? ' on' : ''}`, role: multi ? 'checkbox' : 'radio',
    'aria-checked': String(!!selected), 'data-testid': testid, 'data-id': opt.id, style: { '--i': index }, onclick: onClick,
  },
  h('span', { class: 'n' }, String(index + 1).padStart(2, '0')),
  h('span', { class: `box${multi ? '' : ' rd'}` }),
  h('span', { class: 'lb' }, phrases(opt.label)));
  b.querySelector('.box').innerHTML = CHECK;
  return b;
}

/** 選択肢の文字：どれかのチップから文字がはみ出すときだけ、全チップの字を同じ割合で小さくする（収まるなら CSS の大きさのまま） */
function fitChips(grid) {
  grid.style.removeProperty('--lbk');
  const over = () => [...grid.children].some((c) => {
    const lb = c.querySelector('.lb');
    return lb.scrollWidth > lb.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1;
  });
  let k = 1;
  while (over() && k > 0.56) { k = Math.round((k - 0.06) * 100) / 100; grid.style.setProperty('--lbk', String(k)); }
}

function surveyFrame({ name, stepNo, brand, heading, body, foot }) {
  const el = h('section', { class: `scr scr-survey sv-${name}`, 'data-testid': `screen-survey-${name}` },
    h('div', { class: 'step sv-step', 'data-testid': 'survey-step' },
      h('b', {}, 'SURVEY'), h('span', { class: 'stp' }, `アンケート ${stepNo}/2`),
      h('span', { class: 'bars', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i', { class: stepNo === 2 ? 'on' : '' }))),
    heading, body, foot);
  el.insertAdjacentHTML('afterbegin', metaHtml(esc(surveyMid(brand))));
  return el;
}

const backBtn = (onBack) => h('button', { type: 'button', class: 'pbtn back', 'data-testid': 'back', onclick: onBack }, h('span', {}, '← 戻る'));
/** 注意書き（config.survey.notice）。空なら出さない */
const noticeEl = (notice) => (notice ? h('p', { class: 'sv-note', 'data-testid': 'survey-notice' }, phrases(notice)) : null);

/**
 * Q1（単一選択）。タップで選び、onSelect(id) を呼ぶ（次へ進める判断は呼び出し側）。
 * survey = config.survey（q1.heading / short / options と notice を使う）。
 * 並べ方は選択肢の数から（横置き：5個まで1行・それより多ければ2行、縦置き：2列）。10個はこれまでと同じ 5×2 / 2×5。
 */
export function surveyAgeScreen({ survey, brand, selected, onSelect, onBack }) {
  const q = survey.q1;
  const n = q.options.length;
  const rowsL = n <= 5 ? 1 : 2;
  const colsL = Math.ceil(n / rowsL);
  const vars = { '--cl': colsL, '--rl': rowsL, '--rp': Math.ceil(n / 2) };
  // ラベルの大きさは列の数から（5列で 33px。列が増えるとチップが狭くなるので小さく、減ると大きく）
  if (colsL !== 5) vars['--lbs'] = `${Math.max(26, Math.min(44, Math.round(165 / colsL)))}px`;
  const grid = h('div', { class: 'sv-grid sv-age', role: 'radiogroup', 'aria-label': q.short, style: vars });
  const setOn = (id) => grid.querySelectorAll('.chip').forEach((c) => {
    const on = c.dataset.id === id;
    c.classList.toggle('on', on);
    c.setAttribute('aria-checked', String(on));
  });
  q.options.forEach((opt, i) => grid.append(chip({
    opt, index: i, multi: false, selected: opt.id === selected, testid: `age-${opt.id}`,
    onClick: () => { setOn(opt.id); onSelect(opt.id); },
  })));
  const el = surveyFrame({
    name: 'age', stepNo: 1, brand,
    heading: h('h1', { class: 'sv-h' }, h('em', {}, 'Q1.'), ' ', headingNodes(q.heading)),
    body: grid,
    foot: h('div', { class: 'sv-foot' }, backBtn(onBack), noticeEl(survey.notice)),
  });
  autoFit(el, () => fitChips(grid));
  return { el };
}

/** Q2（複数選択・1つ以上で「次へ」が押せる）。noun = 回すものの呼び名（「次へ（舵輪へ）」）。2列で並べる。 */
export function surveyTriggerScreen({ survey, brand, noun, selected = [], onChange, onNext, onBack }) {
  const q = survey.q2;
  const picked = new Set(selected);
  const next = h('button', { type: 'button', class: 'sv-next', 'data-testid': 'survey-next', disabled: picked.size === 0, onclick: () => { if (picked.size) onNext(); } },
    h('span', { class: 'wipe' }), h('span', { class: 't' }, jp(`次へ/（${noun}へ）`)));
  next.insertAdjacentHTML('beforeend', arrow());
  const grid = h('div', { class: 'sv-grid sv-trig', role: 'group', 'aria-label': `${q.short}（複数選択可）`, style: { '--rows': Math.ceil(q.options.length / 2) } });
  q.options.forEach((opt, i) => {
    const c = chip({
      opt, index: i, multi: true, selected: picked.has(opt.id), testid: `trigger-${opt.id}`,
      onClick: () => {
        if (picked.has(opt.id)) picked.delete(opt.id); else picked.add(opt.id);
        const on = picked.has(opt.id);
        c.classList.toggle('on', on);
        c.setAttribute('aria-checked', String(on));
        next.disabled = picked.size === 0;
        onChange([...picked]);
      },
    });
    grid.append(c);
  });
  const el = surveyFrame({
    name: 'trigger', stepNo: 2, brand,
    heading: h('h1', { class: 'sv-h' }, h('em', {}, 'Q2.'), ' ', headingNodes(q.heading), h('span', { class: 'ph sub' }, '（複数選択可）')),
    body: grid,
    foot: h('div', { class: 'sv-foot' }, backBtn(onBack), noticeEl(survey.notice), next),
  });
  autoFit(el, () => fitChips(grid));
  return { el };
}

// ---------- 情報画面（終了・保存失敗・読み込み失敗） ----------
export function infoScreen({ name, tone = '', title, small = false, lead, tagged = false, actions = [], brand }) {
  const el = h('section', { class: `scr scr-info ${tone}`, 'data-testid': `screen-${name}` },
    h('div', { class: 'info-main' },
      h('h1', { class: small ? 's' : '' }, jp(title)),
      lead ? h('p', { class: `lead${tagged ? ' tagged' : ''}` }, jp(lead)) : null,
      actions.length ? h('div', { class: 'acts' }, actions.map((a) =>
        h('button', { type: 'button', class: `pbtn${a.solid ? ' solid' : ''}`, 'data-testid': a.testid, onclick: a.onClick }, h('span', {}, a.label)))) : null));
  el.insertAdjacentHTML('afterbegin', `${metaHtml(esc(brandMid(brand)))}<div class="bigw">${wheelMark()}</div>`);
  return el;
}
