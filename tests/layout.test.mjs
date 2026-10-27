// node --test tests/   文字の割り付けの純粋関数（js/poster.js）：幅の見積り・見出しの大きさ・ワードマークの計画・ヘッダの文言・defs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emWidth, headingSize, planWordmark, brandMid, surveyMid, defsHtml, splitPhrases,
} from '../js/poster.js';
import { MOTIFS } from '../js/motifs.js';

test('emWidth: 全角は 1em・半角は字種ごとの控えめな値・決まった値', () => {
  assert.equal(emWidth(''), 0);
  assert.equal(emWidth('舵輪を回して、'), 7);
  assert.equal(emWidth('ガチャ'), 3);
  assert.equal(emWidth('ー！'), 2);
  assert.ok(emWidth('A') > emWidth('a') && emWidth('a') > emWidth(' '), '大文字 > 小文字 > 空白');
  assert.ok(emWidth('2026') > 2 && emWidth('2026') < 4);
  assert.equal(emWidth('ｱｲ'), 1, '半角カナは 0.5em');
  assert.equal(emWidth('舵輪を回して、'), emWidth('舵輪を回して、'), '同じ入力は同じ値');
});

test('emWidth: W・M（m・w）は 1em（ほかの大文字 0.8em・小文字 0.7em では足りない幅広の字）', () => {
  for (const ch of ['M', 'W', 'm', 'w']) assert.equal(emWidth(ch), 1, ch);
  assert.equal(emWidth('MWmw'), 4);
  assert.equal(emWidth('WOW'), 1 + 0.8 + 1, 'W 以外の大文字は 0.8em のまま');
  assert.equal(emWidth('Wow'), 1 + 0.7 + 1, 'w 以外の小文字は 0.7em のまま');
  assert.equal(emWidth('A'), 0.8);
  assert.equal(emWidth('a'), 0.7);
  assert.ok(emWidth('M') > emWidth('N') && emWidth('m') > emWidth('n'), 'M は N より、m は n より広い');
  assert.equal(emWidth('1W'), 0.72 + 1, '数字・空白・記号は変わらない');
});

test('headingSize: 幅広の大文字（W・M）の景品の呼び方でも、見出しが左の列（416px）からはみ出してダイヤルに掛からない', () => {
  const lines = (prizeWord) => ['舵輪を回して、', `${prizeWord}を引こう！`];
  const size = (prizeWord) => headingSize(lines(prizeWord), { base: 60, min: 40, maxW: 416, ls: -0.015 });
  // 景品の呼び方は 6字まで。W を 0.8em と見積もっていたころは 57px になり、実際の幅（W≒1em）では 450px 近くになって左の列を越えた
  assert.equal(size('WWW'), 52);
  const widest = (prizeWord) => Math.max(...lines(prizeWord).map((t) => emWidth(t) - 0.015 * [...t].length));
  assert.ok(widest('WWW') * size('WWW') <= 416, '見積りの幅で 416px に収まる（W を 1em と見積もるので、実際の幅でも収まる）');
  assert.equal(size('MMMMMM'), 40, '6字とも M なら下限の 40px');
  assert.equal(size('お宝'), 60, 'よーそろ（お宝）は今のまま 60px');
  // 縦置き（幅 740px・基準 54px）は余裕があるので変わらない
  assert.equal(headingSize(lines('WWW'), { base: 54, min: 40, maxW: 740, ls: -0.015 }), 54);
});

test('headingSize: よーそろ（舵輪・お宝）は今のサイズ 60px / 54px のまま', () => {
  const lines = ['舵輪を回して、', 'お宝を引こう！'];
  assert.equal(headingSize(lines, { base: 60, min: 40, maxW: 416, ls: -0.015 }), 60);
  assert.equal(headingSize(lines, { base: 54, min: 40, maxW: 740, ls: -0.015 }), 54);
});

