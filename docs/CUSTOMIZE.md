# ほかのイベントで使うための抽象化 — 設計書

よーそろがちゃ（電波祭2026）を、**コードを書き換えずに**ほかのイベントでも使えるようにする。
変えられるようにするのは「名前・配色・回すもの（演出の図形）・参加の方法・アンケート・景品と日程」。
仕組み（静的 HTML/CSS/JS + Service Worker + IndexedDB、ビルドなし、オフライン完結）は変えない。

既定（テンプレート `denpasai-2026`）のままなら、**画面は今と1画素も変わらない**こと（§10 の検収）。

---

## 0. 方針と、変えないもの

- 設定はすべて IndexedDB の `meta.config`（config v2）に持つ。スタッフ画面で編集し、バックアップ（JSON）に入り、
  「設定ファイル」（抽選履歴を含まない JSON）として書き出し・読み込みできる。
- 既定値は「テンプレート」（`js/templates.js`）から来る。初回セットアップで選ぶ。
- 見た目の部品（配色プリセット `js/theme.js`・回すもの `js/motifs.js`）はコードに持ち、config は **id で参照**する。
  知らない id（新しい版で作った設定ファイルなど）は既定（`yosoro` / `helm`）で表示し、id 自体は保存したまま残す。
- **変えないもの**
  - 抽選の確定・保存の順序（DESIGN.md §5）。単一 readwrite トランザクション、`complete` 待ち、トランザクション中に IDB 以外の await を挟まない。
  - IndexedDB の名前 `yosoro-gacha`・version 1・ストア構成。データ形式の更新は「フィールドの追加」と「読むときの正規化」だけ。
  - 内部の識別子：DB 名・キャッシュ名の接頭辞・バックアップの `app: 'yosoro-gacha'`・PIN の塩。
  - 性能のルール（DESIGN.md §10「性能」）：動かすのは transform / opacity だけ、見える層に visibility を使わない、`.playing` は reset() まで残す 等。
    **配色の適用・回すものの差し替えは演出中に行わない**（スタッフ画面は演出中に開けないので、そこからの変更は安全）。
  - 既存の `data-testid` はすべて残す（E2E が使う）。
  - 外部 CDN・ビルド工程・フレームワークを入れない。相対パスのまま。

## 1. 用語

| 用語 | 中身 | 置き場所 |
|---|---|---|
| テンプレート | config v2 のひな形＋日別の初期本数 | `js/templates.js`（`denpasai-2026` / `generic`） |
| イベント設定（config v2） | このiPadで今使っている設定一式 | IndexedDB `meta.config` |
| テーマ（配色） | 4色（paper / main / ink / accent） | プリセット `js/theme.js`、または config の custom |
| 回すもの（モチーフ） | 抽選画面で回す図形＋その呼び名 | `js/motifs.js`（helm / capsule / garapon / gear / roulette / pinwheel / sakura） |
| 参加の方法 | 学生（学籍番号）／一般の方／一般の方へのアンケート の有無と文言 | config.entry / config.survey.enabled |
| 設定ファイル | 抽選履歴・参加済み番号・PIN を含まない、イベント設定だけの JSON | スタッフ画面から書き出し・読み込み |

## 2. config v2 の形

文字数は「コードポイント数」（`[...s].length`）。英字の欄（〜Latin・latin）は印字可能な ASCII（`/^[\x20-\x7E]*$/`）だけ（欧文書体のサブセットに日本語が無いため）。

