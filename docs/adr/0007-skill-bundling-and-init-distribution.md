# ADR-0007: Skill Bundling and `init` Distribution

## Status

Accepted（2026-05-11）— 詳細実装は Phase 1 で固める。

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

- `init` 実装: Phase 1 で `src/cli/init.ts` を完成
- 詳細プロンプト / 例: `docs/design/skill-design.md` を Phase 1 実装と並走で起こす（別 issue で追跡）
- 関連: [`multi-agent-repo`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/multi-agent-repo.md)（共通 SKILL.md 仕様）
