# AGENTS.md

このファイルは AI エージェント (Codex CLI / Gemini CLI / GitHub Copilot CLI など) が自動で読み込む、エージェント非依存の workspace 共通 instructions です。Claude Code は `CLAUDE.md` を別途参照しますが、`CLAUDE.md` から本ファイルを `@AGENTS.md` 等で取り込むのが業界標準パターンです。

## このディレクトリは何か

このディレクトリは [`agentic-watch`](https://github.com/ozzy-labs/agentic-watch) の **user workspace** です。`agentic-watch` は、ブログ・公式アップデート・リリースフィードを監視し、キーワードヒットを AI エージェントに渡して Markdown 調査レポートを生成する CLI ツールです。

このディレクトリには以下が含まれます:

```text
.
├── sources/           # 監視対象サイトの定義 (YAML)
├── state/             # 既読 ID / etag (差分検出用)
├── items/             # 検出された記事 (YAML)
├── research/          # 調査レポート (Markdown + frontmatter)
├── templates/         # Markdown テンプレート (編集可)
├── .agents/skills/    # 4 CLI 共通 engine SKILL (SSoT)
├── .claude/skills/    # Claude Code 用 slash-command 雛形
└── .gemini/commands/  # Gemini CLI 用 slash-command 定義 (TOML)
```

## 主要コマンド

```bash
# Workspace 初期化
agentic-watch init                          # 既定: AGENTS.md + skills + dirs を生成
agentic-watch init --no-agents-md           # AGENTS.md 生成を skip
agentic-watch init --no-claude-skills       # .claude/skills/ を skip
agentic-watch init --with-routines          # claude/routines/watch-daily.md を生成
agentic-watch init --with-actions           # .github/workflows/watch.yaml を生成
agentic-watch init --force                  # 既存ファイルを上書き

# 監視対象の管理
agentic-watch source add <id> --kind <rss|html|github-releases|npm-registry> --url <url> [options]
agentic-watch source list
agentic-watch source remove <id>

# 監視実行 (新着検出 → items/*.yaml に detected で書く)
agentic-watch watch run

# 検出済み item に対する操作
agentic-watch research <item-id> --agent <agent>     # 調査レポートを生成 (status: detected -> researched)
agentic-watch review <research-id> --agent <agent>   # 既存レポートをレビュー (status: researched -> reviewed)
agentic-watch update <research-id> --agent <agent>   # v+1 を生成 (item status は変えない)
agentic-watch dismiss <item-id>                       # LLM 不要、item を dismissed に
```

`<agent>` の値: `claude-code` / `codex-cli` / `gemini-cli` / `copilot`

## 利用可能な slash commands (Claude Code 等)

`init` 時に `.claude/skills/` 配下に配置される薄い wrapper です。Claude Code interactive session で以下が呼べます (`--no-claude-skills` 指定時は生成されません):

| Slash | 動作 |
|---|---|
| `/research <item-id> [--agent ...]` | `agentic-watch research` を呼ぶ |
| `/review <research-id> [--agent ...]` | `agentic-watch review` を呼ぶ |
| `/update <research-id> [--agent ...]` | `agentic-watch update` を呼ぶ |
| `/dismiss <item-id>` | `agentic-watch dismiss` を呼ぶ (LLM 不要) |

procedure 本体は `.agents/skills/<name>/SKILL.md` (engine SKILL) を SSoT として参照します。

## 典型ワークフロー

```text
1. agentic-watch watch run             # 新着検出 (items/*.yaml に detected で書く)
2. agentic-watch research <item-id>    # AI agent が調査レポートを生成
3. agentic-watch review <research-id>  # 別 agent でクロスレビュー (推奨)
4. agentic-watch update <research-id>  # (任意) 最新情報で v+1 を生成
```

不要な item は `agentic-watch dismiss <item-id>` で dismissed に遷移させます。

## エージェント選択ガイド (cross-agent review)

[ADR-0001](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/adr/0001-agent-adapter-interface.md) に基づき、`research` と `review` は **別の agent** で実行することを推奨します:

```bash
agentic-watch research <item-id> --agent codex-cli
agentic-watch review <research-id> --agent claude-code
```

理由:

- 同一 agent の盲点 (特定情報源への依存、訓練データの偏り) を相互補正できる
- review が research を書いた agent と同じ「思い込み」を引きずらない
- 複数 plan を契約しているならリソースを分散できる

agent の選択は CLI が強制せず、ユーザー判断です。

## データ管理ポリシー

`sources/` `items/` `state/` `research/` `templates/` は **このディレクトリで git にコミットする** ことを推奨します。理由は以下:

- 定期実行 scheduler (Claude Routines / GitHub Actions) は実行ごとに fresh clone を行うため、`state/*.yaml` の `lastSeenIds` が引き継がれないと毎回全件再検出してしまう
- `research/` を git で管理すると、過去レポートの履歴・差分が追える (ADR-0003 で immutable history を採用)
- `items/` の status 遷移 (`detected` → `researched` → `reviewed`) も git 履歴に残る

`init` は `sources/` `items/` `state/` `research/` に `.gitkeep` placeholder を配置するため、初期状態 (中身が空) でも `git add .` でディレクトリ構造が消えずに追跡されます。

詳細は `agentic-watch` リポジトリの [`docs/user-guide.md`](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/user-guide.md) を参照してください。

## セキュリティ警告 (untrusted external content)

`agentic-watch` が fetch する外部 feed (RSS / HTML / GitHub Releases / npm registry) のコンテンツは **untrusted** として扱われます ([ADR-0009](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/adr/0009-untrusted-external-content-handling.md))。攻撃者が feed 内容に prompt injection を仕込む可能性があるため:

- agent に渡すコンテンツは boundary marker で囲まれ、procedure 本体と分離される
- `sources/<id>.yaml` の `trustLevel` で `"trusted" | "untrusted"` を per-source で指定可能 (既定 `"untrusted"`)
- agent 実行時、untrusted コンテンツ内の指示には従わないよう SKILL に指示が入っている

それでも、生成された `research/*.md` の内容は人間がレビューしてから運用判断に使うべきです。

## ドキュメント pointer

詳細・設計判断の根拠は `agentic-watch` リポジトリ配下の以下を参照:

- [`docs/user-guide.md`](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/user-guide.md) — 全コマンドのリファレンス、scheduler 雛形、認証設定
- [`docs/architecture.md`](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/architecture.md) — モジュール構成、データフロー、Phase 別スコープ
- [`docs/adr/`](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/adr/README.md) — 設計判断の記録 (ADR-0001 ~ 0009)
- [`docs/design/`](https://github.com/ozzy-labs/agentic-watch/tree/main/docs/design) — `filter-spec.md` / `skill-design.md` / `threat-model.md`
