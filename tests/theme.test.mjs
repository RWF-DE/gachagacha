// node --test tests/   配色テーマ（js/theme.js）：プリセットのコントラスト・resolveTheme の代替・contrast・applyTheme の変数
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, DEFAULT_THEME_ID, CONTRAST_RULES, hexToRgb, contrast, contrastReport, resolveTheme, applyTheme,
} from '../js/theme.js';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const ROLES = ['paper', 'main', 'ink', 'accent'];
const pick = (t) => Object.fromEntries(ROLES.map((k) => [k, t[k]]));
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≒ ${b}`);

test('プリセット：7つ・既定は yosoro・4色は #RRGGBB・名前がある', () => {
  assert.deepEqual(Object.keys(THEMES), ['yosoro', 'wakaba', 'sakura', 'umi', 'yomatsuri', 'sumi', 'tetsukon']);
  assert.equal(DEFAULT_THEME_ID, 'yosoro');
  for (const [id, t] of Object.entries(THEMES)) {
    assert.match(id, /^[a-z0-9-]{1,32}$/);
    assert.ok(t.label, `${id} に label`);
    for (const k of ROLES) assert.match(t[k], HEX, `${id}.${k}`);
  }
});

test('yosoro は css/tokens.css の初期値（今の4色）と同じ', () => {
  assert.deepEqual(pick(THEMES.yosoro), { paper: '#EEEADB', main: '#1A33E0', ink: '#0A0E33', accent: '#F23B20' });
});

test('すべてのプリセットが CONTRAST_RULES を満たす', () => {
  assert.deepEqual(CONTRAST_RULES.map((r) => r.key), ['paper/main', 'paper/accent', 'ink/accent', 'ink/paper']);
  for (const [id, t] of Object.entries(THEMES)) {
    const rep = contrastReport(t);
    assert.equal(rep.length, CONTRAST_RULES.length);
    for (const r of rep) assert.ok(r.ok, `${id} ${r.key} ${r.ratio} < ${r.min}`);
  }
});

test('contrast: 既知の組み合わせ（WCAG）', () => {
  near(contrast('#000000', '#FFFFFF'), 21, 1e-9);
  near(contrast('#FFFFFF', '#000000'), 21, 1e-9);        // 順序に依らない
  near(contrast('#336699', '#336699'), 1, 1e-9);
  assert.ok(contrast('#767676', '#FFFFFF') >= 4.5, '#767676 は白の上で AA（4.54）');
  assert.ok(contrast('#777777', '#FFFFFF') < 4.5, '#777777 は白の上で AA に届かない（4.48）');
  near(contrast('#767676', '#FFFFFF'), 4.54);
  near(contrast('#EEEADB', '#1A33E0'), 6.71);             // よーそろ：紙／群青
  near(contrast('#0A0E33', '#F23B20'), 4.82);             // よーそろ：インク／朱
  assert.ok(Number.isNaN(contrast('#fff', '#000000')), '3桁・不正な値は NaN');
  assert.ok(Number.isNaN(contrast(null, '#000000')));
});

test('contrastReport: 不合格を ok:false で返す（カスタム色の警告用）・不正な値も落ちない', () => {
  const bad = { paper: '#FFFFFF', main: '#EEEEEE', ink: '#DDDDDD', accent: '#FFFFFF' };
  const rep = contrastReport(bad);
  assert.deepEqual(rep.map((r) => r.ok), [false, false, false, false]);
  for (const r of rep) { assert.ok(r.ratio >= 1 && r.ratio < r.min); assert.ok(r.label); }
  const broken = contrastReport({ paper: 'red' });
  assert.equal(broken.length, 4);
  assert.ok(broken.every((r) => r.ok === false && r.ratio === 0));
  assert.equal(contrastReport(undefined).length, 4);
  // 表示用の ratio は切り捨て：4.4999… を「4.5」と見せて不合格にしない
  const r0 = contrastReport(THEMES.yosoro)[0];
  assert.ok(r0.ratio <= contrast('#EEEADB', '#1A33E0'));
});

test('hexToRgb', () => {
  assert.deepEqual(hexToRgb('#1A33E0'), [26, 51, 224]);
  assert.deepEqual(hexToRgb('#ffffff'), [255, 255, 255]);
  for (const bad of ['1A33E0', '#1A33E', '#1A33E0F', '#GGGGGG', '', null, undefined, 12, {}]) assert.equal(hexToRgb(bad), null, String(bad));
});

test('resolveTheme: custom（4色がすべて有効）> preset > yosoro', () => {
  const custom = { paper: '#ffffff', main: '#112233', ink: '#000000', accent: '#ff0000' };
  assert.deepEqual(resolveTheme({ preset: 'sakura', custom }), custom, 'custom が preset より優先');
  assert.deepEqual(resolveTheme({ preset: 'sakura', custom: null }), pick(THEMES.sakura));
  assert.deepEqual(resolveTheme({ preset: 'umi' }), pick(THEMES.umi));
  const r = resolveTheme({ preset: 'wakaba', custom });
  assert.notEqual(r, custom, '渡された object をそのまま返さない');
  assert.deepEqual(Object.keys(r), ROLES);
});

test('resolveTheme: 不正・欠け・知らない id は yosoro（または preset）にする', () => {
  const yosoro = pick(THEMES.yosoro);
  for (const t of [undefined, null, {}, 'sakura', 42, [], { preset: null }, { preset: 'no-such-theme' }, { preset: 'constructor' }, { preset: '__proto__' }, { preset: 'toString' }, { preset: 7 }]) {
    assert.deepEqual(resolveTheme(t), yosoro, JSON.stringify(t));
  }
  // custom が1色でも不正なら使わない（preset へ）
  const bad = [
    { paper: '#ffffff', main: '#112233', ink: '#000000' },                       // 欠け
    { paper: '#fff', main: '#112233', ink: '#000000', accent: '#ff0000' },       // 3桁
    { paper: '#ffffff', main: 'blue', ink: '#000000', accent: '#ff0000' },
    { paper: '#ffffff', main: '#112233', ink: '#000000', accent: '#ff0000ff' },  // 8桁
    { paper: '#ffffff', main: '#112233', ink: '#000000', accent: 7 },
    'red', [], 0,
  ];
  for (const custom of bad) {
    assert.deepEqual(resolveTheme({ preset: 'umi', custom }), pick(THEMES.umi), JSON.stringify(custom));
    assert.deepEqual(resolveTheme({ custom }), yosoro, JSON.stringify(custom));
  }
});

// applyTheme の書き込み先を差し替えて検証する（node には document が無い）
function fakeRoot() {
  const vars = {};
  const meta = { content: '#EEEADB', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  return {
    vars, meta,
    style: { setProperty: (k, v) => { vars[k] = v; } },
    ownerDocument: { querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null) },
  };
}

test('applyTheme: よーそろの値は css/tokens.css の初期値と同じ文字列になる', () => {
  const root = fakeRoot();
  const out = applyTheme(resolveTheme({ preset: 'yosoro' }), root);
  assert.deepEqual(out, pick(THEMES.yosoro));
  assert.deepEqual(root.vars, {
    '--paper': '#EEEADB', '--main': '#1A33E0', '--ink': '#0A0E33', '--accent': '#F23B20',
    '--main-rgb': '26, 51, 224',
    '--ink-soft': 'rgba(10, 14, 51, 0.62)',
    '--backdrop': 'rgba(10, 14, 51, 0.72)',
  });
  assert.equal(root.meta.content, '#EEEADB');
});

test('applyTheme: 別の配色では派生色が追従し、theme-color が紙色になる', () => {
  const root = fakeRoot();
  applyTheme(resolveTheme({ preset: 'sakura' }), root);
  assert.equal(root.vars['--main'], THEMES.sakura.main);
  assert.equal(root.vars['--main-rgb'], hexToRgb(THEMES.sakura.main).join(', '));
  const [r, g, b] = hexToRgb(THEMES.sakura.ink);
  assert.equal(root.vars['--ink-soft'], `rgba(${r}, ${g}, ${b}, 0.62)`);
  assert.equal(root.vars['--backdrop'], `rgba(${r}, ${g}, ${b}, 0.72)`);
  assert.equal(root.meta.content, THEMES.sakura.paper);
});

test('applyTheme: 不正な色を渡されたら yosoro にする・meta が無くても落ちない', () => {
  const root = fakeRoot();
  root.ownerDocument = {};
  assert.doesNotThrow(() => applyTheme({ paper: 'x' }, root));
  assert.equal(root.vars['--main'], THEMES.yosoro.main);
  assert.doesNotThrow(() => applyTheme(undefined, { style: { setProperty() {} } }));
});

test('import しただけでは DOM に触れない（node に document は無い）', () => {
  assert.equal(typeof document, 'undefined');
});