test('headingSize: すべてのモチーフの呼び名で 40〜60px（横）・54px 以下（縦）に収まる。短い呼び名は縮めない', () => {
  for (const [id, m] of Object.entries(MOTIFS)) {
    for (const prize of ['お宝', '景品', '賞品']) {
      const lines = [`${m.noun}を回して、`, `${prize}を引こう！`];
      const l = headingSize(lines, { base: 60, min: 40, maxW: 416, ls: -0.015 });
      const p = headingSize(lines, { base: 54, min: 40, maxW: 740, ls: -0.015 });
      assert.ok(l >= 40 && l <= 60 && Number.isInteger(l), `${id}/${prize} 横 ${l}`);
      assert.ok(p >= 40 && p <= 54 && Number.isInteger(p), `${id}/${prize} 縦 ${p}`);
      const widest = Math.max(...lines.map((t) => emWidth(t) - 0.015 * [...t].length));
      assert.ok(l === 40 || widest * l <= 416, `${id}: 左の列（416px）に収まる`);
      if ([...m.noun].length <= 2) assert.equal(l, 60, `${id}: 2字の呼び名は 60px`);
    }
  }
});

test('headingSize: 長い呼び名は小さく（下限 40px）・上限を超えない', () => {
  assert.equal(headingSize(['ルーレットを回して、', 'お宝を引こう！'], { base: 60, min: 40, maxW: 416, ls: -0.015 }), 42);
  assert.equal(headingSize(['とてもとてもながいよびなをまわして、', 'お宝を引こう！'], { base: 60, min: 40, maxW: 416, ls: -0.015 }), 40);
  assert.equal(headingSize(['あ', 'い'], { base: 60, min: 40, maxW: 416 }), 60, '短ければ base まで（それ以上は大きくしない）');
});

test('brandMid / surveyMid: ヘッダ中央の文言（docs/CUSTOMIZE.md §7.2）', () => {
  const yo = { name: 'よーそろがちゃ', nameLatin: 'YOSORO GACHA' };
  assert.equal(brandMid(yo), 'YOSORO GACHA — よーそろがちゃ');
  assert.equal(surveyMid(yo), 'YOSORO GACHA — SURVEY');
  const noLatin = { name: 'がちゃ祭', nameLatin: '' };
  assert.equal(brandMid(noLatin), 'がちゃ祭', 'nameLatin が空なら name だけ');
  assert.equal(surveyMid(noLatin), 'がちゃ祭 — SURVEY', 'アンケートは nameLatin または name');
  assert.equal(brandMid(undefined), '');
});

