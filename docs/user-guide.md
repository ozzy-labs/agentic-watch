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

`--with-routines` を指定すると `claude/routines/watch-daily.md` も生成（**Phase 5 で実装予定**。Phase 1 では `--with-routines` を渡すと warning を表示してスキップする）。

#### Phase 1 時点の挙動

- `sources/` `state/` `items/` `research/` `templates/` を作成（既存ディレクトリは温存）
- `.agents/skills/{research,review,update}/SKILL.md` を **bundled SKILL.md** からコピー（review / update は Phase 1 では stub プロンプト、本文は Phase 2/4 で確定）
- 既存ファイルは warning + skip で保護。`--force` で上書き
- Claude Code 側 (`.claude/skills/`) への配置は本 Phase では行わない（`@ozzylabs/skills` Renovate preset との衝突回避）

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

すべての source（または `--source` で指定）を fetch、filter を適用、新規 item を `items/<sourceId>/<item-id>.yaml` に追加。

| オプション | 説明 |
|---|---|
| `--source <id>` | 単一 source のみ fetch する。未指定なら `sources/*.yaml` 全件 |
| `--bootstrap` | 既存記事を全て **検出済み (seen)** として state に取り込み、items は作らない。初回導入時のノイズ抑制用 |

挙動:

- 各 source の `kind` に応じた feed adapter（Phase 1 では `rss` のみ）を呼び出す
- adapter は `If-None-Match` ヘッダ（前回 `lastEtag`）を付けて GET し、サーバが `304 Not Modified` を返した場合は items 処理をスキップしつつ `lastFetchedAt` のみ更新する
- fetch した item に [filter](./design/filter-spec.md) を適用し、`lastSeenIds` に無いもののみを `items/<sourceId>/` に書き出す（`status: detected`、`matchedKeywords` 付き）
- 実行後 `state/<sourceId>.yaml` の `lastFetchedAt` / `lastEtag` / `lastSeenIds` が更新される
- 一部 source で失敗した場合でも他 source は続行し、exit code は `1` を返す（CI で検知可能）
- Phase 1 では `kind: rss` のみ対応。他 kind の source は warning を出してスキップする

### `agentic-watch research <item-id> [--agent <agent-id>] [--template <id>]`

指定 item に対して、指定 agent で調査レポートを生成。

| 引数 | 説明 |
|---|---|
| `<item-id>` | `items/<sourceId>/*.yaml` の `id` フィールド。形式は `<title-slug>-<8 hex>`（例: `claude-code-releases-agents-438eddad`）。元のフィード GUID は `items/<sourceId>/<item-id>.yaml` の `raw` 内に保持される |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（既定: `claude-code`） |
| `--template` | テンプレ id（既定: `default`、`templates/<id>.md` を参照） |

挙動:

- `items/<sourceId>/<item-id>.yaml` を読み込み、`agent` adapter に渡す
- adapter は `<agent> -p "<prompt>"` を子プロセスで起動し、`.agents/skills/research/SKILL.md` を実行する
- adapter が `research/<YYYYMMDD>_<slug>_v1.md` を書き出す
- CLI 側で frontmatter を `ResearchFrontmatter` schema で検証する。違反時は exit code 1
- 検証が通れば `items/<sourceId>/<item-id>.yaml` の `status` を `researched` に遷移
- 既存ファイルが既にある場合は上書きせずエラー終了する（再実行は `agentic-watch update` 経由）

出力: `research/<YYYYMMDD>_<slug>_v1.md`。命名規則とフォーマットは [ADR-0003](./adr/0003-output-format-and-versioning.md)。`reviewedAt` / `reviewedBy` は **常に `null`** で書き出される（`agentic-watch review` で書き換わる）。

Phase 1 では agent は `claude-code` のみ対応。Phase 2 で 4 agent 対応。`templates/default.md` が存在しない場合は SKILL に同梱された既定構造でレポートが生成される。

### `agentic-watch review <research-id> --agent <agent-id>`

既存 research に対し、指定 agent でレビューを生成。**更新先は 2 箇所**:

| 更新先 | 内容 |
|---|---|
| `items/<item-id>.yaml` | `status: researched → reviewed` |
| `research/<id>.md` frontmatter | `reviewedAt` / `reviewedBy` |
| `research/<id>.md` 本文末尾 | レビューコメント本文 |

両者は同一コマンド内でアトミックに更新される（部分失敗時はロールバック）。詳細は [ADR-0003](./adr/0003-output-format-and-versioning.md) / [ADR-0008](./adr/0008-status-state-machine.md)。

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

CLI 側で agent の組合せを強制はしない（ユーザー判断）。`radar.config.yaml` で default agent を指定すれば、`--agent` を毎回付けずに済む（[後述](#radarconfigyaml)）。

### `agentic-watch update <research-id> --agent <agent-id>`

既存 research を最新情報で再生成。新バージョン (`_v2.md`, `_v3.md`, …) を作成し、旧バージョンは保持（immutable history）。

## radar.config.yaml

ワークスペースルート（`sources/` と同じ階層）に `radar.config.yaml` を置くと、`research` / `review` コマンドの `--agent` 省略時に使う default agent を指定できる。設定ファイルは任意で、無ければハードコードされた `claude-code` がそのまま fallback として使われる。

例:

```yaml
# radar.config.yaml
defaultResearchAgent: codex-cli
defaultReviewAgent: claude-code
```

### 設定可能フィールド

| フィールド | 対応コマンド | 値 |
|---|---|---|
| `defaultResearchAgent` | `agentic-watch research` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot` |
| `defaultReviewAgent` | `agentic-watch review` | 同上 |

両フィールドとも optional。未指定のフィールドはハードコード default にフォールバックする。

### Agent 解決の優先順位

`research` / `review` コマンドが起動時に使う agent は、以下の優先順位で決定する:

1. 明示 `--agent <id>` （CLI 引数）
2. `radar.config.yaml` の対応フィールド（`defaultResearchAgent` / `defaultReviewAgent`）
3. ハードコード default: `claude-code`

たとえば `defaultResearchAgent: codex-cli` を設定したワークスペースで:

```bash
agentic-watch research <item-id>                      # codex-cli が使われる (config)
agentic-watch research <item-id> --agent gemini-cli   # gemini-cli が使われる (明示優先)
```

### エラー時の挙動

`radar.config.yaml` が schema 違反（未知の agent id、不正な YAML 構文など）の場合、`research` / `review` は exit code `2` で終了し、違反箇所を stderr に出力する。typo を黙ってフォールバックで隠さないための仕様。

### スコープ外

- `update` コマンドの default agent: Phase 5 で `update` コマンド本体を実装する際に追加
- agent 固有の設定（timeout / API key / モデル指定など）: 必要が出てから別 issue で追加

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
