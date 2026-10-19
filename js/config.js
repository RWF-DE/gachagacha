// 既定設定（DESIGN.md §1）。初回セットアップ時に IndexedDB へ複製され、以後はスタッフ画面で編集する。

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'yosoro-gacha';

/** 初回セットアップ用の config（pinHash は未設定）。毎回新しいオブジェクトを返す。 */
export function createDefaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: 'denpasai-2026',
    eventName: '電波祭2026',
    days: [
      { id: 'day1', label: '1日目' },
      { id: 'day2', label: '2日目' },
    ],
    categories: [
      { id: 'sponsor', name: '協賛特別賞', tier: 'sponsor' },
      { id: 'rare', name: 'レアステッカー賞', tier: 'rare' },
      { id: 'sticker', name: 'ステッカー賞', tier: 'sticker' },
    ],
    prizes: [
      { id: 'greenland', categoryId: 'sponsor', name: 'グリーンランド招待券', countUnknown: false },
      { id: 'ezo', categoryId: 'sponsor', name: 'E・ZO FUKUOKA招待券', countUnknown: false },
      { id: 'bulldak', categoryId: 'sponsor', name: 'ブルダック炒め麺', countUnknown: false },
      { id: 'rare-ibaraki', categoryId: 'rare', name: '茨城コラボステッカー〈レア〉', countUnknown: true },
      { id: 'rare-denpasai', categoryId: 'rare', name: '電波祭ステッカー〈レア〉', countUnknown: false },
      { id: 'sticker-ibaraki', categoryId: 'sticker', name: '茨城コラボステッカー', countUnknown: true },
      { id: 'sticker-denpasai', categoryId: 'sticker', name: '電波祭ステッカー', countUnknown: false },
    ],
    studentIdRule: { charset: 'digits', minLength: 7, maxLength: 7 },
    pinHash: null,
    sound: { enabled: true, volume: 0.7 },
  };
}

/** 日別の初期本数。0 は「未定」を含む。 */
export const DEFAULT_INITIALS = {
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

export function createDefaultInitials() {
  return JSON.parse(JSON.stringify(DEFAULT_INITIALS));
}

/** 長押し時間（ms） */
export const LONG_PRESS_OK_MS = 1000;      // スタッフ「お渡し済み・OK」
export const LONG_PRESS_ADMIN_MS = 3000;   // ロゴ長押しでスタッフ画面
export const IDLE_RESET_MS = 90 * 1000;    // 入力・アンケート途中で放置されたら待機へ戻す
export const PIN_MIN = 4;
export const PIN_MAX = 8;

// ---------- 来場者アンケート（本校学生以外の方だけ。DESIGN.md §3/§4/§6） ----------
// 選択肢は表示順どおり。id は保存データに入る「変えない名前」、label は画面表示用（保存時に履歴へも写す）。
// 文言を直すときは label だけ変える。選択肢を足す・消すのは自由（古い履歴は保存時のラベルで集計される）。
export const SURVEY_VERSION = 1;

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

export const SURVEY_NOTICE = '回答は個人が分からない形で集計し、電波祭の運営と協賛企業への来場者層の説明に使います。';
export const SURVEY_ADVANCE_MS = 250;   // Q1 で選んでから Q2 へ進むまでの「選んだ」確認の時間
