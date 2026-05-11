# ADR-0003: Output Format and Versioning

## Status

Accepted（2026-05-11）

## Context

調査レポートは:

1. ユーザー編集可能で diff レビュー可能であること
2. 履歴を辿れること（agent が間違えた場合に旧版に戻れる）
3. 複数 agent / 複数テンプレートで出力できること
4. ファイル単体で完結し、外部 DB を持たないこと

を満たす必要がある。

## Decision

### フォーマット

- **Markdown + YAML frontmatter** をファイル単体に格納
- `frontmatter` は `Research` schema（[schemas/research.ts](../../src/schemas/research.ts)）と整合:

```yaml
---
id: 20260511_anthropic-claude-code-update_v1
itemIds:
  - anthropic-news-2026-05-10-claude-code
agent: claude-code
templateId: default
createdAt: "2026-05-11T00:00:00Z"
updatedAt: null
reviewedAt: null      # review 実行時に ISO8601 で記録
reviewedBy: null      # review を行った AgentId
---
# Anthropic: Claude Code Update

（本文 Markdown）

<!-- review コメントは本文末尾に追記される -->
```

`reviewedAt` / `reviewedBy` は `agentic-watch review` 実行時に書き込まれる。レビューコメントは本文末尾に追記する（frontmatter には summary を持たない）。

### ファイル命名

```text
research/<YYYYMMDD>_<slug>_v<n>.md
```

- `YYYYMMDD`: 作成日（agent 起動日）
- `<slug>`: 元 item から派生（小文字 + ハイフン）
- `_v<n>`: バージョン番号。初回 `v1`、`update` 実行で `v2`, `v3`, ...

### Versioning ポリシー

- **新バージョンは新ファイル**として作成（既存ファイルは変更しない）
- 旧版は **immutable history** として保持
- frontmatter `updatedAt` は **当該ファイル**の更新時刻（マイナー編集）に使う。バージョン作成は新ファイル
- 同一 source item に対する research は frontmatter `itemIds` で紐づけ

### Status 表現と review の二重更新

`Research` schema 自体には `status` フィールドを持たない。**ライフサイクル状態は item.yaml の `status` で管理**（[ADR-0008](./0008-status-state-machine.md)）。

`agentic-watch review` 実行時の更新先は**二箇所**:

| 更新先 | 内容 |
|---|---|
| `items/<item-id>.yaml` | `status: researched → reviewed` |
| `research/<id>.md` frontmatter | `reviewedAt` / `reviewedBy` |
| `research/<id>.md` 本文末尾 | レビューコメント本文 |

両方の更新は同一 review コマンド実行内でアトミックに行う（部分失敗時は両方ロールバック）。詳細実装は `docs/design/skill-design.md`（[issue #9](https://github.com/ozzy-labs/agentic-watch/issues/9)）で固める。

## Consequences

### 良い面

- git で diff レビューが自然
- 履歴復元は `git log` + 旧版ファイルで完結（agentic-watch 自身は履歴管理機構を持たない）
- agent ごと / template ごとに異なる出力を**別ファイル**として並列保持可能（同 item に対し v1 を claude、v1.b を codex、のようなパターンは将来サポート余地）

### 悪い面 / 制約

- ファイル数が単調増加。`update` を多用するリポでは `research/` が肥大化する
- frontmatter の手書きミスで CLI が parse できなくなる（schema 検証で吸収）

### 中立

- レビューコメントを research ファイル末尾に追記する設計（`agentic-watch review`）。本 ADR の versioning とは独立

## Alternatives

### 案 A: SQLite に格納

- 却下理由: 「ファイル単体で完結」要件に反する。git 連携や手編集が困難

### 案 B: 1 ファイル内に複数バージョンを節として保持

- 却下理由: diff が読みにくく、特定バージョンへの直接 URL も貼れない

### 案 C: 既存ファイルを上書き（git に履歴を任せる）

- 却下理由: 明示的に「v1 / v2 / v3」と並ぶほうが、ローカルでも履歴認知が容易。手元ファイラから旧版を開きやすい

## 関連

- 実装: [`src/schemas/research.ts`](../../src/schemas/research.ts)
- 参考: `writing-studio` の `research/20260215_*_v1` 命名スタイル
