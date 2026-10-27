// 配色テーマ（docs/CUSTOMIZE.md §5）。色の役割は4つ：
//   paper  = 地（紙）            main   = 主色（ワードマーク・群青の面・主ボタン。紙色の文字を載せる）
//   ink    = 文字・罫線          accent = 差し色（版ズレの影・帯・「まわす」ボタン・スタンプ・協賛特別賞の面）
// 条件（すべてのプリセットが満たす。カスタム色は満たさないとき警告を出す）：
//   paper/main ≥ 4.5（主色の面に紙色の文字）  paper/accent ≥ 3.0（差し色の面に紙色の大きな文字）
//   ink/accent ≥ 4.5（協賛特別賞：差し色の面にインクの文字）  ink/paper ≥ 12（本文）
// 名前は fonts/ のサブセットに入る字だけ（「橙」「菫」などは入らないので使わない）。

/** プリセット（表示順）。yosoro が既定（css/tokens.css の初期値と同じ） */
export const THEMES = {
  yosoro: { label: 'よーそろ（群青×朱）', paper: '#EEEADB', main: '#1A33E0', ink: '#0A0E33', accent: '#F23B20' },
  wakaba: { label: '若葉（深緑×柿）', paper: '#F0EEDD', main: '#0B6E4F', ink: '#06150F', accent: '#E5561E' },
  sakura: { label: '桜（牡丹×青緑）', paper: '#F7EDEA', main: '#B3165C', ink: '#2A0B1C', accent: '#1F8F96' },
  umi: { label: '海（紺青×サンゴ）', paper: '#ECF0EC', main: '#00627A', ink: '#06232B', accent: '#F0503C' },
  yomatsuri: { label: '夜祭（紫×オレンジ）', paper: '#F1ECE0', main: '#5326B8', ink: '#160B2E', accent: '#E8561A' },
  sumi: { label: '墨（墨×紅）', paper: '#EFEDE6', main: '#222222', ink: '#000000', accent: '#E8293E' },
  tetsukon: { label: '鉄紺（鉄紺×黄丹）', paper: '#EDEBE3', main: '#1F3A68', ink: '#0B1424', accent: '#E15A17' },
};

export const DEFAULT_THEME_ID = 'yosoro';

/** コントラストの条件（カスタム色の警告用）。key は 'a/b' */
export const CONTRAST_RULES = [
  { key: 'paper/main', a: 'paper', b: 'main', min: 4.5, label: '主色の面の文字（紙色）' },
  { key: 'paper/accent', a: 'paper', b: 'accent', min: 3.0, label: '差し色の面の文字（紙色）' },
  { key: 'ink/accent', a: 'ink', b: 'accent', min: 4.5, label: '協賛特別賞の面の文字（インク）' },
  { key: 'ink/paper', a: 'ink', b: 'paper', min: 12, label: '本文（紙の上のインク）' },
];

// ---------- 関数 ----------
// applyTheme 以外は DOM に触れない（node:test から読める）。import しただけでは何もしない。

const ROLES = ['paper', 'main', 'ink', 'accent'];
const HEX6 = /^#[0-9A-Fa-f]{6}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);   // 'constructor' などの継承プロパティを id と見なさない
const pickRoles = (o) => ({ paper: o.paper, main: o.main, ink: o.ink, accent: o.accent });
const validColors = (c) => !!c && typeof c === 'object' && ROLES.every((k) => typeof c[k] === 'string' && HEX6.test(c[k]));

/** '#RRGGBB' → [r, g, b]（0〜255 の整数）。形が違えば null */
export function hexToRgb(hex) {
  if (typeof hex !== 'string' || !HEX6.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG のコントラスト比（1〜21）。a・b は '#RRGGBB'。どちらかが不正なら NaN */
export function contrast(a, b) {
  const ra = hexToRgb(a); const rb = hexToRgb(b);
  if (!ra || !rb) return NaN;
  const la = luminance(ra); const lb = luminance(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 4色が CONTRAST_RULES を満たすか。戻り値は規則ごとの { key, label, ratio, min, ok }（順番は CONTRAST_RULES と同じ）。
 * ratio は小数2桁に切り捨て（「4.50」と表示されたのに不合格、を避ける）。ok は切り捨て前の値で判定。
 */
export function contrastReport(colors) {
  return CONTRAST_RULES.map(({ key, a, b, min, label }) => {
    const r = contrast(colors?.[a], colors?.[b]);
    const good = Number.isFinite(r);
    return { key, label, ratio: good ? Math.floor(r * 100) / 100 : 0, min, ok: good && r >= min };
  });
}

/**
 * config の theme（{preset, custom}）から実際に使う4色 {paper, main, ink, accent} を決める。
 * custom の4色がすべて '#RRGGBB' ならそれ。そうでなければ preset。知らない preset は yosoro。
 */
export function resolveTheme(themeCfg) {
  const c = themeCfg?.custom;
  if (validColors(c)) return pickRoles(c);
  const id = themeCfg?.preset;
  return pickRoles(THEMES[typeof id === 'string' && own(THEMES, id) ? id : DEFAULT_THEME_ID]);
}

/**
 * 配色を CSS 変数に反映する（--paper --main --ink --accent と、派生の --main-rgb --ink-soft --backdrop）。
 * 派生色の式は css/tokens.css の初期値と同じ（よーそろの値なら初期値と一致する）。<meta name="theme-color"> も紙色にする。
 * 演出中に呼ばない（app.js の applyLook は refresh() からだけ呼ぶ）。root を渡せば <html> 以外にも書ける（テスト用）。
 */
export function applyTheme(colors, root = document.documentElement) {
  const t = validColors(colors) ? pickRoles(colors) : pickRoles(THEMES[DEFAULT_THEME_ID]);
  const s = root.style;
  for (const k of ROLES) s.setProperty(`--${k}`, t[k]);
  s.setProperty('--main-rgb', hexToRgb(t.main).join(', '));
  const [ir, ig, ib] = hexToRgb(t.ink);
  s.setProperty('--ink-soft', `rgba(${ir}, ${ig}, ${ib}, 0.62)`);
  s.setProperty('--backdrop', `rgba(${ir}, ${ig}, ${ib}, 0.72)`);
  root.ownerDocument?.querySelector?.('meta[name="theme-color"]')?.setAttribute('content', t.paper);
  return t;
}
