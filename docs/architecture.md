# Architecture

**FeedRadar** (`radar` CLI) は、技術ブログ・公式アップデート・リリースフィードを監視し、キーワードヒットを 4 種の AI エージェント (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) に渡して **Markdown 調査レポートを生成する CLI**。

詳細な責務分離・拡張ポイント・運用判断の根拠は [`adr/`](./adr/README.md) 配下を参照。

## 全体像

```text
┌──────────── User Workspace (ユーザー任意 dir) ────────────┐
│  sources/*.yaml       ← サイト定義                       │
│  state/*.yaml         ← 既読 ID / etag                   │
│  items/*.yaml         ← 検出記事                         │
│  research/*.md        ← 調査結果（Markdown + frontmatter）│
│  templates/*.md       ← Markdown テンプレ（ユーザー編集可）│
│  AGENTS.md            ← Codex / Gemini / Copilot が auto-read する │
│                          agent-agnostic instructions (--no-agents-md でスキップ) │
│  .agents/skills/...   ← 4 CLI 共通 engine SKILL (SSoT, dual-mode)│
│  .claude/skills/...   ← Claude Code slash-command 雛形    │
│                          (薄い wrapper、--no-claude-skills でスキップ) │
│  .gemini/commands/... ← Gemini CLI slash command (TOML)    │
│                          (薄い wrapper、--no-gemini-commands でスキップ) │
│  claude/routines/...  ← Claude Routines 雛形 (init --with-routines) │
│  .github/workflows/...← GitHub Actions ワークフロー (init --with-actions) │
└───────────────────────────────────────────────────────────┘
                    ▲
                    │ CLI が読み書き
                    │
┌──────────── @ozzylabs/feedradar (npm) ────────────────┐
│  core/                                                    │
│    ├─ watcher           : Feed adapter を呼び出して fetch │
│    ├─ feeds/            : RSS / HTML / GitHub Releases / npm │
│    ├─ filter            : keyword + excludeKeywords 判定  │
│    ├─ items             : 検出アイテムの保存・status 管理 │
│    ├─ templates         : Markdown テンプレート差し込み   │
│    ├─ config            : radar.config.yaml の読込        │
│    ├─ state             : source state YAML I/O           │
│    └─ injection-detector: ADR-0009 M1c regex pre-filter   │
│  agents/         : 4 CLI アダプタ + _boundary wrap helper │
│  schemas/        : Zod スキーマ (Source / Item / State / Research / Config) │
│  cli/            : init / source / watch / research / dismiss / review / update │
└────────────────────────────────────────────────────────────┘
```

## モジュール責務

