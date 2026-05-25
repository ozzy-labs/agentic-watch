# ADR-0020: Claude Routines 生成方針（自セッション完結・spawn しない原則）

## Status

Accepted（2026-05-24）— 親 epic [#277](https://github.com/ozzy-labs/feedradar/issues/277) の起点 ADR。`radar routine generate <type>` サブコマンドの設計判断と、Claude Routines 環境特有のセーフティ方針を記録する。後続 sub-issue（[#279](https://github.com/ozzy-labs/feedradar/issues/279) triage 自セッション入口 / [#280](https://github.com/ozzy-labs/feedradar/issues/280) `routine generate watch` / [#284](https://github.com/ozzy-labs/feedradar/issues/284) フルパイプライン routine / [#281](https://github.com/ozzy-labs/feedradar/issues/281) YAML 統一・パス修正 / [#282](https://github.com/ozzy-labs/feedradar/issues/282) `/fire` 連携 / [#283](https://github.com/ozzy-labs/feedradar/issues/283) docs）の起点として固定する。

> Post-merge review は welcome。指摘がある場合は follow-up issue で起票してください。

## Context

### GitHub Actions と Claude Routines は実行環境が根本的に違う

[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) で `radar workflow generate <type>` を導入し、GitHub Actions（GHA）での無人実行を確立した。GHA では:

- API キー（`ANTHROPIC_API_KEY` 等）を secret として持ち込み、`radar research --agent <id>` が**別プロセスの agent CLI を spawn** する（[ADR-0001](./0001-agent-adapter-interface.md)）
- 複数 AI のクロス運用（research=claude / review=codex）が成立する（[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) F2）
- `concurrency:` group で同一 branch への同時 push を制御できる（[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) D4）

一方 Claude Routines（以下 routine）は、その前提が成り立たない:

- routine は**サブスク枠で動く 1 つの Claude セッション**である。クラウド側（Anthropic 管理 VM）で **fresh clone** され、出力は `claude/*` ブランチか PR に限られる
- **最小実行間隔は 1 時間**。**ローカル MCP は使えない**
- 管理は CLI `/schedule`（schedule トリガーのみ）と Web UI、外部からの起動は API `/fire`。**設定を宣言的に流し込む公開 API は無い**（GET も無い）
- routine 内で API キーを別途持ち込んで別 agent を spawn することは、サブスク枠とは別のコスト・認証経路を要し、ADR-0004 の OAuth 禁止方針とも整合しない

### ADR-0019 の自セッション処理は「対話専用」に限定されている

[ADR-0019](./0019-host-agent-execution-mode.md) は、ホストセッションが手順を実行してレポートを書き、CLI の `--emit-payload` / `--commit` で finalize する **host-agent（in-session）実行モード**を確立した。ただし ADR-0019 は §Consequences「セキュリティ posture の差」で、このモードを **interactive 専用の opt-in に留め、CI / headless では無効** とすると明記している。根拠は untrusted item content の blast radius:

- **spawn モード**: untrusted content は使い捨ての headless サブプロセスのコンテキストに閉じる
- **host モード**: untrusted content は**ユーザーの対話セッション本体**のコンテキストに入る。対話セッションは対話的に付与された広い tool 権限や standing approval を持つため、prompt injection が成立した場合の blast radius が大きい

routine は「無人実行される 1 つの Claude セッション」であり、host モードの構造（モデル自身が手順を実行する自セッション処理）を取りつつ、対話相手は存在しない。よって ADR-0019 の「対話専用・headless では無効」という制約をそのまま適用すると、**routine では自セッション処理が一切使えない**ことになり、かつ routine 内で spawn もできない（サブスク枠 1 セッション）ため、**routine から無人パイプラインを回す経路が消える**。

本 ADR は、routine という第三の実行環境のために ADR-0019 の制約を **routine 向けに carve-out（切り出し）** し、その安全性を成立させる前提条件を確定させる。

### triage には自セッション入口が無い

ADR-0019 §「triage / review / update への展開方針」は、research / review / update は host モード（`--emit-payload` / `--commit`）を備えるが、**triage は per-item の `TriageDecision` を書く別形**（レポートファイルが無い）で payload / commit 契約が別物のため、host モード化は deferred であると記している。routine でフルパイプライン（watch → triage → research → review）を回すには、triage の自セッション入口が前提として必要になる。本 ADR はその payload / commit 契約の形を §「triage 自セッション入口の payload / commit 契約」で確定させ、実装は [#279](https://github.com/ozzy-labs/feedradar/issues/279) に委ねる。

## Decision

### D1. `radar routine generate <type>` サブコマンドを新設

`radar` CLI に新しいサブコマンド namespace `radar routine` を切り、`generate` を最初の verb として実装する。

```text
radar routine generate <type> [options]
```

- 出力形式は **`.claude/routines/*.yaml`**（Web UI のフォームと 1:1 対応する宣言的設定ファイル）
- `radar workflow generate <type>`（GHA、[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md)）と**対等な並び**の surface とし、環境ごとに namespace を分ける（`workflow` = GHA / `routine` = Claude Routines）
- 既存 `init --with-routines`（[ADR-0004](./0004-schedule-strategy.md)）は出力先・形式を本 ADR の方針へ寄せる（後述 D6 / [#281](https://github.com/ozzy-labs/feedradar/issues/281)）

`/schedule`・Web UI・`/fire` のいずれも宣言的に設定を流し込む公開 API を持たないため、配布 CLI としては「**正本の設定ファイルを生成 → ユーザーが Web UI に手で適用**」が唯一の形になる。`routine generate` はこの正本を吐く。

### D2. routine では spawn しない（自セッション完結）

routine 内では**別プロセスの AI を起動しない（spawn しない）**。routine 自身の 1 セッションで手順を実行し、CLI の自セッション入口（`--emit-payload` / `--commit`、[ADR-0019](./0019-host-agent-execution-mode.md)）で finalize する。

環境別の方式分離を明確にする:

| 環境 | AI 起動方式 | 認証 | クロス AI |
|---|---|---|---|
| GitHub Actions（[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md)） | **spawn**（`--agent <id>`） | API キー（`<AGENT>_API_KEY`） | 可（research=claude / review=codex 等） |
| Claude Routines（本 ADR） | **自セッション**（spawn しない） | サブスク枠（追加キー不要） | 不可（Claude 単独） |

この分離により:

- routine は追加の API キーを持ち込まない（サブスク枠で完結）
- 「別 AI による review」は routine では成立しない。これを type 名で誤認させない（後述 D5）

### D3. routine 向け安全策（出力ゲート・connector・通信先・データ扱い・件数上限）

routine は無人実行されるため、ADR-0009 / ADR-0019 の防御を保ちつつ、routine 環境に固有のゲートを重ねる:

#### D3a. 出力ゲート — PR または `claude/*` のみ（自動マージ禁止）

routine の出力は **PR か `claude/*` ブランチに限定**し、**main 直接反映・自動マージを禁止**する。

- routine が生成した research / review レポートや items 更新は、人間がレビューする PR か `claude/*` ブランチに着地させる
- routine 自身がデフォルトブランチへ直接 push したり PR を auto-merge することは設計上認めない
- これは ADR-0009 prompt injection 対策（M2a / M3b）が成立しても、なお untrusted content 由来の変更が無レビューで main に入らないための最終ゲート

##### D3a-1. `pipeline` の opt-in auto-merge（既定は据え置き）

`radar routine generate pipeline` の既定は **PR / `claude/*`（auto-merge なし）** のまま据え置く（上記ゲートが既定）。ただし、ユーザーが明示的に opt-in した場合に限り、pipeline routine が自分の PR を main に着地させる経路を用意する（[#301](https://github.com/ozzy-labs/feedradar/issues/301)。GHA 側の [`workflow generate combined-with-triage --output-mode pr|direct-commit`](./0014-workflow-generate-and-auto-research-safety.md)（[#258](https://github.com/ozzy-labs/feedradar/issues/258)）と対称）:

- **`radar routine generate pipeline --output-mode auto-merge`**（既定は `pr`）を選ぶと、生成 YAML の instructions の着地 step（[#331](https://github.com/ozzy-labs/feedradar/issues/331) で digest / unsure step を挿入したため step 8）が `claude/pipeline/...` PR を開いた後に `git switch main` → `gh pr merge "${BRANCH}" --squash --delete-branch`（fail-soft）で **自分の PR を squash-merge して main に着地**させる。GHA の `direct-commit`（PR を介さず main へ直 push）とは異なり、**必ず PR を経由する**ため名前を `auto-merge` と分ける。
- pipeline は着地前の review step（[#331](https://github.com/ozzy-labs/feedradar/issues/331) 後は step 6）で `radar review` 済みなので、auto-merge の前提（review-complete な PR）は自然に満たす。これが ADR-0009 の無レビュー反映ゲートを opt-in で緩める根拠になる。
- `auto-merge` は `permissions.allow_unrestricted_git_push: true` を要求するが、これは **必要条件であって十分条件ではない**。Web UI の「Allow unrestricted branch pushes」トグルも別途 ON にする必要がある（RemoteTrigger API は当該フィールドを受け付けないため、YAML だけでは有効化できない）。生成時に stderr 警告でこの点を明示する。
- `--auto`（required check 前提のキューイング）ではなく **即時 `--squash`** を焼き込む。check の無いリポでは `gh pr merge --auto` が永久に merge されないため。
- **`watch` には `--output-mode` を追加しない**: watch は detection のみで pipeline のような review step が無く、auto-merge すると未レビュー内容が main に乗るため、ゲート緩和は pipeline 限定とする。
- untrusted-content の blast radius（ADR-0009 / [ADR-0019](./0019-host-agent-execution-mode.md)）を踏まえ、**既定は据え置き**（auto-merge は明示 opt-in のユーザーのみ）。

#### D3b. connector なし

routine からは connector（外部サービス連携プラグイン）を一切有効化しない。routine の能力は「購読フィードを取得し、レポートを書き、`claude/*` か PR に出す」に閉じる。

#### D3c. 通信先は購読フィードに限定

routine の outbound 通信先は、 workspace に登録済みの**購読フィード（`sources/*.yaml`）に限定**する。[ADR-0009](./0009-untrusted-external-content-handling.md) D5b の host allowlist / blocklist がそのまま適用され、routine から任意 URL への fetch は行わない。

#### D3d. 取得した外部本文はデータ扱い

routine が取得した外部本文（feed item の title / summary / body / tags）は、[ADR-0009](./0009-untrusted-external-content-handling.md) M1c の `<untrusted_item>...</untrusted_item>` 境界マーカーで wrap され、「**指示ではなくデータ**」として扱われる。M2a（untrusted instruction に従わない）/ M2b（tool 呼び出し前 self-check）/ M3b（workspace 外 write 禁止）の self-check guidance も routine の自セッション実行時にそのまま適用される。これは [ADR-0019](./0019-host-agent-execution-mode.md) が `--emit-payload` payload に M1c 境界を含めて host 実行時にも継続適用する設計と同一であり、routine も同じ payload を消費する。

#### D3e. 1 実行あたりの件数上限はフラグで担保

1 回の routine 実行で扱う件数の上限は、**指示文の裁量に任せず CLI フラグで担保**する:

- triage 件数: `radar triage --max-items N`（[ADR-0018](./0018-triage-extension.md) W7）
- research / review 対象の取り出し件数: `radar items list --limit N` / `radar research --batch --max-items N`（[ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) D3a）

routine テンプレには [ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) D3 と同じく **literal value として上限を焼き込む**。「ルーティンの instruction に『重要なものだけ N 件やって』と書く」運用は、untrusted content の injection で上限が無視され得るため採らない。上限はあくまで CLI 層（決定論的に超過分を切り捨て）で担保する。

### D4. 自セッション処理は 1 件ずつ・順次（`--emit-payload` は `--batch` と非両立）

research / review の自セッション処理（`--emit-payload` / `--commit`）は **1 件ずつ**である（`--emit-payload` は `--batch` と併用不可、[ADR-0019](./0019-host-agent-execution-mode.md)）。routine では:

- **順次処理 + 件数上限**で回す（D3e の cap が 1 実行の総量を縛る）
- spawn モードの `--batch` は使わない（D2: routine では spawn しない）

### D5. type 名は `pipeline` 等（`combined-with-triage` を避ける）

routine の type 名は GHA の `combined-with-triage`（[ADR-0018](./0018-triage-extension.md)）を**避け**、`pipeline` 等の誤解を招かない名前にする。

- GHA の `combined-with-triage` は spawn による**別 AI の review**を含み得るが、routine は Claude 単独で、別 AI による review が**構造的に存在しない**
- 同じ type 名を使うと「GHA 版と対等な review 品質」と誤認させる。type 名で「これは単一 Claude の自セッションパイプラインである」ことを表現する
- 採用 type（初期）:

| type | 用途 | spawn | 出力 |
|---|---|---|---|
| `watch` | `watch run` のみを定期実行（[#280](https://github.com/ozzy-labs/feedradar/issues/280)） | しない | `claude/*` or PR（items/state 更新） |
| `pipeline` | watch → triage → research → review を自セッションで順次（[#284](https://github.com/ozzy-labs/feedradar/issues/284)） | しない | `claude/*` or PR |

### D6. テンプレ二重化防止 — bundled と org `_template.yaml` の形を揃える

bundled テンプレ（`src/templates/routines/*.yaml.tmpl`）と org 配布の `.claude/routines/_template.yaml` の**形を揃える**。

- routine YAML の frontmatter / schedule / 手順ブロックの構造を 1 つの正規形に統一し、bundled と org template が drift しないようにする
- これは [ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) で workflow テンプレが（type × agent × cadence × max-items）の組み合わせ爆発を抱えた教訓を踏まえ、routine では正規形 1 本に寄せる方針
- パス・形式の統一（旧 `claude/routines/*.md` → `.claude/routines/*.yaml`）は破壊的変更として [#281](https://github.com/ozzy-labs/feedradar/issues/281) で実施する

### D7. 並行実行レース運用注意（GHA `concurrency:` 相当が無い）

routine には GHA の `concurrency:` group 相当が無い。よって:

- **routine 同士 / routine ＋ GHA workflow を同一 workspace（同一 branch）に向けない**ことをテンプレ・docs に明記する
- routine の出力ゲートが `claude/*` か PR（D3a）に限定されているため、複数 routine が同時に main へ push し合うレースは構造的に発生しにくいが、`claude/*` ブランチや items/state の commit 競合は起こり得る
- [ADR-0019](./0019-host-agent-execution-mode.md) の「prepare→commit 間に同一 workspace の cron を重ねない」運用注意を routine でも継承する（`researching` ロック status は追加しない、ADR-0019 / [ADR-0008](./0008-status-state-machine.md)）

### D8. Web UI Prompt の貼り付けモード — `--prompt-mode inline | bootstrap`（bootstrap は opt-in）

routine の正本 YAML は宣言的 apply API を持たず、ユーザーが Web UI の各欄に手で貼る前提（D1）。なかでも `instructions:`（Web UI の Prompt 欄）はフルブロック（pipeline で ~220 行）であり、`instructions:` を更新するたびに **Web UI へ再貼り付け**する運用摩擦がある（[#327](https://github.com/ozzy-labs/feedradar/issues/327)）。

`radar routine generate <type>` に `--prompt-mode inline | bootstrap`（既定 `inline`、`watch` / `pipeline` 共通）を追加し、**Web UI の Prompt 欄に何を貼るか**だけを切り替えられるようにする:

- `inline`（既定・現状維持）: 生成完了時の案内が「`yq -r '.instructions'` でフル instructions を抽出して Prompt 欄に貼れ」。Web UI の Prompt 単体で自己完結する。
- `bootstrap`（opt-in）: 生成完了時の案内が、短い bootstrap 文（「あなたは `<name>` routine。リポジトリの `.claude/routines/<name>.yaml` を読み、その top-level `instructions:` ブロックを忠実に実行せよ。autonomous・AskUserQuestion 不可・MCP 不可」）を貼れ、に変わる。実行時にルーティン自身が正本 YAML を読むため、`instructions:` の更新は **リポへのコミットだけで自動追随**し Web UI 再貼り付けが不要になる。

重要な不変条件: **どちらのモードでも生成 YAML の `instructions:` ブロックはそのまま残す**（実行時の正本）。`--prompt-mode` が変えるのは生成完了時の stdout 案内（どの文字列を Web UI に貼るか）だけであり、ファイルの中身・安全策（D3a〜D3e）には一切影響しない。

トレードオフと既定の根拠:

- bootstrap だと Web UI 上の Prompt が「YAML を読め」だけになり、**routine が何をするか一見で分からない**（self-contained 性が下がる ＝ 本 ADR の「prompt 単体で自己完結」方針と一部相反する）。
- モデルが正本 YAML の `instructions:` ブロックを読んで follow する前提で、instructions-as-prompt より僅かに間接的（end-to-end の動作は実証済みだが直接性は劣る）。
- 以上より、**既定は `inline`（現状維持）・bootstrap は明示 opt-in** とする。bootstrap を選ぶかは「再貼り付け摩擦の削減」と「Prompt 欄の self-contained 性」のどちらを取るかのユーザー判断に委ねる。

### triage 自セッション入口の payload / commit 契約

triage には自セッション入口が無い（spawn 専用、[ADR-0018](./0018-triage-extension.md)）。routine の `pipeline` type が triage を自セッションで回すには、research / review と同型の prepare / commit 2-call を triage にも新設する（[#279](https://github.com/ozzy-labs/feedradar/issues/279)）。ただし triage は **per-item の `TriageDecision` を書く別形**であり、research のレポートファイル契約とは異なるため、本 ADR で形を確定させる:

1. **`radar triage --emit-payload`**（prepare）
   - triage 対象 item をロードし、`<untrusted_item>...</untrusted_item>`（M1c）でラップした item ブロックと `<policy>...</policy>`（[ADR-0018](./0018-triage-extension.md) W-A）でラップした per-source `triagePolicy:` を含む payload を **stdout に出力**する。**agent は spawn しない。**
   - `--max-items N` の cap はこの prepare 段で適用し、payload に含める item 数を縛る（D3e）
   - item の status は変えない（triage 結果は commit 段で初めて反映）
2. routine の自セッションが payload の手順に従い、4 つの triage decision（`research` / `digest` / `dismiss` / `unsure`、[ADR-0018](./0018-triage-extension.md)）を per-item で判定する。
3. **`radar triage --commit <path>`**（commit）
   - 判定結果（per-item `TriageDecision`）を検証し、`items/<id>.yaml` の `triage:` ブロックに書き込み、status を遷移させる（`detected → triaged_research / triaged_digest / triaged_unsure / dismissed`、[ADR-0018](./0018-triage-extension.md) W-B）。検証失敗時はロールバックして非ゼロ終了。

研究レポートと異なり**レポートファイルが無い別形**であるため:

- research の `--commit <outputPath>`（Markdown ファイルを検証）と違い、triage の `--commit` は **per-item decision の構造化データ**（JSON / YAML フェンス）を検証する
- spawn パスの triage decision validate（[ADR-0018](./0018-triage-extension.md) PR-2 で実装済み）と **同一の検証ロジックを共有**し、spawn / 自セッションの finalize 挙動を drift させない（[ADR-0019](./0019-host-agent-execution-mode.md) の `finalizeResearch()` 共有と同型）
- payload フェンスは spawn の stdin contract（triage `#273` の stdin payload）とスキーマ互換に保つ

実装の詳細（フェンス構造・decision の正本をどのフィールドに置くか）は [#279](https://github.com/ozzy-labs/feedradar/issues/279) で確定する。本 ADR は「triage も research / review と同型の prepare / commit を持つ」「ただしレポートファイルが無い別形である」という契約の骨子のみを固定する。

## Consequences

### 良い面

- **routine から無人パイプラインが回せる** — ADR-0019 の「対話専用」制約を routine 向けに carve-out したことで、routine の 1 セッションで watch → triage → research → review を完結できる
- **追加 API キー不要** — routine はサブスク枠で完結し、別 agent を spawn しないため認証経路が 1 本に保たれる（[ADR-0004](./0004-schedule-strategy.md) OAuth 禁止方針とも整合）
- **環境別の方式分離が明確** — GHA = spawn + API キー / routine = 自セッションが対表として固定され、agent / type を増やしてもこの分岐を蒸し返さない
- **出力ゲートで blast radius を抑える** — PR / `claude/*` 限定・自動マージ禁止・connector なし・通信先限定により、prompt injection が成立しても無レビューで main に変更が入らない
- **件数上限がフラグで担保** — 指示文の裁量でなく CLI 層（`--max-items` / `--limit`）が決定論的に縛るため、injection で上限を外せない

### 悪い面・制約

- **routine では別 AI による review が失われる** — Claude 単独のため、GHA の cross-agent review に相当する独立観点が無い。type 名（`pipeline`）でこれを誤認させない（D5）が、品質面の制約は残る
- **自セッション処理は 1 件ずつ** — `--emit-payload` が `--batch` 非両立のため、件数が多いと 1 routine 実行で処理しきれず次回に持ち越す（D3e の cap と相まって意図的に総量を絞る）
- **並行レース運用注意** — `concurrency:` 相当が無いため、routine 同士 / routine ＋ GHA を同一 workspace に向けない運用注意が必要（D7）
- **正本→Web UI 手適用の手間** — 宣言的流し込み API が無いため、生成した正本をユーザーが Web UI に手で反映する 1 ステップが残る。`--prompt-mode bootstrap`（D8）でこの再貼り付け摩擦は軽減できるが、その代わり Web UI 上の Prompt 欄から routine の挙動が一見で読み取れなくなる（self-contained 性が下がる）トレードオフを負う。bootstrap は opt-in に留め、既定は self-contained な `inline` を維持する
- **triage 自セッション入口の新設コスト** — research / review と別形の prepare / commit を triage に足す実装が前提（[#279](https://github.com/ozzy-labs/feedradar/issues/279)）

### 中立

- `radar routine generate` は `radar workflow generate`（GHA）と対等な namespace として並ぶ。内部テンプレエンジンは workflow generate と共有可能
- routine YAML の正規形は bundled / org template で 1 本に揃える（D6）。形式・パスの統一は破壊的変更として [#281](https://github.com/ozzy-labs/feedradar/issues/281) で実施
- 本 ADR は [ADR-0019](./0019-host-agent-execution-mode.md) を**改訂しない**。ADR-0019 の「対話専用・headless 無効」は対話セッションに対する制約として有効なまま、routine 環境を carve-out として本 ADR で別途規定する

#### ADR-0019 carve-out の根拠（routine は影響範囲を構造的に抑えられる）

ADR-0019 が host モードを「対話専用・CI/headless 無効」とした根拠は、対話セッションが**広い tool 権限・ローカル standing approval を持つ**ため blast radius が大きいことだった。routine はこの前提が当てはまらず、影響範囲を構造的に抑えられるため carve-out できる:

- **使い捨て VM・fresh clone** — routine はクラウドの使い捨て VM で fresh clone され、対話セッションのような永続的なローカル環境・蓄積された権限を持たない
- **ローカル standing approval が無い** — 対話で対話的に積み上がる tool 承認が存在しない。routine の能力は生成時に宣言された範囲に固定される
- **connector なし・通信先最小化** — D3b / D3c により外部連携・任意 URL fetch を断つ
- **出力ゲートで無レビュー反映を遮断** — D3a により PR / `claude/*` 限定・自動マージ禁止
- **件数上限のフラグ担保** — D3e により 1 実行の総量が決定論的に縛られる

これらにより、routine の自セッション処理は「対話セッションの host モード」より blast radius が小さく、ADR-0019 が懸念した posture の差を別の防御層で埋められる。よって routine 向けに自セッション処理を解禁する。

## Alternatives

### 案 A: routine でも spawn する（GHA と同じ方式） — 却下

routine 内で API キーを持ち込み `--agent <id>` で別 agent を spawn する案。却下理由:

- routine はサブスク枠 1 セッションが前提で、別プロセスの agent CLI を spawn するとサブスク枠とは別のコスト・認証経路（API キー）を要する
- [ADR-0004](./0004-schedule-strategy.md) の「routine はサブスク枠で完結」という前提と矛盾し、二重課金・二重クォータ消費（[ADR-0019](./0019-host-agent-execution-mode.md) §Context が指摘した摩擦）を routine に持ち込む
- → routine は自セッション完結（D2）に統一する

### 案 B: ADR-0019 をそのまま適用し routine では自セッション処理を禁止 — 却下

ADR-0019 の「対話専用・headless 無効」を routine にも厳格適用する案。却下理由:

- routine では spawn もできない（案 A 却下）ため、自セッション処理も禁止すると **routine から無人パイプラインを回す経路が完全に消える**
- routine は対話セッションと posture が違う（使い捨て VM・fresh clone・standing approval 無し・connector/network 最小化）ため、ADR-0019 の懸念をそのまま当てはめるのは過剰。別防御層（D3a〜D3e）で blast radius を抑えられる
- → routine 向けに carve-out（§Consequences 末尾の根拠）して自セッション処理を解禁する

### 案 C: type 名を GHA と揃える（`combined-with-triage`） — 却下

routine の フルパイプライン type 名を GHA と同じ `combined-with-triage` にする案。却下理由:

- GHA 版は spawn による別 AI review を含み得るが、routine は Claude 単独で別 AI review が構造的に無い。同名は「GHA と対等な review 品質」と誤認させる
- → `pipeline` 等、単一 Claude の自セッションパイプラインであることを表す名前にする（D5）

### 案 D: 件数上限を routine instruction（自然言語）で指定 — 却下

「重要なものだけ N 件 research して」と routine の指示文に書く案。却下理由:

- untrusted content の prompt injection が成立すると、自然言語の上限指示は無視され得る（[ADR-0009](./0009-untrusted-external-content-handling.md)）
- 上限は決定論的に効く必要があり、CLI フラグ（`--max-items` / `--limit`）でのみ担保する（D3e）
- → [ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) D3c（YAML literal 化で「読めば上限が明らか」「編集しない限り外れない」）と同じ思想を routine にも適用する

## 関連

- 親 epic: [#277](https://github.com/ozzy-labs/feedradar/issues/277) feat: Claude Routines 対応（routine generate / 自セッション完結パイプライン）
- 本 ADR: [#278](https://github.com/ozzy-labs/feedradar/issues/278) docs(adr): ADR-0020 生成方針
- 後続 sub-issue:
  - [#279](https://github.com/ozzy-labs/feedradar/issues/279) triage に自セッション入口（`--emit-payload` / `--commit`）
  - [#280](https://github.com/ozzy-labs/feedradar/issues/280) `radar routine generate watch` ＋ 1h cron 検証 ＋ validate
  - [#284](https://github.com/ozzy-labs/feedradar/issues/284) フルパイプライン routine テンプレ（自セッション・件数上限）
  - [#281](https://github.com/ozzy-labs/feedradar/issues/281) routine 形式を YAML 統一・`.claude/routines/` にパス修正（破壊的）
  - [#282](https://github.com/ozzy-labs/feedradar/issues/282) `/fire`（外部からの起動）連携
  - [#283](https://github.com/ozzy-labs/feedradar/issues/283) routine workflow のドキュメント整備
- 関連 ADR:
  - [ADR-0004 Schedule Strategy](./0004-schedule-strategy.md) — `init --with-routines` の起点。routine はサブスク枠で完結・fresh clone 前提・OAuth 禁止。本 ADR で出力形式・パスを `.claude/routines/*.yaml` へ寄せる
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) — M1c 境界マーカー / M2a / M2b / M3b self-check guidance を routine の自セッション実行時にも継続適用。D5b host allowlist で通信先を購読フィードに限定
  - [ADR-0014 Workflow Generate と自動 research セーフティ](./0014-workflow-generate-and-auto-research-safety.md) — GHA = spawn + API キーの対表。件数上限を literal 化で担保する思想（D3）を routine にも継承
  - [ADR-0018 LLM-based Triage Extension](./0018-triage-extension.md) — triage の `--max-items` / `<policy>` boundary / per-item `TriageDecision`。triage 自セッション入口の payload / commit 契約の前提
  - [ADR-0019 Host-agent Execution Mode](./0019-host-agent-execution-mode.md) — 自セッション処理（`--emit-payload` / `--commit`）の元設計。本 ADR はその「対話専用」制約を routine 向けに carve-out する
- 関連 docs:
  - [`docs/user-guide.md`](../user-guide.md) — routine workflow セクションを [#283](https://github.com/ozzy-labs/feedradar/issues/283) で追加予定
