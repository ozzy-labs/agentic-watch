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

エージェント CLI は **ユーザー側で別途インストール・認証**しておく必要がある。`agentic-watch` 自体はこれらの CLI を子プロセスとして起動する。

### 対応 agent CLI 一覧

| `--agent` 値 | 実装状況 | 必要な CLI | 認証方法 | 起動コマンド（非対話） |
|---|---|---|---|---|
| `claude-code` | 実装済み | [Claude Code](https://docs.claude.com/en/docs/claude-code) | `claude` 内で対話ログイン | `claude -p "<prompt>" --output-format text --permission-mode bypassPermissions` |
| `codex-cli` | 実装済み | [Codex CLI](https://github.com/openai/codex) | `codex login` | `codex exec "<prompt>" --cd <workspace> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` |
| `gemini-cli` | 実装済み | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini` 内で対話ログイン（OAuth）または `GEMINI_API_KEY` 環境変数 | `gemini -p "<prompt>" -y --skip-trust --output-format text` |
| `copilot` | 実装済み | [GitHub Copilot CLI](https://docs.github.com/copilot/github-copilot-in-the-cli) | `copilot auth login` | `copilot -p "<prompt>" --allow-all-paths --allow-all-tools --no-color` |

Phase 2 で 4 agent 全てが本実装済み。

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
├── AGENTS.md            # Codex / Gemini / Copilot が auto-read する instructions
├── .agents/skills/      # engine SKILL (SSoT): research / review / update
├── .claude/skills/      # Claude Code slash-command 雛形 (薄い wrapper)
└── .github/workflows/   # 定期実行ワークフロー（任意）
```

`--with-routines` / `--with-actions` を指定すると、定期実行 scheduler への接続用雛形が追加で生成される（詳細は本ドキュメントの「[スケジュール実行](#スケジュール実行)」セクション）。

#### 挙動

- `sources/` `state/` `items/` `research/` `templates/` を作成（既存ディレクトリは温存）
- **engine SKILL** (`.agents/skills/{research,review,update}/SKILL.md`) を **bundled** からコピー。adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体
- **Claude Code slash-command 雛形** (`.claude/skills/{research,review,update,dismiss}/SKILL.md`) を bundled からコピー。Claude Code interactive で `/research` 等として発火する薄い wrapper (内部で `agentic-watch <subcommand>` を呼ぶだけ)。`--no-claude-skills` で skip 可
- **`AGENTS.md`** (workspace root) を bundled からコピー。Codex CLI / Gemini CLI / GitHub Copilot CLI が auto-read する agent-agnostic な instructions (workspace 概要、主要コマンド、典型ワークフロー、docs pointer)。`--no-agents-md` で skip 可
- 既存ファイルは warning + skip で保護。`--force` で上書き

#### AGENTS.md について

`init` は workspace の root に **`AGENTS.md`** (agent-agnostic instructions) を default で生成する。Codex CLI / Gemini CLI / GitHub Copilot CLI はこのファイルを auto-read するため、interactive session を開いた agent に workspace の文脈 (主要コマンド、典型ワークフロー、docs pointer) を即座に伝えられる ([ADR-0007 Revision 2026-05-17 b](./adr/0007-skill-bundling-and-init-distribution.md))。

| Agent | AGENTS.md auto-read |
|---|---|
| Claude Code | ❌ (`CLAUDE.md` 経由 — `CLAUDE.md` から `@AGENTS.md` で取り込むパターンが業界標準) |
| Codex CLI | ✅ (project root → CWD、`project_doc_max_bytes` 32 KiB 制限) |
| Gemini CLI | ✅ (project root、`.gemini/settings.json` の `context.fileName` でも追加可) |
| GitHub Copilot CLI | ✅ (repo root / CWD / `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) |

`--no-agents-md` を使うべきケース:

- workspace に既に独自の `AGENTS.md` (monorepo 全体の指示等) があり、agentic-watch の boilerplate と衝突させたくない
- `AGENTS.md` を別ツール (`@ozzylabs/skills` 等) で集中管理している

```bash
agentic-watch init --no-agents-md   # AGENTS.md 生成を skip
```

Claude Code と併用する場合、`CLAUDE.md` 側で AGENTS.md を取り込んで SSoT を維持するパターンが推奨:

```markdown
# CLAUDE.md

共通方針は @AGENTS.md を参照。以下は Claude Code 固有の設定。

## Claude Code 固有
...
```

#### Claude Code interactive での利用 (slash commands)

`init` で配置される slash commands:

| Slash | 動作 | 中身 |
|---|---|---|
| `/research <item-id> [--agent ...]` | research を実行 | `agentic-watch research $ARGUMENTS` を呼ぶ |
| `/review <research-id> [--agent ...]` | review を実行 | `agentic-watch review $ARGUMENTS` を呼ぶ |
| `/update <research-id> [--agent ...]` | v+1 を生成 | `agentic-watch update $ARGUMENTS` を呼ぶ |
| `/dismiss <item-id>` | item を dismiss | `agentic-watch dismiss $ARGUMENTS` を呼ぶ (LLM 不要) |

各 slash command は **薄い wrapper** で、研究 / レビュー / update / dismiss の procedure 本体は `.agents/skills/<name>/SKILL.md` (engine SKILL) を SSoT として参照する。

#### `--no-claude-skills` を使うべきケース

`@ozzylabs/skills` Renovate preset 等で `.claude/skills/` を集中管理している workspace では、`agentic-watch init --no-claude-skills` で discovery 層 (`.claude/skills/`) を skip すると preset 側との衝突 / 上書き競合を避けられる。engine SKILL (`.agents/skills/`) は SSoT として常に書かれる。

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

なお `sources/<id>.yaml` は **`trustLevel: "trusted" | "untrusted"`** フィールドも持つ（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M4）。default は `"untrusted"` で、`source add` で生成される YAML には `trustLevel: untrusted` が書き出される。`"trusted"` への opt-in は YAML を手で編集する（CLI flag は提供しない。後述「[trustLevel: 信頼境界の opt-in](#trustlevel-信頼境界の-opt-in)」を参照）。

#### `--kind github-releases`

GitHub の Releases API (`GET /repos/<owner>/<repo>/releases`) からリリースを取得する。

```bash
# 例: anthropic-sdk-python の releases を監視する
agentic-watch source add anthropic-sdk \
  --kind github-releases \
  --url https://github.com/anthropics/anthropic-sdk-python
```

`--url` は以下のいずれの形式でも受け付ける（`<owner>/<repo>` を抽出する）:

- `https://github.com/<owner>/<repo>`
- `https://github.com/<owner>/<repo>.git`
- `https://github.com/<owner>/<repo>/tree/<branch>` 等の末尾パスは無視される
- `<owner>/<repo>` ショートハンド

正規化マッピング:

| Item フィールド | GitHub Release フィールド |
|---|---|
| `title` | `name`（空なら `tag_name` にフォールバック） |
| `url` | `html_url` |
| `summary` | `body` |
| `publishedAt` | `published_at`（なければ `created_at`） |
| `id` | `<title-slug>-<8 hex of sha256(<tag_name>#<release.id>)>`（[ADR-0002](./adr/0002-source-adapter-plugin-pattern.md)） |
| `raw` | API レスポンス全体 |

`tag_name` と GitHub 側 `release.id` を組み合わせて stable id を作るため、再タグ付け（`tag_name` 変化・`release.id` 不変）と削除→再作成（`tag_name` 不変・`release.id` 変化）のどちらでも別 item として検出される。

##### `GITHUB_TOKEN` で rate limit を上げる

GitHub Releases API は環境変数 `GITHUB_TOKEN` で認証する:

| 認証状態 | rate limit |
|---|---|
| 認証なし | 60 req/h（IP 単位） |
| 認証あり (`GITHUB_TOKEN`) | 5000 req/h |

設定例 (bash / zsh):

```bash
# Personal Access Token (classic) または Fine-grained PAT を発行し、
# `repo` 権限（public のみなら不要）を付与する
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
agentic-watch watch run --source anthropic-sdk
```

GitHub Actions 上では自動注入される `GITHUB_TOKEN` (`secrets.GITHUB_TOKEN`) をそのまま使える。

残量が 10 req を下回ると stderr に warning が出る:

```text
github-releases: rate limit low (5/60 remaining) for anthropics/anthropic-sdk-python (resets at 2026-05-12T13:00:00.000Z). Set GITHUB_TOKEN to raise the quota from 60 to 5000 req/h.
```

quota 枯渇時 (HTTP 403 + `X-RateLimit-Remaining: 0`) は user-friendly なエラーで終了する:

```text
github-releases adapter: rate limit exhausted for anthropics/anthropic-sdk-python (resets at 2026-05-12T13:00:00.000Z). Set GITHUB_TOKEN to raise the quota from 60 to 5000 req/h.
```

##### スコープ外（現時点）

- `prerelease` / `draft` のフィルタ（必要なら filter 設計拡張で対応予定）
- GitHub Tags / Commits 監視（別 source kind で将来検討）
- GitHub Enterprise (self-hosted) URL（public github.com のみ対応）

#### `--kind html`

任意の HTML ページから CSS セレクタで item 一覧を抽出する。RSS が無いブログや変更履歴ページ向け。

```bash
agentic-watch source add anthropic-changelog \
  --kind html \
  --url https://docs.anthropic.com/changelog \
  --selector-item "article.changelog-entry" \
  --selector-title "h2" \
  --selector-link "h2 a" \
  --selector-summary "p.summary" \
  --selector-publishedAt "time"
```

`--selector-<field>` フラグでセレクタを指定する:

| フィールド | 必須 | 説明 |
|---|---|---|
| `item` | ✅ | 各 item を囲む親要素のセレクタ。例: `article.post` |
| `title` | ✅ | item 内の title 要素 |
| `link` | ✅ | item 内の link 要素。`<a href>` を優先、なければ text を URL として扱う |
| `summary` | | 概要要素（任意） |
| `publishedAt` | | 公開日時要素（任意）。`<time datetime>` / `<meta content>` を優先、フォールバックで text |
| `body` | | 本文要素（任意）。Item.raw に保存される |
| `tags` | | タグ要素のセレクタ（任意）。複数一致を配列として収集する |

挙動の要点:

- 相対リンク (`href="/path"`) は source の `--url` を base として解決される
- `Item.id` は `<title-slug>-<8 hex>`（ADR-0002 の id 派生コントラクト、stableKey は url）
- ETag を返すサーバには `If-None-Match` で条件付き GET。返さないサーバには body の sha256 を `state.lastEtag` slot に `sha256:` プレフィックス付きで保存し、次回の dedup に使う
- title / link が解決できない item は silent drop（RSS adapter 同様の fail-soft）

詳細な設計判断 (parser 選定、selector contract) は [`docs/design/source-html.md`](./design/source-html.md) を参照。

#### `--kind npm-registry`

npm パッケージの新バージョン公開を監視する。`registry.npmjs.org/<package>` の packument を取得し、`versions` を Item として正規化する（認証不要 / rate limit 1000 req/h 程度）。

`--url` には次のどちらの形式も指定できる:

- パッケージ名そのまま: `@anthropic-ai/sdk` / `react`
- 公開 URL: `https://www.npmjs.com/package/<package>`（`/v/<version>` 付きも可）

例:

```bash
agentic-watch source add anthropic-sdk-js --kind npm-registry --url @anthropic-ai/sdk
```

挙動の要点:

- 1 バージョン = 1 Item。`Item.id` は `<package-slug>-<version-slug>-<8 hex>`（ADR-0002 の id 派生コントラクト）
- `Item.title` = `<package>@<version>`、`Item.url` = `https://www.npmjs.com/package/<package>/v/<version>`
- `Item.publishedAt` = packument の `time[<version>]`
- ETag-based 条件付き GET をサポート。サーバが `304` を返すと items 処理をスキップ
- 既知バージョンは state の `lastSeenIds` で除外されるため、2 回目以降は新バージョンのみ検出される

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

- 各 source の `kind` に応じた feed adapter を呼び出す（4 種すべて `rss` / `html` / `github-releases` / `npm-registry` が実装済み）
- adapter は `If-None-Match` ヘッダ（前回 `lastEtag`）を付けて GET し、サーバが `304 Not Modified` を返した場合は items 処理をスキップしつつ `lastFetchedAt` のみ更新する
- fetch した item に [filter](./design/filter-spec.md) を適用し、`lastSeenIds` に無いもののみを `items/<sourceId>/` に書き出す（`status: detected`、`matchedKeywords` 付き）
- 実行後 `state/<sourceId>.yaml` の `lastFetchedAt` / `lastEtag` / `lastSeenIds` が更新される
- 一部 source で失敗した場合でも他 source は続行し、exit code は `1` を返す（CI で検知可能）

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

Phase 2 で 4 agent (`claude-code` / `codex-cli` / `gemini-cli` / `copilot`) 全てが利用可能になった (#19, #44, #45, #32 本 PR, #46)。`templates/default.md` が存在しない場合は SKILL に同梱された既定構造でレポートが生成される。

Codex CLI は非対話モード `codex exec "<prompt>" --cd <workspace>` で起動する。`--skip-git-repo-check` と `--dangerously-bypass-approvals-and-sandbox` が必須（unattended 実行のため。Claude Code の `--permission-mode bypassPermissions` 相当）。stdin に JSON で構造化入力を渡し、`outputPath` への書き込みは agent に委ねる（[ADR-0001](./adr/0001-agent-adapter-interface.md)）。Codex CLI が未認証の場合 `codex login` の実行を案内する user-friendly エラーになる。

Gemini CLI は非対話モード `gemini -p "<prompt>" -y --skip-trust` で起動する (`-y` は YOLO mode で承認をスキップ、`--skip-trust` は folder trust チェックを bypass。Claude Code の `--permission-mode bypassPermissions` 相当)。`--skip-trust` は他 3 adapter (`claude-code` / `codex-cli` / `copilot`) と同じ「全権モード起動」の整合性回復であり、新たな権限付与ではない (folder trust は Gemini CLI 側の UI 制約)。stdin に JSON で構造化入力を渡し、`outputPath` への書き込みは agent に委ねる ([ADR-0001](./adr/0001-agent-adapter-interface.md))。Gemini CLI が未認証の場合 `gemini` を対話起動して OAuth するか、`GEMINI_API_KEY` を設定するよう案内する user-friendly エラーになる。

### `agentic-watch dismiss <item-id>`

検出 (`detected`) 状態の item を `dismissed`（terminal）に遷移させる。research しないと決めた item を `items/<sourceId>/<item-id>.yaml` から取り除かずに状態だけで除外する用途で使う ([ADR-0008](./adr/0008-status-state-machine.md))。

| 引数 | 説明 |
|---|---|
| `<item-id>` | `items/<sourceId>/*.yaml` の `id` フィールド |

挙動:

- 対象 item を `items/` 配下から探索し、`status` を `detected → dismissed` に更新する
- `status` が `detected` 以外（`researched` / `reviewed` / `dismissed`）の item に対してはエラーで終了する（dismiss は detected からのみ有効。ADR-0008）
- item が見つからない場合は exit code `1` で user-friendly なエラーを返す
- agent を起動しないため、tokens は消費しない

復元 (`undismiss`) や 1 source 全件 dismiss (`--source <id>`) は現状未対応（要望次第で別 issue）。

### `agentic-watch review <research-id> [--agent <agent-id>] [--template <id>]`

既存 research に対し、指定 agent でレビューを生成。

| 引数 | 説明 |
|---|---|
| `<research-id>` | `research/<id>.md` の id（拡張子 `.md` は省略可。例: `20260510_anthropic-news-claude-code_v1`） |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（既定: `claude-code`） |
| `--template` | レビュー観点テンプレ id（既定: `default`、`templates/<id>.md` を参照） |

**更新先は 2 箇所**（厳密にはファイル 2 つ、フィールド 3 箇所）:

| 更新先 | 内容 |
|---|---|
| `items/<sourceId>/<item-id>.yaml` | `status: researched → reviewed` |
| `research/<id>.md` frontmatter | `reviewedAt` / `reviewedBy` |
| `research/<id>.md` 本文末尾 | `## レビュー (<agent>, <ISO 8601>)` セクションを追記 |

両者は同一コマンド内でアトミックに更新される（部分失敗時は両方ロールバック）。CLI は agent 起動前にスナップショットを取り、以下のいずれかで失敗するとリストアする:

- adapter が非ゼロ終了 / 例外を投げた
- 書き換え後の frontmatter が `ResearchFrontmatterSchema` に違反
- `reviewedAt` / `reviewedBy` が未スタンプ、または `reviewedBy` が起動 agent と不一致
- immutable フィールド（`id` / `itemIds` / `agent` / `templateId` / `createdAt`）が改変された
- `items/*.yaml` の書き込みが失敗

rollback 自体が失敗した場合（同じファイルシステム障害が継続している等）は「workspace may be in an inconsistent state」を出力して exit 1 する。ユーザーは `git status` / `git diff` で復旧する。

詳細は [ADR-0003](./adr/0003-output-format-and-versioning.md) / [ADR-0008](./adr/0008-status-state-machine.md) / [`docs/design/skill-design.md` §7](./design/skill-design.md)。

#### 再レビュー (re-review)

同一 research 版に対する再レビューは拒否する（`reviewedAt != null` を CLI が検知）。レビューが古くなった場合は `agentic-watch update` で `_v2.md` を作成してから review し直す（Phase 4）。

Phase 2 で 4 agent (`claude-code` / `codex-cli` / `gemini-cli` / `copilot`) 全てが review に対応する。

#### クロスエージェント運用（推奨）

research を書いた agent と**別の agent** で review を実行することを推奨する:

```bash
# 例: copilot で書いて claude にレビューさせる
agentic-watch research <item-id> --agent copilot
agentic-watch review <research-id> --agent claude-code
```

なぜクロスチェック:

- 同一 agent の盲点（特定の情報源への偏り、用語の取りこぼし）を相互補正できる
- review が research と同じ思い込みを引きずらない
- 4 種類の agent プランを契約しているなら、利用枠を分散できる

CLI 側で agent の組合せを強制はしない（ユーザー判断）。`radar.config.yaml` で default agent を指定すれば、`--agent` を毎回付けずに済む（[後述](#radarconfigyaml)）。

### `agentic-watch update <research-id> [--agent <agent-id>] [--template <id>]`

既存 research を最新情報で再生成。新バージョン (`_v2.md`, `_v3.md`, …) を作成し、旧バージョンは保持（immutable history、[ADR-0003](./adr/0003-output-format-and-versioning.md)）。

| 引数 | 説明 |
|---|---|
| `<research-id>` | `research/<id>.md` の id（拡張子 `.md` は省略可。例: `20260510_anthropic-news-claude-code_v1`） |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（既定: `claude-code`、`radar.config.yaml` の `defaultResearchAgent` を fallback として使う） |
| `--template` | テンプレ id（既定: `default`、`templates/<id>.md` を参照） |

挙動:

- 前版 (`<base>_v<N>.md`) を読み込み、その frontmatter / 本文を adapter に渡す
- adapter は `<agent> -p "<prompt>"` を子プロセスで起動し、`.agents/skills/update/SKILL.md` を実行する
- adapter が新ファイル `research/<base>_v<N+1>.md` を書き出す（rewrite-and-supersede 戦略、[`docs/design/skill-design.md` §8.2](./design/skill-design.md)）
- CLI 側で v+1 frontmatter を `ResearchFrontmatter` schema で検証し、v+1 invariants を assert する:
  - `itemIds` / `templateId` / `createdAt` が前版と一致
  - `supersedes` が前版 id と一致
  - `reviewedAt` / `reviewedBy` が `null`
- 違反が検出された場合は警告ログを出して frontmatter を自動修正する（agent の drift から保護）
- 旧版 (`_v<N>.md`) は**書き換えない**（immutable history）
- `items/<sourceId>/<itemId>.yaml` の `status` は**変更しない**（[ADR-0008](./adr/0008-status-state-machine.md) / [`docs/design/skill-design.md` §8.4](./design/skill-design.md)）。`reviewed` だった item は `reviewed` のまま、`researched` だった item は `researched` のまま
- `detected` / `dismissed` の item に対する update は拒否する（v1 research がないため supersede 対象がない）

出力: `research/<base>_v<N+1>.md`。命名規則とフォーマットは [ADR-0003](./adr/0003-output-format-and-versioning.md)。

例:

```bash
# v1 を元に v2 を生成（v1 と同じ claude-code で）
agentic-watch update 20260510_anthropic-news-claude-code_v1 --agent claude-code

# v2 を生成しつつ agent を切り替え（v1 は claude-code、v2 は codex-cli）
agentic-watch update 20260510_anthropic-news-claude-code_v1 --agent codex-cli

# v2 を更に更新 (v3 を生成)
agentic-watch update 20260510_anthropic-news-claude-code_v2 --agent claude-code
```

#### v+1 で `reviewedAt` / `reviewedBy` をリセットする理由

v1 に対して `review` を実行した内容は v2 には引き継がない（v2 は v1 と内容が変わっているため、v1 のレビュー結論をそのまま使えない）。v+1 の内容を改めてレビューしたい場合は、`agentic-watch review <new-id> --agent <id>` を v+1 に対して実行する（[`docs/design/skill-design.md` §8.6](./design/skill-design.md)）。

#### items.yaml の status が動かないことの含意

「`reviewed` の item の最新 research が v2 で、まだ review されていない」状態が出現することがある。`items.yaml` の `status` 単独では「最新 research が review 済みか」を判定できないので、必要に応じて `research/*.md` 側の `reviewedAt` を確認すること。これは ADR-0003 / ADR-0008 の意図的な設計（item lifecycle と research version を直交させる）であり、自動 promote はしない。

#### update の対象が無い場合 (no-op suppression)

agent が最新情報を取得しても material な変更が無いと判断した場合は、v+1 ファイルを作らずスキップする（[`docs/design/skill-design.md` §8.5](./design/skill-design.md)）。空 diff の v+1 を作らない設計のため、再実行で v3, v4 が無限に増えることはない。

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

`agentic-watch` 本体は scheduler を内蔵しない（[ADR-0004](./adr/0004-schedule-strategy.md)）。`init` の opt-in フラグでクラウド scheduler 向けの**接続用雛形**を生成する。

| フラグ | 生成先 | 用途 |
|---|---|---|
| `agentic-watch init --with-routines` | `claude/routines/watch-daily.md` | Claude Routines (Anthropic 管理クラウド VM) |
| `agentic-watch init --with-actions` | `.github/workflows/watch.yaml` | GitHub Actions (cron + workflow_dispatch) |

既存ファイル保護 + `--force` 上書きは bundled skills と同じ挙動。

### 認証ポリシー

- **`ANTHROPIC_API_KEY` を secret として登録する**。OAuth トークン (`CLAUDE_CODE_OAUTH_TOKEN`) は Anthropic 利用ポリシー上の制約により雛形では使わない（ADR-0004）
- GitHub Releases adapter の rate limit を 5000 req/h に引き上げるため、`watch.yaml` 雛形は `secrets.GITHUB_TOKEN` を `GITHUB_TOKEN` env として forward する

### GitHub Actions 雛形の検証手順

生成された `.github/workflows/watch.yaml` を実 cron で動かして items / state が更新されることを確認する手順:

1. `agentic-watch init --with-actions` で workspace 直下に雛形が出来ていることを確認する
2. workspace を GitHub に push する（`sources/` `items/` `state/` も含めて commit）
3. リポジトリ設定で secret `ANTHROPIC_API_KEY` を登録する（[Settings → Secrets and variables → Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)）
4. **Actions タブから `agentic-watch` workflow を `Run workflow` で手動実行**する（`workflow_dispatch` トリガー）
5. ジョブが緑になり、`watch run` が新着 item を検出した場合は `items/` / `state/` の更新を含む commit が自動 push されることを確認する
6. cron スケジュール (`"0 0 * * *"`) を必要に応じて編集する。次回 cron 起動時に同様に動くはず

なお `permissions: contents: write` は新しい commit を push するために必須。Org level で `Workflow permissions` を `Read repository contents permission` に絞っている場合は workflow 単位の設定で override する必要がある。

### Claude Routines 雛形の検証手順

1. `agentic-watch init --with-routines` で `claude/routines/watch-daily.md` が生成される
2. Claude Routines に routine を登録する（取り込み方法は Claude Routines 側の手順に従う）
3. Routine 実行画面で API キー (`ANTHROPIC_API_KEY` 等) を secret として渡す
4. 1 回手動実行（Routines UI から）して `watch run` が成功すること、`items/` / `state/` の commit が push されることを確認する

### スコープ外（CLI 側）

- 雛形 file が実 cron で動くかの自動テストは行わない（実機検証はユーザー側責務、ADR-0004）
- `research` / `review` / `update` を cron で自動実行する雛形は提供しない（人が triage する設計）
- desktop scheduled tasks（macOS launchd / Linux systemd timer 等）への対応は将来検討

## セキュリティ

### 全 adapter は「全権モード」で起動する

`agentic-watch research` / `agentic-watch review` が起動する 4 種類の agent CLI は、いずれも tool 承認なしで自動実行できるモードで spawn される（headless / 非対話実行を成立させるための前提）:

| adapter | 起動モード |
|---|---|
| `claude-code` | `--permission-mode bypassPermissions` |
| `codex-cli` | `--dangerously-bypass-approvals-and-sandbox` |
| `gemini-cli` | `-y` (YOLO mode) + `--skip-trust` (folder trust bypass) |
| `copilot` | `--allow-all-paths --allow-all-tools` |

つまり、agent が読み込む **任意の文字列が tool execution の指示として解釈されうる**。RSS feed の item content や HTML 抽出結果に攻撃者が prompt injection を仕込むと、agent がワークスペース内のファイル読み書きや任意コマンド実行を承認なしで行ってしまう経路が成立する。

### 信頼できる feed source のみ登録する

現時点 (Phase 2) では agentic-watch 側に prompt injection sanitize レイヤーを持たないため、ユーザー側の運用で feed source を選別することが第一の防御線になる。

**推奨される source**:

- 公式ベンダーの blog / news feed（例: anthropic.com/news/rss.xml、openai.com/blog/rss.xml）
- GitHub Releases feed（プロジェクト maintainer が release notes を直接書くもの）
- npm registry / PyPI などの公式 registry feed
- publisher が認証済みかつ信頼できる発信元

**注意が必要な source**:

- Hacker News / Reddit / Lobsters など、任意の third-party がコンテンツを投稿できるアグリゲータ
- ユーザー投稿型のフォーラム / コメント欄を含む feed
- 信頼境界が不明確な mirror / aggregator サイト

これらを source として登録する場合、item content 内に「Ignore previous instructions and ...」「以下を実行してください: ...」といった prompt injection 文字列が混入する可能性を許容したうえで運用する必要がある。少なくとも `agentic-watch research` 実行時のワークスペースには機密情報（`.env`、認証 token、秘密鍵など）を置かないこと。

### 包括的な sanitize 対策

agentic-watch 全体での prompt injection 緩和レイヤー（item content の sanitize、agent prompt の分離、出力検証など）は別 Phase で取り組む予定（[#49](https://github.com/ozzy-labs/agentic-watch/issues/49)）。それまでは上記の運用ガイドラインで mitigate する。

### `trustLevel`: 信頼境界の opt-in

`sources/<id>.yaml` の **`trustLevel`** フィールドで、その source のコンテンツを信頼境界の内側として扱うかを宣言する（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M4）。

| 値 | 意味 |
|---|---|
| `"untrusted"` (default) | 外部 feed と同等に扱う。`source add` で生成される YAML はすべてこれ |
| `"trusted"` | ユーザーが自分でコンテンツを掌握している source（自社内部 feed、社内 wiki エクスポート、release notes を maintainer 自身が書く GitHub Releases など）に opt-in |

ファイル例（明示 opt-in。CLI flag は提供されないため YAML を直接編集する）:

```yaml
# sources/internal-blog.yaml
id: internal-blog
kind: rss
url: https://blog.internal.example.com/feed.xml
trustLevel: trusted   # 既定は untrusted。社内 feed のみ明示的に格上げする
tags: ["internal"]
filters:
  keywords: ["release", "changelog"]
```

`trustLevel` 未指定の既存 YAML（[#17](https://github.com/ozzy-labs/agentic-watch/pull/17) 以前に作成したもの）は schema が default `"untrusted"` を補うため、migration は不要。

**現時点の挙動**: 本フィールドは schema のみの拡張で、実際の policy 分岐（regex 検出感度の調整、prompt builder の boundary marker 強度など）はまだ実装されていない。すべての source は `trustLevel` の値に関わらず untrusted 扱いで運用される。downstream で `trustLevel` を参照するロジックは [#49](https://github.com/ozzy-labs/agentic-watch/issues/49) 配下の sub-issue で順次入れていく。それまで `trustLevel: trusted` を設定しても挙動上の差は出ない（将来の policy 分岐に備えた宣言として機能する）。

### prompt injection の audit ログ (`injectionFlags`)

`agentic-watch watch run` 実行時、各 item の `title` / `summary` / `raw` に対し best-effort の regex pre-filter を走らせる（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M1a / M5a — Adopt）。検出された pattern label の一覧は `items/<sourceId>/<item-id>.yaml` の `injectionFlags` フィールドに記録される。

検出対象 (8 種類):

- `system-tag` — `[SYSTEM]` 形式の偽システムタグ
- `chatml-token` — `<|im_start|>` / `<|im_end|>` (OpenAI ChatML special token)
- `ignore-previous` — `Ignore previous instructions` 系（語形ゆれ吸収）
- `disregard-above` — `Disregard the above` 系
- `system-override` — `SYSTEM OVERRIDE` / `SYSTEM PROMPT OVERRIDE`
- `role-reassignment` — `You are now ...` 形式の役割再付与
- `instruction-fence` — `BEGIN/END INSTRUCTIONS` フェンス
- `endoftext-token` — `<|endoftext|>` (GPT family special token)

**重要**: あくまで auditability のための観察層であり、検出されたからといって item は変更されない（status は `detected` のまま、本文も sanitize しない）。判断は user に委ねる（ADR-0009 M5b — Reject: auto-dismiss しない）。

**既知の限界 (false negative)**:

- zero-width / 同型字 (homoglyph) による難読化（例: `i​gnore`）
- base64 / hex などの encoding 経由のペイロード
- 文字どおりの marker を含まない自然言語ジェイルブレイク（例: "Forget what you were told"）
- 英語以外の言語による paraphrase

これらは pre-filter では検出できないため、引き続き「信頼できる source のみ登録する」運用ルールが第一の防御線になる。

#### injection flag が立った item の手動 dismiss 手順

`watch run` 後に warn ログ `watch run: '<sourceId>' N item(s) tripped the prompt-injection pre-filter` が出た場合、または `research` / `review` / `update` 実行時に `item 'X' has N injection flag(s): ...` が表示された場合、以下のいずれかで運用する:

1. **内容を確認したうえで dismiss する** (推奨):

   ```bash
   # flag が立っている item のみを列挙する
   # (空の `injectionFlags: []` は除外し、配列要素がある形式だけ match させる)
   grep -lE '^injectionFlags:$' items/*/*.yaml
   cat items/<sourceId>/<item-id>.yaml

   # 攻撃ペイロードだと判断したら dismiss (detected → dismissed)
   agentic-watch dismiss <item-id>
   ```

2. **誤検知 (false positive) だと判断したらそのまま research を進める**:

   ```bash
   # flag が立っていても research は普通に動作する（audit-only）
   agentic-watch research <item-id>
   ```

   `injectionFlags` は `items/<id>.yaml` に残るので、後から `grep -rE '^injectionFlags:$' items/` で監査ログを追える。

3. **source 自体が信頼できないと判断したら source を外す**:

   ```bash
   agentic-watch source remove <sourceId>
   ```

   `items/<sourceId>/` 配下は履歴として残る（ADR-0008）。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `not implemented yet (Phase 1)` | 該当コマンドは未実装。Phase 1 まで待つか、[Phase 1 epic](https://github.com/ozzy-labs/agentic-watch/issues?q=label%3Aphase-1) に貢献 |
| agent CLI が見つからない | `claude` / `codex` / `gemini` / `copilot` が `PATH` に存在し認証済みであることを確認 |
| OIDC 認証エラー（publish 時） | maintainer 向け。`standards/npm-trusted-publishers` を参照 |
| Phase 1 で試した workspace の `items/` / `state/` をリセットしたい | `state/` ディレクトリと `items/<sourceId>/` ディレクトリを削除してから `watch run` を再実行する。`state/<sourceId>.yaml` に記録された `lastSeenIds` が消えるので、`watch run` が source 全件を再検出して `items/<sourceId>/*.yaml` を作り直す（[#24](https://github.com/ozzy-labs/agentic-watch/pull/24) の Item.id refactor 前後で id 形式が変わったため、古い workspace を引き継ぎたい場合の標準手順）。`sources/` `templates/` `.agents/skills/` は触らない |