| フィールド | 型・制約 | よーそろ（`denpasai-2026`） |
|---|---|---|
| `schemaVersion` | `2` | 2 |
| `eventId` | `/^[a-z0-9][a-z0-9-]{0,39}$/`（抽選記録に写る） | `denpasai-2026` |
| `eventName` | 1〜30字（タブのタイトル・管理画面・CSV） | 電波祭2026 |
| `brand.name` | ガチャ名 1〜16字 | よーそろがちゃ |
| `brand.nameLatin` | 欧文名 0〜24字 ASCII。空なら読みの行を出さない | YOSORO GACHA |
| `brand.eventLabel` | ロゴ横の和文・タイトルカードの小見出し 0〜20字 | 電波祭 2026 |
| `brand.eventLatin` | ロゴ横の欧文・スタンプの下の文字 0〜24字 ASCII | DENPASAI 2026 |
| `brand.tagline` | 待機画面の赤い帯 0〜24字。空なら帯を出さない | おひとり1回・参加無料 |
| `brand.prizeWord` | 「〇〇を引こう！」の〇〇 1〜6字 | お宝 |
| `brand.wordmark` | 手詰め `{for, gaps[], breakAt, yomiSpacing:{l,p}}` または `null`。`for === name + '|' + nameLatin` のときだけ使う | （よーそろの値） |
| `theme.preset` | `/^[a-z0-9-]{1,32}$/` | yosoro |
| `theme.custom` | `null` または `{paper, main, ink, accent}`（各 `/^#[0-9A-Fa-f]{6}$/`）。あればプリセットより優先 | null |
| `motif` | `/^[a-z0-9-]{1,32}$/` | helm |
| `entry.student` | `{enabled, title 1〜12字, sub 0〜20字}` | true／本校の学生／学籍番号を入力します |
| `entry.guest` | `{enabled, title 1〜12字, sub 0〜20字}` | true／本校学生以外の方／入力不要・参加後に印をつけます |
| （制約） | student・guest の少なくとも一方は enabled | |
| `survey.enabled` | 一般の方に抽選前のアンケートを出すか | true |
| `survey.notice` | 注意書き 0〜80字 | 回答は個人が分からない形で… |
| `survey.q1` | `{heading 1〜40字, short 1〜10字, options}`。単一選択・選ぶと自動で次へ | 年齢を/教えてください／年齢 |
| `survey.q1.options` | `[{id, label}]` 2〜12個。id `/^[a-z0-9-]{1,40}$/`・重複なし、label 1〜24字・重複なし | SURVEY_AGES（10個） |
| `survey.q2` | `{heading, short, options}`。複数選択・1つ以上で次へ | 電波祭に/来場した/きっかけを/教えてください。／きっかけ |
| `survey.q2.options` | 2〜10個（制約は q1 と同じ） | SURVEY_TRIGGERS（8個） |
| `days` | `[{id, label 1〜12字}]` 1〜7日。id は `day<n>`（追加は末尾に、まだ無い番号で） | day1 1日目 / day2 2日目 |
| `categories` | `[{id, name 1〜40字, tier, latin 0〜24字 ASCII}]` 1〜12個。tier ∈ sponsor / rare / sticker | 協賛特別賞 sponsor SPONSOR AWARD ほか |
| `prizes` | `[{id, categoryId, name 1〜60字, countUnknown}]` 1〜40個 | グリーンランド招待券 ほか7つ |
| `studentIdRule` | これまでどおり | digits 7〜7 |
| `pinHash` / `sound` | これまでどおり | |

- 見出し（`survey.q*.heading`）の `/` は「ここで改行してよい」の印（表示しない。今の `jp()` と同じ）。`/` が無ければ `splitPhrases` で自動。
- `tier` は演出の系統（派手さ）で、順位ではない。スタッフ画面の表示名：sponsor＝「特別（いちばん派手）」、rare＝「レア」、sticker＝「通常」。
- `categories[].latin` は結果画面のヘッダ中央と協賛特別賞のタイトルカードに出る欧文（今の `SPONSOR AWARD` 等）。新しく作る賞の既定は `TIER_LATIN`（SPECIAL PRIZE / RARE PRIZE / PRIZE）。
- id の採番（景品・賞・選択肢）：`newId(prefix, taken)` → `${prefix}-${Date.now().toString(36)}${連番}` のような、既存と重ならない英小文字・数字・ハイフン。一度付けた id は変えない（抽選記録・アンケート記録が id で参照するため）。

## 3. 互換性とデータ移行

### 3.1 読むときに正規化する（`js/profile.js normalizeConfig`）

- `normalizeConfig(raw)` は v1 / v2 / 壊れた値のどれを渡しても、完全な v2 を返す純粋関数（DOM・DB に触れない。べき等：2回かけても同じ）。
- 足りない v2 のフィールドは **テンプレート `denpasai-2026` の値**で補う（v1 のデータはすべて電波祭2026 のものなので、見た目は今のまま）。
  - v1 の `categories` に `latin` が無いときは `YOSORO_TIER_LATIN`（SPONSOR AWARD / RARE STICKER / STICKER）を tier から補う。v2 で欠けていたら `TIER_LATIN`。
  - 文字列は前後の空白を除き、上限で切る。必須の文字列が空なら既定。英字の欄の ASCII 以外は除く。
  - `entry` の両方が無効なら両方を有効に戻す。`survey.q*.options` が不正（配列でない・有効な項目が2つ未満）なら既定の選択肢。
  - `theme.custom` の色が1つでも不正なら `null`。`theme.preset`・`motif` は形が正しければ知らない id でも残す。
  - `days` / `categories` / `prizes` の構造（id の整合・在庫との対応）は `validateBackup` と保存処理が見る。正規化は欠けた値の補完（latin、countUnknown の真偽化、知らない tier → sticker）だけ。
  - 知らないトップレベルのキーは捨てる。`schemaVersion` は 2 にする。
