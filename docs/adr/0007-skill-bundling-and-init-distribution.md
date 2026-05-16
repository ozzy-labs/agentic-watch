# ADR-0007: Skill Bundling and `init` Distribution

## Status

Accepted（2026-05-11、Revised 2026-05-17）— Phase 1 で同梱 + `.agents/skills/` 配置を確定。**Revision** で `.claude/skills/` への slash-command wrapper 配置 (default-on、`--no-claude-skills` で opt-out) を追加 ([#75](https://github.com/ozzy-labs/agentic-watch/issues/75))。

## Context

`research` / `review` / `update` は AI エージェントに依頼するタスクで、各エージェントは Skill（`SKILL.md`）経由でプロンプトを受け取る。これらの Skill は agentic-watch の動作に不可欠だが、配置場所に選択肢がある:

1. ユーザーが個別に書く
2. agentic-watch が npm パッケージに同梱し `init` で配置
3. 別 npm パッケージ（`@ozzylabs/agentic-watch-skills` 等）にする
4. `@ozzylabs/skills` Renovate preset に含める

`@ozzylabs/skills` は org 横断の汎用 skill（commit / pr / review / ship 等）が住む場所であり、**agentic-watch 固有のドメインロジック**を含む skill を混ぜると責務が崩れる。

## Decision

**agentic-watch リポに同梱、`init` で user workspace にコピー**する。

### 同梱する Skill

`src/skills/` 配下に canonical SKILL.md を置く:

```text
src/skills/
├── research/SKILL.md       # item → Markdown research レポート生成
├── review/SKILL.md         # 既存 research → レビューコメント追記
└── update/SKILL.md         # 既存 research → 最新情報で v+1 を生成
```

`package.json` の `files` に `dist/skills` を含めて配布する。

### `init` の挙動

`agentic-watch init` 実行時:

1. user workspace の `.agents/skills/{research,review,update}/SKILL.md` にコピー
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

`SKILL.claude-code.md` のような CLI 固有 companion は **agentic-watch 同梱 skill では当面用意しない**。必要が出たら本 ADR を改訂する（Claude Code の `AskUserQuestion` 等を使う必要が出た場合）。

## Revision (2026-05-17, [#75](https://github.com/ozzy-labs/agentic-watch/issues/75))

### 動機

初版 (2026-05-11) では `init` は `.agents/skills/` のみに書き込み、`.claude/skills/` を意図的に touch しない方針だった (Renovate preset との衝突回避)。これは agent CLI 経由の呼び出し (`agentic-watch research <item> --agent claude-code` → adapter が `claude` を spawn → `claude` が `.agents/skills/research/SKILL.md` を読む) には十分だが、**Claude Code interactive session で `/research` / `/review` / `/update` / `/dismiss` の slash command が発見されない** という UX gap があった (user feedback、`docs/design/skill-design.md` line 112 の "revisit if user feedback shows friction" 条件発動)。

### 改訂後の方針

`init` は **2 層の skill** を user workspace に配置する:

| 層 | 配置先 | 役割 | bundle 元 |
|---|---|---|---|
| **engine SKILL (SSoT)** | `<cwd>/.agents/skills/<name>/SKILL.md` | adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体 | `src/skills/` |
| **Claude discovery SKILL (薄い wrapper)** | `<cwd>/.claude/skills/<name>/SKILL.md` | Claude Code interactive で `/research` 等の slash command として発火、`agentic-watch <subcommand>` を呼ぶだけ | `src/claude-skills/` (新規 bundle dir) |

#### Claude discovery SKILL の対象

| Slash | wraps |
|---|---|
| `/research <item-id> [--agent ...]` | `agentic-watch research` |
| `/review <research-id> [--agent ...]` | `agentic-watch review` |
| `/update <research-id> [--agent ...]` | `agentic-watch update` |
| `/dismiss <item-id>` | `agentic-watch dismiss` (no LLM) |

`dismiss` は agent を呼ばないため engine SKILL を持たないが、UX 上 slash command として提供する価値があるため discovery 層には含める (非対称性を許容)。

#### opt-out

`agentic-watch init --no-claude-skills` で discovery 層を skip する。これは `@ozzylabs/skills` Renovate preset で `.claude/skills/` を集中管理している workspace 向け。engine SKILL (`.agents/skills/`) は SSoT として常に書かれる (この flag では skip しない)。

#### SSoT 維持

discovery SKILL は **薄い wrapper** であり、research / review / update の procedure 本体 (frontmatter 形式、boundary marker 取扱い、status 不変ルール 等) は engine SKILL のみに書く。procedure を duplicate しない (drift 防止)。

### 改訂が解消しない事項

- 初版 § Consequences 「ユーザー編集後の sync 問題」は引き続き発生 (`--force` または手 merge で対処)
- 別 npm 分離 (案 C) は引き続き不要

### 既存ファイル保護

discovery 層も `.claude/skills/<name>/SKILL.md` が既に存在すれば skip + warning。`--force` で上書き (engine 層と同じパターン)。preset で配布される skill 名と衝突した場合、user は preset 側を優先するか agentic-watch 側を `--force` で上書きするかを選べる。

## Consequences

### 良い面

- ユーザーは Skill を書かずに `init` 一発で使える
- agentic-watch のバージョンと skill のバージョンが整合（pnpm up で同期）
- `@ozzylabs/skills` の責務（org 横断 skill）と混ざらない

### 悪い面 / 制約

- ユーザーが skill を編集した後、`pnpm up` で agentic-watch を更新しても自動 sync しない（ユーザー編集保護のため）。更新時は `--force` で上書きまたは手 merge
- 同梱 skill の更新 = agentic-watch の minor/patch release。skill だけ更新したい場合に粒度が粗い

### 中立

- 将来 agentic-watch 固有の skill が増えたら別 npm（`@ozzylabs/agentic-watch-skills`）への分離を検討（YAGNI、現状不要）

## Alternatives

### 案 B: ユーザーが個別に書く

- 却下理由: 「キーワードヒットを AI に渡して Markdown を書かせる」プロンプトをユーザーに毎回書かせるのは UX が悪い。CLI の主要機能を担う skill を bundle するのは妥当

### 案 C: 別 npm パッケージ

- 却下理由: 現状 skill 3 つ + 同期管理コスト。分離する利益が薄い

### 案 D: `@ozzylabs/skills` preset に含める

- 却下理由: org 横断の汎用 skill リポと、agentic-watch 固有のドメイン skill を混在させない（責務分離）

## 関連

- `init` 実装: [`src/cli/init.ts`](../../src/cli/init.ts)（Phase 1）
- 詳細プロンプト / 例: [`docs/design/skill-design.md`](../design/skill-design.md)（research SKILL の本文プロンプト構造、`init` の copy 戦略、`allowed-tools` 推奨、`.agents/skills/` 単一配置の決定理由、`update` の差分検出戦略）
- 関連: [`multi-agent-repo`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/multi-agent-repo.md)（共通 SKILL.md 仕様）
