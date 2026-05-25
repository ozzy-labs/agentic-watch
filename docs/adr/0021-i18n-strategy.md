# ADR-0021: i18n 方針（en/ja・locale 解決・英語正本プロンプト・user-facing 限定）

## Status

Accepted（2026-05-24）— 親 epic [#307](https://github.com/ozzy-labs/feedradar/issues/307) の起点 ADR。`radar` の **ユーザー向け入出力メッセージ**と**生成ファイル**を英語・日本語の 2 言語に対応させるための設計判断を記録する。後続の実装 PR（P1〜P9）が参照できるよう、対応言語・スコープ境界・ロケール解決・カタログ方式・AI 向け生成物の扱い・移行方針を本 ADR で固定する。

> Post-merge review は welcome。指摘がある場合は follow-up issue で起票してください。

## Context

### 現状は日本語前提で固定されている

`radar` の CLI 出力・エラーメッセージ・生成ファイル（`FEEDRADAR.md` / `AGENTS.md` / `CLAUDE.md`・research レポート雛形・workflow / routine YAML の step 名やコメント）は現状、日本語で固定されている。OzzyLabs 外のユーザーや英語圏での利用を見据えると、少なくとも英語をデフォルトとした 2 言語対応が必要になる。

### 「何を翻訳対象にするか」の境界が曖昧だと破綻する

i18n は対象範囲を広げ過ぎると保守コストが爆発する。特に AI エージェント向けの生成物（エンジン `SKILL.md`・triage / research プロンプト）まで per-locale で 2 本持つと、プロンプトの分岐が増えて triage の JSON parse 安定性・保守性が損なわれる。一方で、ユーザーが直接読む CLI 出力や生成ドキュメントを英語化しないと、デフォルト en という目標が成立しない。

よって本 ADR は **「エンドユーザーが CLI 出力 / 生成ファイルとして読むか」を境界の判定基準**として、user-facing のみを i18n 対象とし、AI 向け生成物・開発者向け（非 user-facing）資産を対象外とする線引きを明文化する。

### ロケール解決の経路を最初に固定する必要がある

`radar` の `run()` には共有実行コンテキストが無く、各コマンドが `loadRadarConfig(cwd)`（[`src/core/config.ts`](../../src/core/config.ts)）で個別に config を読む構造になっている。グローバルな単一のロケール解決を後付けで挿そうとすると、`run()` のリファクタが前提になり epic の足を引っ張る。本 ADR は **解決を各コマンド内で行う**前提を最初に固定し、実装 PR が安心して `resolveLocale()` を各コマンドに配線できるようにする。

### zod v4 のロケール機構を前提にできる

schema バリデーションエラーは zod v4 ネイティブの `z.config(z.locales.ja())` で出力言語を切替えられる（API 動作確認済み）。自前でエラー文言を二重管理せず、解決済み locale を zod に渡すだけで済む。本 ADR はこれを前提として固定する。

## Decision

### D1. 対応言語とデフォルト

対応言語は **`en`（英語）/ `ja`（日本語）** の 2 つとし、**既定は `en`** とする。

- 新規 `radar init` のデフォルト出力言語は `en`。
- `ja` は明示指定（後述 D3 の解決経路）で選択する。

### D2. スコープ境界 — user-facing のみ i18n 対象

i18n の対象は **user-facing（エンドユーザーが CLI 出力 / 生成ファイルとして読む）部分のみ** とする。境界の判定基準は **「エンドユーザーが CLI 出力 / 生成ファイルとして読むか」** で明文化する。

| 区分 | 例 | i18n |
|---|---|---|
| **対象（user-facing）** | CLI の help / usage・エラーメッセージ・結果通知・進捗表示、生成ファイル（research レポート雛形、`FEEDRADAR.md` / `AGENTS.md` / `CLAUDE.md`、workflow / routine YAML の step 名・コメント） | ○ per-locale（en/ja） |
| **対象外（非 user-facing）** | コード内コメント、ADR（本 docs/adr 含む）、schema description、debug 寄りの内部ログ | × 日本語のまま可（無理に英語化しない） |

非 user-facing は日本語のままで構わない（開発者向けであり、エンドユーザーの目に触れない）。逆に user-facing を日本語固定のまま残さない。

### D3. ロケール解決 — 各コマンド内で解決

ロケールの解決優先順位は次のとおり:

```text
--lang フラグ > RADAR_LANG 環境変数 > radar.config.yaml: locale > 既定 en
```

- **`radar.config.yaml` に `locale` を永続化**する（`RadarConfigSchema` に `locale?` フィールドを追加）。
- **解決は各コマンド内で行う**。各コマンドは `loadRadarConfig(cwd)` と同じ経路で config を読み、`--lang` / `RADAR_LANG` と合成して `resolveLocale({ flag, env, config })` で確定する。`run()` に共有実行コンテキストは無いため、**グローバルな単一解決は持たない**。
- **global help / version（[`src/cli/index.ts`](../../src/cli/index.ts)）のみ例外**: workspace の config を読まず、`--lang` / `RADAR_LANG` のみで解決する（config を読む前段の surface のため）。

### D4. メッセージカタログ方式 — 自前の型安全カタログ

メッセージは **自前の型安全カタログ**（`src/i18n/`、`messages/en.ts` / `messages/ja.ts` ＋型安全な `createTranslator(locale)`）で持つ。**新規ランタイム依存は導入しない。**

- 採用理由: メッセージ数が限定的で、型安全性（キーの欠落をコンパイル時に検出）を TypeScript の型だけで担保できる。ランタイム i18n ライブラリの ICU フォーマットや動的ロードは現時点で過剰。
- 代替（i18n ライブラリ導入）の却下理由は後述 Alternatives 参照。

### D5. AI 向け生成物の扱い — 英語正本 1 本、出力言語のみ locale 追従

**エンジン `SKILL.md`（[`src/skills/**`](../../src/skills/)）・triage / research プロンプト（[`src/agents/*.ts`](../../src/agents/)・[`src/core/triage/prompt.ts`](../../src/core/triage/prompt.ts)）は英語を正本として 1 本に保つ。**

- プロンプト本体は per-locale で分岐させない（英語正本 1 本）。
- **レポートの出力言語のみ locale に追従**させる。adapter 契約に `locale` を追加し、プロンプトに**出力言語ディレクティブ**（「出力言語は X」）を付与する。
- **agent が綴る user-facing prose も locale に追従**させる（[#376](https://github.com/ozzy-labs/feedradar/issues/376)）。spawn しない自セッション routine（[ADR-0020](./0020-claude-routines-generation.md)）の `pipeline` では、research / review レポート本文（上記）だけでなく、agent が手順内で自由文として綴る **PR タイトル / 本文・実行サマリー・commit message body** も設定 locale の言語で出力する。`radar routine generate pipeline --lang <非 en>` が生成 `instructions:` の `## Hard constraints` に locale 出力ディレクティブ（`buildLocaleOutputDirective`）を焼き込んで担保する。ただし **Conventional Commits の subject 行（型）は英語のまま**で、追従するのは本文・その他自由文のみ。bootstrap プロンプト自体は言語ニュートラル（[#365](https://github.com/ozzy-labs/feedradar/issues/365)）に保ち、locale 指定は生成 `instructions:` 側が担う。なお GHA `combined-with-triage`（[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md)）の PR 本文は workflow step がテンプレ文字列で per-locale 生成するため agent 自由文ではなく、本ディレクティブの対象外。
- 根拠: triage プロンプトの JSON parse 安定性と保守コスト。プロンプトを 2 本持つと分岐が増え、triage の構造化出力が言語ごとに drift するリスクが上がる。

この D5 と後述 D6 は**混同しやすい**ため、ADR で明確に区別する（D6 のワークスペース運用ドキュメントは per-locale 対象だが、D5 のエンジン SKILL / プロンプトは英語正本 1 本）。

### D6. ワークスペース運用ドキュメントは per-locale

`AGENTS.md` / `CLAUDE.md` / `FEEDRADAR.md` は **ユーザーが読み・git 管理する運用ドキュメント** であるため、**per-locale（en/ja）対象**とする。

- これらは D5 の「エンジン SKILL / プロンプト英語正本」とは**区別**する。D5 は AI が消費する内部プロンプト、D6 はユーザーが読み git 管理する運用ドキュメントであり、性質が異なる。
- 混同しやすいので本 ADR で明記する。

### D7. 生成ファイルの per-locale 構成

生成ファイルのテンプレートは **`src/templates/{en,ja}/**`** の per-locale 構成とする。

- 既定は `en`。
- 現行の日本語テンプレは `ja/` 配下へ移す。

### D8. schema エラー — zod v4 ネイティブ locale を適用

schema バリデーションエラーは zod v4 ネイティブの **`z.config(z.locales.ja())`** を**解決済み locale に応じて適用**する（API 動作確認済み）。

- 自前でエラー文言を二重管理せず、D3 で解決した locale を zod に渡すだけにする。
- `en` 時はデフォルト（英語）のままで追加設定不要。

### D9. 翻訳しないもの（locale 非依存フィールド）

次は user-facing であっても **locale 非依存**とし、翻訳しない:

- レポートの `# <Title>`（item title はソース言語由来）
- digest slug（`matchedKeywords` 由来）
- `run:` のコマンド文字列
- cron / model ID / `network_access` など**機能的フィールド**

これらは意味的に翻訳対象ではない（ソース言語由来 / 機能的識別子）ため、locale を切替えても不変とする。

### D10. 既存ワークスペースの移行

i18n 導入前に `radar init` 済みのワークスペースは、テンプレ等が既にディスク上にあるため**言語が固定**されている。

- **デフォルト en 化は新規 init のみに影響**する。既存ワークスペースのオンディスク資産は自動では書き換えない。
- locale 切替は**再 init もしくは `radar.config.yaml` の手編集**で行う。
- 専用の `radar config` コマンドは現状なく、**本 epic の範囲外**とする。

## Consequences

### 良い面

- **デフォルト en で英語圏ユーザーに届く** — 新規 init が英語になり、`ja` は明示指定で選べる（D1 / D3）。
- **境界が明文化され保守範囲が固定される** — 「エンドユーザーが読むか」を判定基準にしたことで、何を翻訳し何を翻訳しないかが機械的に判断でき、対象の際限ない拡大を防ぐ（D2）。
- **プロンプトの安定性を守れる** — エンジン SKILL / triage・research プロンプトを英語正本 1 本に保つことで、triage の JSON parse 安定性が言語によって揺れない（D5）。
- **新規ランタイム依存ゼロ** — 自前の型安全カタログでキー欠落をコンパイル時に検出でき、依存追加によるサプライチェーン / バンドルサイズ増を避けられる（D4）。
- **schema エラーを二重管理しない** — zod v4 ネイティブ locale により、解決済み locale を渡すだけでエラー文言が切替わる（D8）。
- **後付けリファクタを避けられる** — 各コマンド内解決を最初に固定したことで、`run()` への共有コンテキスト導入という大手術を回避できる（D3）。

### 悪い面・制約

- **ロケール解決ロジックが各コマンドに分散する** — グローバル単一解決を持たないため、`resolveLocale()` の呼び出しが各コマンドに点在する。`resolveLocale()` を 1 関数に集約して配線ミスを抑える（D3）。
- **レポート出力言語と正本言語のずれ** — プロンプトは英語正本だが出力レポートは locale 追従のため、AI の出力品質が `ja` 出力時に英語正本ほど安定しない可能性が残る（D5。出力言語ディレクティブで緩和）。
- **テンプレ移行の一時的な重複** — 現行日本語テンプレを `ja/` へ移し `en/` を新設するため、移行 PR で per-locale の整合を取る手間が生じる（D7）。
- **既存ワークスペースは自動移行されない** — D10 により、導入前 init 済みワークスペースの locale 切替は手動（再 init / config 手編集）になる。

### 中立

- D5（エンジン SKILL / プロンプト = 英語正本 1 本）と D6（運用ドキュメント = per-locale）の区別は混同されやすいため、実装・レビュー時に本 ADR の線引きを参照する。
- `radar config` コマンドは本 epic 範囲外（D10）。将来 locale 切替 UX を整える場合に別 issue で検討する。
- D9 の locale 非依存フィールドは「翻訳しない」ことを明示的な決定として固定し、レビューで「なぜ翻訳されていないか」を蒸し返さない。

## Alternatives

### 案 A: i18n ライブラリ（i18next 等）を導入する — 却下

ランタイム i18n ライブラリでカタログ・複数形・ICU フォーマットを扱う案。却下理由:

- メッセージ数が限定的で、ICU の複数形・動的ロードは現時点で過剰。
- 自前の型安全カタログ（D4）なら、キーの欠落を **TypeScript の型でコンパイル時に検出**できる。ライブラリのランタイム解決はこの静的保証を持たない。
- 新規ランタイム依存はサプライチェーン / バンドルサイズ / メンテ対象を増やす。
- → `src/i18n/` の自前カタログ＋ `createTranslator(locale)` に統一する（D4）。

### 案 B: AI 向けプロンプトも per-locale で 2 本持つ — 却下

エンジン SKILL・triage / research プロンプトを en/ja で 2 本管理する案。却下理由:

- プロンプト分岐が倍増し、triage の構造化出力（JSON）が言語ごとに drift するリスクが上がる。保守コストも倍。
- ユーザーが必要とするのは**レポートの出力言語**であって、プロンプト本体の言語ではない。出力言語ディレクティブ（D5）で出力側だけ追従させれば要件を満たす。
- → エンジン SKILL / プロンプトは英語正本 1 本、出力言語のみ locale 追従（D5）。

### 案 C: グローバルな単一ロケール解決を `run()` に持たせる — 却下

`run()` に共有実行コンテキストを足し、ロケールを 1 度だけ解決して全コマンドへ配る案。却下理由:

- 現状 `run()` には共有コンテキストが無く、各コマンドが `loadRadarConfig(cwd)` で個別に config を読む。共有コンテキスト導入は大規模リファクタになり、i18n epic のスコープを超える。
- → 各コマンド内で `loadRadarConfig` 経路に合わせて解決する（D3）。global help / version のみ config を読まず `--lang` / `RADAR_LANG` で解決する例外を許す。

### 案 D: 既存ワークスペースを自動マイグレーションする — 却下

導入時に既存ワークスペースのオンディスク資産を自動で書き換え、locale を切替える案。却下理由:

- ユーザーが編集済みの `FEEDRADAR.md` / `AGENTS.md` / `CLAUDE.md` 等を機械的に上書きするリスクが高い。
- デフォルト en 化は新規 init にだけ影響させ、既存は再 init / config 手編集に委ねるのが安全（D10）。
- → 自動移行はせず、本 epic 範囲外（専用 `radar config` コマンドも範囲外）。

## 関連

- 親 epic: [#307](https://github.com/ozzy-labs/feedradar/issues/307) feat: i18n 対応（en/ja・user-facing 限定・デフォルト en）
- 本 ADR: [#308](https://github.com/ozzy-labs/feedradar/issues/308) docs(adr): ADR-0021 i18n 方針
- 関連 ADR:
  - [ADR-0003 Output Format and Versioning](./0003-output-format-and-versioning.md) — research レポート雛形・schema 検証の起点。出力言語追従（D5）とレポートの locale 非依存フィールド（D9）はこの出力契約上で規定する
  - [ADR-0007 Skill Bundling and `init` Distribution](./0007-skill-bundling-and-init-distribution.md) — `init` の生成物配布。per-locale テンプレ `src/templates/{en,ja}/**`（D7）・デフォルト en 化（D1 / D10）はこの配布経路に乗る
  - [ADR-0018 LLM-based Triage Extension](./0018-triage-extension.md) — triage プロンプト / per-item `TriageDecision`。triage プロンプトを英語正本 1 本に保つ（D5）根拠（JSON parse 安定性）
  - [ADR-0019 Host-agent Execution Mode](./0019-host-agent-execution-mode.md) — research の adapter 契約。adapter 契約への `locale` 追加（D5）はこの契約上で行う
  - [ADR-0020 Claude Routines Generation](./0020-claude-routines-generation.md) — routine YAML の step 名・コメントは user-facing として per-locale 対象（D2）。cron / model ID / `network_access` は locale 非依存（D9）
- 関連 docs:
  - [`docs/user-guide.md`](../user-guide.md) — i18n（`--lang` / `RADAR_LANG` / `radar.config.yaml: locale`）のユーザー向け記述は後続 sub-issue（P1〜P9）で追加予定