- `db.getConfig()` は正規化した config を返す。`db.draw()` もトランザクション内で読んだ `m.config` を正規化して使う（同期の関数なので可）。
  保存（`saveConfig` / `initialize` / `importAll`）は正規化してから書く。初めてこの版で開いた iPad の v1 データは、次に保存したときに v2 になる。

### 3.2 バックアップ（JSON）

- `exportAll()` の `schemaVersion` は 2。`validateBackup` は 1 と 2 を受け付ける（3 以上は今までどおり「新しいバージョンのバックアップです」）。
- `importAll()` は config を正規化して書く。v1 のバックアップを復元すると、よーそろの設定（舵輪・群青×朱…）になる。
- 設定ファイルをバックアップの復元に渡されたら、`validateBackup` は「これは設定ファイルです。『設定ファイルを読み込む』から読み込んでください」で断る。

### 3.3 設定ファイル（JSON）

```json
{ "app": "yosoro-gacha", "kind": "profile", "profileVersion": 1, "exportedAt": 1790000000000,
  "profile": { "config": { …config v2（pinHash・sound を除く）… }, "initials": { "day1": { "<prizeId>": 3 } } } }
```

- 書き出し：今の config と、在庫の **初期本数**（残数ではない）。
- 読み込み（2か所）
  - 初回セットアップの「はじめかた」：テンプレートの代わりに使う（このあと PIN などを決める）。
  - スタッフ画面：**抽選履歴が1件も無いときだけ**（リハーサル後の本番リセットのあとなど）。PIN と効果音の設定は今のものを残す。
    在庫は初期本数で作り直し、開催日は最初の日、連番はリセット。ログに `profile-import`。履歴があれば `HAS_DRAWS` で断る。
- 検証 `validateProfileFile(obj)`：`app`・`kind`・`profileVersion`（1 だけ）・config が正規化後に days / categories / prizes の整合を満たすこと・initials が 0〜100000 の整数。

## 4. 抽選まわりの規則

### 4.1 参加の方法・アンケート（`db.draw` のトランザクション内で config を見て判定）

- `kind:'student'` は `entry.student.enabled` のときだけ。`kind:'guest'` は `entry.guest.enabled` のときだけ。違えば `BAD_REQUEST`。
- 一般の方：`survey.enabled` なら `survey` 必須で、`normalizeSurvey(survey, {ages: q1.options, triggers: q2.options})` で検証（今と同じ規則）。
  `survey.enabled` が false なら `survey` を付けてはいけない（付いていたら `BAD_REQUEST`）。学生は今までどおり `survey` を持てない。
- 記録の形（`draws[].survey = {v:1, age, triggers, ageLabel, triggerLabels}`）は変えない。q1 / q2 の中身が年齢・きっかけ以外の質問になっても、
  フィールド名は `age`（= Q1）・`triggers`（= Q2）のまま。表示名は `survey.q1.short` / `q2.short`。
- 選択肢の編集：id は変えない。消した選択肢は、記録に残っている分が集計で「旧選択肢」として出る（今の仕組みのまま）。

### 4.2 景品・賞・開催日の追加と削除（`db.saveBoxSettings`）

スタッフ画面の「景品・日程」タブとセットアップの景品の手順は、**画面の一覧をまるごと**渡す（`{days, categories, prizes, initials}`）。
保存処理は今の config と比べて、追加・変更・削除を1つのトランザクションで行い、ログ `box-settings` に差分を残す。

