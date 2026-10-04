// プレイヤー画面のうち、状態を持たない静的な画面（区分選択・学籍番号・情報画面）の組み立て。
// 舵輪の画面と結果は js/stage.js。画面遷移・DB は js/app.js。
import { h } from './util.js';
import { metaHtml, wheelMark } from './poster.js';
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
  el.querySelector('.rows').append(
    row('a', '01', '本校の学生', '学籍番号を入力します', 'choose-student', onStudent),
    row('b', '02', '本校学生以外の方', '入力は不要です', 'choose-guest', onGuest));
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
