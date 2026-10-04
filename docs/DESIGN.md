# YoSoro! お宝ガチャ — 設計書（電波祭2026）

本部テント（屋外・Wi-Fi不安定）に置いた iPad 1台で、来場者が無料の景品抽選をする。
**完全オフラインで iPad 内に完結**する PWA（静的 HTML/CSS/JS + manifest + Service Worker + IndexedDB）。

- ビルド工程なし・フレームワークなし・外部CDNなし。ES Modules（`<script type="module">`）。
- 画像は原則インライン SVG / CSS。効果音は Web Audio で合成（音声ファイルなし）。フォントはシステムフォント。
- すべて**相対パス**。`https://denpasai.jp/gacha/` でも `https://<user>.github.io/gachagacha/` でも動くこと。
- 対象：iPad Safari / ホーム画面に追加したPWA、横置き優先（縦置きでも崩れない）。1024×768〜1366×1024。

## 1. 景品（「〇等」は使わず名称で表示。スポンサー間に順位をつけない）

| 系統 tier | 賞の名称（category） | 景品（prize） | 1日目 | 2日目 |
|---|---|---|---|---|
| sponsor | 協賛特別賞 | グリーンランド招待券 | 3 | 3 |
| sponsor | 協賛特別賞 | E・ZO FUKUOKA招待券 | 3 | 3 |
| sponsor | 協賛特別賞 | ブルダック炒め麺 | 50 | 50 |
| rare | レアステッカー賞 | 茨城コラボステッカー〈レア〉 | 0（未定） | 0（未定） |
| rare | レアステッカー賞 | 電波祭ステッカー〈レア〉 | 25 | 25 |
| sticker | ステッカー賞 | 茨城コラボステッカー | 0（未定） | 0（未定） |
| sticker | ステッカー賞 | 電波祭ステッカー | 100 | 100 |

- 上記は `js/config.js` の初期値。賞の名称・景品名・日別本数はスタッフ画面で編集可能。
  「未定」の景品は `countUnknown: true` を持ち、スタッフ画面で警告表示する。
- ブルダックは届かない可能性があるので、スタッフ画面で残数を 0 にできれば足りる。
- 協賛特別賞内の3景品は同格。演出（tier）も同じ。

## 2. くじの方式

- **日ごとに独立した「引いたら戻さないくじ箱」**。両日の初期本数を同じにすることで「1日目・2日目でスポンサー賞が出る確率は等しい」を満たす。
- 全景品が当たりくじ（はずれ無し・ステッカー賞が実質参加賞）。総口数 = その日の残数合計。
- ある景品が出る確率 = その景品の残数 / その日の残数合計。残数0は対象外。
- 箱が空になったらその日の抽選は終了（新規抽選不可）。黙ってくじを追加しない。スタッフが明示的に残数を足すのはOK（ログに残す）。
- 乱数は `crypto.getRandomValues` + 棄却サンプリング（偏りなし）。演出・指の速度・タップ時刻・属性・学籍番号で結果を変えない。
- 1日目の残りを2日目に自動で繰り越さない（確率が変わるため）。必要ならスタッフが手動調整。

## 3. 参加制限

- 本校学生：学籍番号の重複で参加済みを判定。**電波祭全体（両日）で1回**。
- 本校学生以外：自己申告で1人1回。氏名・メール・電話などは一切収集しない。ダミー番号も割り当てない。
- 学籍番号ルール（スタッフ画面で変更可）：既定は「数字のみ・5〜10桁」。全角数字→半角、前後空白除去で正規化。文字列で保存（先頭ゼロ保持）。
- 入力時点では「形式チェック」と「参加済みか（読み取りのみ）」だけ。使用済み登録は抽選トランザクション内で行う。
- 学籍番号を URL・console・エラーメッセージに出さない。

## 4. 画面フロー（プレイヤー）

```
[待機/区分選択] ─学生→ [学籍番号テンキー] ─OK→ [舵輪で抽選]
       └─学生以外────────────────────────→ [舵輪で抽選]
[舵輪で抽選] ─回す→ (DB保存完了) → [演出] → [結果（自動で閉じない）]
[結果] ─スタッフ「お渡し済み・OK」1秒長押し→ [待機]
[箱が空] → [本日の抽選は終了しました]
```

1. **区分選択**：「本校の学生」「本校学生以外の方」の大ボタン。「おひとり1回・参加無料」。
2. **学籍番号**：大きな表示欄、テンキー（0-9・1文字削除・戻る・決定）。注意書き「学籍番号は参加済みの確認だけに使います。」
   参加済みなら「この学籍番号では参加済みです。スタッフに確認してください」（氏名等は表示しない）。
3. **舵輪で抽選**：「舵輪を回して、お宝を引こう！」。舵輪をドラッグで約120°以上回す、または舵輪タップ、または「タップでまわす」ボタン。どれでも1回だけ発火。戻るボタンあり（抽選前のみ）。
4. **演出**：保存完了後に開始。合計 約3.5〜4.5秒（協賛特別賞は+1秒まで）。reduced-motion 時は 1秒未満。
5. **結果**：賞の名称（大）・景品名（大）・抽選番号（小）「この画面のままスタッフにお見せください」。スタッフが「お渡し済み・OK」を**約1秒長押し**（進捗リング表示）→ 確認済み保存 → 待機へ。

