# ADR-0008: Item Status State Machine

## Status

Accepted（2026-05-11）— Phase 1 で `Item` schema に `status` フィールド追加と遷移実装を行う。

## Context

`agentic-watch` は detected → research → review → update のループを回す。session の議論初期には writing-studio の状態モデル（`detected → triaged → researched → reviewed → published → updated`）を引用したが、agentic-watch のスコープに合わせた再評価が必要:

- agentic-watch は **research / review のみ**で、article publishing（writing-studio の `published`）は持たない
- `triaged` はユーザーの「research する / dismiss する」判断ステップ。明示状態として持つか、操作（CLI コマンド）として表現するかが論点

## Decision

Item の `status` は以下の 4 値:

```text
detected ──► (dismissed | researched) ──► reviewed
                         │
                         └─── update は research ファイルの v+1 を作る
                              （item status は変えない）
```

| status | 意味 | 遷移トリガー |
|---|---|---|
| `detected` | watch run が filter 通過後に出力した直後 | `agentic-watch watch run` |
| `dismissed` | ユーザーが「research しない」と判断した terminal 状態 | `agentic-watch dismiss <item-id>` |
| `researched` | research report が `research/` に作成された | `agentic-watch research <item-id> --agent <id>` |
| `reviewed` | 既存 research に対しレビューが実行された | `agentic-watch review <research-id> --agent <id>` |

### Update の扱い

`agentic-watch update <research-id>` は **research ファイルの v+1 を作る**操作。item status は変えない（既に `researched` または `reviewed`）。

### Review の二重更新

`agentic-watch review` 実行時、**item.yaml と research.md の両方**を更新する:

- `items/<item-id>.yaml`: `status: researched → reviewed`
- `research/<id>.md` frontmatter: `reviewedAt` / `reviewedBy` を記録（[ADR-0003](./0003-output-format-and-versioning.md)）
- `research/<id>.md` 本文末尾: レビューコメントを追記

両更新は同一コマンド実行内でアトミックに行う（部分失敗時は両方ロールバック）。

### Triage の扱い

session で言及した `triaged` は**明示状態として持たない**。理由:

- `detected → researched` への遷移自体が「ユーザーが research する判断をした」ことを表す
- `dismissed` で「research しない判断」を表す
- 別状態 `triaged` を挟むと triaged ≠ researched ≠ dismissed の 3 状態が必要になり複雑化

将来「triage が長期化する」「triage 中の一時的なメモを残したい」等の要件が出たら本 ADR を改訂。

### writing-studio との差異

| 概念 | writing-studio | agentic-watch |
|---|---|---|
| article publishing | あり (`published`) | なし（research のみ） |
| triage | 明示状態 (`triaged`) | 暗黙（操作で表現） |
| update | あり (`updated`) | research ファイルの v+1（item status 不変） |

## Consequences

### 良い面

- 4 値で十分シンプル。Phase 1 実装が小さく済む
- terminal 状態が 2 つ（`dismissed` / `reviewed`）のみで、不正遷移を検出しやすい
- `dismiss` という CLI 操作を明示することで、ユーザーが除外した理由を別途記録する余地（コメント等）を将来追加可能

### 悪い面 / 制約

- `reviewed` 後に「もう一度 research し直す」流れは未定義。**現状は `update` で v+1 を作り、これは reviewed のまま留まる**（review は v1 に対して行われたまま）。Phase 2 で `review` を再実行する仕様の決定が必要
- `triaged` がないため、「research 候補だが今は時間がない」という保留状態は表現できない。ユーザーは items YAML を見て手作業で覚える

### 中立

- status は items YAML の単一フィールドとして保存（Phase 1 で `src/schemas/item.ts` に `status: z.enum([...])` を追加）

## Alternatives

### 案 A: writing-studio と完全に同じ 6 状態

- 却下理由: `published` は agentic-watch の機能範囲外。`triaged` は実用上の必要性が薄い

### 案 B: 状態を持たず、ファイルの存在で判定

- `research/<item-id>.md` があれば researched、無ければ detected、等
- 却下理由: `dismissed` を表現できない。複数 research バージョンの整合性管理も複雑化

## 関連

- 実装: [`src/schemas/item.ts`](../../src/schemas/item.ts) の `status` フィールド（Phase 1）
- 詳細仕様: [`docs/design/skill-design.md`](../design/skill-design.md) §1 / §7 / §8（`research` / `review` / `update` 各 skill による status 遷移の駆動、`update` の `items.status` 不変ポリシー）
- architecture.md の「状態遷移（Item）」セクションを本 ADR で正式化
