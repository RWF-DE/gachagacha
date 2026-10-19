// プレイヤー画面のうち、状態を持たない静的な画面（区分選択・学籍番号・情報画面）の組み立て。
// 舵輪の画面と結果は js/stage.js。画面遷移・DB は js/app.js。
import { h } from './util.js';
import { metaHtml, wheelMark, splitPhrases } from './poster.js';
import { SURVEY_NOTICE } from './config.js';
import { createTenkey } from './ui.js';

// 日本語の見出し・ボタンは「文節」でだけ折り返す。'/' が文節の区切り（表示はされない）。
export const jp = (...parts) => parts.flatMap((p) => (Array.isArray(p) ? p : String(p).split('/')))
  .filter((t) => t !== '').map((t) => h('span', { class: 'ph' }, t));

const arrow = () => '<svg class="ar" aria-hidden="true"><use href="#arrow"/></svg>';

// ---------- 区分選択 ----------
export function chooseScreen({ intro, onStudent, onGuest }) {
  const el = h('section', { class: `scr scr-choose ${intro ? 'intro' : 'quick'}`, 'data-testid': 'screen-choose' });
  const letters = [...'YoSoro'].map((c) => `<span class="c"><span class="ci">${c}</span></span>`).join('');
  el.innerHTML = `${metaHtml('お宝ガチャ — TREASURE DRAW')}
    <div class="bigw">${wheelMark()}</div>
    <h1 class="yo" aria-label="YoSoro!">${letters}<span class="c"><span class="ci bang">!</span></span></h1>
    <h2 class="takara">お宝ガチャ</h2>
    <p class="tag">おひとり1回・参加無料</p>
    <div class="rows"></div>`;
  const row = (cls, n, title, sub, testid, onclick) => h('button', {
    type: 'button', class: `row ${cls}`, 'data-testid': testid, onclick,
  }, h('span', { class: 'wipe' }), h('span', { class: 'n' }, n),
  h('span', {}, h('span', { class: 't' }, title), h('span', { class: 's' }, sub)),
  (() => { const t = document.createElement('template'); t.innerHTML = arrow(); return t.content.firstChild; })());
  // 各行は .rw で包む（登場のワイプ用：枠と中身を逆向きに transform で動かす。css/poster.css の rwOut / rwIn）
  const wrap = (cls, btn) => h('div', { class: `rw ${cls}` }, btn);
  el.querySelector('.rows').append(
    wrap('a', row('a', '01', '本校の学生', '学籍番号を入力します', 'choose-student', onStudent)),
    wrap('b', row('b', '02', '本校学生以外の方', '入力不要・参加後に印をつけます', 'choose-guest', onGuest)));
  // 登場の間だけ枠で切る（終わったら外す）
  el.classList.add('anim');
  setTimeout(() => el.classList.remove('anim'), intro ? 2200 : 800);
  return el;
}

// ---------- 学籍番号 ----------
export function studentScreen({ rule, onSubmit, onBack }) {
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
  el.insertAdjacentHTML('afterbegin', metaHtml('お宝ガチャ — TREASURE DRAW'));
  return { el, msg };
}

// ---------- 来場者アンケート（本校学生以外の方。Q1 年齢 → Q2 きっかけ → 舵輪） ----------
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

function surveyFrame({ name, stepNo, heading, body, foot }) {
  const el = h('section', { class: `scr scr-survey sv-${name}`, 'data-testid': `screen-survey-${name}` },
    h('div', { class: 'step sv-step', 'data-testid': 'survey-step' },
      h('b', {}, 'SURVEY'), h('span', { class: 'stp' }, `アンケート ${stepNo}/2`),
      h('span', { class: 'bars', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i', { class: stepNo === 2 ? 'on' : '' }))),
    heading, body, foot);
  el.insertAdjacentHTML('afterbegin', metaHtml('お宝ガチャ — SURVEY'));
  return el;
}

const backBtn = (onBack) => h('button', { type: 'button', class: 'pbtn back', 'data-testid': 'back', onclick: onBack }, h('span', {}, '← 戻る'));
const noticeEl = () => h('p', { class: 'sv-note', 'data-testid': 'survey-notice' }, phrases(SURVEY_NOTICE));

/** Q1 年齢（単一選択）。タップで選び、onSelect(id) を呼ぶ（次へ進める判断は呼び出し側）。 */
export function surveyAgeScreen({ options, selected, onSelect, onBack }) {
  const grid = h('div', { class: 'sv-grid sv-age', role: 'radiogroup', 'aria-label': '年齢' });
  const setOn = (id) => grid.querySelectorAll('.chip').forEach((c) => {
    const on = c.dataset.id === id;
    c.classList.toggle('on', on);
    c.setAttribute('aria-checked', String(on));
  });
  options.forEach((opt, i) => grid.append(chip({
    opt, index: i, multi: false, selected: opt.id === selected, testid: `age-${opt.id}`,
    onClick: () => { setOn(opt.id); onSelect(opt.id); },
  })));
  const el = surveyFrame({
    name: 'age', stepNo: 1,
    heading: h('h1', { class: 'sv-h' }, h('em', {}, 'Q1.'), ' ', jp('年齢を/教えてください')),
    body: grid,
    foot: h('div', { class: 'sv-foot' }, backBtn(onBack), noticeEl()),
  });
  return { el };
}

/** Q2 きっかけ（複数選択・1つ以上で「次へ」が押せる）。 */
export function surveyTriggerScreen({ options, selected = [], onChange, onNext, onBack }) {
  const picked = new Set(selected);
  const next = h('button', { type: 'button', class: 'sv-next', 'data-testid': 'survey-next', disabled: picked.size === 0, onclick: () => { if (picked.size) onNext(); } },
    h('span', { class: 'wipe' }), h('span', { class: 't' }, jp('次へ/（舵輪へ）')));
  next.insertAdjacentHTML('beforeend', arrow());
  const grid = h('div', { class: 'sv-grid sv-trig', role: 'group', 'aria-label': 'きっかけ（複数選択可）' });
  options.forEach((opt, i) => {
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
    name: 'trigger', stepNo: 2,
    heading: h('h1', { class: 'sv-h' }, h('em', {}, 'Q2.'), ' ', jp('電波祭に/来場した/きっかけを/教えてください。'), h('span', { class: 'ph sub' }, '（複数選択可）')),
    body: grid,
    foot: h('div', { class: 'sv-foot' }, backBtn(onBack), noticeEl(), next),
  });
  return { el };
}

// ---------- 情報画面（終了・保存失敗・読み込み失敗） ----------
export function infoScreen({ name, tone = '', title, small = false, lead, tagged = false, actions = [] }) {
  const el = h('section', { class: `scr scr-info ${tone}`, 'data-testid': `screen-${name}` },
    h('div', { class: 'info-main' },
      h('h1', { class: small ? 's' : '' }, jp(title)),
      lead ? h('p', { class: `lead${tagged ? ' tagged' : ''}` }, jp(lead)) : null,
      actions.length ? h('div', { class: 'acts' }, actions.map((a) =>
        h('button', { type: 'button', class: `pbtn${a.solid ? ' solid' : ''}`, 'data-testid': a.testid, onclick: a.onClick }, h('span', {}, a.label)))) : null));
  el.insertAdjacentHTML('afterbegin', `${metaHtml('お宝ガチャ — TREASURE DRAW')}<div class="bigw">${wheelMark()}</div>`);
  return el;
}
