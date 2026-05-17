# ADR-0003: Output Format and Versioning

## Status

Accepted（2026-05-11、2026-05-16 改訂: Phase 5 で `supersedes` フィールドと update 不変仕様を追記）

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
supersedes: null      # v1 は null。v+1 は前版 id を記録（後述）
---
# Anthropic: Claude Code Update

（本文 Markdown）

<!-- review コメントは本文末尾に追記される -->
```

`reviewedAt` / `reviewedBy` は `radar review` 実行時に書き込まれる。レビューコメントは本文末尾に追記する（frontmatter には summary を持たない）。

`supersedes` は版間の系譜を表す（v1=null、v+1=前版 id）。詳細は後述「Update 系譜と `supersedes` フィールド」節を参照。Phase 5 より前に作成された v1 frontmatter（フィールド自体を持たない）も schema 違反にならないよう、`ResearchFrontmatterSchema` 側で `.nullable().default(null)` を指定している（[`src/schemas/research.ts`](../../src/schemas/research.ts)）。

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

### Update 系譜と `supersedes` フィールド

`radar update <research-id>` は v+1 ファイル (`_v<N+1>.md`) を**新規作成**する操作で、旧版ファイルには一切手を加えない（immutable history）。版間の系譜は frontmatter の `supersedes` で表す:

| 版 | `supersedes` 値 |
|---|---|
| v1 (初版) | `null` |
| v+1 (v2 以降) | 直前版の `id`（ファイル名から `.md` を除いたもの） |

例: `20260612_anthropic-claude-3-7_v2.md` の frontmatter:

```yaml
---
id: 20260612_anthropic-claude-3-7_v2
itemIds:
  - anthropic-news-2026-05-10-claude-code
agent: claude-code
templateId: default
createdAt: "2026-05-11T00:00:00Z"   # v1 の createdAt を引き継ぐ（detection 時系列を保持）
updatedAt: "2026-06-12T00:00:00Z"   # この v+1 ファイルの作成時刻
reviewedAt: null                     # v+1 では reset（v1 の review は引き継がない）
reviewedBy: null
supersedes: 20260612_anthropic-claude-3-7_v1   # 直前版の id
---
```

**v+1 ファイルの不変項目** (`update` 実行で変更してはいけない):

- `itemIds`: 元の item 紐付けは保持（追加 item は別 issue/別 detection 経路で取り扱う）
- `templateId`: v1 と同じテンプレートで再生成（rewrite-and-supersede 戦略のため）
- `createdAt`: v1 の値を引き継ぐ。detection から report までの時系列が `createdAt` で読めるようにする

**v+1 ファイルで reset する項目**:

- `reviewedAt` / `reviewedBy`: `null` に reset。v1 に対する review は v+1 には引き継がれない。v+1 の内容を review したい場合は改めて `radar review` を v+1 に対して実行する（[ADR-0008](./0008-status-state-machine.md) と `docs/design/skill-design.md` §7.5 参照）

**`supersedes` のスキーマ表現**:

[`src/schemas/research.ts`](../../src/schemas/research.ts) で `supersedes: z.string().min(1).nullable().default(null)` として定義する。`.default(null)` を指定する理由は、Phase 5 より前に作成された既存 v1 frontmatter (フィールド自体を持たない) が schema 違反にならないようにするため。`null` 明示と「フィールド不在」は意味的に同じ (どちらも「前版なし」) に揃える。

### `update` 実行と `items.yaml` の `status` 不変仕様

`radar update` は research ファイルの v+1 を作る操作であり、**`items/<sourceId>/<itemId>.yaml` の `status` は不変**とする（[ADR-0008](./0008-status-state-machine.md) で正式化）。

| 状態の保持 | 理由 |
|---|---|
| 既に `reviewed` だった item は `reviewed` のまま | v1 に対する review 事実は失われない。v+1 の review を行う場合は別途 `radar review` を v+1 に対して実行する |
| `researched` だった item は `researched` のまま | item ライフサイクルは research 版数とは独立に管理される |
| `detected` / `dismissed` に対する `update` は禁止 | research が存在しない or 取り下げ済の item に対する v+1 は意味を成さないため CLI 側で reject |

これにより「item lifecycle」と「research file version」が直交した属性になり、運用上の混乱が防げる:

- 「item 単位の何かが進捗したか」は `items.yaml` の `status` を見れば分かる
- 「research の最新版を誰がどう書き換えたか」は `research/*.md` の `supersedes` チェーンと `updatedAt` を辿れば分かる

### Status 表現と review の二重更新

`Research` schema 自体には `status` フィールドを持たない。**ライフサイクル状態は item.yaml の `status` で管理**（[ADR-0008](./0008-status-state-machine.md)）。

`radar review` 実行時の更新先は**二箇所**:

| 更新先 | 内容 |
|---|---|
| `items/<item-id>.yaml` | `status: researched → reviewed` |
| `research/<id>.md` frontmatter | `reviewedAt` / `reviewedBy` |
| `research/<id>.md` 本文末尾 | レビューコメント本文 |

両方の更新は同一 review コマンド実行内でアトミックに行う（部分失敗時は両方ロールバック）。詳細実装は `docs/design/skill-design.md`（[issue #9](https://github.com/ozzy-labs/feedradar/issues/9)）で固める。

## Consequences

### 良い面

- git で diff レビューが自然
- 履歴復元は `git log` + 旧版ファイルで完結（FeedRadar 自身は履歴管理機構を持たない）
- agent ごと / template ごとに異なる出力を**別ファイル**として並列保持可能（同 item に対し v1 を claude、v1.b を codex、のようなパターンは将来サポート余地）
- `supersedes` チェーンを辿れば「どの v1 から派生したか」が CLI/外部スクリプトから機械的に解決できる

### 悪い面 / 制約

- ファイル数が単調増加。`update` を多用するリポでは `research/` が肥大化する
- frontmatter の手書きミスで CLI が parse できなくなる（schema 検証で吸収）
- `update` 後の item は古い `status` のまま留まるため、「reviewed の item の最新 research が v2 でまだ review されていない」状態が出現する。`research/*.md` 側の `reviewedAt` を見ないと気付けない（[`docs/design/skill-design.md`](../design/skill-design.md) §7.5 / §8 で運用ガイドを記述）

### 中立

- レビューコメントを research ファイル末尾に追記する設計（`radar review`）。本 ADR の versioning とは独立

## Alternatives

### 案 A: SQLite に格納

- 却下理由: 「ファイル単体で完結」要件に反する。git 連携や手編集が困難

### 案 B: 1 ファイル内に複数バージョンを節として保持

- 却下理由: diff が読みにくく、特定バージョンへの直接 URL も貼れない

### 案 C: 既存ファイルを上書き（git に履歴を任せる）

- 却下理由: 明示的に「v1 / v2 / v3」と並ぶほうが、ローカルでも履歴認知が容易。手元ファイラから旧版を開きやすい

## 関連

- 実装: [`src/schemas/research.ts`](../../src/schemas/research.ts)
- 関連 ADR: [ADR-0008](./0008-status-state-machine.md)（item status state machine、reviewed→updated 不変仕様の出所）
- update 差分検出戦略と rewrite-and-supersede の詳細: [`docs/design/skill-design.md`](../design/skill-design.md) §2 / §8
- 参考: `writing-studio` の `research/20260215_*_v1` 命名スタイル