test('defsHtml: #wheel はモチーフの中身・矢印と回転は変わらない・id の重複なし', () => {
  for (const [id, m] of Object.entries(MOTIFS)) {
    const s = defsHtml(id);
    assert.ok(s.includes(`<symbol id="wheel" viewBox="-300 -300 600 600" overflow="visible">${m.svg}</symbol>`), id);
    assert.ok(s.includes('<symbol id="arrow" viewBox="0 0 48 48">') && s.includes('<symbol id="rot" viewBox="0 0 48 48">'));
    const ids = [...s.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(ids, ['wheel', 'arrow', 'rot'], `${id}: id は3つだけ`);
    assert.ok(!s.includes('wh-s'), '舵輪のスポークは <use> でなく展開済み');
  }
  assert.equal(defsHtml('no-such'), defsHtml('helm'), '知らない id は舵輪');
  assert.equal(defsHtml(undefined), defsHtml('helm'));
});

// ---------- ワードマークの計画 ----------
const ends = (name) => { let a = 0; return splitPhrases(name).map((p) => (a += [...p].length)).slice(0, -1); };
const plan = (name, o = {}) => planWordmark({
  adv: [...name].map(() => 1), gap: -0.04, phraseEnds: ends(name), availW: 1118, maxInk: 188, cap: 164, ...o,
});
const lineW = (p, name) => p.widths.map((w) => w * p.fs);

test('planWordmark: 短い名前は上限（横置き 164px）の1行', () => {
  const p = plan('がちゃがちゃ');
  assert.equal(p.lines, 1);
  assert.equal(p.fs, 164);
  assert.equal(p.split, 6);
});

test('planWordmark: 1文節の長い名前は2行にできず、幅に収まるまで小さく', () => {
  const name = 'ほんとうにながいなまえのがちゃ';   // すべてひらがな＝文節の切れ目なし
  const p = plan(name);
  assert.equal(p.lines, 1);
  assert.ok(p.fs < 120 && Math.max(...lineW(p)) <= 1118 + 1e-6, `fs=${p.fs}`);
});

test('planWordmark: 1行だと小さくなる長い名前は、文節の切れ目で2行（行の幅がなるべく揃う位置）', () => {
  const name = 'オープンキャンパス2026がちゃ';
  const p = plan(name);
  assert.equal(p.lines, 2);
  assert.equal(p.split, 9, '「オープンキャンパス」と「2026がちゃ」');
  assert.ok(p.fs > plan(name, { phraseEnds: [] }).fs, '1行より大きい');
  assert.ok(Math.max(...lineW(p)) <= 1118 + 1e-6, '行が幅に収まる');
  // 2行の高さ：先頭の行の上から (0.88 + 0.976)em ≦ maxInk
  assert.ok((0.88 + 0.976) * p.fs <= 188 + 1e-6);
  assert.ok(p.fs <= 164);
});

test('planWordmark: 切れ目が複数あるときは、長い方の行がいちばん短くなる位置', () => {
  // 3|2|7 字の3文節（切れ目は 3 と 5。長い方の行が短くなるのは 3 の位置：3|9 でなく 5|7）
  const adv = new Array(12).fill(1);
  const p = planWordmark({ adv, gap: 0, phraseEnds: [3, 5], availW: 600, maxInk: 400, cap: 199 });
  assert.equal(p.lines, 2);
  assert.equal(p.split, 5, '5|7 の方が 3|9 より揃っている');
  assert.deepEqual(p.widths, [5, 7]);
});

test('planWordmark: 1字だけの孤立した行ができる切れ目は使わない（がちゃがちゃ祭 → 1行）', () => {
  const name = 'がちゃがちゃ祭';   // 文節は「がちゃがちゃ」「祭」。6|1 は 1行より大きくなるが、「祭」だけの行は作らない
  const p = planWordmark({ adv: [...name].map(() => 1), gap: -0.04, phraseEnds: ends(name), availW: 767, maxInk: 400, cap: 199, twoFirst: true });
  assert.equal(p.lines, 1);
  const loose = planWordmark({ adv: [...name].map(() => 1), gap: -0.04, phraseEnds: ends(name), availW: 767, maxInk: 400, cap: 199, twoFirst: true, minRatio: 0 });
  assert.equal(loose.lines, 2, 'minRatio を外すと2行（比較用）');
});

test('planWordmark: 同じ大きさなら、twoFirst（縦置き）のときだけ2行', () => {
  // 4字・上限 100px・幅は十分：1行も2行も 100px
  const base = { adv: [1, 1, 1, 1], gap: 0, phraseEnds: [2], availW: 2000, maxInk: 2000, cap: 100 };
  assert.equal(planWordmark(base).lines, 1);
  assert.equal(planWordmark({ ...base, twoFirst: true }).lines, 2);
});

test('planWordmark: 縦置きの箱（高さ 400px・上限 199px）：7字は 2行・199px', () => {
  const name = 'ガチャガチャ祭';
  const p = planWordmark({ adv: [...name].map(() => 1), gap: -0.04, phraseEnds: ends(name), availW: 767, maxInk: 400, cap: 199, twoFirst: true });
  assert.ok(p.fs >= 100 && p.fs <= 199);
  assert.ok(Math.max(...p.widths) * p.fs <= 767 + 1e-6);
  assert.ok(((p.lines - 1) * 0.88 + 0.976) * p.fs <= 400 + 1e-6);
});

test('planWordmark: 字送りの違い（半角英数）を使う・fs は整数で下限 12', () => {
  const p = planWordmark({ adv: [0.8, 0.8, 0.8, 1, 1], gap: -0.04, phraseEnds: [], availW: 300, maxInk: 188, cap: 164 });
  assert.ok(Number.isInteger(p.fs));
  assert.ok(Math.max(...p.widths) * p.fs <= 300 + 1e-6);
  assert.equal(planWordmark({ adv: [1, 1], gap: 0, phraseEnds: [], availW: 1, maxInk: 188, cap: 164 }).fs, 12, '極端に狭くても 12px 未満にはならない');
});
