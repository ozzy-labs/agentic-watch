# ADR-0004: Schedule Strategy

## Status

Accepted（2026-05-11）

## Context

FeedRadar は手動実行（`radar watch run`）が必須要件だが、**定期実行**も想定される。Claude Code 系では複数の選択肢があり、認証ポリシー・実行環境・実行間隔の制約が異なる。

詳細な比較表は ozzy-labs 内 knowledge MCP の [`ai/practice/scheduled-tasks`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/scheduled-tasks.md) を参照。

## Decision

`radar` 本体は **schedule 機構を内蔵せず**、外部 scheduler への接続点だけを `init` で生成する。

| 用途 | 推奨 | `init` で生成 |
|---|---|---|
| 手動実行 | `radar watch run` | （CLI 自体） |
| クラウド定期実行 | **GitHub Actions** + `ANTHROPIC_API_KEY` 等の API キー認証 | `.github/workflows/watch.yaml` |
| ローカル PC 定期 | Claude Routines（クラウド側）or Desktop scheduled tasks | `.claude/routines/watch-daily.yaml`（`--with-routines` 指定時） |

### 認証ポリシー（重要）

CI 自動化では **`ANTHROPIC_API_KEY` 等の API キー**を使う。OAuth トークン（`CLAUDE_CODE_OAUTH_TOKEN`）は技術的に動くが、Anthropic の利用ポリシー上 "ordinary individual use" の範囲外。違反リスクと個人アカウント枠の浪費の両方を避ける。

### `init --with-routines` の挙動

Claude Routines 用 routine 定義 `.claude/routines/watch-daily.yaml` を生成。Routines はクラウド VM で fresh clone するため、user data はリポにコミット済みである必要がある。生成テンプレートに「sources/ items/ state/ を commit すること」の注記を含める。

> **2026-05-24 追補（#281, ADR-0020 連動・破壊的変更）**: 出力先・形式を変更した。
>
> | | 旧（〜#280） | 新（#281〜） |
> |---|---|---|
> | 出力先 | `claude/routines/watch-daily.md`（ドット無し） | `.claude/routines/watch-daily.yaml`（ドット有り） |
> | 形式 | Markdown frontmatter | YAML（Web UI フォームと 1:1） |
>
> 変更理由は 2 点。(1) ドット有り `.claude/` は org 規約のディレクトリ（`.claude/skills/` 等と整合）。(2) `radar routine generate watch`（#280, ADR-0020）が出力する `.claude/routines/*.yaml` と形式・出力先を統一し、`init` の静的雛形とジェネレーターの出力を 1 つの正本形式に揃える。バンドル元テンプレートは `src/templates/routines/watch-daily.yaml`。
>
> **移行**: 旧 `claude/routines/watch-daily.md` を手動利用していた場合、`radar init --with-routines` を再実行して新 `.claude/routines/watch-daily.yaml` を取得し、旧ファイルは削除する。`radar routine generate watch` でパラメータ化した variant を生成してもよい。

### `init --with-actions` の挙動

GitHub Actions workflow 雛形 `.github/workflows/watch.yaml` を生成。

- `schedule.cron: "0 0 * * *"` を初期値とし、ユーザーが必要に応じて編集
- `workflow_dispatch` も含め、cron を待たずに手動検証できる
- `permissions: contents: write` + 最終ステップで `items/` / `state/` を commit + push（Routines と同じく fresh clone 前提のため state を git に残す必要がある）
- `ANTHROPIC_API_KEY` を `secrets` から env として渡す
- GitHub Releases adapter 用に `secrets.GITHUB_TOKEN` も `GITHUB_TOKEN` env として forward（rate limit を 60 → 5000 req/h に引き上げる、ADR-0002）
- `concurrency.cancel-in-progress: false` で overlapping cron firing が partial commit を中断しないようにする

### 既存ファイル保護

`--with-routines` / `--with-actions` で生成されるファイルは bundled skills と同じ「既存ファイルは warning + skip、`--force` で上書き」プロトコルに従う。手動編集した routine / workflow が CLI 再実行で消えることはない。

### 対象外

- `/loop`: セッションスコープ、7 日失効。長期 cron には不適
- Desktop scheduled tasks: アプリ起動中限定。雛形提供は将来検討

## Consequences

### 良い面

- スケジューラーの選択をユーザーに委ねられる（クラウド使うか、ローカルで完結させるか）
- FeedRadar コア実装が小さく保たれる
- `init` で雛形を吐くため、ユーザーは選んだ scheduler の boilerplate を毎回書く必要がない

### 悪い面 / 制約

- 雛形が古くなった場合の更新方法が暗黙（commons / handbook の改訂を反映するルートが要る）
- GitHub Actions と Routines で **使用する認証方式が異なる**ことをユーザーが理解する必要がある

### 中立

- 将来 self-hosted scheduler（OpenAI Workspace agents 等）対応の要望が出たら、`init` のテンプレ追加で対応可能

## Alternatives

### 案 A: FeedRadar 自体に内蔵 daemon（cron 風）

- 却下理由: ユーザーの PC が常時起動している前提を強制してしまう。既存 scheduler（GitHub Actions / Routines / cron）を活用するほうが筋

### 案 B: GitHub Actions のみサポート

- 却下理由: ローカル完結したいユーザー（API キーを Actions に置きたくない等）を排除してしまう

## 関連

- knowledge: [`ai/practice/scheduled-tasks`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/scheduled-tasks.md)
- Phase 4 で `init --with-routines` / `init --with-actions` を実装 (#27 / #39)
- 後追い生成・複数 workflow 共存・自動 research セーフティは [ADR-0014](./0014-workflow-generate-and-auto-research-safety.md) を参照（本 ADR の拡張）
- Claude Routines の生成方針（`radar routine generate`・自セッション完結・spawn しない原則）は [ADR-0020](./0020-claude-routines-generation.md) を参照（本 ADR の `init --with-routines` を後追い生成・YAML 統一へ拡張）
