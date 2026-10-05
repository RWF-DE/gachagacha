# YoSoro! お宝ガチャ — 設計書（電波祭2026）

本部テント（屋外・Wi-Fi不安定）に置いた iPad 1台で、来場者が無料の景品抽選をする。
**完全オフラインで iPad 内に完結**する PWA（静的 HTML/CSS/JS + manifest + Service Worker + IndexedDB）。

- ビルド工程なし・フレームワークなし・外部CDNなし。ES Modules（`<script type="module">`）。
- 画像は原則インライン SVG / CSS。効果音は Web Audio で合成（音声ファイルなし）。フォントは自前ホスト（`fonts/*.woff2`、サブセット済み・OFL）で、iPad では Hiragino Sans を代替にする。
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
- 本校学生以外：**運用ルールで1人1回**。スタッフが景品を渡した後、来場者のパンフレットまたは手に「済」のスタンプ／シールを付けて管理する（アプリでの重複判定はしない）。氏名・メール・電話などは一切収集しない。ダミー番号も割り当てない。一般の方の結果画面には、OKボタンの上にスタッフ向けの注意書き「印を付けてからOK」を表示する。
- 学籍番号ルール（スタッフ画面で変更可）：既定は「数字のみ・7桁ちょうど」。全角数字→半角、前後空白除去で正規化。文字列で保存（先頭ゼロ保持）。
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
3. **舵輪で抽選**：「舵輪を回して、お宝を引こう！」。舵輪をドラッグで累積180°以上回す、または舵輪タップ、または「タップでまわす」ボタン、または Enter/Space。どれでも1回だけ発火。戻るボタンあり（抽選前のみ）。入力した瞬間から舵輪が空転し（待ち時間の演出）、保存が完了したらワイプ演出に入る。
4. **演出**：保存完了を 0 秒として、スタッフのボタンが出るまで ステッカー賞 約3秒／レアステッカー賞 約4秒／協賛特別賞 約5.5秒。reduced-motion・`?fast=1` は 1秒未満（カットとフェードだけ）。
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

## 9. モジュール構成

```
index.html               … 骨組み・meta・フォント preload・SW登録。#stage（ポスター全体）と #admin-root
css/tokens.css           … 色・フォント・イージングのトークン、@font-face
css/app.css              … リセット・iPad対策・ボタン・テンキー・ダイアログ・スタッフ画面
css/poster.css           … プレイヤー画面すべて（各画面・シャッター・タイトルカード・結果・演出タイムライン）
fonts/*.woff2, OFL-*.txt … Dela Gothic One / Zen Kaku Gothic New 700 / Archivo 900 / DM Mono 500（dev/build-fonts.py で生成）
js/config.js, lottery.js, db.js  … 既定設定・純粋関数・IndexedDB（演出と無関係）
js/app.js                … 画面状態機械・抽選フロー（保存→演出）・スタッフOK・起動復旧・アイドル復帰
js/screens.js            … 区分選択／学籍番号／情報画面（終了・エラー・読込失敗）の組み立て
js/stage.js              … 舵輪の画面・空転・演出（シャッター／タイトルカード）・結果カード・拡縮
js/poster.js             … 舵輪SVG・ヘッダ帯・拡縮（fitStage）・紙の粒子・ハーフトーン(canvas)・文字の割り付け
js/perf.js               … ?perf=1 のときだけ出る rAF 間隔の計測表示（実機のカクつき確認用）
js/sound.js              … 効果音（Web Audio 合成）
js/admin.js, ui.js, util.js … スタッフ画面・共通UI・ユーティリティ
sw.js, manifest.webmanifest, icons/*
tests/                   … node:test（lottery）と Playwright E2E
dev/                     … build-fonts.py（フォント生成）, render-icons.mjs（アイコン書出し）
```

### 9.1 app.js ↔ stage.js の境界

```js
const stage = createStage(document.getElementById('stage'), { sound, reducedMotion });
stage.wheelScreen({ onBack }): HTMLElement   // 舵輪の画面（data-testid screen-wheel / spin-button / wheel / back）。app.js が #screen-host に入れる
stage.onTurn(cb)          // 回した（累積180°・タップ・ボタン・Enter/Space）と判定したら1回だけ。直前に自身を setInteractive(false)
stage.setInteractive(on)
stage.startSpin()         // 入力の直後：保存完了を待つあいだ舵輪を空転
stage.abort()             // 保存失敗：空転停止（景品は出さない）
stage.playReveal(r)       // 保存完了「後」に呼ぶ。スタッフのボタンが出る瞬間に resolve
stage.showResultStatic(r) // 起動時の復旧：演出なしで結果を表示
stage.resultActionsEl     // 結果カード内の操作スロット（app.js がスタッフOKボタンを入れる）
stage.reset()             // 結果を畳んで待機の紙へ
stage.setDay(text)        // ヘッダの開催日（飾り。残数・確率は出さない）
// r = { tier:'sponsor'|'rare'|'sticker', categoryName, prizeName, label }
```

- stage は抽選ロジック・DBに一切触れない。app.js は演出の DOM に触らない（`resultActionsEl` と、画面ホスト `#screen-host` への画面の出し入れを除く）。
- 賞の名称・景品名は draw のスナップショット（スタッフが編集できる）をそのまま使う。コードに名称を埋め込まない。
- E2E 用フック（data-testid）：`screen-choose|student|wheel|closed|error|fatal`, `choose-student|guest`, `tenkey-*`, `student-error`, `spin-button`, `wheel`, `back`, `result-card`, `ok-button`, `error-back`, `logo`, `pin-*`, スタッフ画面の各 testid。