| 操作 | 条件 | 在庫 |
|---|---|---|
| 景品を追加 | いつでも | 全ての日に行を作る。抽選が始まった日（その日の抽選が1件以上）は初期本数 0（0 以外は `DAY_HAS_DRAWS`）。本数は「在庫」の ±調整で入れる（ログに残る） |
| 景品の名前・本数未定・賞の変更 | いつでも | — |
| 初期本数の変更 | その日にまだ抽選が無いときだけ（今と同じ） | 残数も同じ値に |
| 景品を削除 | その景品の抽選が1件も無いときだけ（あれば `PRIZE_HAS_DRAWS`。代わりに残数を 0 に） | 全ての日の行を消す |
| 賞を追加 | いつでも（tier・欧文を選ぶ） | — |
| 賞の名前・tier・欧文の変更 | いつでも（過去の抽選記録は保存時の名前・tier のまま） | — |
| 賞を削除 | その賞に景品が1つも無いときだけ | — |
| 開催日を追加 | いつでも（末尾に追加。id は `day<n>`） | 全ての景品に行を作る。初期本数は渡された値（画面の既定は1日目と同じ値） |
| 開催日の名前の変更 | いつでも | — |
| 開催日を削除 | **最後の日**で、その日の抽選が無く、開催中の日でもないときだけ | その日の行を消す |

- 上限：賞 12・景品 40・開催日 7。賞・景品はそれぞれ1つ以上残す。
- 開催日を最後の日だけ消せるようにするのは、抽選番号（`<日の番号>-<連番>`）が日の並び順から作られるため（途中を消すと番号が重なる）。
- 既存の `savePrizeSettings` は互換のため残してよい（中身は `saveBoxSettings` を呼ぶ）。

## 5. 見た目：テーマ（配色）

