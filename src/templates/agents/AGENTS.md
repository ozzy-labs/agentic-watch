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
├── .claude/skills/    # Claude Code / Copilot CLI 用 slash-command 雛形
├── .gemini/commands/  # Gemini CLI 用 slash-command 定義 (TOML)
└── AGENTIC_WATCH.md   # 人間向け workspace ガイド (本 AGENTS.md とは別レイヤー)
```

## エージェントへの基本指示

ユーザーは「最新の Anthropic news を research して」「この item は不要だから dismiss」のような **自然言語** で依頼してきます。CLI コマンドを覚えて打つのはユーザーの責務ではありません。エージェントは以下のように振る舞ってください:

1. **自然言語の意図を slash command にマップする** — research / review / update / dismiss のいずれに該当するか判断する
2. **必要な引数 (item-id / research-id) を解決する** — ユーザーが正確な id を知らない場合、`items/` / `research/` を読んで該当するものを特定する
3. **slash command を実行する** — `/research <item-id>` 等を呼び、結果をユーザーに報告する
4. **複数候補がある場合は確認する** — 「直近の item」が複数あれば候補を提示してユーザーに選ばせる

slash command 経由で呼ぶことで、CLI 側の schema 検証 / status 遷移 / rollback がすべて効きます。直接 `items/*.yaml` を編集する等の low-level 操作は避け、必ず slash 経由で行ってください。

## 主要コマンド

```bash
# Workspace 初期化
agentic-watch init                          # 既定: CLAUDE.md + AGENTS.md + skills + templates/default.md + dirs を生成
agentic-watch init --no-agents-md           # AGENTS.md 生成を skip (CLAUDE.md も自動 skip)
agentic-watch init --no-claude-md           # CLAUDE.md 生成を skip
agentic-watch init --no-claude-skills       # .claude/skills/ を skip
agentic-watch init --no-gemini-commands     # .gemini/commands/ を skip
agentic-watch init --no-templates           # templates/default.md 生成を skip
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

## 利用可能な slash commands (4 agent 共通)

`init` 時に配置される薄い wrapper です。Claude Code / Copilot CLI / Gemini CLI / Codex CLI のいずれの interactive session でも呼べます (発火形式と読み取り経路は agent によって異なるが、最終的に同じ `agentic-watch <subcommand>` に解決されます):

| Slash | 動作 |
|---|---|
| `/research <item-id> [--agent ...]` | `agentic-watch research` を呼ぶ |
| `/review <research-id> [--agent ...]` | `agentic-watch review` を呼ぶ |
| `/update <research-id> [--agent ...]` | `agentic-watch update` を呼ぶ |
| `/dismiss <item-id>` | `agentic-watch dismiss` を呼ぶ (LLM 不要) |

| Agent | 発火形式 | 読まれるファイル |
|---|---|---|
| Claude Code | `/research <id>` | `.claude/skills/research/SKILL.md` |
| Copilot CLI | `/research <id>` | `.claude/skills/` および `.agents/skills/` (両方) |
| Gemini CLI | `/research <id>` | `.gemini/commands/research.toml` |
| Codex CLI | `$research` mention / `/skills` panel | `.agents/skills/research/SKILL.md` (dual-mode) |

procedure 本体は `.agents/skills/<name>/SKILL.md` (engine SKILL) を SSoT として参照します。

## 典型ワークフロー

**ユーザー対話中 (interactive、エージェント駆動):**

```text
1. ユーザー: 「最新の Anthropic news で気になるやつ research して」
   → エージェント: items/ を読んで該当 item を選び、/research <item-id> を実行

2. ユーザー: 「いまのレポートを別エージェントでレビューしたい」
   → エージェント: 直前の research-id を覚えていれば /review <research-id> --agent <別 agent> を実行
                  覚えていなければ research/ から最新を特定

3. ユーザー: 「v1 が古いから update」
   → エージェント: /update <research-id> を実行 (新 _v2.md が生成される、v1 は immutable)

4. ユーザー: 「この item 不要」
   → エージェント: /dismiss <item-id> を実行
```

**スケジュール実行 / CI (CLI 直叩き):**

```text
agentic-watch watch run               # 新着検出 (items/*.yaml に detected で書く)
agentic-watch research <item-id>      # 自動 triage は推奨しない (ユーザー判断が必要)
```

`watch run` は cron / GitHub Actions / Claude Routines から呼ぶことを想定しています。`research` / `review` / `update` / `dismiss` は人間の判断が伴うため、interactive session 経由を推奨します。

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
