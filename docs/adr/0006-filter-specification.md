# ADR-0006: Filter Specification

## Status

Proposed（2026-05-11）— 実装は Phase 1 で行う。実装と乖離が出た場合は本 ADR を更新する。

## Context

Source ごとに「どの item を新着として items/ に書き出すか」を決める filter が必要。session で議論した要件:

1. キーワード一致と除外
2. 一致モードの切替（word / substring / regex）
3. 対象フィールドの選択（title だけか、summary も含むか、等）
4. 大文字小文字の扱い

現状の Zod スキーマ（[`src/schemas/source.ts`](../../src/schemas/source.ts)）は MVP として `keywords` / `excludeKeywords` のみを持つ。Phase 1 で本 ADR の範囲まで拡張する。

## Decision

`Source.filters` を以下のフィールドで定義する:

```typescript
filters: {
  keywords: string[];           // 一つでも一致したら採用
  excludeKeywords: string[];    // 一つでも一致したら除外（keywords より優先）
  matchMode: "word" | "substring" | "regex";  // 既定 "word"
  matchFields: Array<"title" | "summary" | "body" | "tags">;  // 既定 ["title", "summary"]
  caseSensitive: boolean;       // 既定 false
}
```

### 評価順序

1. 各 item の `matchFields` 内のテキストを連結した検索対象を作る
2. `caseSensitive: false` の場合、検索対象とキーワード両方を lowercase 化
3. `excludeKeywords` のいずれかが `matchMode` でヒット → 除外（最優先）
4. `keywords` のいずれかが `matchMode` でヒット → 採用
5. それ以外 → 採用しない

### `matchMode` の意味

| mode | 挙動 |
|---|---|
| `word` | 単語境界で完全一致（regex `\b<kw>\b` 相当、デフォルト） |
| `substring` | 部分一致 |
| `regex` | キーワードを正規表現としてコンパイル（無効な regex はエラー） |

### `matchFields` の意味

- `title`: item.title
- `summary`: item.summary
- `body`: item の本文（フィードが本文を提供する場合のみ。RSS は通常無し）
- `tags`: feed が tags / categories を提供する場合

source の `kind` によって利用可能なフィールドは異なる。adapter は利用不可フィールドを silently skip する。

## Consequences

### 良い面

- 用途別の filter 強度を選べる（汎用ブログには `word`、コード スニペット監視には `regex`）
- false-positive を `excludeKeywords` で削れる
- 標準で `title + summary` を見るため、サマリにしかキーワードが出ない記事も拾える

### 悪い面 / 制約

- regex モードは ReDoS の温床になり得る。adapter は正規表現コンパイルに timeout / 長さ制限を入れる（Phase 1 実装時に決定）
- `body` 取得は adapter ごとに対応・非対応が分かれる。**ドキュメントで明示**する

### 中立

- 将来「日付範囲」「言語フィルタ」等を増やす場合は本 ADR を改訂し、フィールド追加で対応

## Alternatives

### 案 A: keyword / excludeKeyword のみ（現状の MVP）

- 却下理由: `match` の粒度が粗く、ノイズが取れない。本物の運用では `excludeKeywords` だけでは不十分だった先例（writing-studio）

### 案 B: SQL 風 where 句

- 却下理由: YAML での記述が冗長になり、ユーザー入力エラーが増える。フィルタ 4 軸で十分

## 関連

- 実装: [`src/schemas/source.ts`](../../src/schemas/source.ts)（Phase 1 で本 ADR に合わせて拡張）
- 詳細仕様 / 例集: `docs/design/filter-spec.md` を Phase 1 実装と並走で起こす（別 issue で追跡）
- 参考: `writing-studio` の `filters` 構造（先行例）
