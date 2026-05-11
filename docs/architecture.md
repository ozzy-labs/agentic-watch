# Architecture

`agentic-watch` は、技術ブログ・公式アップデート・リリースフィードを監視し、キーワードヒットを 4 種の AI エージェント (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) に渡して **Markdown 調査レポートを生成する CLI**。

詳細な責務分離・拡張ポイント・運用判断の根拠は [`adr/`](./adr/README.md) 配下を参照。

## 全体像

```text
┌──────────── User Workspace (ユーザー任意 dir) ────────────┐
│  sources/*.yaml       ← サイト定義                       │
│  state/*.yaml         ← 既読 ID / etag                   │
│  items/*.yaml         ← 検出記事                         │
│  research/*.md        ← 調査結果（Markdown + frontmatter）│
│  templates/*.md       ← Markdown テンプレ（ユーザー編集可）│
│  .agents/skills/...   ← 4 CLI 共通 Skill (init で配置)    │
│  .github/workflows/...← 定期実行ワークフロー (init で配置) │
└───────────────────────────────────────────────────────────┘
                    ▲
                    │ CLI が読み書き
                    │
┌──────────── @ozzylabs/agentic-watch (npm) ────────────────┐
│  core/                                                    │
│    ├─ watcher    : Feed adapter を呼び出して fetch        │
│    ├─ feeds/     : RSS / HTML / GitHub Releases / npm     │
│    ├─ filter     : keyword + excludeKeywords 判定         │
│    ├─ items      : 検出アイテムの保存・status 管理        │
│    └─ templates  : Markdown テンプレート差し込み           │
│  agents/         : 4 CLI アダプタ（共通 IF + 個別実装）   │
│  schemas/        : Zod スキーマ (Source / Item / State / Research) │
│  cli/            : init / source / watch / research / review / update │
└────────────────────────────────────────────────────────────┘
```

## モジュール責務

| モジュール | パス | 責務 |
|---|---|---|
| `core/watcher` | `src/core/watcher.ts` | Source 配列を受け取り、各 source の kind に応じた Feed adapter で fetch、Item[] を返す |
| `core/feeds` | `src/core/feeds/` | Source kind ごとの fetch 実装。共通 `FeedAdapter` interface（[ADR-0002](./adr/0002-source-adapter-plugin-pattern.md)）|
| `core/filter` | `src/core/filter.ts` | Item に対する `keywords` `excludeKeywords` 判定。Source に紐づく filter を適用 |
| `core/items` | `src/core/items.ts` | items YAML の保存・読み込み・status 遷移管理 |
| `core/templates` | `src/core/templates.ts` | テンプレ Markdown の読み込み + frontmatter 駆動の差し込み |
| `agents/` | `src/agents/` | 共通 `AgentAdapter`（[ADR-0001](./adr/0001-agent-adapter-interface.md)）+ 4 CLI 固有実装 |
| `schemas/` | `src/schemas/` | `Source` `Item` `SourceState` `Research` の Zod スキーマ |
| `cli/` | `src/cli/` | 各サブコマンド (init / source / watch / research / review / update) |

## データフロー

```text
sources/*.yaml
   │
   ▼
[watcher] ── feeds/<kind> ──► (HTTP fetch)
   │
   ▼
Item[] ── [filter] ──► matched Item[]
   │
   ▼
items/*.yaml (status=detected) ◄── state/*.yaml (lastEtag / lastSeenIds)
   │
   │ user: agentic-watch research <item-id> --agent <id>
   ▼
[templates] + [agents/<id>] ──► research/<id>.md
   │
   │ user: agentic-watch review <research-id> --agent <id>
   ▼
research/<id>.md (status=reviewed)
   │
   │ user: agentic-watch update <research-id> --agent <id>
   ▼
research/<id>.md (新バージョン、immutable history)
```

## 状態遷移（Item）

```text
detected ──► (dismissed | researched) ──► reviewed
                         │
                         └── update は research ファイルの v+1 を作る
                            （item status は変えない）
```

- `detected`: watcher が filter 通過後に出力した直後
- `dismissed`: ユーザーが research しないと判断した terminal 状態
- `researched`: agent が research レポートを書き終えた
- `reviewed`: 別 agent または人がレビューを通した

Status は `items/*.yaml` に保存され、CLI が遷移を駆動。詳細・writing-studio との差異 / 簡略化の根拠は [ADR-0008](./adr/0008-status-state-machine.md) を参照。

## クロスエージェント運用

agentic-watch は 4 種の agent CLI を adapter で抽象化しているため、**研究 (research) と レビュー (review) を別 agent で実行**することを推奨する:

```bash
agentic-watch research <item> --agent codex-cli
agentic-watch review <research> --agent claude-code
```

異なる agent によるクロスチェックにより:

- 同一 agent の盲点（あるトピックでの偏り、特定情報源への依存）を相互補正できる
- review が research を書いた agent と同じ「思い込み」を引きずらない
- 4 プランを契約しているなら、リソースを分散できる

agent 選択ロジックは CLI が強制しない（ユーザー判断）。`init` で生成される `radar.config.yaml`（仮）で default agent を指定可能（Phase 1）。

## 配布形態

- npm パッケージ `@ozzylabs/agentic-watch`、`bin: agentic-watch`
- OIDC Trusted Publishers（[handbook/ADR-0001](https://github.com/ozzy-labs/handbook/blob/main/adr/0001-npm-scope-ozzylabs.md)、[standards/npm-trusted-publishers](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/standards/npm-trusted-publishers.md)）
- 単一パッケージ（pnpm workspace なし）
- engine と user data の分離（[ADR-0005](./adr/0005-user-data-separation.md)）

## Phase 別スコープ

| Phase | 範囲 |
|---|---|
| Phase 0 | リポ初期化、CI/Release 基盤、本ドキュメント |
| Phase 1 (MVP) | `init` / `source add\|list\|remove` / `watch run` (RSS のみ) / `research` (Claude Code 単独で固定) |
| Phase 2 | 4 agent adapters + `review` |
| Phase 3 | HTML scraping / GitHub Releases / npm registry の追加 source 種別 |
| Phase 4 | `update` コマンド（既存 research の差分更新） |
| Phase 5 | schedule 雛形（[ADR-0004](./adr/0004-schedule-strategy.md)）を `init` で吐く |
| Phase 6 | npm publish 初版 + Trusted Publisher 登録 |
| Phase 7 | VS Code extension |

## 関連 ADR

- [0001 Agent Adapter Interface](./adr/0001-agent-adapter-interface.md)
- [0002 Source Adapter Plug-in Pattern](./adr/0002-source-adapter-plugin-pattern.md)
- [0003 Output Format and Versioning](./adr/0003-output-format-and-versioning.md)
- [0004 Schedule Strategy](./adr/0004-schedule-strategy.md)
- [0005 User Data Separation](./adr/0005-user-data-separation.md)
