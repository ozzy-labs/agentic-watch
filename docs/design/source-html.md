# HTML scraping adapter design

> **Status**: accepted (2026-05-12)
> 関連 ADR: [ADR-0002](../adr/0002-source-adapter-plugin-pattern.md) Source Adapter Plug-in Pattern
> 関連 Issue: [#36](https://github.com/ozzy-labs/agentic-watch/issues/36)

ADR-0002 で導入した `FeedAdapter` インタフェースに準拠する HTML adapter (`src/core/feeds/html.ts`) の設計メモ。本ドキュメントは parser の選定根拠と selector schema の契約を記録する。

## HTML parser の選定

HTML adapter は `Source.selectors` の CSS セレクタを使って item を抽出するため、parser に求める要件は以下:

1. **CSS セレクタが標準搭載** — 別途 `css-select` を組み合わせる構成は依存が増える
2. **メンテナンス継続** — 直近 1 年以内に release 実績がある
3. **ESM ネイティブ** または ESM 互換 — 本プロジェクトは `"type": "module"`
4. **小さい install footprint** — agentic-watch 本体は CLI で end-user に install される

### 候補比較

| parser | CSS selector | 直近 release | bundle/deps | 備考 |
|---|---|---|---|---|
| **node-html-parser** | あり (CSS3 範囲) | 2025-2026 で活発 | 単一パッケージ、依存 0、tarball ~30 KB | 採択。lenient な HTML parser で実 web サイトに強い |
| cheerio | あり (`css-select`) | 活発 | parse5 + css-select + dom-serializer 等を内包、~200 KB+ | jQuery 風 API は不要。重い |
| linkedom | あり (`css-select`) | 活発 | より完全な DOM (DOMParser 等) を提供、~150 KB | DOM 互換性は HTML adapter には過剰 |
| parse5 | なし（DOM のみ） | 活発 | small | CSS セレクタを別途実装する必要があり、要件 1 を満たさない |
| fast-html-parser | あり | 古い、メンテ低下 | small | 要件 2 を満たさない（`node-html-parser` の前身相当） |

### 決定

**`node-html-parser`** を採択する。

- 単独で CSS セレクタによる item 列挙 + テキスト抽出 + attribute 取得を完結できる
- 依存パッケージなし。footprint が最も小さい
- 実 web サイトに頻出する不正な HTML を寛容に扱う
- `HTMLElement.querySelector(All)` / `getAttribute` / `text` / `structuredText` の API は cheerio/linkedom 経由でも同等。乗り換え時の移植コストは限定的

### 不採用理由

- **cheerio**: jQuery 風 API 全体は scraping 用途では過剰。`$()` チェーンを使わず `querySelectorAll` 互換だけ使うなら `node-html-parser` のほうが軽量
- **linkedom**: 完全な DOM API は本 adapter では不要 (Element creation / mutation を行わない)
- **parse5 / fast-html-parser**: CSS セレクタを内蔵していない / メンテが止まっている

## Selector contract

`Source.selectors` のフィールドは CSS3 セレクタ文字列で、以下のセマンティクスを持つ:

| field | 必須 | 評価コンテキスト | 抽出方法 |
|---|---|---|---|
| `item` | yes | document root | 各 match を 1 件の Item とする |
| `title` | yes | item 要素配下 | テキスト (`structuredText`) |
| `link` | yes | item 要素配下 | `href` 属性。属性が無ければテキスト |
| `summary` | no | item 要素配下 | テキスト |
| `publishedAt` | no | item 要素配下 | `datetime` / `content` / `value` 属性のいずれかを優先、無ければテキスト。`new Date()` で ISO 8601 に正規化、parse 失敗時は drop |
| `body` | no | item 要素配下 | テキスト（`SourceFilters.matchFields` で `body` を選択した場合に filter で使用される） |
| `tags` | no | item 要素配下 | 全 match 要素のテキストの配列 |

要件:

- `item` が 1 件も match しなければ adapter は空配列を返す（エラーではない。空ページは正常応答）
- `title` / `link` のいずれかが空の item は drop （`raw` には保持されない）
- `publishedAt` の解析失敗は drop ではなく `undefined` に降格する（RSS adapter と同じ）

## Item id 派生

`deriveStableKey()` / `deriveItemId()` ([`src/core/feeds/derive-id.ts`](../../src/core/feeds/derive-id.ts), ADR-0002 改訂版) を再利用する。HTML には publisher id が無いため候補は次の通り:

1. `publisherId`: なし
2. `url`: link selector の抽出結果（item の正規 URL）
3. `fallbackHashInputs`: `[title, publishedAt]`

これにより `Item.id` は `<title-slug>-<8 hex>` 形式 ([#24](https://github.com/ozzy-labs/agentic-watch/pull/24) 互換) になり、URL が変わらない限り再 fetch 後も同一 id が再現する。

## 再 fetch 戦略

HTTP レイヤと content hash の二段構え:

1. **HTTP 304 (`ETag` + `If-Modified-Since`)**: RSS adapter と同じ。前回の `lastEtag` を `If-None-Match` に載せ、server が 304 を返したら `notModified: true` を返して item 処理を skip
2. **Content hash dedup**: 200 で返ってきた本体を **生 HTML 全体** で sha256 し、前回 hash と一致したら同様に `notModified: true` 扱い。`lastEtag` を持たない server / 動的フッタで ETag が壊れている server に対する fallback として動作する。hash は `SourceState.lastEtag` フィールドに `"sha256:<hex>"` 形式で書き込み、ETag と同一の slot に共存させる（後述）

state schema を破壊変更せずに済ませるため、HTML adapter は `lastEtag` を次のいずれかとして書く:

- server が ETag を返した場合: そのまま (`"...""`)
- ETag が無く content hash で fallback した場合: `sha256:<hex>` プレフィックス付き

次回の fetch 時は先頭 `sha256:` を見て分岐する:

- 通常 ETag 値 → `If-None-Match` に載せる
- `sha256:<hex>` → `If-None-Match` には載せず、応答 body の sha256 と比較する

`SourceState` 自体に新フィールドを追加すると state migration が必要になるため、本 Phase では `lastEtag` を兼用する小さなトリックで済ませる。将来 RSS 以外の adapter が増えて衝突が発生した場合は `SourceState.lastContentHash` を追加するかを別 issue で議論する。

## tests

`tests/core/feeds/html.test.ts` で以下を検証:

1. 標準的な fixture (Anthropic Changelog 風 / OpenAI Blog 風) で selectors 適用と Item 正規化
2. `publishedAt` を `<time datetime="...">` 属性から抽出
3. item 要素が無い HTML で空配列
4. title / link が空の item は drop
5. ETag based 304 で `notModified: true`
6. content hash based 304 (server が ETag を返さない場合) で `notModified: true`
7. id 派生が `<title-slug>-<8 hex>` 形式で安定

## スコープ外

- JavaScript rendering (Playwright / Puppeteer) — 別 Phase
- 認証付き scraping — 別 Phase
- robots.txt 自動遵守 — 信頼できる feed source のみ登録する運用前提 (user-guide.md "セキュリティ" 節を参照)
- 動的 selectors (XPath / 正規表現) — 必要に応じて別 issue
