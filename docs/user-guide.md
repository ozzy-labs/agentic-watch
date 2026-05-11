# User Guide

> **Status**: alpha — Phase 1 実装中。各コマンドは段階的に有効化される。
> 本ドキュメントは Phase 1 完了時点の仕様を先取りして記述しており、Phase 0 時点では一部のサブコマンドが `not implemented yet (Phase 1)` を返す。

## インストール

```bash
pnpm add -g @ozzylabs/agentic-watch
# または
npx @ozzylabs/agentic-watch <command>
```

要件:

- Node.js 22+
- pnpm（globally install する場合）
- 監視対象に応じてネットワーク到達性

エージェント CLI（Claude Code / Codex CLI / Gemini CLI / Copilot CLI）は **ユーザー側で別途インストール・認証**しておく必要がある。`agentic-watch` 自体はこれらの CLI を子プロセスとして起動する。

## クイックスタート

```bash
mkdir my-watch && cd my-watch
agentic-watch init
agentic-watch source add anthropic-news --kind rss --url https://anthropic.com/news/rss.xml --keywords "Claude Code,agents"
agentic-watch watch run
agentic-watch research <item-id> --agent claude-code
```

## コマンド

### `agentic-watch init`

カレントディレクトリをワークスペースとして初期化する。

生成するもの:

```text
.
├── sources/             # サイト定義 (YAML)
├── state/               # 既読 ID / etag
├── items/               # 検出記事 (YAML)
├── research/            # 調査結果 (Markdown)
├── templates/           # 既定テンプレートのコピー
├── .agents/skills/      # research / review / update skill
└── .github/workflows/   # 定期実行ワークフロー（任意）
```

`--with-routines` を指定すると `claude/routines/watch-daily.md` も生成。

### `agentic-watch source add <id> --kind <kind> --url <url> [options]`

新規 source を `sources/<id>.yaml` に追加。

| 引数 | 説明 |
|---|---|
| `<id>` | source 識別子（slug） |
| `--kind` | `rss` / `html` / `github-releases` / `npm-registry` |
| `--url` | fetch 対象の URL |
| `--name` | 表示名（省略時は `<id>`） |
| `--tags` | カンマ区切りタグ |
| `--keywords` | カンマ区切り、ヒット対象キーワード |
| `--exclude-keywords` | カンマ区切り、除外キーワード |

### `agentic-watch source list [--enabled-only]`

`sources/*.yaml` を一覧表示。

### `agentic-watch source remove <id>`

`sources/<id>.yaml` を削除。`state/<id>.yaml` と紐づく `items/` は残す（履歴保持）。

### `agentic-watch watch run [--source <id>] [--bootstrap]`

すべての source（または `--source` で指定）を fetch、filter を適用、新規 item を `items/` に追加。

- `--bootstrap`: 既存記事を全て **検出済み (seen)** として state に取り込み、items は作らない。初回導入時のノイズ抑制用
- 実行後、`state/<id>.yaml` の `lastFetchedAt` / `lastEtag` / `lastSeenIds` が更新される

### `agentic-watch research <item-id> --agent <agent-id> [--template <id>]`

指定 item に対して、指定 agent で調査レポートを生成。

| 引数 | 説明 |
|---|---|
| `<item-id>` | `items/<id>.yaml` の id |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot` |
| `--template` | テンプレ id（既定: `default`） |

出力: `research/<YYYYMMDD>_<slug>_v1.md`。命名規則とフォーマットは [ADR-0003](./adr/0003-output-format-and-versioning.md)。

Phase 1 では agent は `claude-code` 固定。Phase 2 で 4 agent 対応。

### `agentic-watch review <research-id> --agent <agent-id>`

既存 research に対し、指定 agent でレビューを生成。`research/<id>.md` の frontmatter に `reviewedAt` / `reviewedBy` を追記し、レビューコメントを末尾に追加。

#### クロスエージェント運用（推奨）

research を書いた agent と**別の agent** で review を実行することを推奨する:

```bash
# 例: codex で書いて claude にレビューさせる
agentic-watch research <item-id> --agent codex-cli
agentic-watch review <research-id> --agent claude-code
```

なぜクロスチェック:

- 同一 agent の盲点（特定の情報源への偏り、用語の取りこぼし）を相互補正できる
- review が research と同じ思い込みを引きずらない
- 4 種類の agent プランを契約しているなら、利用枠を分散できる

CLI 側で agent の組合せを強制はしない（ユーザー判断）。Phase 1 で `radar.config.yaml` に default `researchAgent` / `reviewAgent` を指定する仕組みを入れる予定。

### `agentic-watch update <research-id> --agent <agent-id>`

既存 research を最新情報で再生成。新バージョン (`_v2.md`, `_v3.md`, …) を作成し、旧バージョンは保持（immutable history）。

## スケジュール実行

[ADR-0004](./adr/0004-schedule-strategy.md) を参照。`init` で生成されるワークフロー雛形は以下:

- `.github/workflows/watch.yaml` — GitHub Actions、API キー認証
- `claude/routines/watch-daily.md` — Claude Routines 用 routine（`--with-routines` 指定時）

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `not implemented yet (Phase 1)` | 該当コマンドは未実装。Phase 1 まで待つか、[Phase 1 epic](https://github.com/ozzy-labs/agentic-watch/issues?q=label%3Aphase-1) に貢献 |
| agent CLI が見つからない | `claude` / `codex` / `gemini` / `copilot` が `PATH` に存在し認証済みであることを確認 |
| OIDC 認証エラー（publish 時） | maintainer 向け。`standards/npm-trusted-publishers` を参照 |
