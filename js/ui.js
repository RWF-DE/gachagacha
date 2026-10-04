// 共通UI部品：テンキー・ダイアログ・トースト
import { h } from './util.js';

/**
 * テンキー（0-9 / 削除 / 決定）。数字のみ。
 * opts: {maxLength, mask, placeholder, submitLabel, onChange(value), onSubmit(value), testid}
 */
export function createTenkey({ maxLength = 10, mask = false, placeholder = '', submitLabel = '決定', onChange, onSubmit, testid = 'tenkey' }) {
  let value = '';
  const display = h('div', { class: 'tk-display', 'data-testid': `${testid}-display`, 'aria-live': 'polite' });
  const render = () => {
    display.classList.toggle('is-empty', value === '');
    display.textContent = value === '' ? placeholder : (mask ? '●'.repeat(value.length) : value);
    onChange?.(value);
  };
  const press = (d) => { if (value.length < maxLength) { value += d; render(); } };
  const key = (label, cls, handler, tid, aria) =>
    h('button', { type: 'button', class: `tk-key ${cls}`, 'data-testid': tid, 'aria-label': aria || label, onclick: handler }, label);
  const grid = h('div', { class: 'tk-grid' },
    ...'123456789'.split('').map((d) => key(d, '', () => press(d), `${testid}-${d}`)),
    key('削除', 'tk-del', () => { value = value.slice(0, -1); render(); }, `${testid}-del`, '1文字削除'),
    key('0', '', () => press('0'), `${testid}-0`),
    key(submitLabel, 'tk-ok', () => onSubmit?.(value), `${testid}-ok`),
  );
  const el = h('div', { class: 'tenkey' }, display, grid);
  render();
  return {
    el,
    getValue: () => value,
    setValue: (v) => { value = String(v); render(); },
    clear: () => { value = ''; render(); },
  };
}

// ---------- ダイアログ ----------
/**
 * opts: {title, body:Node|string, actions:[{label, kind:'primary'|'danger'|'ghost', value, check?:()=>true|string}], dismissible}
 * check が文字列を返すとダイアログ内にエラー表示して閉じない。
 * 戻り値 Promise<value|null>
 */
export function openDialog({ title, body, actions, dismissible = false }) {
  return new Promise((resolve) => {
    const err = h('p', { class: 'dlg-error', role: 'alert' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape' && dismissible) close(null); };
    const btns = actions.map((a) =>
      h('button', {
        type: 'button', class: `btn btn--${a.kind || 'ghost'} btn--sm`, 'data-testid': a.testid || `dlg-${a.value}`,
        onclick: () => {
          if (a.check) {
            const r = a.check();
            if (r !== true) { err.textContent = typeof r === 'string' ? r : '入力を確認してください'; return; }
          }
          close(a.value);
        },
      }, a.label));
    const box = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' },
      title ? h('h2', { class: 'dlg-title' }, title) : null,
      h('div', { class: 'dlg-body' }, body),
      err,
      h('div', { class: 'dlg-actions' }, btns));
    const back = h('div', { class: 'dlg-backdrop', 'data-testid': 'dialog' }, box);
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    const first = box.querySelector('input,select,textarea');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export async function confirmDialog({ title, message, okLabel = 'OK', cancelLabel = 'キャンセル', danger = false }) {
  const r = await openDialog({
    title,
    body: typeof message === 'string' ? h('p', { class: 'dlg-msg' }, message) : message,
    actions: [
      { label: cancelLabel, kind: 'ghost', value: false, testid: 'dlg-cancel' },
      { label: okLabel, kind: danger ? 'danger' : 'primary', value: true, testid: 'dlg-ok' },
    ],
  });
  return r === true;
}

export function alertDialog(message, title) {
  return openDialog({
    title,
    body: h('p', { class: 'dlg-msg' }, message),
    actions: [{ label: '閉じる', kind: 'primary', value: true, testid: 'dlg-ok' }],
  });
}

// ---------- トースト ----------
let toastTimer = 0;
export function toast(message, kind = 'info') {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const t = h('div', { class: `toast toast--${kind}`, role: 'status', 'data-testid': 'toast' }, message);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 3200);
}
