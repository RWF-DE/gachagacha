// イベントのテンプレート（初回セットアップの「はじめかた」で選ぶひな形。docs/CUSTOMIZE.md §2）。
// 中身は config v2 の形そのもの（pinHash・sound はセットアップで決めるので持たない）と、日別の初期本数 initials {dayId:{prizeId:n}}。
// 既定は 'denpasai-2026'（電波祭2026 よーそろがちゃ）。v1 の保存データ・旧バックアップは、この内容を補って v2 にする（js/profile.js）。
// 画面に出る文字は fonts/ のサブセット（JIS 第1水準漢字＋かな＋英数）に入るものだけを使う（入らない字は iPad では代替の書体になる）。
// このファイルは他のモジュールを import しない（config.js がここから再エクスポートするため、循環させない）。

// ---------- 来場者アンケートの選択肢（id は保存データに入る「変えない名前」、label は表示名） ----------
export const SURVEY_AGES = [
  { id: 'preschool', label: '未就学児' },
  { id: 'elementary', label: '小学生' },
  { id: 'junior-high', label: '中学生' },
  { id: 'high-school', label: '高校生' },
  { id: 'college', label: '大学生・専門学生' },
  { id: 'age-20s', label: '20代' },
  { id: 'age-30s', label: '30代' },
  { id: 'age-40s', label: '40代' },
  { id: 'age-50s', label: '50代' },
  { id: 'age-60plus', label: '60代以上' },
];

export const SURVEY_TRIGGERS = [
  { id: 'referral', label: '家族・友人・知人からの紹介' },
  { id: 'sns', label: 'SNS（Instagram・Xなど）' },
  { id: 'website', label: 'ホームページ' },
  { id: 'poster', label: 'ポスター・チラシ' },
  { id: 'annual', label: '毎年参加している' },
  { id: 'event-interest', label: 'イベント内容に興味があった' },
  { id: 'kosen-interest', label: '熊本高専に興味があった' },
  { id: 'other', label: 'その他' },
];

/** 新しく作る賞の欧文ラベルの既定（演出の系統ごと。順位を表す語は使わない） */
export const TIER_LATIN = { sponsor: 'SPECIAL PRIZE', rare: 'RARE PRIZE', sticker: 'PRIZE' };

/** v1（電波祭2026）の賞の欧文ラベル。v1 のデータを v2 にするときに使う */
export const YOSORO_TIER_LATIN = { sponsor: 'SPONSOR AWARD', rare: 'RARE STICKER', sticker: 'STICKER' };

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 電波祭2026（よーそろがちゃ）：これまでの既定そのもの ----------
const DENPASAI_2026 = {
  eventId: 'denpasai-2026',
  eventName: '電波祭2026',
  brand: {
    name: 'よーそろがちゃ',
    nameLatin: 'YOSORO GACHA',
    eventLabel: '電波祭 2026',
    eventLatin: 'DENPASAI 2026',
    tagline: 'おひとり1回・参加無料',
    prizeWord: 'お宝',
    // 「よーそろがちゃ」専用の手詰め（docs/DESIGN.md §10 区分選択の見出し）。name と nameLatin が for と一致するときだけ使う。
    // gaps = 各字の右の字間（em）、breakAt = 縦置きで改行する字の位置、yomiSpacing = 読み（欧文）の字間（em。l=横置き / p=縦置き）
    wordmark: {
      for: 'よーそろがちゃ|YOSORO GACHA',
      gaps: [-0.066, -0.039, -0.019, -0.066, -0.041, -0.129, 0],
      breakAt: 4,
      yomiSpacing: { l: 0.122, p: 0.077 },
    },
  },
  theme: { preset: 'yosoro', custom: null },
  motif: 'helm',
  entry: {
    student: { enabled: true, title: '本校の学生', sub: '学籍番号を入力します' },
    guest: { enabled: true, title: '本校学生以外の方', sub: '入力不要・参加後に印をつけます' },
  },
  survey: {
    enabled: true,
    notice: '回答は個人が分からない形で集計し、電波祭の運営と協賛企業への来場者層の説明に使います。',
    q1: { heading: '年齢を/教えてください', short: '年齢', options: SURVEY_AGES },
    q2: { heading: '電波祭に/来場した/きっかけを/教えてください。', short: 'きっかけ', options: SURVEY_TRIGGERS },
  },
  days: [
    { id: 'day1', label: '1日目' },
    { id: 'day2', label: '2日目' },
  ],
  categories: [
    { id: 'sponsor', name: '協賛特別賞', tier: 'sponsor', latin: 'SPONSOR AWARD' },
    { id: 'rare', name: 'レアステッカー賞', tier: 'rare', latin: 'RARE STICKER' },
    { id: 'sticker', name: 'ステッカー賞', tier: 'sticker', latin: 'STICKER' },
  ],
  prizes: [
    { id: 'greenland', categoryId: 'sponsor', name: 'グリーンランド招待券', countUnknown: false },
    { id: 'ezo', categoryId: 'sponsor', name: 'E・ZO FUKUOKA招待券', countUnknown: false },
    // id は既設端末の在庫キーと抽選履歴で使うため維持し、表示名だけ更新した（db.js migrateGamjaPrizeName）
    { id: 'bulldak', categoryId: 'sponsor', name: 'カムジャ麺', countUnknown: false },
    { id: 'rare-ibaraki', categoryId: 'rare', name: '茨城コラボステッカー〈レア〉', countUnknown: true },
    { id: 'rare-denpasai', categoryId: 'rare', name: '電波祭ステッカー〈レア〉', countUnknown: false },
    { id: 'sticker-ibaraki', categoryId: 'sticker', name: '茨城コラボステッカー', countUnknown: true },
    { id: 'sticker-denpasai', categoryId: 'sticker', name: '電波祭ステッカー', countUnknown: false },
  ],
  studentIdRule: { charset: 'digits', minLength: 7, maxLength: 7 },
};

