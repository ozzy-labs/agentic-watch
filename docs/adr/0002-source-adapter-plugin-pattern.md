# ADR-0002: Source Adapter Plug-in Pattern

## Status

Accepted（2026-05-11）

## Context

監視対象は RSS フィード以外にも多様で、それぞれ fetch 戦略が異なる:

- **RSS / Atom**: 標準的なフィード parser
- **HTML scraping**: `ETag` / `If-Modified-Since` + content hash
- **GitHub Releases**: GitHub API（rate limit / 認証考慮）
- **npm registry**: registry metadata API（新バージョン検出）

これらを `core/watcher.ts` 内に分岐で書くと、新 source 種別追加のたびに watcher を編集することになり、責務が散らかる。

## Decision

`src/core/feeds/types.ts` に共通 interface を定義し、各 source 種別に対応する adapter を `src/core/feeds/<kind>.ts` に置く。

```typescript
import type { Item, Source } from "../../schemas/index.js";

export interface FeedAdapter {
  kind: Source["kind"];
  fetch: (source: Source) => Promise<Item[]>;
}
```

- `Source["kind"]` は `"rss" | "html" | "github-releases" | "npm-registry"`（[schemas/source.ts](../../src/schemas/source.ts)）
- `core/watcher.ts` は kind から adapter を解決し、interface 経由でのみ fetch を呼ぶ
- 各 adapter は state（`lastEtag` / `lastSeenIds`）を読み取り、新規分のみ返す（実装の詳細は adapter 内）

新 adapter を追加する手順:

1. `src/core/feeds/{new-kind}.ts` に `FeedAdapter` を実装
2. `src/schemas/source.ts` の `SourceKindSchema` に `{new-kind}` を追加
3. `src/core/feeds/index.ts` の registry に登録
4. `tests/feeds/{new-kind}.test.ts` を追加
5. `docs/user-guide.md` の `source add --kind` 一覧を更新

## Consequences

### 良い面

- 新 source 種別の追加が adapter 1 ファイル + registry 1 行で済む
- adapter 内部で fetch 方式を自由に選択可能（HTTP / API / シェルアウト）
- `core/watcher.ts` は薄い orchestrator に留まる

### 悪い面 / 制約

- adapter ごとに state 形式が暗黙に異なる場合がある（RSS は `lastSeenIds`、HTML は `lastEtag` ＋ content hash）。`SourceState` schema は **共通フィールドのみ持ち、adapter 固有は `raw` か別フィールド**で扱う設計判断が将来必要になる可能性

### 中立

- 認証が要る source（private API 等）の credential 管理は adapter 内に閉じる（環境変数経由）

## Alternatives

### 案 A: 1 つの巨大 fetcher で URL から推測

- 却下理由: GitHub Releases と通常 HTML scraping の判別が URL だけでは曖昧。明示的 `kind` のほうが堅牢

### 案 B: 外部 plugin（npm install で動的追加）

- 却下理由: 配布パッケージ前提で過剰。将来需要が出てから検討（YAGNI）

## 関連

- 実装: [`src/core/feeds/types.ts`](../../src/core/feeds/types.ts) / [`src/core/feeds/index.ts`](../../src/core/feeds/index.ts)
- 参考: `ozzy-labs/writing-studio` の `feeds/parser.py` / `feeds/site.py`（同種の責務分離を Python で実装した先行例）