- CSS 変数の名前を役割名にする：`--blue` → `--main`、`--red` → `--accent`（css/*.css・js の中のすべて。機械的な置換）。`--paper`・`--ink` はそのまま。
  `css/tokens.css` の初期値は今の4色（よーそろ）。危険操作のボタン `--danger` は配色に関係なく赤（`#F23B20` 固定）。
  スタッフ画面の警告色（`#F7D9A8`）・無効の地（`#D8D3C2`）も固定のまま。
- `js/theme.js`
  - `THEMES`（7つ。条件は同ファイル冒頭）、`resolveTheme(themeCfg)` → `{paper, main, ink, accent}`（custom > preset > yosoro）。
  - `applyTheme(colors)`：`document.documentElement` に `--paper --main --ink --accent`、派生の `--ink-soft`（ink の 62%）、`--backdrop`（ink の 72%）、
    `--main-rgb`（`"r, g, b"`。スタッフ画面のクロス表の濃淡）を設定し、`<meta name="theme-color">` を paper にする。よーそろの値なら今の見た目と同じ。
  - `contrast(a, b)`（WCAG の比）と `contrastReport(colors)`（`CONTRAST_RULES` ごとの ok / ratio）。
- JS に直書きの色をなくす：抽選画面のダイヤル（目盛り・進捗の弧・針）は CSS で `var(--ink)` / `var(--accent)`、
  ハーフトーンの canvas はインクの色を引数でもらう（キャッシュのキーに色を含める）、スタッフ画面のクロス表は `rgba(var(--main-rgb), a)`。
- `manifest.webmanifest` の色・名前は静的（配置ごとに書き換える。README）。実行時は `document.title`・`apple-mobile-web-app-title`・`theme-color` を config から更新する。

## 6. 見た目：回すもの（モチーフ）

- `js/motifs.js` の `MOTIFS`：`{label, noun, stepLatin, angle, svg}`。svg の約束は同ファイル冒頭（中心 0,0・半径 ~292 以内・2色・id なし）。
- 差し替え方：`<symbol id="wheel">` の **中身だけ**を入れ替える。ロゴ・待機画面の大きなマーク・抽選画面の回すもの・結果画面の飾りはすべて
  `<use href="#wheel">` なので、1か所の差し替えで全部変わる。`stage.setMotif(id)` が行う（演出中は呼ばない）。
- 抽選画面の文言は呼び名から作る（よーそろは今と同じ文字列になること）：
  - 見出し：`{noun}を回して、` / `<em>{prizeWord}</em>を引こう！`
  - 説明：`{noun}をぐるっと回すか、` `タップでまわす` `を押して` `ください。`
  - 小見出し：`DRAW` ＋ `stepLatin`、`aria-label`：`{noun}（タップするか、ぐるっと回します）`
  - アンケートの「次へ」：`次へ/（{noun}へ）`
  - 見出しは左の列（ダイヤルの左）に収まるよう、長い呼び名のときだけ字を小さくする（下限 40px。よーそろは今の 60px のまま）。
- 舵輪の初期角度 38° のような最初の向きは `angle`。回す操作・空転（WAAPI）・刻み音・演出は全モチーフ共通（今の舵輪と同じ）。

## 7. 見た目：名前と文言

### 7.1 待機画面（区分選択）のワードマーク

- `brand.wordmark.for === name + '|' + nameLatin` のとき（よーそろ）：今の手詰め（字ごとの `--g`、縦置きの改行位置、読みの字間）をそのまま使う。**画素まで今と同じ**。
- それ以外：自動で割り付ける。
  - ワードマーク（Dela）：字間は一律 `-0.04em`（目で調整してよい）。箱（横置き：左 26px〜右端から 40px、高さ約 190px／縦置き：左右 17〜40px、高さ約 400px）に収まる最大の大きさ。
    1行と2行（文節 `splitPhrases` の切れ目で、行の幅がなるべく揃う位置）を比べて大きくなる方を使う。上限は横置き 164px（1行）、縦置き 199px（今と同じ）。
  - 読み（Archivo）：ワードマークの実際の幅にそろうよう字間を計算（0〜0.3em。それでもはみ出すなら字を小さく）。nameLatin が空なら行ごと出さず、帯を上に詰める。
  - 帯（tagline）が空なら出さない。
  - 縦の並びは「ワードマークの高さ → 読み → 帯」を今と同じ間隔（横置き：41px・41px、`--ex` の配分も同じ）で積む。
  - 測るのは画面を作ったときと画面の大きさが変わったときだけ（フォントの読み込み後にもう一度）。演出中は測らない。
- 行（参加の方法）：有効な方法だけを並べる。1つだけなら1行（群青の行）、番号は `01`。文言は `entry.*.title` / `sub`。

### 7.2 文言の出どころ

| 場所 | 今 | これから |
|---|---|---|
| ヘッダ中央（待機・学籍番号・抽選・情報画面） | `YOSORO GACHA — よーそろがちゃ` | `{nameLatin} — {name}`（nameLatin が空なら `{name}`） |
| ヘッダ中央（アンケート） | `YOSORO GACHA — SURVEY` | `{nameLatin または name} — SURVEY` |
| ロゴ（左上） | `電波祭 2026 / DENPASAI 2026`（縦置きは欧文だけ） | `{eventLabel} / {eventLatin}`（片方が空ならもう片方だけ）、`aria-label` は name |
| 結果のヘッダ中央・タイトルカード上 | `SPONSOR AWARD` 等（tier で固定） | 賞の `latin`（無ければ tier の既定） |
| タイトルカード右上 | `電波祭 2026 / 1-0042` | `{eventLabel} / {抽選番号}` |
| タイトルカード左下 | `YoSoro Gacha — Sponsor Award` | `{nameLatin または name} — {賞の latin}`（大文字で表示） |
| 結果の PRIZE ラベル | `お宝 / 景品` | `{prizeWord} / 景品`（prizeWord が「景品」なら `景品`） |
| スタンプの下 | `DENPASAI 2026` | `{eventLatin}`（空なら出さない） |
| アンケートの見出し・注意書き・選択肢 | config.js の定数 | `survey.q1` / `q2` / `notice` |
| `document.title` | `よーそろがちゃ｜電波祭2026` | `{name}｜{eventName}` |

結果画面に出す賞の欧文は、抽選記録（スナップショット）ではなく今の config から `categoryId` で引く（飾りなので。賞が消えていれば tier の既定）。

## 8. スタッフ画面とセットアップ

### 8.1 タブ

`状態 / 在庫 / 景品・日程 / イベント / 履歴 / アンケート / バックアップ・リセット / 設定`（`景品・日程` は今の「景品設定」。testid は `tabbtn-prizes` のまま。新しい `イベント` は `tabbtn-event`）。

- **景品・日程**：開催日（名前・追加・最後の日の削除）、賞ごとのカード（名前・演出の系統・欧文・景品の行〔名前・日別の初期本数・本数未定・削除〕・景品を追加・賞を削除）、賞を追加、保存。
  消せない行のボタンは押せない状態にし、理由を添える。抽選が始まった日の初期本数は今と同じく編集不可。
- **イベント**：
  - 名前と表示：ガチャ名・欧文名・イベント名・ロゴの文字（和／欧）・帯の文字・景品の呼び方。入力の上限は §2。保存で反映。
  - 配色：プリセットの見本（4色のチップ＋名前）をタップで即保存・即反映。カスタム（4色の `<input type=color>`）は「適用」で保存し、`contrastReport` の警告を出す（保存はできる）。
  - 回すもの：各モチーフの見本（その場の配色で描いた小さな SVG）をタップで即保存。
  - 参加の方法：学生／一般の方／一般の方にアンケート のチェックと、各行の文言。少なくとも一方は有効。
- **アンケート**：今の集計（Q1・Q2 の名前は `short`、選択肢は config から）＋「質問と選択肢」の編集（見出し・短い名前・選択肢の追加／名前の変更／削除、注意書き）。
  アンケートを使っていないときは、その旨を表示（集計は過去の記録のぶんを出す）。
- **バックアップ・リセット**：「設定ファイル」カード（書き出す／読み込む。読み込みは抽選履歴が無いときだけ）を追加。
- 設定を変えたら、スタッフ画面を閉じたときの `refresh()` で全画面に反映する（app.js の `applyLook(config)`。配色はスタッフ画面の中でもすぐ反映する）。

### 8.2 初回セットアップ

1. **はじめかた**：テンプレート（`setup-template-denpasai-2026` / `setup-template-generic`、既定は denpasai-2026）、設定ファイルを読み込む、バックアップから復元する（`setup-restore`。今は PIN の手順にある）。
2. **PIN**（今と同じ。2回入力で自動で次へ）。
3. **イベントの基本**：ガチャ名・欧文名・イベント名・配色・回すもの・参加の方法・開催日数（1〜7。名前は「1日目…」、1日なら「当日」。テンプレートの日数が既定）。
4. **景品と本数**：「景品・日程」タブと同じ編集部品（全ての日が編集可）。初期本数の入力欄の testid は今の `init-<day>-<prize>` のまま。
5. **学籍番号のルール**（学生が有効なときだけ）。
6. **最後の準備**（今と同じ）。

## 9. モジュールと境界

```
js/templates.js  テンプレート（データ）。他のモジュールを import しない
js/profile.js    normalizeConfig・設定ファイルの書き出し/検証・newId（純粋関数）
js/theme.js      THEMES・resolveTheme・applyTheme・contrast（applyTheme 以外は DOM に触れない）
js/motifs.js     MOTIFS（データ）
js/config.js     定数。createDefaultConfig() = テンプレート denpasai-2026 を正規化したもの。SURVEY_* は templates.js から再エクスポート
js/db.js         getConfig（正規化）・draw（参加の方法とアンケートの判定を tx 内で）・saveBoxSettings・importProfile・バックアップ v2
js/app.js        applyLook(config)：applyTheme・stage.setMotif・stage.setBrand・ロゴ・document.title。refresh() のたびに呼ぶ
js/stage.js      setMotif(id) / setBrand(brand) を追加。r に categoryLatin を追加（無ければ tier の既定）
js/screens.js    画面の組み立てに brand / motif / entry / survey を渡す
js/admin.js      §8
```

- stage は config を知らない（app.js が必要な値だけを渡す）。screens も DB を知らない（今と同じ）。
- スタッフ画面は stage に触れない。配色だけは `applyTheme` をその場で呼んでよい。

## 10. 検収

- 単体テスト（`npm test`）：normalizeConfig（v1→v2・べき等・不正値）、validateBackup（v1/v2/v3/設定ファイル）、設定ファイルの往復、
  saveBoxSettings の規則（純粋な判定部分）、contrast、選択肢を差し替えた normalizeSurvey / aggregateSurvey。
- E2E（`tests/e2e.mjs`）：今の 28 項目がすべて通る（セットアップの手順が増えた分だけ直す）。
  追加（`tests/e2e-custom.mjs`）：汎用テンプレートでのセットアップ、配色・回すもの・名前の変更が画面に出る、参加の方法（学生だけ／一般だけ／アンケートなし）、
  景品・賞・日の追加と削除の規則、アンケートの選択肢の編集と集計、設定ファイルの書き出し→全初期化→読み込み、v1 バックアップの復元でよーそろに戻る、
  長い名前・長い呼び名でも 1180×820 / 1024×768 / 820×1180 で文字がはみ出さない。
- **よーそろの画素一致**：乱数を固定して撮った今の画面（待機・学籍番号・アンケート2画面・抽選・結果3系統・終了 × 3サイズ）と、
  変更後に同じ手順で撮った画面が一致すること（差があれば理由を説明できること）。
- 性能のルール（DESIGN.md §10）に反する変更が無いこと。`?perf=1` の数字が悪くならないこと。
