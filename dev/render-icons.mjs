// アイコンの書き出し。icons/icon.svg から PNG（192 / 512 / apple-touch-icon 180）を作る。
// （グローバルの playwright を絶対パスで読み込む。ブラウザの再インストールは不要）
//
// 使い方
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node dev/render-icons.mjs
//     icons/icon.svg をそのまま PNG にする。icon.svg は書き換えない（引数なしの動作は従来のまま）。
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node dev/render-icons.mjs --motif capsule --theme wakaba
//     ほかのイベント専用の配置を作るとき。回すもの（js/motifs.js の id）と配色（js/theme.js のプリセット id）から
//     icons/icon.svg を作り直し（上書き）、続けて PNG も書き出す。片方だけでもよい（省いた側は helm / yosoro）。
//     構図は既定の icon.svg と同じ：紙色の地の中央に主色の回すもの、その後ろに差し色の版ズレ影（右下へ 16, 14）、
//     目印（舵輪なら王様スポーク）はインク色。--motif helm --theme yosoro は既定の icon.svg と同じ絵になる
//     （PNG にして比べると、王様スポークの影のふちのアンチエイリアスが数十〜百画素ほど違うだけ）。
//     選べる id は --help で表示する。
//
// icons/ を替えたら sw.js の VERSION を上げる（icons は precache の対象）。
// manifest.webmanifest の name・色と index.html の theme-color は、その配置に合わせて手で書き換える（このスクリプトは触れない）。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => { console.error(msg); process.exit(1); };

// ---------- 引数 ----------
let opts;
try {
  opts = parseArgs({ options: { motif: { type: 'string' }, theme: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }).values;
} catch (e) {
  die(`${e.message}\n使い方は --help で確認できる。`);
}
const themed = opts.motif !== undefined || opts.theme !== undefined;

// ---------- 配置専用のアイコン（--motif / --theme） ----------
/**
 * js/motifs.js と js/theme.js から、既定の icons/icon.svg と同じ構図の SVG を作る。
 * 回すものの svg は塗りを var(--wc) / var(--hl) で持つので、アイコン用には色そのものに置き換える
 * （アイコンは <link rel="icon"> やホーム画面で CSS 変数なしに描かれることがある）。
 * 影は本体と目印の両方を差し色で塗ったシルエット、本体は主色・目印はインク色（既定の icon.svg と同じ重ね順）。
 */
function themedIconSvg(motifId, motif, themeId, theme) {
  const paint = (svg, wc, hl) => svg.replace(/var\(--wc,[^)]*\)/g, wc).replace(/var\(--hl,[^)]*\)/g, hl).replace(/>\s+</g, '><');
  const shadow = paint(motif.svg, theme.accent, theme.accent);
  const body = paint(motif.svg, theme.main, theme.ink);
  if (/var\(/.test(shadow + body)) die(`motif ${motifId}: --wc / --hl 以外の var() が残っている`);
  // コメントに「--」は書けない（XML の規則）ので、引数の名前は書かない
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <!-- ${motif.label}・${theme.label}：紙色の地に、主色の回すものと差し色の版ズレ影。dev/render-icons.mjs が js/motifs.js と js/theme.js から生成（motif=${motifId}, theme=${themeId}） -->
  <rect width="512" height="512" fill="${theme.paper}"/>
  <g transform="translate(254 260) scale(.74)">
    <g transform="translate(16 14)">${shadow}</g>
    ${body}
  </g>
</svg>
`;
}

let motifs = null;
let themes = null;
if (opts.help || themed) {
  motifs = await import('../js/motifs.js');
  themes = await import('../js/theme.js');
}
if (opts.help) {
  console.log(`使い方: node dev/render-icons.mjs [--motif <id>] [--theme <id>]
  引数なし  icons/icon.svg から PNG（192 / 512 / apple-touch-icon 180）を書き出す
  --motif   回すもの（既定 ${motifs.DEFAULT_MOTIF_ID}）: ${Object.keys(motifs.MOTIFS).join(' / ')}
  --theme   配色（既定 ${themes.DEFAULT_THEME_ID}）: ${Object.keys(themes.THEMES).join(' / ')}
  どちらかを付けると icons/icon.svg を作り直して（上書き）から PNG を書き出す`);
  process.exit(0);
}

// ---------- 書き出し ----------
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

let paper = '#EEEADB';
if (themed) {
  const motifId = opts.motif ?? motifs.DEFAULT_MOTIF_ID;
  const themeId = opts.theme ?? themes.DEFAULT_THEME_ID;
  if (!Object.hasOwn(motifs.MOTIFS, motifId)) die(`--motif ${motifId} はありません（選べる id: ${Object.keys(motifs.MOTIFS).join(', ')}）`);
  if (!Object.hasOwn(themes.THEMES, themeId)) die(`--theme ${themeId} はありません（選べる id: ${Object.keys(themes.THEMES).join(', ')}）`);
  writeFileSync(path.join(root, 'icons/icon.svg'), themedIconSvg(motifId, motifs.MOTIFS[motifId], themeId, themes.THEMES[themeId]));
  paper = themes.THEMES[themeId].paper;
  console.log('wrote icons/icon.svg', `(motif=${motifId}, theme=${themeId})`);
}

const svg = readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

const targets = [
  ['icons/icon-192.png', 192],
  ['icons/icon-512.png', 512],
  ['icons/apple-touch-icon.png', 180], // 不透明（背景は SVG 内で全面塗り）
];

const browser = await chromium.launch();
try {
  for (const [file, size] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${paper}"><img src="${dataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`
    );
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(root, file), omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote', file, `${size}x${size}`);
  }
} finally {
  await browser.close();
}