起動時に未確認の抽選があれば、その抽選の結果を（短い演出で）再表示し、新規抽選を許可しない。

## 5. 抽選と保存の順序（最重要）

1. 抽選開始は1回だけ受け付ける（ガード）。開始後は戻る・二度押し無効。
2. IndexedDB の**単一 readwrite トランザクション**（stores: meta, inventory, draws, students）内で：
   未確認抽選が無いこと／学生なら未参加であること／当日箱に残りがあることを再確認。
3. 残数から1本を確定（`pickPrize`）。
4. 残数 -1、抽選履歴追加、学籍番号の使用済み登録（学生のみ）、`meta.pendingDrawId` を同じトランザクションで書く。
5. **transaction の `complete` を待つ**（個々の request success ではなく）。トランザクション中に `await` で IDB 以外の非同期処理を挟まない。
6. 成功後に演出開始。失敗時は景品を表示せず、エラー画面「保存できませんでした。スタッフを呼んでください」。
7. スタッフOKは同じ抽選IDの `confirmedAt` を更新し `pendingDrawId` を消すだけ。再抽選・再減算しない（冪等）。

## 6. データ（IndexedDB `yosoro-gacha`, version 1）

| store | keyPath | 内容 |
|---|---|---|
| meta | `key` | `{key:'config', value:{...}}`, `{key:'activeDayId'}`, `{key:'pendingDrawId'}`, `{key:'drawSeq'}`, `{key:'lastBackupAt'}`, `{key:'schemaVersion'}` |
| inventory | `key` (`${dayId}:${prizeId}`) | `{key, dayId, prizeId, initial, remaining}` |
| draws | `id` | `{id, seq, label, eventId, dayId, kind:'student'|'guest', studentId?, prizeId, categoryId, tier, prizeName, categoryName, drawnAt, confirmedAt|null}` |
| students | `studentId` | `{studentId, drawId, at}` |
| logs | autoIncrement | `{at, type, detail}`（在庫調整・設定変更・復元・初期化など） |

- `label` は `1-0042` 形式（日番号-日内連番）。
- 結果表示に必要な名称は draw に**スナップショット**として保存（後で設定名が変わっても履歴が変わらない）。
- config: `{schemaVersion:1, eventId, eventName, days:[{id:'day1',label:'1日目'},{id:'day2',label:'2日目'}], categories:[{id,name,tier}], prizes:[{id,categoryId,name,countUnknown}], studentIdRule:{charset:'digits'|'alnum', minLength, maxLength}, pinHash, sound:{enabled, volume}}`
- データ形式の更新で台帳を消さない（onupgradeneeded は追加のみ）。

## 7. スタッフ画面

- 入口：画面左上のロゴを**3秒長押し** → PIN入力（4〜8桁）。初回起動時（config未作成）はセットアップ画面が直接出る。
- PINは SHA-256 ハッシュで保存（`crypto.subtle`）。認証はあくまで誤操作防止。
- 機能：
  - 状態：開催日（1日目/2日目の切替）、オフライン準備状況（SW制御中＋キャッシュ完了）、`storage.persisted()`、未確認抽選の有無。
  - 在庫：当日・両日の景品別「初期／残り／出た数」、現在の確率（%）。残数の ±調整（理由つきでlogs記録）。
  - 景品設定：賞の名称・景品名・日別初期本数の編集（抽選が始まった日は初期本数ではなく残数調整で）。
  - 学籍番号ルール、効果音 ON/OFF・音量、PIN変更。
  - 履歴：抽選一覧（新しい順、学籍番号は末尾以外マスク表示可）、未確認結果の再表示、確認済みにする。
  - バックアップ：JSON書出し（`navigator.share({files})` が使えれば共有シート、無ければダウンロード）、JSON復元（確認ダイアログ）、CSV書出し（確認用）。最終バックアップからの件数を表示。
  - 本番リセット：履歴・使用済み番号・ログを消し、在庫を初期本数に戻す（設定は残す）。「リセット」と入力＋PIN。
  - 全初期化：全データ削除。
  - アプリ更新：待機中の新しいSWがあれば「更新を適用」（未確認抽選が無い時のみ）。

## 8. オフライン（PWA）

- `sw.js` はアプリと同じディレクトリに置き scope はそのディレクトリ。キャッシュ名 `yosoro-gacha-v<N>`。activate 時は `yosoro-gacha-` 接頭辞の旧キャッシュのみ削除（他サイトのキャッシュに触らない）。
- 全ファイルを install で precache。fetch は cache-first、navigate は index.html を返す。
- **本番中に強制リロードしない**：`skipWaiting` は自動で呼ばず、スタッフ画面からのメッセージでのみ。
- `manifest.webmanifest`：`display: standalone`, `orientation: landscape`, `start_url: ./`, `scope: ./`、アイコン 192/512 PNG + `apple-touch-icon` 180 PNG。
- iPad 対策：ダブルタップズーム無効（`touch-action: manipulation`）、ピンチズーム無効、オーバースクロール無効、長押しメニュー/文字選択無効、ノッチ安全域対応。

