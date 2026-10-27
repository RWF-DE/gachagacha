// 回すもの（モチーフ。docs/CUSTOMIZE.md §6）。抽選画面で回す図形と、ロゴ・待機画面・結果画面の飾りに使う。
// 約束：
//   - svg は <symbol id="wheel" viewBox="-300 -300 600 600"> の中身。中心 (0,0)、半径およそ 292 以内に収める。
//   - 塗りは2色だけ：本体 fill="var(--wc,#0A0E33)"・目印 fill="var(--hl,#F23B20)"。目印は回っていることが分かる1か所（舵輪の赤いスポークと同じ役割）。
//     結果画面の飾りは --hl を --wc と同じにして単色のシルエットで使う。グラデーション・線（stroke）・フィルタは使わない。
//   - id 属性を持たない（スタッフ画面の見本で同じ図形を何度も並べるため。くり返しは <g transform> で展開する）。
//   - noun は画面の文言に入る呼び名（「舵輪を回して、」「次へ（舵輪へ）」）。stepLatin は抽選画面の小見出し。angle は抽選画面での最初の向き（度）。
// このファイルは DOM に触れない（node:test から読める）。

const f = (n) => +n.toFixed(1);
const pol = (r, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [f(r * Math.cos(a)), f(r * Math.sin(a))]; };
const ring = (ro, ri) => `M${-ro} 0a${ro} ${ro} 0 1 0 ${2 * ro} 0a${ro} ${ro} 0 1 0 ${-2 * ro} 0ZM${-ri} 0a${ri} ${ri} 0 1 1 ${2 * ri} 0a${ri} ${ri} 0 1 1 ${-2 * ri} 0Z`;
const circ = (cx, cy, r) => `M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const poly = (pts) => `M${pts.map((p) => p.join(' ')).join('L')}Z`;
const ngon = (n, r, rot = 0) => poly([...Array(n)].map((_, i) => pol(r, rot + (360 / n) * i)));
const BODY = 'var(--wc,#0A0E33)';
const HL = 'var(--hl,#F23B20)';

// 舵輪（よーそろ）：これまでの DEFS と同じ形。<use href="#wh-s"> の8本のスポークを <g transform> に展開しただけ
const helmSpoke = '<rect x="-11" y="-240" width="22" height="240"/><rect x="-19" y="-292" width="38" height="132" rx="19"/>';
const helm = `<g fill="${BODY}">
  <path fill-rule="evenodd" d="M-206 0a206 206 0 1 0 412 0a206 206 0 1 0 -412 0ZM-170 0a170 170 0 1 1 340 0a170 170 0 1 1 -340 0Z"/>
  <g>${helmSpoke}</g>${[45, 90, 135, 180, 225, 270, 315].map((a) => `<g transform="rotate(${a})">${helmSpoke}</g>`).join('')}
  <path fill-rule="evenodd" d="M-76 0a76 76 0 1 0 152 0a76 76 0 1 0 -152 0ZM-42 0a42 42 0 1 1 84 0a42 42 0 1 1 -84 0Z"/>
  <circle r="16"/>
 </g>
 <g fill="${HL}"><rect x="-19" y="-292" width="38" height="132" rx="19"/><rect x="-11" y="-240" width="22" height="80"/></g>`;

// ガチャ玉（カプセル）：上半分ベタ・下半分は空き・合わせ目の帯。中の★が目印
const star = (cx, cy, ro, ri) => poly([...Array(10)].map((_, i) => { const [x, y] = pol(i % 2 ? ri : ro, i * 36); return [f(cx + x), f(cy + y)]; }));
const capsule = `<g fill="${BODY}">
  <path fill-rule="evenodd" d="${ring(268, 230)}"/>
  <path d="M-232 0A232 232 0 0 1 232 0Z"/>
  <rect x="-286" y="-24" width="572" height="48" rx="24"/>
 </g>
 <g fill="${HL}"><path d="${star(0, 122, 74, 31)}"/></g>`;

// ガラポン（八角形の抽選器を正面から）：八角形の枠・内枠の桟・軸。ハンドルが目印
const oct = (r) => ngon(8, r, 22.5);
const garapon = `<g fill="${BODY}">
  <path fill-rule="evenodd" d="${oct(272)}${oct(228)}"/>
  ${[...Array(8)].map((_, i) => `<rect x="-13" y="-226" width="26" height="160" transform="rotate(${i * 45})"/>`).join('')}
  <path fill-rule="evenodd" d="${oct(96)}${circ(0, 0, 38)}"/>
 </g>
 <g fill="${HL}"><rect x="-19" y="-292" width="38" height="270" rx="19" transform="rotate(45)"/><path d="${circ(...pol(270, 45), 40)}"/></g>`;

// 歯車（12枚歯・肉抜き穴6つ）。1枚の歯が目印
const GEAR_N = 12; const GEAR_RO = 286; const GEAR_RR = 238;
const gearTeeth = [];
for (let i = 0; i < GEAR_N; i++) {
  const c = (360 / GEAR_N) * i;
  gearTeeth.push(pol(GEAR_RR, c - 10.5), pol(GEAR_RO, c - 6), pol(GEAR_RO, c + 6), pol(GEAR_RR, c + 10.5));
}
const gearHoles = [...Array(6)].map((_, i) => { const [x, y] = pol(160, 30 + i * 60); return circ(x, y, 46); }).join('');
const gear = `<g fill="${BODY}"><path fill-rule="evenodd" d="${poly(gearTeeth)}${gearHoles}${circ(0, 0, 44)}"/></g>
 <g fill="${HL}"><path d="${poly([pol(GEAR_RR - 6, -10.8), pol(GEAR_RO, -6), pol(GEAR_RO, 6), pol(GEAR_RR - 6, 10.8)])}"/></g>`;

// ルーレット（12区画のうち6つをベタ）。空いた区画の1つが目印
const wedge = (a0, a1, ro, ri) => {
  const [x0, y0] = pol(ro, a0); const [x1, y1] = pol(ro, a1); const [x2, y2] = pol(ri, a1); const [x3, y3] = pol(ri, a0);
  return `M${x0} ${y0}A${ro} ${ro} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${ri} ${ri} 0 0 0 ${x3} ${y3}Z`;
};
const roulette = `<g fill="${BODY}">
  <path fill-rule="evenodd" d="${ring(286, 252)}"/>
  <path d="${[...Array(6)].map((_, i) => wedge(i * 60 + 2, i * 60 + 28, 238, 84)).join('')}"/>
  <path fill-rule="evenodd" d="${circ(0, 0, 60)}${circ(0, 0, 22)}"/>
 </g>
 <g fill="${HL}"><path d="${wedge(32, 58, 238, 84)}"/></g>`;

// 風車（4枚羽根。羽根の表が本体、折り返しが目印の色）
const pinBlade = (rot) => `<g transform="rotate(${rot})"><path d="M0 0L0 -282L200 -200Z" fill="${BODY}"/><path d="M0 0L200 -200Q186 -92 104 -26Z" fill="${HL}"/></g>`;
const pinwheel = `${[0, 90, 180, 270].map(pinBlade).join('')}
 <g fill="${BODY}"><path d="${circ(0, 0, 26)}"/></g>`;

// さくら（5枚の花びら。1枚が目印）
const PETAL = 'M0 -34C-70 -82 -132 -178 -86 -246C-62 -282 -24 -286 0 -258C24 -286 62 -282 86 -246C132 -178 70 -82 0 -34Z';
const sakura = `<g fill="${BODY}">${[1, 2, 3, 4].map((i) => `<path d="${PETAL}" transform="rotate(${i * 72})"/>`).join('')}<path d="${circ(0, 0, 40)}"/></g>
 <g fill="${HL}"><path d="${PETAL}"/></g>`;

/** モチーフ一覧（表示順）。helm が既定 */
export const MOTIFS = {
  helm: { label: '舵輪（よーそろ）', noun: '舵輪', stepLatin: 'TURN THE WHEEL', angle: 38, svg: helm },
  capsule: { label: 'ガチャ玉', noun: 'ガチャ', stepLatin: 'TURN THE GACHA', angle: -24, svg: capsule },
  garapon: { label: 'ガラポン（福引き）', noun: 'ガラポン', stepLatin: 'TURN THE DRUM', angle: 0, svg: garapon },
  gear: { label: '歯車', noun: '歯車', stepLatin: 'TURN THE GEAR', angle: 8, svg: gear },
  roulette: { label: 'ルーレット', noun: 'ルーレット', stepLatin: 'SPIN THE ROULETTE', angle: 0, svg: roulette },
  pinwheel: { label: '風車', noun: '風車', stepLatin: 'SPIN THE PINWHEEL', angle: 0, svg: pinwheel },
  sakura: { label: 'さくら', noun: 'さくら', stepLatin: 'SPIN THE FLOWER', angle: 0, svg: sakura },
};

export const DEFAULT_MOTIF_ID = 'helm';

// ---------- 関数 ----------
/** 実際に使うモチーフの id。知らない id（新しい版で作った設定など）は舵輪。'constructor' などの継承プロパティは id と見なさない */
export function resolveMotifId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MOTIFS, id) ? id : DEFAULT_MOTIF_ID;
}

/** id のモチーフ { label, noun, stepLatin, angle, svg }。知らない id は舵輪 */
export const getMotif = (id) => MOTIFS[resolveMotifId(id)];

const SAFE_COLOR = /^(#[0-9A-Fa-f]{3,8}|[A-Za-z]{3,20}|(?:rgb|hsl)a?\([\d\s,.%/-]+\))$/;   // style 属性に埋め込んでよい色だけ

/**
 * 単体で置ける <svg> 文字列（スタッフ画面の見本用）。<use> を使わず図形をそのまま描くので、何個並べても id がぶつからない。
 * wc = 本体の色、hl = 目印の色（既定はよーそろの インク／朱）。size は px（一辺）。装飾なので aria-hidden（名前は置く側のボタンが持つ）。
 */
export function motifPreviewSvg(id, { size = 96, wc = '#0A0E33', hl = '#F23B20' } = {}) {
  const px = Math.max(8, Math.min(1024, Math.round(Number(size)) || 96));
  const color = (v, d) => (typeof v === 'string' && SAFE_COLOR.test(v.trim()) ? v.trim() : d);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-300 -300 600 600" width="${px}" height="${px}" aria-hidden="true" `
    + `style="--wc:${color(wc, '#0A0E33')};--hl:${color(hl, '#F23B20')}">${getMotif(id).svg}</svg>`;
}
