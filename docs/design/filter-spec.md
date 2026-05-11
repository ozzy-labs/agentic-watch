# Filter Specification

> **Status:** v1 — Phase 1 で実装した `agentic-watch` の filter 仕様詳細。設計判断の根拠は [ADR-0006](../adr/0006-filter-specification.md) を参照。

`Source.filters` は、watch run が fetch した item を「items として書き出すか / 捨てるか」を決める唯一の決定機構。本ドキュメントは ADR-0006 の意思決定をユーザー視点の仕様書として記述する。

## スキーマ

```yaml
# sources/<id>.yaml
id: anthropic-news
kind: rss
url: https://anthropic.com/news/rss.xml
filters:
  keywords:        # 一つでも一致したら採用
    - Claude Code
    - agents
  excludeKeywords: # 一つでも一致したら除外（keywords より優先）
    - hiring
  matchMode: word              # word | substring | regex   既定 "word"
  matchFields:                 # 既定 [title, summary]
    - title
    - summary
  caseSensitive: false         # 既定 false
```

Zod スキーマ実装: [`src/schemas/source.ts`](../../src/schemas/source.ts) の `SourceFiltersSchema`。

## 評価順序

ADR-0006 §評価順序に従う。疑似コード:

```python
def evaluate(item, filters):
    # 1. matchFields のテキストを連結（adapter が提供しないフィールドは silently skip）
    haystack = "\n".join(item.field(f) for f in filters.matchFields if item.has(f))

    # 2. case-insensitive なら lowercase 化
    if not filters.caseSensitive:
        haystack = haystack.lower()
        keywords        = [k.lower() for k in filters.keywords]
        excludeKeywords = [k.lower() for k in filters.excludeKeywords]
    else:
        keywords        = filters.keywords
        excludeKeywords = filters.excludeKeywords

    # 3. excludeKeywords ヒット → 除外（最優先）
    for kw in excludeKeywords:
        if match(haystack, kw, filters.matchMode):
            return DROP

    # 4. keywords が空 → 不採用（"keywords 未設定 = match 0 件" の安全側 default）
    if not keywords:
        return DROP

    # 5. keywords のいずれかヒット → 採用（matchedKeywords にヒット内容を記録）
    hits = [kw for kw in keywords if match(haystack, kw, filters.matchMode)]
    return ACCEPT(matchedKeywords=hits) if hits else DROP
```

実装: [`src/core/filter.ts`](../../src/core/filter.ts) の `evaluateFilter`。

## `matchMode` の意味

| mode | 挙動 | 使いどころ |
|---|---|---|
| `word` | 単語境界一致（`\b<kw>\b`）。キーワード中の正規表現メタ文字は literal 扱い（自動 escape） | 通常のブログ監視。誤マッチが少なく、`Rust` が `rustfmt` にヒットしない |
| `substring` | 部分文字列一致 | バージョン番号 / タグ片など、単語の一部にしか現れないトークン |
| `regex` | キーワード文字列を `RegExp(keyword)` として解釈。**無効な正規表現はエラー** | 複雑なパターン（`v\d+\.\d+\.\d+` など）。ユーザーが ReDoS を含めパターンの安全性を負う |

### `matchMode: regex` の安全性

`regex` モードは `new RegExp(keyword, flags)` をそのまま使う。これは強力だが、ユーザー入力が直接コンパイルされるため **ReDoS（指数バックトラック）の責任はユーザーが負う**。Phase 1 の実装方針:

