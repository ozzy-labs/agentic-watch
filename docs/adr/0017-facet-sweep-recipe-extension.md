# ADR-0017: Facet Sweep Recipe Extension for `kind: json-api`

## Status

Accepted（2026-05-23）

## Context

### AWS dirs API の 10,000 件 offset cap（実測）

[ADR-0012](./0012-json-api-adapter-and-recipe-strategy.md) で導入した `kind: json-api` adapter は、AWS What's New (`https://aws.amazon.com/api/dirs/items/search`) の page-based pagination を `pagination.maxPages` まで walk して全履歴を取り込めるはずだった。実装直後の bundled recipe は `directoryId=whats-new` (legacy / 凍結) を指していたため (`maxPages: 200`) これでもカバー可能に見えていたが、PR [#229](https://github.com/ozzy-labs/feedradar/pull/229) で `directoryId=whats-new-v2` (active, totalHits 21,834) に切り替えたところ、`maxPages: 200 × pageSize 100 = 20,000` で最古 ~1,800 件が backfill に乗らない欠落が露呈した。

これに対する初期対応として PR [#232](https://github.com/ozzy-labs/feedradar/pull/232) で `maxPages` を 250 に引き上げ (250 × 100 = 25,000) `tests/recipes/bundled.test.ts` の hard cap も同時に動かした。理論上は totalHits 21,834 を完全カバーするはずだった。

しかし、2026-05-23 に `curl` で endpoint を直接叩いて検証した結果、**AWS dirs API は `(page + 1) × size <= 10000` の hard cap を実装している**ことが判明した:

| `page` × `size`                                 | レスポンス              |
| ----------------------------------------------- | ----------------------- |
| `page=99, size=100` (offset 9,900)              | `items: [100件]` (正常) |
| `page=100, size=100` (offset 10,000)            | `items: []` (空)        |
| `page=0, size=500` × `page=20` (offset 10,000)  | `items: []` (空)        |
| `page=0, size=1000` × `page=10` (offset 10,000) | `items: []` (空)        |
| `pageSize` を変えても境界は 10,000 で一定       |                         |

つまり、`maxPages: 250` に引き上げても **AWS 側が page 100 で打ち切る**ため PR #232 の修正は実質効いていない。`sort_order=desc` (新→古) と `sort_order=asc` (古→新) を両方走らせても 10,000 + 10,000 = 20,000 件にしかならず、中間の ~11 ヶ月分 ~1,834 件 (2021-08-17 から 2022-07-26 付近) は引き続き取り込めない。

### 解決策の発見: year facet

AWS の公開ランディングページ `https://aws.amazon.com/new/` のレンダリング済み HTML を `grep` すると、front-end SPA が year-filter chip に使う `data-facet="whats-new-v2#year"` という属性が見つかる。同じ string format `<directoryId>#year#<YYYY>` を API の `tags.id` クエリパラメタに渡すと:

```bash
curl 'https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new-v2&tags.id=whats-new-v2%23year%232024&...'
```

各年の totalHits は 10,000 の cap を**大幅に**下回る:

| 年   | totalHits | 年   | totalHits |
| ---- | --------- | ---- | --------- |
| 2026 | 842       | 2015 | 452       |
| 2025 | (進行中)  | 2014 | ~250      |
| 2024 | 2,345     | 2013 | ~120      |
| 2023 | ~2,200    | 2012 | ~70       |
| 2022 | 2,101     | 2011 | ~70       |
| 2021 | 2,074     | 2010 | 66        |
| 2020 | 2,294     | ...  | ...       |
| 2019 | ~2,300    | 2004 | 2         |

最大の年 (2020) でも 2,294 件 / 100 件 per page = **23 ページ**で完結し、AWS の 10,000 件 cap (~100 ページ) に余裕で収まる。年単位で sweep すれば、2004 年〜現在の **21,834 件すべて**を欠落なく取得できる。

### archive 系サイトでの類似パターン

facet sweep は AWS 固有の workaround ではなく、archive / news 系の page-based JSON API で**広く見込まれる構造的問題**である:

- 多くの SaaS / clouds が news / changelog の API offset cap を 10,000 前後で持っている (パフォーマンス / DB cursor の現実的な上限)
- 同じ API が「年単位 / カテゴリ単位 / リージョン単位」の filter param を front-end フィルタリングのために露出していることが多い
- 標準仕様 (JSON Feed 1.1 / RSS / Atom) には facet 概念がないため、adapter / recipe 層で吸収する必要がある

## Decision

### D1. top-level `facets:` の追加（option A）

`kind: json-api` の source / recipe schema に top-level の `facets:` セクションを追加する。これは `pagination:` とは **独立した次元** として定義する:

- `pagination:` — 内側 (per-request) のページ繰り返し軸
- `facets:` — 外側 (data slice) の facet 軸

つまり構造は `(outer facet sweep) × (inner page-based pagination)` の二重ループになる。Phase 1 では **単一 facet のみサポート**する (multi-facet は future work、§Scope 参照)。

### D2. Schema

```yaml
facets:
  year:
    type: range
    range: [2004, 2026] # inclusive (両端含む)
    step: 1
    param: tags.id
    template: "whats-new-v2#year#{}"
```

#### 共通フィールド

| field      | type                | 説明                                                                                             |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `type`     | `"range" \| "enum"` | facet の値生成戦略                                                                               |
| `param`    | string              | inject 先の query param 名 (上例では `tags.id`)                                                  |
| `template` | string              | facet 値を埋め込む string テンプレート。**リテラル `{}` プレースホルダ必須** (Zod refine で検証) |

#### `type: range` 固有

| field   | type                                 | 説明                                                                                                                                  |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `range` | `[number, number \| "current-year"]` | inclusive な start / end。end は数値 or `current-year` sentinel ([#257](https://github.com/ozzy-labs/feedradar/issues/257) follow-up) |
| `step`  | `number` (default 1)                 | 正の整数                                                                                                                              |

> **Follow-up ([#257](https://github.com/ozzy-labs/feedradar/issues/257)):** range の上端を数値ハードコードにすると、年 (時刻) 軸 facet が年境界で新着をサイレントに取りこぼす (例: 2027 年に `…#year#2027` を一度もクエリしない)。上端に `current-year` sentinel を許容し、fetch 時 (`generateFacetValues`) に現在のカレンダー年へ解決することで、手動 bump 不要で範囲が wall-clock に追随する。既存の数値タプルは後方互換でそのまま動作する。

#### `type: enum` 固有

```yaml
facets:
  category:
    type: enum
    values: ["compute", "storage", "database"]
    param: category
    template: "{}"
```

| field    | type                      | 説明                          |
| -------- | ------------------------- | ----------------------------- |
| `values` | `Array<string \| number>` | 明示的な値のリスト (min 1 件) |

### D3. Adapter semantics

#### 二重ループ

```text
for facetValue of generateFacetValues(facets[name]):
    url = applyTemplate(source.url, facet.param, facet.template, facetValue)
    yield fetchSingle({ ...source, url, facets: undefined })
```

- 外側 facet loop で URL を `param=template.replace("{}", value)` に書き換える
- 内側は既存の pagination ロジックを **そのまま** 再利用する (`fetchSingle`)
- 既存の `pagination.maxPages` / `--max-pages` / `lastSeenIds` early-stop / 空ページ termination は内側ループ内で従来通り効く

#### 状態管理 (§State)

- **`lastSeenIds` は global**: AWS What's New の item ID (`item.id`) は facet 値を跨いでもユニーク。複数 facet 値で同じ item を観測することはない (year=2024 と year=2023 が同じ post を含まない)。よって、aggregated lastSeenIds set を facet 間で共有して inner loop に渡し、最終的に **union を 1 つ**永続化する
- **`lastEtag` と conditional GET は facet sweep mode で無効化**: 1 つの ETag が N 個の facet 値の状態を表現することはできない。facet 値ごとに別 ETag を保存することは Phase 1 では実装しない (将来必要になったら別 ADR で扱う)。実装上は inner `fetchSingle` の呼び出し前に `state.lastEtag = undefined` で渡し、最終的に永続化する state でも `lastEtag: undefined` とする

#### normal mode vs `--backfill`

- **normal mode**: 外側 facet loop は **全 facet 値を walk**するが、内側 pagination は通常通り page-0 のみで `lastSeenIds` early-stop が効くため、定期実行時のオーバーヘッドは facet 数 × page 1 fetch (AWS 例: ~23 リクエスト/run) に抑えられる。facet 値を 1 つもスキップしないのは、低 traffic facet (例: 古い年) で新着が出た場合に取りこぼさないため
- **`--backfill`**: 外側 facet loop で全 facet 値を walk、かつ内側 pagination も full traversal (recipe の `pagination.maxPages` まで)。AWS 例: 23 年 × 最大 24 ページ = ~552 requests (実測 ~25 sec)
- **`--max-pages N`** CLI override は **inner pagination のみ** に適用される。facet 軸には影響しない

#### dry-run (`source test`)

- `source test <id>` は dry-run なので、facet 軸も **単一の facet 値のみ** を walk する
- これにより selector adoption preview / pagination preview は意味のある情報を保ったまま、`source test` の実行時間が膨張しない
- diag (selectorAdoption / paginationPreview) は **その facet 値の結果**を代表値として返す

> **Revision (2026-05-23, [#256](https://github.com/ozzy-labs/feedradar/issues/256) / [#257](https://github.com/ozzy-labs/feedradar/issues/257)):** 初版は「**最初の 1 facet 値のみ**」(range facet なら range 先頭 = 最古年) を test していたが、recency 系 recipe で常に `matched: 0` となりキーワード検証が機能しない問題があった。range facet は **上端 (最新年) を probe** するよう変更し、#257 で導入した相対上端 (`current-year` sentinel) も解決される。enum facet は「最新」概念が無いため従来どおり先頭値を test する。どの facet 値を test したかは警告として明示される。詳細は末尾の Revision 節を参照。

#### progress reporting

既存の `onPage` callback に加え、facet sweep mode では外側軸も観測可能にする。Phase 1 では既存の `onPage(pageIndex, pageTotal, items)` interface を **per-facet で発火**させる (denominator は inner pagination cap)。`facet=YYYY (i/N)` の表示は CLI 側 (`watch run`) で `onProgress` の `phase()` 呼び出しに合わせて出す。formal な per-facet callback API の追加は Phase 1 では避ける (現状の interface で十分情報が出るため)。

### D4. Bundled recipe (`recipes/aws-whats-new.yaml`)

```yaml
facets:
  year:
    type: range
    range: [2004, 2026]
    step: 1
    param: tags.id
    template: "whats-new-v2#year#{}"
```

- `maxPages` を 250 → **30** に下げる。各年 ≤2,345 件 / 100 件 per page = ≤24 ページのため、30 で約 25% のヘッドルームを残す
- `tests/recipes/bundled.test.ts` の hard cap も 250 → **100** に下げる (将来 bundle される他の recipe に向けた余裕を残しつつ、facet sweep mode が標準になった以上 250 のような巨大値は不要)
- recipe コメントで「10,000 件 cap は facet sweep で回避される」「30 は per-facet inner cap」を明記する

### D5. Scope (Phase 1 限定)

| 項目                                           | Phase 1                       | 後続                                   |
| ---------------------------------------------- | ----------------------------- | -------------------------------------- |
| 単一 facet sweep                               | ✅                            |                                        |
| `type: range` / `type: enum`                   | ✅                            |                                        |
| **multi-facet (year × category 等)**           | ❌ (adapter が runtime error) | future ADR で composition rules を確立 |
| **per-facet ETag tracking**                    | ❌ (conditional GET 無効)     | future ADR で必要性が出たら検討        |
| facet ごとの異なる selector / template / param | ✅ (record shape)             |                                        |
| CLI flags (`--facet-*`)                        | ❌ (recipe のみ)              | future issue                           |

## Consequences

### 良い面

- **AWS What's New の完全 backfill が実現** (21,834 件、欠落なし)
- **PR #232 の 250 ページ cap が superseded**: per-facet inner cap で十分。各 facet 値が 10,000 件 cap 未満なので、cap 値の "正しさ" を巡る議論が消える
- **archive 系サイトの類似パターンに転用可能**: GitHub Releases (リポ別)、cloud changelog (リージョン別) 等で同じ pattern が効く
- **既存 recipe / source は無変更**: `facets:` は optional、`facets:` 無しの recipe は従来通りの `(pagination のみ)` ループ
- **schema 拡張性が確保された**: `pagination.type: facet` (却下案 D) と違い、multi-facet を追加する時に schema を破壊しない

### 悪い面 / 制約

- **conditional GET が facet sweep mode で無効化**: 通常の `--bootstrap` モード後の差分 fetch でも全 facet を walk する。AWS 例で run あたり ~23 リクエスト (facet 数 × page 0) が発生。一般的な site の rate limit には収まる想定だが、極端な低 facet cardinality の API では invariant が崩れる可能性あり
- **adapter 複雑度 +1 loop**: 外側 facet 軸が追加されたぶん、debug 時に「どの facet 値で問題が起きたか」を追う必要が出る (progress reporter で軽減)
- **Phase 1 では multi-facet が runtime error**: schema 上は record shape (2+ entry を受け付ける) だが adapter が `length > 1` で throw する。これは forward-compat (schema 安定) を取った代償
- **per-facet lastErrorReason / lastFetchedAt が追跡されない**: 1 facet 値で 500 が出ても、他 facet の成功と aggregate された state が永続化される。Phase 1 では一律「success / fail のいずれか」のシンプルなセマンティクス
- **state ファイルの `lastSeenIds` が大きくなる**: AWS の場合 21,834 ID が global lastSeenIds に蓄積される (~1 MB の YAML)。既存の lastSeenIds rotation policy (将来必要なら別 ADR で導入) との整合はまだ取れていない

### 中立

- `tests/recipes/bundled.test.ts` の hard cap が 250 → 100 に下がる。AWS が facet sweep に乗ったため bundled recipe で 100 を超える recipe は当面想定しない
- ADR-0012 §D2 (pagination type enum) と本 ADR (facets) は **独立した axis** であり、enum を増やす必要はない

## Alternatives

### 案 D: `pagination.type: facet` に追加する

`SourcePaginationSchema.type` の enum に `"facet"` を追加し、pagination の 1 形式として扱う案。

```yaml
# 案 D (却下)
pagination:
  type: facet
  facetSpec: { ... }
```

**却下理由**:

1. **multi-facet support で破綻する**: `pagination.type` は単一値の enum (`page | offset | cursor | link-header | token | none`)。将来 (e.g. `year × category` のような 2 軸 sweep) を追加する時、`pagination.type` には 1 つの値しか入らないため、`type: "facet"` × `type: "page"` の合成を表現できない
2. **概念が混ざる**: pagination は「1 つのリクエスト集合の中での進み方」、facet は「データセット全体を slice する切り口」で性質が異なる。同じ key に入れると `pagination.type: facet` の中の `pagination.maxPages` の意味が「outer × inner どっち?」と曖昧になる
3. **schema migration コスト**: 後から「やはり別軸でした」と気付いて分離するのは breaking change だが、最初から分離しておけば追加で問題ない

option A (top-level `facets:`) は **独立 axis** として宣言できるため、上の問題がすべて回避される。詳細は §D1。

### 案 X: facet sweep を実装せず、欠落 ~1,834 件を諦める

`desc + asc` の組み合わせで totalHits 21,834 中 ~20,000 件 (~91%) はカバーできるため、残り ~9% を「許容」とする案。

**却下理由**:

- AWS What's New backfill のユーザー期待が「全件」であることは明確 ([#230](https://github.com/ozzy-labs/feedradar/issues/230) でも全件カバーが目標)
- 欠落区間が ~11 ヶ月の連続帯 (2021-08-17 〜 2022-07-26) で、ピンポイントで「Lambda の何々」を探したい時に取れないのは UX として致命的
- facet sweep は実装コスト +1 loop 程度で済む

### 案 Y: 別 endpoint / 別 adapter で対応

AWS の rss / atom feed や、別の history endpoint があればそちらに切り替える案。

**却下理由**:

- 既存 RSS は ~57 件 rolling window cap で過去履歴が取れない (ADR-0012 §Context 参照)
- AWS public API で full history を返す endpoint は dirs API しか発見できていない
- そもそも facet sweep は一般化された技術であり、AWS 専用の workaround にしない方がエコシステム的に有益

## 関連

- 親 PR / 関連 PR:
  - PR [#229](https://github.com/ozzy-labs/feedradar/pull/229) — `directoryId` を `whats-new-v2` に切り替え (本問題の発端)
  - PR [#232](https://github.com/ozzy-labs/feedradar/pull/232) — `maxPages` を 250 に引き上げ (本 ADR で superseded)
  - issue [#230](https://github.com/ozzy-labs/feedradar/issues/230) — 200 → 250 引き上げの議論 (本 ADR が根本解決)
- 関連 ADR:
  - [ADR-0012 JSON API Adapter and Recipe Bundling Strategy](./0012-json-api-adapter-and-recipe-strategy.md) — `kind: json-api` 本体。本 ADR で facet sweep 拡張を追加。ADR-0012 §D2 (pagination type enum) は不変
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) — facet sweep でも全リクエストが ADR-0009 の boundary 上で処理される (`trustLevel` / size cap / host blocklist)
- 関連 docs:
  - `docs/user-guide.md` (`#--kind-json-api`) — facet sweep の使い方を追記

## Revision (2026-05-23, [#256](https://github.com/ozzy-labs/feedradar/issues/256) / [#257](https://github.com/ozzy-labs/feedradar/issues/257))

### 動機

初版の dry-run 仕様 (上記 §dry-run) は `source test` が facet 軸の **最初の 1 facet 値のみ** を walk すると定めていた。range facet では range 先頭 = 最古年が test されるため、recency 系の recipe (バンドル `aws-whats-new` の `facets.year`、range `[2004, current-year]`) で次の問題が顕在化した:

- "Amazon Quick" のような 2025+ のブランドキーワードは 2004 年のアーカイブには出現せず、`source test` が常に `matched: 0` を返す
- 「キーワードが当たるか」を確認する最重要ツールが、フラッグシップ recipe で実質無効になっていた ([#256](https://github.com/ozzy-labs/feedradar/issues/256))

あわせて、range facet の上端がハードコード (`[2004, 2026]`) のままだと年境界で新着をサイレントに取りこぼす問題も判明した ([#257](https://github.com/ozzy-labs/feedradar/issues/257))。

### 改訂後の方針

- **range facet の上端を相対指定可能に** ([#257](https://github.com/ozzy-labs/feedradar/issues/257)): `range` の上端に `current-year` sentinel を許容し、実行時の現在年へ自動拡張する。out-of-range 年は 0 件即終了なので安全。既存の数値タプル (`[2004, 2026]`) は後方互換で受け付け続ける。
- **`source test` は range facet で上端 (最新年) を probe** ([#256](https://github.com/ozzy-labs/feedradar/issues/256)): dry-run の単一 facet 値選択を「先頭値」から、range facet に限り「上端 (= 最新年。`current-year` sentinel も解決後の値)」へ変更。これにより recency 系 recipe でも最新コンテンツに対してキーワード検証ができる。enum facet は「最新」概念が無いため従来どおり先頭値を test する。
- **どの facet 値を test したか明示**: `facet sweep 有効: year=2026 のみ test 中（全 facet 値は walk しない）` のように、test 対象の facet 値を警告として表示し、サイレントな誤認を防ぐ。

これにより上記 §dry-run の「最初の 1 facet 値のみ」記述は range facet については本 Revision で上書きされる (enum facet の挙動は不変)。実装は `src/core/feeds/json-api.ts` / `src/cli/source.ts`、利用方法は `docs/user-guide.md` を参照。