const DENPASAI_2026_INITIALS = {
  day1: {
    greenland: 3, ezo: 3, bulldak: 50,
    'rare-ibaraki': 0, 'rare-denpasai': 25,
    'sticker-ibaraki': 0, 'sticker-denpasai': 100,
  },
  day2: {
    greenland: 3, ezo: 3, bulldak: 50,
    'rare-ibaraki': 0, 'rare-denpasai': 25,
    'sticker-ibaraki': 0, 'sticker-denpasai': 100,
  },
};

// ---------- 新しいイベント（汎用）：名前・景品・本数は仮。セットアップとスタッフ画面で書き換える前提 ----------
const GENERIC = {
  eventId: 'gacha-event',
  eventName: 'イベント',
  brand: {
    name: 'がちゃがちゃ',
    nameLatin: 'GACHA GACHA',
    eventLabel: 'イベント',
    eventLatin: 'EVENT',
    tagline: 'おひとり1回・参加無料',
    prizeWord: '景品',
    wordmark: null,
  },
  theme: { preset: 'wakaba', custom: null },
  motif: 'capsule',
  entry: {
    student: { enabled: true, title: '本校の学生', sub: '学籍番号を入力します' },
    guest: { enabled: true, title: '本校学生以外の方', sub: '入力不要・参加後に印をつけます' },
  },
  survey: {
    enabled: true,
    notice: '回答は個人が分からない形で集計し、イベントの運営に使います。',
    q1: { heading: '年齢を/教えてください', short: '年齢', options: SURVEY_AGES },
    q2: {
      heading: 'このイベントに/来場した/きっかけを/教えてください。',
      short: 'きっかけ',
      options: SURVEY_TRIGGERS.filter((t) => t.id !== 'kosen-interest'),
    },
  },
  days: [{ id: 'day1', label: '当日' }],
  categories: [
    { id: 'grand', name: '特賞', tier: 'sponsor', latin: 'GRAND PRIZE' },
    { id: 'rare', name: 'レア賞', tier: 'rare', latin: 'RARE PRIZE' },
    { id: 'basic', name: '参加賞', tier: 'sticker', latin: 'PRIZE' },
  ],
  prizes: [
    { id: 'grand-1', categoryId: 'grand', name: '特賞の景品', countUnknown: false },
    { id: 'rare-1', categoryId: 'rare', name: 'レア賞の景品', countUnknown: false },
    { id: 'basic-1', categoryId: 'basic', name: '参加賞の景品', countUnknown: false },
  ],
  studentIdRule: { charset: 'digits', minLength: 7, maxLength: 7 },
};

const GENERIC_INITIALS = { day1: { 'grand-1': 3, 'rare-1': 20, 'basic-1': 100 } };

/** テンプレート一覧（表示順）。config / initials は直接書き換えず templateConfig() で複製を受け取る */
export const TEMPLATES = {
  'denpasai-2026': {
    label: '電波祭2026（よーそろがちゃ）',
    description: '前回と同じ設定：舵輪・群青×朱・2日間・協賛特別賞／レアステッカー賞／ステッカー賞',
    config: DENPASAI_2026,
    initials: DENPASAI_2026_INITIALS,
  },
  generic: {
    label: '新しいイベント（汎用）',
    description: 'ガチャ玉・若葉の配色・1日・特賞／レア賞／参加賞（名前・本数はこのあと自由に変更）',
    config: GENERIC,
    initials: GENERIC_INITIALS,
  },
};

export const DEFAULT_TEMPLATE_ID = 'denpasai-2026';

/** テンプレートの config・initials の複製（pinHash・sound は付けない。正規化は js/profile.js normalizeConfig） */
export function templateConfig(id = DEFAULT_TEMPLATE_ID) {
  const t = TEMPLATES[id] || TEMPLATES[DEFAULT_TEMPLATE_ID];
  return { config: clone(t.config), initials: clone(t.initials) };
}
