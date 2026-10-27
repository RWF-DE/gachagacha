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
