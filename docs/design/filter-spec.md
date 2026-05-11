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

`regex` モードは `RegExp` をそのまま使う。Phase 1 ではタイムアウトを設けていないため、ユーザーが意図的に破壊的パターンを書けば watch run がブロックする可能性がある。将来 `vm` ベースの timeout を導入する場合は本仕様を改訂する（ADR-0006 §Consequences）。

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
