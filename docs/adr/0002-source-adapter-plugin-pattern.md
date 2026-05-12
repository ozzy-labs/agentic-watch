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

### Item ID 派生のコントラクト

`Item.id` は adapter が生成する。形式と派生規則は全 adapter で統一する（Phase 1 [#24](https://github.com/ozzy-labs/agentic-watch/pull/24) で確定）:

- **形式**: `<title-slug>-<8 hex of sha256(stableKey)>`（title がスラッグ化不能な場合はハッシュのみ 8 hex）
  - `title-slug`: title を小文字化し `[^a-z0-9]+` を `-` に正規化、長さ 40 で切り詰め
  - ハッシュ部: 8 文字なので衝突は実用上問題にならない範囲。同一 source 内の同名タイトルでも `stableKey` が異なれば別 id になる
- **`stableKey`**: 「同一エンティティの再フェッチで不変な値」を adapter ごとに選定する。優先順位は **publisher が宣言した安定識別子 → 正規化済み URL → 内容ハッシュ** の fallback ladder
  - RSS / Atom: `guid` > `link` > `sha1:` プレフィックス付きの `sha1(title|pubDate)` ハッシュ
  - HTML scraping (予定): 正規化済み page URL > 内容ハッシュ
  - GitHub Releases (予定): `release.id` または `release.tag_name`
  - npm-registry (予定): `<pkg-name>@<version>`
- **publisher の原 ID 保持**: `stableKey` の派生に用いた元 ID（RSS の `guid` 等）は **`Item.raw` に保持** する。`Item.id` を変更しても publisher の元 ID 情報は失われない
- **共通 helper**: 形式生成ロジックは [`src/core/feeds/derive-id.ts`](../../src/core/feeds/derive-id.ts) の `deriveStableKey()` / `deriveItemId()` に集約し、各 adapter から再利用する

新 adapter を追加する手順:

1. `src/core/feeds/{new-kind}.ts` に `FeedAdapter` を実装（id 生成は `deriveItemId()` を使う）
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

- 実装: [`src/core/feeds/types.ts`](../../src/core/feeds/types.ts) / [`src/core/feeds/index.ts`](../../src/core/feeds/index.ts) / [`src/core/feeds/derive-id.ts`](../../src/core/feeds/derive-id.ts)
- 参考: `ozzy-labs/writing-studio` の `feeds/parser.py` / `feeds/site.py`（同種の責務分離を Python で実装した先行例）
