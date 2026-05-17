# ADR-0007: Skill Bundling and `init` Distribution

## Status

Accepted（2026-05-11、Revised 2026-05-17、Revised 2026-05-17 b、Revised 2026-05-17 c）— Phase 1 で同梱 + `.agents/skills/` 配置を確定。**Revision (a)** で `.claude/skills/` への slash-command wrapper 配置 (default-on、`--no-claude-skills` で opt-out) を追加 ([#75](https://github.com/ozzy-labs/FeedRadar/issues/75))。**Revision (b)** で `AGENTS.md` (agent-agnostic instructions、default-on、`--no-agents-md` で opt-out) を追加し、4 層構成に拡張 ([#77](https://github.com/ozzy-labs/FeedRadar/issues/77))。**Revision (c)** で `.gemini/commands/` への Gemini CLI slash command TOMLs 配置 (default-on、`--no-gemini-commands` で opt-out) を追加し、engine SKILL を adapter spawn / interactive 両対応の **dual-mode** に拡張、**5 層構成** に到達 ([#78](https://github.com/ozzy-labs/FeedRadar/issues/78))。

## Context

`research` / `review` / `update` は AI エージェントに依頼するタスクで、各エージェントは Skill（`SKILL.md`）経由でプロンプトを受け取る。これらの Skill は FeedRadar の動作に不可欠だが、配置場所に選択肢がある:

1. ユーザーが個別に書く
2. FeedRadar が npm パッケージに同梱し `init` で配置
3. 別 npm パッケージ（`@ozzylabs/FeedRadar-skills` 等）にする
4. `@ozzylabs/skills` Renovate preset に含める

`@ozzylabs/skills` は org 横断の汎用 skill（commit / pr / review / ship 等）が住む場所であり、**FeedRadar 固有のドメインロジック**を含む skill を混ぜると責務が崩れる。

## Decision

**FeedRadar リポに同梱、`init` で user workspace へ 5 層構成でコピー**する。

### 5 層構成 (canonical)

`init` は以下の 5 層を user workspace に配置し、4 種類の agent CLI (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) に対し **adapter spawn 経路と interactive slash / mention 経路の両方** を同一の SSoT から駆動する:

| 層 | 配置先 | 役割 | bundle 元 | opt-out |
|---|---|---|---|---|
| **engine SKILL (SSoT, dual-mode)** | `<cwd>/.agents/skills/<name>/SKILL.md` | adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体。冒頭に "Invocation modes" セクションを持ち、(1) adapter spawn 時は procedure を実行、(2) interactive 起動時 (stdin JSON なし、`$ARGUMENTS` あり) は `radar <subcommand>` に shell out する dual-mode | `src/skills/` | (なし、SSoT) |
| **Claude discovery SKILL** | `<cwd>/.claude/skills/<name>/SKILL.md` | Claude Code interactive で `/research` 等の slash command として発火、`radar <subcommand>` を呼ぶだけの薄い wrapper | `src/claude-skills/` | `--no-claude-skills` |
| **Gemini commands** | `<cwd>/.gemini/commands/<name>.toml` | Gemini CLI interactive で `/research` 等の slash command として発火、TOML の `prompt` キーから `radar <subcommand> {{args}}` を呼ぶ | `src/gemini-commands/` | `--no-gemini-commands` |
| **AGENTS.md** | `<cwd>/AGENTS.md` | Codex / Gemini / Copilot が auto-read する agent-agnostic instructions (workspace 概要、主要コマンド、典型ワークフロー、docs pointer) | `src/templates/agents/AGENTS.md` | `--no-agents-md` |
| **schedule scaffolds** (opt-in) | `<cwd>/claude/routines/watch-daily.md` / `<cwd>/.github/workflows/watch.yaml` | 定期実行 scheduler への接続用雛形 (ADR-0004) | `src/templates/{routines,workflows}/` | (opt-in: `--with-routines` / `--with-actions`) |

`package.json` の `files` には `dist/skills` / `dist/claude-skills` / `dist/gemini-commands` / `dist/templates` を含めて配布する。

### SSoT 維持の原則

engine SKILL (`.agents/skills/`) のみが procedure 本体を持つ。Claude discovery / Gemini commands は **薄い wrapper** (slash command の発火点のみ) で、procedure を duplicate しない (drift 防止)。dual-mode 化により Codex CLI は `.agents/skills/` の auto-discovery 経由で `$research` mention に応答でき、Gemini CLI は `.gemini/commands/` の TOML 経由で `/research` slash に応答できる。

### 同梱する Skill

`src/skills/` 配下に canonical SKILL.md を置く:

```text
src/skills/
├── research/SKILL.md       # item → Markdown research レポート生成
├── review/SKILL.md         # 既存 research → レビューコメント追記
└── update/SKILL.md         # 既存 research → 最新情報で v+1 を生成
```

### `init` の挙動

`FeedRadar init` 実行時:

1. user workspace の 5 層配置先にコピー（engine SKILL は SSoT として常時、それ以外は default-on / opt-out）
2. ファイル既存時は `--force` 指定なしで skip し warning（ユーザー編集を保護）
3. `--force` 指定時のみ上書き

### SKILL.md frontmatter（共通仕様）

```yaml
---
name: research                          # ディレクトリ名と一致
description: <短い説明、エージェント発見用>
allowed-tools: Read,Grep,Bash,WebFetch  # 推奨ツール（カンマ区切り）
---
```

`name` / `description` / `allowed-tools` の 3 フィールドは [@ozzylabs/skills](https://github.com/ozzy-labs/skills) と同じ最小共通仕様（[multi-agent-repo](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/multi-agent-repo.md) 規約）。

### CLI 固有 companion

`SKILL.<agent-id>.md` のような per-agent override 用 companion file path は §4 of [`docs/design/skill-design.md`](../design/skill-design.md) で予約済みだが、現状は未使用 (engine SKILL 1 本で 4 agent を兼用)。初版 (2026-05-11) は「CLI 固有 companion は当面用意しない」方針だったが、Revision (a) (`.claude/skills/`)、(b) (`AGENTS.md`)、(c) (`.gemini/commands/`) の 3 段階で **CLI 固有 discovery 層は薄い wrapper として導入済み** (procedure は engine SKILL に閉じる、という SSoT 原則は維持)。

## Revision (2026-05-17, [#75](https://github.com/ozzy-labs/FeedRadar/issues/75))

### 動機

初版 (2026-05-11) では `init` は `.agents/skills/` のみに書き込み、`.claude/skills/` を意図的に touch しない方針だった (Renovate preset との衝突回避)。これは agent CLI 経由の呼び出し (`FeedRadar research <item> --agent claude-code` → adapter が `claude` を spawn → `claude` が `.agents/skills/research/SKILL.md` を読む) には十分だが、**Claude Code interactive session で `/research` / `/review` / `/update` / `/dismiss` の slash command が発見されない** という UX gap があった (user feedback、`docs/design/skill-design.md` line 112 の "revisit if user feedback shows friction" 条件発動)。

### 改訂後の方針

`init` は **2 層の skill** を user workspace に配置する (further extended to 4 layers in Revision (b), 2026-05-17 b):

| 層 | 配置先 | 役割 | bundle 元 |
|---|---|---|---|
| **engine SKILL (SSoT)** | `<cwd>/.agents/skills/<name>/SKILL.md` | adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体 | `src/skills/` |
| **Claude discovery SKILL (薄い wrapper)** | `<cwd>/.claude/skills/<name>/SKILL.md` | Claude Code interactive で `/research` 等の slash command として発火、`radar <subcommand>` を呼ぶだけ | `src/claude-skills/` (新規 bundle dir) |

#### Claude discovery SKILL の対象

| Slash | wraps |
|---|---|
| `/research <item-id> [--agent ...]` | `FeedRadar research` |
| `/review <research-id> [--agent ...]` | `FeedRadar review` |
| `/update <research-id> [--agent ...]` | `FeedRadar update` |
| `/dismiss <item-id>` | `FeedRadar dismiss` (no LLM) |

`dismiss` は agent を呼ばないため engine SKILL を持たないが、UX 上 slash command として提供する価値があるため discovery 層には含める (非対称性を許容)。

#### opt-out

`FeedRadar init --no-claude-skills` で discovery 層を skip する。これは `@ozzylabs/skills` Renovate preset で `.claude/skills/` を集中管理している workspace 向け。engine SKILL (`.agents/skills/`) は SSoT として常に書かれる (この flag では skip しない)。

#### SSoT 維持

discovery SKILL は **薄い wrapper** であり、research / review / update の procedure 本体 (frontmatter 形式、boundary marker 取扱い、status 不変ルール 等) は engine SKILL のみに書く。procedure を duplicate しない (drift 防止)。

### 改訂が解消しない事項

- 初版 § Consequences 「ユーザー編集後の sync 問題」は引き続き発生 (`--force` または手 merge で対処)
- 別 npm 分離 (案 C) は引き続き不要

### 既存ファイル保護

discovery 層も `.claude/skills/<name>/SKILL.md` が既に存在すれば skip + warning。`--force` で上書き (engine 層と同じパターン)。preset で配布される skill 名と衝突した場合、user は preset 側を優先するか FeedRadar 側を `--force` で上書きするかを選べる。

## Revision (2026-05-17 b, [#77](https://github.com/ozzy-labs/FeedRadar/issues/77))

### 動機 (Revision b)

Revision (a) (2026-05-17) で `.claude/skills/` の slash-command wrapper を default-on で配置するようにしたが、**Claude Code 以外の agent CLI が auto-read する instructions file** (AGENTS.md) は user workspace に配置されていなかった。

[`ai/practice/multi-agent-repo`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/multi-agent-repo.md) knowledge doc の中心原則は **「`AGENTS.md` を SSoT、CLI 固有ファイルは差分のみ」**。Codex CLI / Gemini CLI / GitHub Copilot CLI は `AGENTS.md` を auto-read するため、これがないと interactive session を開いた agent は「ここが何のワークスペースか / 何が実行できるか」を知らないままになる (Claude Code は `CLAUDE.md` を参照するが、`CLAUDE.md` → `@AGENTS.md` include が業界標準パターン)。

#### Auto-read 対応表

| Agent | AGENTS.md auto-read |
|---|---|
| Claude Code | ❌ (CLAUDE.md 経由 — ただし CLAUDE.md → "see AGENTS.md" パターンが業界標準) |
| Codex CLI | ✅ (project root → CWD、`project_doc_max_bytes` 32 KiB 制限) |
| Gemini CLI | ✅ (project root、`.gemini/settings.json` の `context.fileName` でも追加可) |
| Copilot CLI | ✅ (repo root / CWD / `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) |

### 改訂後の方針 (4 層構成)

`init` は **4 層** を user workspace に配置する:

| 層 | 配置先 | 役割 | bundle 元 | opt-out |
|---|---|---|---|---|
| **engine SKILL (SSoT)** | `<cwd>/.agents/skills/<name>/SKILL.md` | adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体 | `src/skills/` | (なし、SSoT) |
| **Claude discovery SKILL** | `<cwd>/.claude/skills/<name>/SKILL.md` | Claude Code interactive で `/research` 等の slash command として発火、`radar <subcommand>` を呼ぶだけ | `src/claude-skills/` | `--no-claude-skills` |
| **AGENTS.md** (新規) | `<cwd>/AGENTS.md` | Codex / Gemini / Copilot が auto-read する agent-agnostic instructions (workspace 概要、主要コマンド、典型ワークフロー、docs pointer) | `src/templates/agents/AGENTS.md` | `--no-agents-md` |
| **schedule scaffolds** (opt-in) | `<cwd>/claude/routines/watch-daily.md` / `<cwd>/.github/workflows/watch.yaml` | 定期実行 scheduler への接続用雛形 (ADR-0004) | `src/templates/{routines,workflows}/` | (opt-in: `--with-routines` / `--with-actions`) |

#### AGENTS.md の内容方針

bundle される `AGENTS.md` は user workspace 向けに簡潔で実用的な内容 (32 KiB 制限以内、目安 5-8 KiB):

- このディレクトリは何か (FeedRadar workspace の概要)
- 主要コマンド一覧 (init / source / watch / research / review / update / dismiss)
- 利用可能 slash commands (`.claude/skills/` 経由)
- 典型ワークフロー (watch run → research → review → (任意で update))
- cross-agent review 推奨パターン (ADR-0001)
- データ管理ポリシー (`sources/` / `items/` / `state/` / `research/` を git commit)
- セキュリティ警告 (untrusted external content、ADR-0009)
- 詳細ドキュメントへの pointer (user-guide.md / architecture.md / adr/)

このリポ自身の `AGENTS.md` (本リポ開発者向け) は触らない。user workspace 向けの内容は別物。

#### AGENTS.md の opt-out

`FeedRadar init --no-agents-md` で AGENTS.md 生成を skip。既に独自の `AGENTS.md` を管理している workspace (monorepo 等) 向け。engine SKILL / Claude discovery SKILL は影響を受けない。

#### AGENTS.md の既存ファイル保護

`<cwd>/AGENTS.md` が既に存在すれば skip + warning。`--force` で上書き (engine / discovery 層と同じパターン)。

### 改訂 (b) が解消しない事項

- Revision (a) と同じく、ユーザー編集後の sync 問題は引き続き発生 (`--force` または手 merge で対処)
- 個別 agent 設定ファイル (`.gemini/settings.json` 等) の bundling は本改訂のスコープ外 (別 issue で検討)

## Revision (2026-05-17 c, [#78](https://github.com/ozzy-labs/FeedRadar/issues/78))

### 動機 (Revision c)

Revision (a) で Claude Code、Revision (b) で Codex / Gemini / Copilot の **auto-read** ファイル (`AGENTS.md`) を埋めたが、**slash command 発火** の対応は agent ごとに非対称だった:

| Agent | discovery 経路 | slash 発火 | Revision (b) 時点の状態 |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `/<name>` | ✅ Revision (a) で対応 |
| Copilot CLI | `.claude/skills/` 等を auto-read | `/<name>` | ✅ Revision (a) で free (Copilot は `.claude/skills/` を auto-read) |
| **Codex CLI** | `.agents/skills/` を auto-read | `/skills` panel or `$<name>` mention | ❌ engine SKILL は adapter spawn (stdin JSON) 専用 |
| **Gemini CLI** | `.gemini/skills/` or `.agents/skills/`、+ `.gemini/commands/*.toml` で `/<name>` slash | `/<name>` (commands) or `$<name>` mention (skills) | ❌ engine SKILL は slash 不向き、`.gemini/commands/` 雛形なし |

このギャップを 2 つのアプローチで同時に埋めて 4 agent 完全 parity に到達する。

### 改訂後の方針 (5 層構成)

| 層 | 配置先 | 役割 | bundle 元 | opt-out |
|---|---|---|---|---|
| **engine SKILL (SSoT, dual-mode)** | `<cwd>/.agents/skills/<name>/SKILL.md` | adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体。**冒頭に "Invocation modes" セクション** を持ち、(1) adapter spawn 時は procedure を実行、(2) interactive 起動時 (stdin JSON なし、`$ARGUMENTS` 等あり) は `radar <subcommand>` に shell out する dual-mode 化 | `src/skills/` | (なし、SSoT) |
| **Claude discovery SKILL** | `<cwd>/.claude/skills/<name>/SKILL.md` | Claude Code interactive で `/research` 等の slash command として発火、`radar <subcommand>` を呼ぶだけ | `src/claude-skills/` | `--no-claude-skills` |
| **Gemini commands (新規)** | `<cwd>/.gemini/commands/<name>.toml` | Gemini CLI interactive で `/research` 等の slash command として発火、TOML の `prompt` キーから `radar <subcommand> {{args}}` を呼ぶ | `src/gemini-commands/` | `--no-gemini-commands` |
| **AGENTS.md** | `<cwd>/AGENTS.md` | Codex / Gemini / Copilot が auto-read する agent-agnostic instructions | `src/templates/agents/AGENTS.md` | `--no-agents-md` |
| **schedule scaffolds** (opt-in) | `<cwd>/claude/routines/watch-daily.md` / `<cwd>/.github/workflows/watch.yaml` | 定期実行 scheduler への接続用雛形 (ADR-0004) | `src/templates/{routines,workflows}/` | (opt-in: `--with-routines` / `--with-actions`) |

#### B1: engine SKILL の dual-mode 化

`src/skills/{research,review,update}/SKILL.md` の **冒頭** に "Invocation modes" セクションを追加し、adapter spawn / interactive の判定を agent 側に明示する:

```markdown
## Invocation modes

This SKILL serves two invocation modes:

1. **Adapter spawn (default)**: The `radar` CLI spawns the agent as a
   subprocess and pipes a JSON payload to stdin (...). Follow the procedure below.

2. **Interactive invocation (slash / mention)**: If invoked from an interactive
   session (no stdin JSON payload, `$ARGUMENTS` or equivalent argument string
   present), do NOT attempt the full procedure. Instead, shell out to the
   `radar` CLI verbatim:

   - For research: `FeedRadar research $ARGUMENTS`
```

adapter spawn 時の挙動は **完全に保持** (procedure 本体は不変、stdin JSON contract も不変、`tests/agents/*.test.ts` の prompt assert もそのまま通る)。interactive で発火した場合のみ、agent は CLI に shell out して adapter spawn path 経由に戻る (二重 fan-out にならない)。

これで Codex CLI は `.agents/skills/` の auto-discovery 経由で `$research` 等の mention に正しく応答できるようになる (Codex CLI は独自の `.gemini/commands/` 相当を持たないため、engine SKILL の dual-mode 化が唯一の interactive 経路)。

#### B2: Gemini commands bundle (新規)

`src/gemini-commands/{research,review,update,dismiss}.toml` を新規追加 (4 ファイル):

```toml
# src/gemini-commands/research.toml
prompt = "Run `FeedRadar research {{args}}` to generate a research report ..."
description = "Generate a research report for a detected item via FeedRadar."
```

`init` は `<cwd>/.gemini/commands/<name>.toml` に default-on で配置。`scripts/copy-skills.mjs` の filter は `.toml` も許可するよう拡張 (既存の `.md` / `.yaml` 許可に追加)。

Gemini CLI の slash command は TOML 形式が canonical (`.gemini/commands/<name>.toml`)。`{{args}}` は Gemini CLI が `/research foo bar` を引数に展開する placeholder。procedure 本体は engine SKILL (`.agents/skills/<name>/SKILL.md`) に残し、TOML は **薄い wrapper** に徹する (drift 防止)。

`dismiss` は engine SKILL を持たない (no LLM) が、UX 上 slash command として提供する価値があるため commands 層には含める (Claude discovery 層と同じ非対称性パターン)。

#### opt-out (Revision c)

`FeedRadar init --no-gemini-commands` で `.gemini/commands/` 配置のみ skip。engine SKILL / `.claude/skills/` / `AGENTS.md` は影響を受けない。`--no-gemini-commands` 指定時も Gemini CLI interactive session は engine SKILL の dual-mode procedure で正しく動作する (`.agents/skills/` を Gemini CLI が auto-read してくれるため、slash の `/research` ではなく `$research` mention 経由になる)。

#### 既存ファイル保護 (Revision c)

`<cwd>/.gemini/commands/<name>.toml` が既に存在すれば skip + warning。`--force` で上書き (engine / discovery / agents 層と同じパターン)。

#### CI 同梱検証

`.github/workflows/ci.yaml` の pack:dry-run `required` リストに 4 toml ファイルを追加:

- `dist/gemini-commands/research.toml`
- `dist/gemini-commands/review.toml`
- `dist/gemini-commands/update.toml`
- `dist/gemini-commands/dismiss.toml`

`scripts/copy-skills.mjs` の filter regression や `package.json#files` の漏れを CI が即座に検出する。

### 改訂 (c) が解消しない事項

- Revision (a) / (b) と同じく、ユーザー編集後の sync 問題は引き続き発生 (`--force` または手 merge で対処)
- `.gemini/settings.json` 等の **agent 設定ファイル** の bundling は本改訂のスコープ外 (別 Phase)
- 本リポ自身の `.gemini/settings.json` / `.agents/skills/` は **触らない** (本 issue は user workspace 向け bundle の改訂のみ)

## Consequences

### 良い面

- ユーザーは Skill を書かずに `init` 一発で使える
- FeedRadar のバージョンと skill のバージョンが整合（pnpm up で同期）
- `@ozzylabs/skills` の責務（org 横断 skill）と混ざらない

### 悪い面 / 制約

- ユーザーが skill を編集した後、`pnpm up` で FeedRadar を更新しても自動 sync しない（ユーザー編集保護のため）。更新時は `--force` で上書きまたは手 merge
- 同梱 skill の更新 = FeedRadar の minor/patch release。skill だけ更新したい場合に粒度が粗い

### 中立

- 将来 FeedRadar 固有の skill が増えたら別 npm（`@ozzylabs/FeedRadar-skills`）への分離を検討（YAGNI、現状不要）

## Alternatives

### 案 B: ユーザーが個別に書く

- 却下理由: 「キーワードヒットを AI に渡して Markdown を書かせる」プロンプトをユーザーに毎回書かせるのは UX が悪い。CLI の主要機能を担う skill を bundle するのは妥当

### 案 C: 別 npm パッケージ

- 却下理由: 現状 skill 3 つ + 同期管理コスト。分離する利益が薄い

### 案 D: `@ozzylabs/skills` preset に含める

- 却下理由: org 横断の汎用 skill リポと、FeedRadar 固有のドメイン skill を混在させない（責務分離）

## 関連

- `init` 実装: [`src/cli/init.ts`](../../src/cli/init.ts)（Phase 1）
- 詳細プロンプト / 例: [`docs/design/skill-design.md`](../design/skill-design.md)（research SKILL の本文プロンプト構造、`init` の copy 戦略、`allowed-tools` 推奨、`.agents/skills/` 単一配置の決定理由、`update` の差分検出戦略）
- 関連: [`multi-agent-repo`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/multi-agent-repo.md)（共通 SKILL.md 仕様）