| モジュール | パス | 責務 |
|---|---|---|
| `core/watcher` | `src/core/watcher.ts` | Source 配列を受け取り、各 source の kind に応じた Feed adapter で fetch、Item[] を返す |
| `core/feeds` | `src/core/feeds/` | Source kind ごとの fetch 実装。共通 `FeedAdapter` interface（[ADR-0002](./adr/0002-source-adapter-plugin-pattern.md)）|
| `core/filter` | `src/core/filter.ts` | Item に対する `keywords` `excludeKeywords` 判定。Source に紐づく filter を適用（詳細仕様: [`design/filter-spec.md`](./design/filter-spec.md)）|
| `core/items` | `src/core/items.ts` | items YAML の保存・読み込み・status 遷移管理 |
| `core/templates` | `src/core/templates.ts` | テンプレ Markdown の読み込み + frontmatter 駆動の差し込み |
| `core/config` | `src/core/config.ts` | `radar.config.yaml` の読み込みと default agent / 既定値の解決 |
| `core/state` | `src/core/state.ts` | source 単位の state YAML (`lastEtag` / `lastSeenIds` 等) の読み書き |
| `core/injection-detector` | `src/core/injection-detector.ts` | ADR-0009 M1c の regex pre-filter + research frontmatter / log への audit 出力 |
| `agents/` | `src/agents/` | 共通 `AgentAdapter`（[ADR-0001](./adr/0001-agent-adapter-interface.md)）+ 4 CLI 固有実装、`_boundary.ts` で untrusted コンテンツ wrap helper を提供（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M1c）。skill 呼び出しプロトコル: [`design/skill-design.md`](./design/skill-design.md) |
| `schemas/` | `src/schemas/` | `Source` `Item` `SourceState` `Research` `Config` の Zod スキーマ。`Source.trustLevel` (`"trusted" \| "untrusted"`、default `"untrusted"`) で prompt injection 緩和の per-source policy 分岐に備える ([ADR-0009](./adr/0009-untrusted-external-content-handling.md))。`Config` は `radar.config.yaml` 用 |
| `cli/` | `src/cli/` | 各サブコマンド (init / source / watch / research / dismiss / review / update) |

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
   ├── user: radar dismiss <item-id>
   │      └── items/*.yaml (status=dismissed) [terminal]
   │
   │ user: radar research <item-id> --agent <id>
   ▼
[templates] + [agents/<id>] ──► research/<id>.md
   │
   │ user: radar review <research-id> --agent <id>
   ▼
research/<id>.md (status=reviewed)
   │
   │ user: radar update <research-id> --agent <id>
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

FeedRadar は 4 種の agent CLI を adapter で抽象化しているため、**研究 (research) と レビュー (review) を別 agent で実行**することを推奨する:

```bash
radar research <item> --agent codex-cli
radar review <research> --agent claude-code
```

異なる agent によるクロスチェックにより:

- 同一 agent の盲点（あるトピックでの偏り、特定情報源への依存）を相互補正できる
- review が research を書いた agent と同じ「思い込み」を引きずらない
- 4 プランを契約しているなら、リソースを分散できる

agent 選択ロジックは CLI が強制しない（ユーザー判断）。`init` で生成される `radar.config.yaml` で default agent を指定可能（Phase 1 で確定済み、schema は `src/schemas/config.ts`）。

## Schedule（定期実行）

`radar` 本体は **scheduler を内蔵しない**（[ADR-0004](./adr/0004-schedule-strategy.md)）。`init` の opt-in フラグで、ユーザーが選んだクラウド scheduler 向けの **接続点（雛形）** だけを workspace に書き出す。

| フラグ | 生成先 | 想定 scheduler |
|---|---|---|
| `radar init --with-routines` | `claude/routines/watch-daily.md` | Claude Routines (Anthropic 管理クラウド VM) |
| `radar init --with-actions` | `.github/workflows/watch.yaml` | GitHub Actions |

両 scheduler は実行ごとに **fresh clone** を行うため、`sources/` / `items/` / `state/` は **git にコミット済み**である必要がある。生成された雛形は `items/` / `state/` の commit + push 手順を含んでいる（fresh clone でも前回の `lastSeenIds` を引き継げるようにするため）。

雛形は **`watch run` のみを自動化**する。`research` / `review` / `update` は人が triage する設計（ADR-0004）。

### 認証ポリシー

CI 自動化では **`ANTHROPIC_API_KEY` 等の API キー**を使う。OAuth トークン（`CLAUDE_CODE_OAUTH_TOKEN`）は Anthropic の利用ポリシー上 "ordinary individual use" の範囲外のため雛形では使わない（ADR-0004）。

GitHub Releases adapter の rate limit を 5000 req/h に引き上げるため、`watch.yaml` 雛形は `secrets.GITHUB_TOKEN` を `GITHUB_TOKEN` env として forward する。

### 既存ファイル保護

雛形生成は既存ファイルを上書きしない（warning + skip）。再生成したい場合は `--force` を指定する（bundled skills と同じ挙動）。

## 配布形態

- npm パッケージ `@ozzylabs/feedradar`、`bin: radar`
- OIDC Trusted Publishers（[handbook/ADR-0001](https://github.com/ozzy-labs/handbook/blob/main/adr/0001-npm-scope-ozzylabs.md)、[standards/npm-trusted-publishers](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/standards/npm-trusted-publishers.md)）
- 単一パッケージ（pnpm workspace なし）
- engine と user data の分離（[ADR-0005](./adr/0005-user-data-separation.md)）

## Phase 別スコープ

| Phase | 範囲 | 状態 |
|---|---|---|
| Phase 0 | リポ初期化、CI/Release 基盤、本ドキュメント | 完了 |
| Phase 1 (MVP) | `init` / `source add\|list\|remove` / `watch run` (RSS のみ) / `research` (Claude Code 単独で固定) | 完了 |
| Phase 2 | 4 agent adapters + `review` | 完了 |
| Phase 3 | HTML scraping / GitHub Releases / npm registry の追加 source 種別 | 完了 |
| Phase 4 | schedule 雛形（[ADR-0004](./adr/0004-schedule-strategy.md)）を `init --with-routines` / `init --with-actions` で吐く | 完了 |
| Phase 5 | `update` コマンド（既存 research の差分更新）、`dismiss` コマンド | 完了 |
| Phase 6 | npm publish 初版 + Trusted Publisher 登録 | 完了 |
| Phase 7 | VS Code extension | 残タスク |
| Phase 別 (security) | prompt injection 緩和 ([ADR-0009](./adr/0009-untrusted-external-content-handling.md)) — 採択した layer 1 + audit + schema 拡張を sub-issue で段階実装 ([#49](https://github.com/ozzy-labs/feedradar/issues/49) 親 issue) | 進行中（M1c 完了、後続 M2/M3 等は残タスク） |

## 関連 ADR

- [0001 Agent Adapter Interface](./adr/0001-agent-adapter-interface.md)
- [0002 Source Adapter Plug-in Pattern](./adr/0002-source-adapter-plugin-pattern.md)
- [0003 Output Format and Versioning](./adr/0003-output-format-and-versioning.md)
- [0004 Schedule Strategy](./adr/0004-schedule-strategy.md)
- [0005 User Data Separation](./adr/0005-user-data-separation.md)
- [0006 Filter Specification](./adr/0006-filter-specification.md)
- [0007 Skill Bundling and `init` Distribution](./adr/0007-skill-bundling-and-init-distribution.md)
- [0008 Item Status State Machine](./adr/0008-status-state-machine.md)
- [0009 Untrusted External Content Handling for Agent Prompts](./adr/0009-untrusted-external-content-handling.md)

## 関連 Design Docs

- [`design/filter-spec.md`](./design/filter-spec.md) — `core/filter` の評価順序・matchMode・matchFields・edge cases（ADR-0006 の実装寄り詳細）
- [`design/skill-design.md`](./design/skill-design.md) — `.agents/skills/` バンドリング、`init` copy 戦略、SKILL 呼び出しプロトコル（ADR-0001 / ADR-0003 / ADR-0007 / ADR-0008 の実装寄り詳細）
- [`design/source-html.md`](./design/source-html.md) — HTML scraping adapter のセレクタ仕様 / 抽出ルール / encoding ハンドリング（ADR-0002 の HTML kind 実装寄り詳細）
- [`design/threat-model.md`](./design/threat-model.md) — prompt injection 攻撃面 / 被害範囲 / 緩和候補（ADR-0009 の脅威モデル詳細）
