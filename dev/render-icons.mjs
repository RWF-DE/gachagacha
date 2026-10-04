// icons/icon.svg から PNG（192 / 512 / apple-touch-icon 180）を書き出す。
// 使い方: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node dev/render-icons.mjs
// （グローバルの playwright を絶対パスで読み込む。ブラウザの再インストールは不要）
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
      `<!doctype html><html><body style="margin:0;background:#155e7d"><img src="${dataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`
    );
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(root, file), omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote', file, `${size}x${size}`);
  }
} finally {
  await browser.close();
}
