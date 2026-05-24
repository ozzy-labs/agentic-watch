# Architecture Decision Records (FeedRadar)

FeedRadar プロジェクト**内部の**設計判断を記録する。OzzyLabs 横断の方針は [handbook/adr/](https://github.com/ozzy-labs/handbook/tree/main/adr) を参照（2 階層 ADR 構成）。

## ファイル命名

- `NNNN-<slug>.md` — ゼロ詰め 4 桁連番 + kebab-case slug
- 例: `0001-agent-adapter-interface.md`

## フォーマット

各 ADR は以下のセクションを持つ:

1. **Status** — `Proposed` / `Accepted` / `Superseded by #N` / `Deprecated`
2. **Context** — 背景・制約・問題
3. **Decision** — 採用する設計
4. **Consequences** — 採用結果のメリット・デメリット
5. **Alternatives** — 検討した代替案と却下理由（任意）

## 一覧

| # | Title | Status |
|---|---|---|
| [0001](./0001-agent-adapter-interface.md) | Agent Adapter Interface | Accepted |
| [0002](./0002-source-adapter-plugin-pattern.md) | Source Adapter Plug-in Pattern | Accepted |
| [0003](./0003-output-format-and-versioning.md) | Output Format and Versioning | Accepted |
| [0004](./0004-schedule-strategy.md) | Schedule Strategy | Accepted |
| [0005](./0005-user-data-separation.md) | User Data Separation | Accepted |
| [0006](./0006-filter-specification.md) | Filter Specification | Accepted |
| [0007](./0007-skill-bundling-and-init-distribution.md) | Skill Bundling and `init` Distribution | Accepted |
| [0008](./0008-status-state-machine.md) | Item Status State Machine | Accepted |
| [0009](./0009-untrusted-external-content-handling.md) | Untrusted External Content Handling for Agent Prompts | Accepted |
| [0010](./0010-html-js-adapter-and-distribution.md) | html-js Adapter and Playwright Distribution | Accepted |
| [0011](./0011-digest-research-output.md) | Digest Research Output | Accepted |
| [0012](./0012-json-api-adapter-and-recipe-strategy.md) | JSON API Adapter and Recipe Bundling Strategy | Accepted |
| [0013](./0013-skipped.md) | _(skipped — recipe bundling strategy was integrated into ADR-0012 §X5 rather than carved out as a standalone ADR)_ | Not Applicable |
| [0014](./0014-workflow-generate-and-auto-research-safety.md) | Workflow Generate (後追い生成) と自動 research セーフティ方針 | Accepted |
| [0015](./0015-progress-reporting-ux.md) | Progress Reporting UX | Accepted |
| [0017](./0017-facet-sweep-recipe-extension.md) | Facet Sweep Recipe Extension for `kind: json-api` | Accepted |
| [0018](./0018-triage-extension.md) | LLM-based Triage Extension for Scheduled Workflows | Accepted |
| [0019](./0019-host-agent-execution-mode.md) | Host-agent (in-session) Research Execution Mode | Accepted |
| [0020](./0020-claude-routines-generation.md) | Claude Routines Generation (自セッション完結・spawn しない原則) | Accepted |
| [0021](./0021-i18n-strategy.md) | i18n Strategy (en/ja・locale 解決・英語正本プロンプト・user-facing 限定) | Accepted |

## 新規 ADR の追加

1. `0000-template.md` を雛形にコピー（無ければ既存 ADR から）
2. 番号は **次の連番**を採る（status が `Superseded` でも欠番にしない）
3. 本 README の一覧テーブルに追加
4. 既存 ADR を superseded する場合、旧 ADR の Status を更新し、新 ADR から参照
