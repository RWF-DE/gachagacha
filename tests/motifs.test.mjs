// node --test tests/   回すもの（js/motifs.js）：データの約束・getMotif の代替・見本 SVG
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOTIFS, DEFAULT_MOTIF_ID, resolveMotifId, getMotif, motifPreviewSvg } from '../js/motifs.js';

const IDS = Object.keys(MOTIFS);
const WC = 'var(--wc,#0A0E33)';
const HL = 'var(--hl,#F23B20)';

test('モチーフ：7つ・舵輪が先頭で既定', () => {
  assert.deepEqual(IDS, ['helm', 'capsule', 'garapon', 'gear', 'roulette', 'pinwheel', 'sakura']);
  assert.equal(DEFAULT_MOTIF_ID, 'helm');
  for (const id of IDS) assert.match(id, /^[a-z0-9-]{1,32}$/);
});

test('各モチーフに label / noun / stepLatin / angle / svg がある', () => {
  for (const id of IDS) {
    const m = MOTIFS[id];
    assert.ok(typeof m.label === 'string' && m.label.length > 0, `${id}.label`);
    assert.ok(typeof m.noun === 'string' && [...m.noun].length >= 1 && [...m.noun].length <= 8, `${id}.noun（画面の文言に入る呼び名）`);
    assert.match(m.stepLatin, /^[A-Z ]{3,24}$/, `${id}.stepLatin（抽選画面の小見出し。大文字の ASCII）`);
    assert.ok(Number.isFinite(m.angle) && Math.abs(m.angle) <= 360, `${id}.angle`);
    assert.ok(typeof m.svg === 'string' && m.svg.length > 100, `${id}.svg`);
  }
  assert.equal(MOTIFS.helm.noun, '舵輪');
  assert.equal(MOTIFS.helm.angle, 38, '舵輪の最初の向きは今と同じ 38°');
  assert.equal(MOTIFS.helm.stepLatin, 'TURN THE WHEEL');
});

test('svg は id 属性を持たない（見本を同じ画面に何個並べても id がぶつからない）', () => {
  for (const id of IDS) {
    assert.ok(!/\sid\s*=/i.test(MOTIFS[id].svg), `${id} に id 属性`);
    assert.ok(!/href\s*=/i.test(MOTIFS[id].svg), `${id} が <use> などで他を参照している`);
  }
});

