// アプリの定数と既定のイベント設定。
// 既定は js/templates.js のテンプレート denpasai-2026 を正規化したもの（docs/CUSTOMIZE.md §9）。
// 初回セットアップ時に IndexedDB へ複製され、以後はスタッフ画面で編集する。
import { SURVEY_AGES, SURVEY_TRIGGERS, TEMPLATES, DEFAULT_TEMPLATE_ID, templateConfig } from './templates.js';
import { normalizeConfig } from './profile.js';
import { SURVEY_VERSION } from './survey.js';

export const SCHEMA_VERSION = 2;   // バックアップ・config の版（config v2）。v1 は読むときに正規化する（js/profile.js）
export const DB_NAME = 'yosoro-gacha';

/** 初回セットアップ用の config（pinHash は未設定・効果音は既定）。毎回新しいオブジェクトを返す。 */
export function createDefaultConfig() {
  return normalizeConfig(templateConfig(DEFAULT_TEMPLATE_ID).config);
}

/** 日別の初期本数（denpasai-2026）。0 は「未定」を含む。互換のために残している。 */
export const DEFAULT_INITIALS = templateConfig(DEFAULT_TEMPLATE_ID).initials;

export function createDefaultInitials() {
  return templateConfig(DEFAULT_TEMPLATE_ID).initials;
}

/** 長押し時間（ms） */
export const LONG_PRESS_OK_MS = 1000;      // スタッフ「お渡し済み・OK」
export const LONG_PRESS_ADMIN_MS = 3000;   // ロゴ長押しでスタッフ画面
export const IDLE_RESET_MS = 90 * 1000;    // 入力・アンケート途中で放置されたら待機へ戻す
export const PIN_MIN = 4;
export const PIN_MAX = 8;

// ---------- 来場者アンケート（本校学生以外の方だけ。DESIGN.md §3/§4/§6） ----------
// 選択肢は templates.js（SURVEY_AGES / SURVEY_TRIGGERS）。実行時は config.survey.q1 / q2 の options が正で、これは電波祭2026 の既定。
// id は保存データに入る「変えない名前」、label は画面表示用。選択肢を足す・消すのは自由（古い履歴は保存時のラベルで集計される）。
export { SURVEY_AGES, SURVEY_TRIGGERS, SURVEY_VERSION };

export const SURVEY_NOTICE = TEMPLATES[DEFAULT_TEMPLATE_ID].config.survey.notice;
export const SURVEY_ADVANCE_MS = 250;   // Q1 で選んでから Q2 へ進むまでの「選んだ」確認の時間