## 9. モジュール構成と担当

```
index.html               … 骨組み・meta・SW登録（core）
css/tokens.css           … 共有トークン（固定）
css/app.css              … 左パネル・テンキー・スタッフ画面・モーダル（core）
css/stage.css            … 背景・ガチャ機・舵輪・演出・結果カード（visual）
js/config.js             … 既定設定（core）
js/lottery.js            … 純粋関数（core）
js/db.js                 … IndexedDB（core）
js/app.js                … 画面状態機械・統合（core）
js/admin.js              … スタッフ画面（core）
js/scene.js              … 背景シーン（visual）
js/stage.js              … ガチャ機・舵輪・演出（visual）
js/sound.js              … 効果音（visual）
js/confetti.js           … 紙吹雪/光の粒子（visual）
sw.js, manifest.webmanifest（core） / icons/*（visual）
tests/                   … node:test（lottery）と Playwright E2E（core）
```

### 9.1 visual ↔ core の契約（この API を厳守）

```js
// js/scene.js
export function createScene(bgEl): { setMood(mood: 'idle'|'celebrate'|'calm'): void }

// js/sound.js
export const sound = {
  unlock(): void,                 // 最初のユーザー操作時に呼ぶ（iOSのAudioContext解錠）
  setEnabled(b: boolean): void,
  setVolume(v: number /*0..1*/): void,
  play(name: 'tap'|'tick'|'spin'|'drop'|'shake'|'open'|'fanfare-sponsor'|'fanfare-rare'|'fanfare-sticker'|'error'): void,
};

// js/stage.js
export function createStage(stageEl: HTMLElement, opts: { sound, reducedMotion?: boolean }): {
  setInteractive(on: boolean): void,  // 舵輪の操作可否（false中は見た目も控えめに）
  onTurn(cb: () => void): void,       // 有効時に「回した」と判定したら1回だけ呼ぶ。呼ぶ直前に自身を setInteractive(false) にする
  startSpin(): void,                  // 結果未確定のまま舵輪の空転・ガチャ機の揺れを開始（onTurn直後にcoreが呼ぶ）
  abort(): void,                      // 保存失敗時：空転停止・何も出さず待機へ
  playReveal(r: RevealData): Promise<void>,  // 空転→宝箱落下→中央へ→揺れ→開封→結果カード。カード表示完了で resolve
  showResultStatic(r: RevealData): void,     // 復旧用：短い演出で結果カードを表示
  resultActionsEl: HTMLElement,       // 結果カード内の操作スロット。coreがスタッフOKボタンを入れる
  reset(): Promise<void>,             // 結果オーバーレイを閉じて待機状態へ（フェードアウト）
  setAttract(on: boolean): void,      // 待機中のアトラクト演出（カプセルがゆらゆら等）
};
// RevealData = { tier:'sponsor'|'rare'|'sticker', categoryName:string, prizeName:string, label:string, reduced?:boolean }
```

- 結果オーバーレイ（宝箱開封＋結果カード）は stage が `position:fixed` 全画面で描く（z-index: `--z-reveal`）。
  結果カードには `categoryName`（大）、`prizeName`（大）、`抽選番号 {label}`（小）、「この画面のままスタッフにお見せください」、そして `resultActionsEl` を含む。
- `?fast=1` クエリ または `reducedMotion` で演出を 1 秒未満に短縮（E2Eテスト用）。
- stage は抽選ロジック・DBに一切触らない。core は演出の DOM に触らない（`resultActionsEl` を除く）。

## 10. デザイン方針「青空の宝船」

- 明るい空（`--sky-top`→`--sky-bottom`）、ゆっくり流れる雲、画面下に何層かの波（視差でゆらぐ）、カモメが時々横切る。
- 右側：**ガチャ機＝宝船の操舵台**。ガラスドームの中に小さな宝箱型カプセルが詰まっている。木製の台座に真鍮の金具、正面に大きな**木製の舵輪**（8本スポーク・真鍮のハブ・持ち手）。取り出し口は船の大砲口風・または錨の飾り。
- 左側：参加操作パネル（生成りの紙/羊皮紙風カード、海の青のボタン、大きな日本語）。
- 演出：舵輪が勢いよく回る（ラチェット音）→ ドーム内の宝箱がシャッフル → 1つが取り出し口から落ちて弾む → 画面中央へ寄りながら拡大 → 揺れる（ここで系統色の光が漏れて期待感） → 蓋が開き光線 → 結果カードがせり上がる。
  - sponsor：金の宝箱に変化、虹〜金の光線、紙吹雪＋金貨、きらめき、ファンファーレ。
  - rare：銀〜水色のホロ光、星のきらめき、短いファンファーレ。
  - sticker：木の宝箱、ポップな紙吹雪少量、明るいジングル。
- 文字は日本語で大きく、コントラスト確保。操作文言は海賊用語だけにしない。
- 管理用情報（残数・確率）はプレイヤー画面に出さない。
