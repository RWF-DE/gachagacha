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
    studentIdRule: { charset: 'digits', minLength: 5, maxLength: 10 },
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
export const IDLE_RESET_MS = 90 * 1000;    // 入力途中で放置されたら待機へ戻す
export const PIN_MIN = 4;
export const PIN_MAX = 8;