test('svg の塗りは var(--wc,…) と var(--hl,…) の2色だけ（線・グラデーション・フィルタ・style なし）', () => {
  for (const id of IDS) {
    const svg = MOTIFS[id].svg;
    const fills = [...svg.matchAll(/\sfill="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(fills.length > 0, `${id} に fill`);
    for (const f of fills) assert.ok(f === WC || f === HL, `${id} の fill が想定外: ${f}`);
    assert.ok(fills.includes(WC), `${id} に本体色`);
    assert.ok(fills.includes(HL), `${id} に目印の色（回っていることが分かる1か所）`);
    // var() の既定値（#0A0E33 / #F23B20）を除いたあとに、色の直書き・線・フィルタなどが残らないこと
    const rest = svg.replace(/var\(--(?:wc|hl),#[0-9A-Fa-f]{6}\)/g, '');
    for (const bad of [/#[0-9A-Fa-f]{3,8}/, /\sstroke/i, /gradient/i, /filter/i, /\sstyle\s*=/i, /<mask|<clipPath|<defs|<symbol|<image|<text/i, /opacity/i]) {
      assert.equal(rest.match(bad), null, `${id}: ${bad} に該当`);
    }
    assert.ok(svg.includes('var(--wc,#0A0E33)') && svg.includes('var(--hl,#F23B20)'), `${id}: 既定値は よーそろの インク／朱`);
  }
});

test('svg はタグが閉じている（入れ子が正しい）', () => {
  for (const id of IDS) {
    const stack = [];
    for (const m of MOTIFS[id].svg.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
      const [, close, name, , self] = m;
      if (self) continue;
      if (close) assert.equal(stack.pop(), name, `${id}: </${name}> の対応`);
      else stack.push(name);
    }
    assert.deepEqual(stack, [], `${id}: 閉じていないタグ`);
    assert.ok(!/<svg/i.test(MOTIFS[id].svg), `${id}: svg の中身だけ（<svg> は付けない）`);
  }
});

test('舵輪：今の DEFS と同じ形（8本のスポークを <g transform> に展開しただけ）', () => {
  const svg = MOTIFS.helm.svg;
  const spoke = '<rect x="-11" y="-240" width="22" height="240"/><rect x="-19" y="-292" width="38" height="132" rx="19"/>';
  assert.equal(svg.split(spoke).length - 1, 8, '8本のスポーク');
  const rots = [...svg.matchAll(/<g transform="rotate\((\d+)\)">/g)].map((m) => Number(m[1]));
  assert.deepEqual(rots, [45, 90, 135, 180, 225, 270, 315]);
  assert.ok(svg.includes('M-206 0a206 206 0 1 0 412 0a206 206 0 1 0 -412 0ZM-170 0a170 170 0 1 1 340 0a170 170 0 1 1 -340 0Z'), '外輪');
  assert.ok(svg.includes('<circle r="16"/>'), '軸');
  // 王様スポーク（赤）
  assert.ok(svg.includes(`<g fill="${HL}"><rect x="-19" y="-292" width="38" height="132" rx="19"/><rect x="-11" y="-240" width="22" height="80"/></g>`));
});

test('getMotif / resolveMotifId: 知らない id は舵輪にする', () => {
  for (const id of IDS) { assert.equal(getMotif(id), MOTIFS[id]); assert.equal(resolveMotifId(id), id); }
  for (const bad of [undefined, null, '', 'no-such-motif', 'HELM', 7, {}, [], 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(getMotif(bad), MOTIFS.helm, String(bad));
    assert.equal(resolveMotifId(bad), 'helm', String(bad));
  }
});

test('motifPreviewSvg: 図形をそのまま描いた単体の <svg>（id なし・色は引数）', () => {
  for (const id of IDS) {
    const s = motifPreviewSvg(id, { size: 72, wc: '#112233', hl: '#FF0000' });
    assert.ok(s.startsWith('<svg '), id);
    assert.ok(s.endsWith('</svg>'));
    assert.ok(s.includes('viewBox="-300 -300 600 600"') && s.includes('width="72"') && s.includes('height="72"'), id);
    assert.ok(s.includes('--wc:#112233') && s.includes('--hl:#FF0000'), id);
    assert.ok(s.includes(MOTIFS[id].svg), `${id}: 図形が入っている`);
    assert.ok(!/\sid\s*=/i.test(s) && !/<use/i.test(s), `${id}: id も <use> も無い`);
    assert.ok(s.includes('aria-hidden="true"'));
  }
  // 既定値
  const d = motifPreviewSvg('helm');
  assert.ok(d.includes('width="96"') && d.includes('--wc:#0A0E33') && d.includes('--hl:#F23B20'));
  // 知らない id は舵輪
  assert.equal(motifPreviewSvg('no-such'), motifPreviewSvg('helm'));
});

test('motifPreviewSvg: 色・大きさの不正な値は既定に戻す（属性に紛れ込ませない）', () => {
  const evil = motifPreviewSvg('gear', { size: '40"onload="x', wc: '#000;background:url(x)', hl: '"><script>' });
  assert.ok(!evil.includes('<script') && !evil.includes('url(') && !evil.includes('onload'));
  assert.ok(evil.includes('--wc:#0A0E33') && evil.includes('--hl:#F23B20'));
  assert.ok(evil.includes('width="96"'), '数値にならない size は既定');
  assert.ok(motifPreviewSvg('gear', { size: 100000 }).includes('width="1024"'), '大きすぎる size は丸める');
  assert.ok(motifPreviewSvg('gear', { size: 1 }).includes('width="8"'), '小さすぎる size は丸める');
  assert.ok(motifPreviewSvg('gear', { wc: 'rgb(10, 20, 30)' }).includes('--wc:rgb(10, 20, 30)'));
});

test('import しただけでは DOM に触れない（node に document は無い）', () => {
  assert.equal(typeof document, 'undefined');
});