## 10. デザイン方針「Festival Key Visual」

現代の日本の祭りポスターが動き出す、というコンセプト。紙色の地にベタ塗りの色面、紙の粒子、印刷の版ズレ（オフセットの影）。グラデーション・グロー・光沢・紙吹雪・コインは使わない。

- パレット：紙 `#EEEADB`／群青 `#1A33E0`／インク紺 `#0A0E33`／信号赤 `#F23B20`。
- 書体：Dela Gothic One（日本語の見出し）／Zen Kaku Gothic New 700（本文）／Archivo 900（欧文・数字）／DM Mono 500（キャプション）。`font-display: block`＋preload。
- 画面は 横1180×820・縦820×1180 を基準にした固定構図で、画面に収まる最大の等倍で拡縮する（`fitStage`）。細長い画面では論理サイズが広がり、各要素は端に固定されて伸びる。縦置きは構図を別に組み替える（`#stage[data-o=p]`）。
- 画面：区分選択（巨大な「YoSoro!」＋ 01/02 の2行＋右下の舵輪マーク）／学籍番号（ベタ塗りの大きなテンキー・版ズレの表示欄・赤いラベルのエラー）／舵輪（目盛りのダイヤル＋進捗の赤い弧）／終了・エラー・読込失敗（情報画面）。ロゴは各画面ヘッダ左の小さな文字マーク（3秒長押しでスタッフ画面）。
- 演出（保存完了を 0 ms）：舵輪の空転 → シャッターの列ワイプ → 結果。系統ごとに色と振付が違う（順位ではなく系統）：
  - 協賛特別賞：群青と赤の縦シャッター → 赤い面に巨大なタイトルカード（1文字ずつマスクから迫り上がる）→ 文字が全部退いてから結果が登場。結果は赤の面＋ハーフトーン。
  - レアステッカー賞：紙が降りて、中央から群青が割れる → 群青の面に紙色の文字（色の反転）。
  - ステッカー賞：群青が1枚横切る → 落ち着いた紙の面。
  - 結果の登場：ヘッダ → 賞の名称（1文字ずつスラム）→ 罫線 → 景品名 → 「この画面のまま…」→ 抽選番号のスタンプ（揺れ）→ スタッフのボタン。
- 賞に順位をつけない：Latin ラベルは非序数（`SPONSOR AWARD`／`RARE STICKER`／`STICKER`）。ステッカー賞の右肩は抽選の連番（`DRAW 0044`）で、賞の序列ではない。
- 景品名は 1 行に収まるよう自動で縮小し、小さくなりすぎるときだけ文節の切れ目で折り返す（`splitPhrases`）。タイトルカードも賞の名称の長さに合わせて行分け・縮小する。
- 性能（iPad Safari。実機で「カクつく」と報告があり、以下を守る）：
  - **動かすのは transform / opacity / visibility のみ。clip-path・filter・box-shadow・mix-blend-mode・width/height/top/left は動かさない。** Safari は clip-path のアニメーションをコンポジタで動かせず、毎フレーム巨大な文字（Dela）ごと再描画になる。ワイプは「背景色のカバー（`::after`、または `.cv`）を `scaleX(1→0)` / `scaleY(1→0)` で外す」で表す（結果面は `--bg` 色。終端は scale 0 なので見た目は clip-path と同じ）。退場も同じ（`#result::after` が `scaleX(0→1)`）。要素の下に動く別要素（舵輪など）がある場所へのカバーは避ける。
  - **重いものは動かす前に描いておく（pre-warm）。** 結果面は演出の序盤（200 ms 時点。結果面とタイトルカードを同じフレームにまとめる）から `opacity: .001` で「描画だけ」しておき、`cv` で opacity 1。初めて見える瞬間に巨大な文字（タイトルカード約 340px・賞の名称・景品名）をラスタライズさせない。大きな文字のレイヤー（`#card .chi`・`#result .cat .chi`）の `will-change: transform` は `#stage.playing` の間だけ。常時付けない（メモリ）。
  - **レイアウトは来場者が回す前に済ませる。** 舵輪の画面が出て 0.7 秒後に `#stage.warm` を付け、結果面・シャッター・タイトルカードを `display:block` + 不可視にしてレイアウトしておく（`stage.js scheduleWarm`）。演出の頭では文字を差し替えて測り直すだけ。測定（`offsetWidth` など）は `layoutResult` に集約し、演出中（`playing`）は DOM を読み書きしない。
  - **ハーフトーンは canvas に1回だけ描く**（枠の大きさ×解像度ごとにキャッシュ、解像度は最大 3 倍）。SVG の円を数百個ラスタライズし直さない。
  - 効果音のノイズバッファは `unlock` 時に1回だけ作る（`sound.js ensure`）。紙の粒子は静止タイル1枚（ブレンドなし）。アイドル中は rAF を回さない（空転中だけ）。
  - 変更後は `?perf=1` で実機の rAF 間隔を確認する（右上に `frames: N, >33ms: K, max: X ms`）。目安は 1 回の演出で >33ms が 0〜2 回、max が 50 ms 未満。
- 管理用情報（残数・確率）はプレイヤー画面に出さない。