| 防御 | 状態 (Phase 1) | 備考 |
|---|---|---|
| `RegExp` コンパイルタイムアウト | **未実装** | Node.js 標準 `RegExp` には timeout が無い。導入には `vm.Script` を介す改造が必要 |
| キーワード文字列長制限 | **未実装** | Zod スキーマは長さ上限を持たない（`keywords: z.array(z.string()).default([])`）|
| 複雑度上限（ネスト量化子等の静的検査） | **未実装** | `safe-regex` 等の依存追加は YAGNI で見送り |
| 無効 regex の挙動 | `RegExp` コンストラクタが throw し watch run が **その source 単位で失敗** | 他 source は続行する（部分故障の局所化）|
| sources/*.yaml は信頼境界内 | YES | source 定義は **ユーザーがリポジトリにコミットするファイル**であり、外部攻撃者から注入される経路は無い |

これは「`regex` モードに頼るユーザーはパターンの安全性も把握している」という前提で成立する。前提が崩れる（信頼できない投稿者が sources を編集するマルチテナント運用等）場合は ADR-0006 を改訂し、以下のいずれかを採用する:

1. `vm.Script({ timeout })` でコンパイル / 実行を分離
2. `keywords` 各要素の最大長 / 量化子数の静的検査（`safe-regex` 等）
3. `regex` モード自体の opt-out（config flag で禁止）

実装位置: `matchKeyword()` の `mode === "regex"` ブランチ（[`src/core/filter.ts`](../../src/core/filter.ts)）。

## `matchFields` の意味と adapter 別利用可否

| field | 意味 | rss | html | github-releases | npm-registry |
|---|---|:--:|:--:|:--:|:--:|
| `title` | `item.title` | YES | YES | YES | YES |
| `summary` | `item.summary`（RSS なら `<description>`） | YES | YES | YES | YES |
| `body` | 記事本文（feed が構造的に提供する場合のみ） | no | YES (Phase 3) | no | no |
| `tags` | feed が `<category>` / labels を提供する場合 | no | no | YES (Phase 3) | no |

Phase 1 は RSS adapter のみ実装。`matchFields` に `body` / `tags` を指定しても RSS adapter は **silently skip**（エラーにせず、その field を無いものとして扱う）。これにより、複数 source kind を 1 つの YAML 設定で共有でき、後で adapter が増えても自動的に有効化される。

## Edge cases

| ケース | 仕様 | 根拠 |
|---|---|---|
| `keywords: []`（空配列） | 全 item を **除外** | "全件素通り" は実運用で事故のもと。明示的に keywords を書かせる |
| `excludeKeywords` と `keywords` 両ヒット | **除外**（exclude が勝つ） | ADR-0006 §評価順序 step 3 |
| `matchFields: []` | haystack は空文字列。`keywords` 非空でも誰も match しないので **全件除外** | 設定ミスを silently 飲み込まずに済む |
| `matchMode: word` + キーワードが特殊文字（`c++`, `.NET` 等）を含む | 自動 escape して literal 扱い | ユーザーが regex の知識なしで安全に書ける |
| `matchMode: regex` + 無効な regex | `RegExp` コンストラクタが throw。watch run はその source をエラーとして記録し他 source は続行 | 部分故障で全停止しない |
| Summary が `undefined`（RSS 側に description 無し） | `summary` field は haystack から silently skip | RSS の現実は description 任意 |
| 大文字小文字混在の summary + `caseSensitive: false` | haystack/keywords ともに `toLowerCase()` 後に評価 | ADR-0006 §評価順序 step 2 |

## 採用 item の `matchedKeywords`

採用された item は `matchedKeywords: [<hit した keyword 文字列>...]` を持つ。複数 keyword がヒットした場合は **すべて** 記録する（順序は `Source.filters.keywords` の宣言順）。

```yaml
# items/<source-id>/<item-id>.yaml
id: post-1
sourceId: anthropic-news
title: "Claude Code launches new agents capabilities"
matchedKeywords:
  - Claude Code
  - agents
status: detected
```

研究レポート生成時、`matchedKeywords` を agent に渡してフォーカスを絞らせることができる（Phase 2 で活用）。

## 単体テストパターン

[`tests/core/filter.test.ts`](../../tests/core/filter.test.ts) は本仕様の検証 fixture を持つ。以下の観点が網羅されている（追加 / 改変時はこの一覧を更新すること）:

| カテゴリ | テストケース | 期待出力 |
|---|---|---|
| 評価順序 | `keywords: []` | reject（"keywords empty (no-match)"）|
| 評価順序 | いずれかの `keywords` がヒット | accept、`matchedKeywords` に**ヒット順**で記録 |
| 評価順序 | 複数 `keywords` がヒット | `matchedKeywords` に**すべて**記録（宣言順）|
| 評価順序 | `keyword` ヒットなし | reject |
| 評価順序 | `keyword` と `excludeKeyword` 両ヒット | reject（exclude 優先）|
| 評価順序 | `keywords: []` + `excludeKeywords` ヒット | reject |
| matchMode | `word`: 単語境界一致のみ（`rust` は `rustfmt` にヒットしない）| 部分一致は reject |
| matchMode | `substring`: 部分一致 | `rust` が `rustfmt` にヒット |
| matchMode | `regex`: ユーザーパターン | `v\d+\.\d+\.\d+` が `v1.2.3` にヒット |
| matchMode | `regex` + `caseSensitive: false`: `i` フラグ適用 | `\D+` の意味が `\d+` に化けない（pattern source を lowercase しない）|
| matchMode | `regex` + `caseSensitive: false`: 大小混在 haystack | `release` が `RELEASE NOTES` にヒット |
| matchMode | `regex` + `caseSensitive: true` | `release` は `RELEASE NOTES` に reject |
| matchMode | `regex` + 無効パターン (`[invalid`) | `RegExp` コンストラクタが throw |
| matchMode | `word` + 特殊文字 (`v1.0`) | 自動 escape され literal 一致のみ（`v100` は reject）|
| caseSensitive | 既定 `false`（大文字小文字無視）| `CLAUDE` が `claude` にヒット |
| caseSensitive | `true` で厳密一致 | `CLAUDE` は `claude` に reject |
| matchFields | `["title"]` 指定で summary はスキップ | summary のみのヒットは reject |
| matchFields | `["body", "tags"]` (RSS は提供しない) | silently skip して reject |
| matchFields | フィールド連結は改行で区切る | "Claude" + "Code" の跨ぎを `\bClaude Code\b` でヒットさせない |
| filterItems | バッチ呼び出し | match した item のみ返す + `matchedKeywords` 付与 |

### Item fixture (典型例)

```typescript
function makeItem(overrides = {}): Item {
  return {
    id: "i1",
    sourceId: "s1",
    title: "Claude Code releases new agents feature",
    url: "https://example.com/post-1",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    summary: "Anthropic announced new Claude Code agents capabilities.",
    matchedKeywords: [],
    status: "detected",
    ...overrides,
  };
}
```

### 期待出力の表現

`evaluateFilter()` は `accept` 時に **`matchedKeywords` 付与後の `Item`** を、`reject` 時に **`null`** を返す。`filterItems()` は accepted 配列のみを返す。テストは個別 keyword レベルの match / no-match と、`Source` 全体での batch accept / reject を分けて assert する。

## 完全な YAML 例

### 例 A: シンプルな blog 監視

```yaml
id: anthropic-news
kind: rss
url: https://www.anthropic.com/news/rss.xml
filters:
  keywords:
    - Claude
    - MCP
  excludeKeywords:
    - hiring
```

`matchMode` / `matchFields` / `caseSensitive` は既定値（word / [title, summary] / false）で十分。

### 例 B: バージョンタグ監視（substring）

```yaml
id: my-lib-releases
kind: rss
url: https://example.com/releases.atom
filters:
  keywords:
    - v1.
    - v2.
  matchMode: substring
  matchFields: [title]
```

### 例 C: regex で SemVer 抽出

```yaml
id: regex-release
kind: rss
url: https://example.com/releases.atom
filters:
  keywords:
    - "v\\d+\\.\\d+\\.\\d+"
  matchMode: regex
  matchFields: [title]
```

YAML の `\\d` は文字列リテラルとして `\d` を表すので、JS の `RegExp` に `\d` として届く。

### 例 D: 厳密な大文字小文字監視

```yaml
id: case-sensitive-watch
kind: rss
url: https://example.com/feed.xml
filters:
  keywords:
    - GPT
    - LLM
  matchMode: word
  caseSensitive: true
```

略語が普通名詞と衝突する場合に有用。

## 関連

- ADR: [0006-filter-specification](../adr/0006-filter-specification.md)
- 実装: [`src/core/filter.ts`](../../src/core/filter.ts) / [`src/schemas/source.ts`](../../src/schemas/source.ts)
- テスト: [`tests/core/filter.test.ts`](../../tests/core/filter.test.ts)
