# ADR-0012: JSON API Adapter and Recipe Bundling Strategy

## Status

Proposed（2026-05-22）— 親 epic [#172](https://github.com/ozzy-labs/feedradar/issues/172) の起点 ADR。実装は sub-issue (#173 / #174 / #176 / #177 / #178 / #181 / 他) に分割。本 ADR は **採用方針の確定**のみを行う。

## Context

### 動機: AWS What's New 100 件 cap 問題

AWS What's New の公式 RSS (`https://aws.amazon.com/about-aws/whats-new/recent/feed/`) は ~57 件の rolling window cap で配信されており、過去履歴を取得できない。FeedRadar が "公式 changelog / release notes 追跡" のコア用途で AWS のような大規模ベンダーをカバーするには、`--bootstrap` で seed しても **古い release は永遠に items として観測できない**問題がある。

一方、同 API endpoint `https://aws.amazon.com/api/dirs/items/search` は `totalHits: 16,281`（2004 年〜現在の全履歴）をページング JSON で返す。これは既存 5 adapter (`rss` / `html` / `html-js` / `github-releases` / `npm-registry`) のいずれでも扱えない:

| 既存 adapter | AWS What's New API への適合性 |
|---|---|
| `rss` | RSS 形式ではない (JSON API) |
| `html` | HTML ではない (JSON body) |
| `html-js` | DOM 不要、Chromium overkill |
| `github-releases` | GitHub 専用 |
| `npm-registry` | npm 専用 |

### 類似 API の多様性

同様のページング JSON API は AWS だけでなく広く存在する。観測した範囲:

- `dev.to` `https://dev.to/api/articles?page=N`
- Anthropic news `https://www.anthropic.com/api/news?page=N`
- OpenAI changelog API
- Cloudflare changelog API
- Vercel changelog API
- Hacker News Firebase REST (`https://hacker-news.firebaseio.com/v0/...`)

これらは **page-based JSON** という共通構造を持つが、レスポンス schema (`items[*]` / `data[*]` / `results[*]` / 直接配列) や pagination 形式 (page / offset / cursor / Link header) は site ごとに異なる。

### 業界標準の欠如

JSON API に **業界標準フォーマットが無い**ことが汎用化の障害となる:

- RSS / Atom: W3C / IETF 標準、parser 1 つで広範囲をカバー
- JSON Feed 1.1 ([`jsonfeed.org/version/1.1`](https://jsonfeed.org/version/1.1)): 標準仕様は存在するが、AWS / dev.to 等の主要 API は採用していない
- 大半の JSON API は **ad-hoc な site 固有 schema**

このため「JSON URL を 1 つ食わせれば動く」zero-config は **原理的に不可能** で、site ごとの recipe（YAML 設定）が必要となる。

### 検討された汎用化軸

| 軸 | 選択肢 |
|---|---|
| **kind 設計** | (a) AWS 専用 adapter (`kind: aws-whats-new`) / (b) 汎用 `kind: json-api` + recipe / (c) 完全 JS expression recipe |
| **standard 対応** | JSON Feed 1.1 を別 `kind: json-feed` で先行対応するか、`kind: json-api` の特殊ケースとして扱うか |
| **recipe バンドル戦略** | (A) リポ同梱 / (B) 別パッケージ / (C) ユーザー手書きのみ |
| **過去履歴取得 semantics** | 既存 `--bootstrap` を拡張 / 新規 `--backfill` を分離 |
| **LLM 補助** | recipe を LLM が draft 生成する CLI を提供するか |

## Decision

### D1. 階層的汎用化モデル (L0 / L1-L2 / L3)

zero-config の限界と特化 adapter の保守コストの間で、3 階層モデルを採用する:

```text
L0: zero-config (URL のみで動く)
    ├ kind: rss             ← 既存
    └ kind: json-feed       ← Phase 2 で追加 (JSON Feed 1.1 標準)

L1-L2: recipe-based (recipe 1 つで動く、汎用 adapter + 設定)
    └ kind: json-api        ← Phase 1 で追加 (本 ADR の主役)
       ├ AWS What's New     (page-based)
       ├ dev.to             (page-based)
       ├ Anthropic news     (page-based)
       └ ...

L3: 特化 adapter (domain logic を保持する)
    ├ kind: html            ← 既存 (CSS selector の評価コンテキストが特殊)
    ├ kind: html-js         ← 既存 (Chromium 隔離 / hardening policy)
    ├ kind: github-releases ← 既存 (rate limit / token / 短縮 URL パース)
    └ kind: npm-registry    ← 既存 (packument 構造 / typosquat 警告)
```

**設計原理**:

- **新規 site の対応コストを ~150 LoC → ~30 行 YAML に圧縮**: L1-L2 で済む site は recipe だけで対応完了。adapter 本体に手を入れない
- **既存 L3 特化 adapter は温存**: rate limit warning / 短縮 URL パース / packument の structural 知識は recipe では表現困難で、特化 adapter のほうが ROI が高い
- **L0 を JSON Feed 1.1 で広げる**: 標準仕様準拠の site は URL のみで動かす

### D2. `kind: json-api` adapter の採用

汎用 adapter `kind: json-api` を Phase 1 で追加する。

#### Recipe (Source) スキーマ概要

```yaml
kind: json-api
url: https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new&...
http:
  method: GET                    # Phase 1 では GET のみ
  headers:
    Authorization: "Bearer ${GITHUB_TOKEN}"  # env var interpolation (後述 D5)
pagination:
  type: page                     # page | offset | cursor | link-header | token
  param: page
  start: 1
  pageSize: 100
  pageSizeParam: size
  maxPages: 200                  # 上限 (DoS / 無限 loop 防御)
selectors:
  items: "$.items[*]"            # JSONPath-lite
  id: "$.item.id"
  title: "$.item.additionalFields.headline"
  url: "$.item.additionalFields.headlineUrl"
  publishedAt: "$.item.dateCreated"
  body: "$.item.additionalFields.postBody"
```

#### JSONPath-lite

完全な JSONPath 仕様 (filter expression / script expression / recursive descent) は **範囲外**。最小サブセット (`$.a.b[*].c` レベル) のみを外部 dep なしで実装する。

| 構文 | 範囲内 | 範囲外 |
|---|---|---|
| `$.field` | ✅ | |
| `$.array[*]` | ✅ | |
| `$.array[0]` | ✅ | |
| `$.a.b.c` (chain) | ✅ | |
| `$..field` (recursive) | | ❌ |
| `$.array[?(@.x > 1)]` (filter) | | ❌ |
| `$.array[*].field` (chain after `[*]`) | ✅ | |

理由:

- 外部依存を増やさない (`jsonpath-plus` 等は ~30 KB)
- filter expression は recipe の表現力としては過剰、site 側に対応エンドポイントがあるはず
- 必要な site が現れたら段階拡張可能 (バージョン互換は保つ)

#### デフォルト selector chain (`source test` で確認)

`selectors.items` が指定されない場合、以下の chain を試行する:

```text
$.items[*] || $.data[*] || $.results[*] || $.posts[*] || $.entries[*] || $[*]
```

これにより「素直な API」は recipe 数行で済む。chain の最終マッチを `source test` の output で表示し、recipe 作者が確認できるようにする。

### D3. Recipe バンドル戦略の決定: **案 A (リポ同梱)** を採用

#### 比較

| 案 | バンドル方法 | install 体験 | 保守コスト | CI smoke test | 採否 |
|---|---|---|---|---|---|
| **A. リポ同梱** | `recipes/*.yaml` を npm package に含める | ユーザー何もせず動く | recipe 内のセレクタが site 変更で壊れた時に main repo の issue 化 | **必須** (公開 recipe が壊れているのに知らずに ship する事故防止) | **採用** |
| B. 別パッケージ | `@ozzylabs/feedradar-recipes` を別 publish | コア install 後に追加 install | コアと独立 release / breaking change の伝播管理が別 release-please | 別 repo / 別 CI 必要 | 却下 |
| C. ユーザー手書きのみ | docs に YAML 例を貼って参考にしてもらう | コピペで動かす | 0 (FeedRadar 側) | 不要 | 却下 |

#### 採用理由 (案 A)

1. **DX 優先**: 「`radar source add aws-whats-new` で recipe 適用 → そのまま `watch run --backfill`」が動く。AWS / dev.to / Anthropic は FeedRadar の事実上のリファレンスケース
2. **release 運用が単純**: release-please の single-package model を維持できる (cf. ADR-0010 D3 の `@feedradar/html-js` 分離却下と同じ理由)
3. **CI smoke test が repo 内で完結**: 「公式 recipe が site の breaking change で壊れていないか」を main CI の matrix job で検証できる。外部 site 依存の flakiness は許容する代わりに、`recipes-smoke` job 単独で fail させて main green を汚さない設計 (詳細は #178)

#### 却下理由 (案 B)

- monorepo / 別 publish workflow が必要、release 運用コストが増加する
- breaking change (`kind: json-api` の schema 変更) が core ↔ recipes 間で循環する
- ユーザー視点で「`feedradar` install 後に `@ozzylabs/feedradar-recipes` も install」となり、手数が増える
- recipe が 10 個を超え、site ごとの release cadence が分離するべき規模になったら **本 ADR を superseded する形で再評価** (現状 3 個から始めるため過剰)

#### 却下理由 (案 C)

- 「URL を `add` するだけで AWS What's New が動く」というコア DX を実現できない
- ユーザーごとに recipe の品質がばらつき、breaking site change への対応も個別
- docs に「公式 recipe」が存在しないと、recipe 書き方の reference が無い

### D4. `--bootstrap` と `--backfill` のセマンティクス分離

#### 既存 `--bootstrap` のセマンティクス (不変、後方互換維持)

`radar watch run --bootstrap` の現状の意味 ([`src/cli/watch.ts:71`](../../src/cli/watch.ts) help):

> Seed lastSeenIds without emitting items (suppress initial noise)

- **目的**: 既存購読の "初回ノイズ抑制"
- **挙動**: 全 fetch 結果の id を `state.lastSeenIds` に書き込むが、items/ には何も書かない
- **想定 use case**: 既に運用中の blog feed を `radar source add` した直後、過去 50 件を items として一気に流したくない場合
- **state 書き込み**: lastSeenIds のみ
- **items/ 出力**: 0 件

#### 新規 `--backfill` のセマンティクス (D4 で確立)

`radar watch run --backfill` の意味:

> Fetch all available history pages and create items for everything observed.

- **目的**: 過去履歴の取り込み
- **挙動**: pagination を `pagination.maxPages` まで辿り、全 page の items を normalize して items/ に書き込む。`state.lastSeenIds` も埋まる
- **想定 use case**: AWS What's New を `kind: json-api` recipe で `add` した直後、2004 年〜現在の 16,281 件すべてを items として観測したい
- **state 書き込み**: lastSeenIds + lastFetchedAt
- **items/ 出力**: 全 page 分

#### 分離の根拠

| 観点 | `--bootstrap` を拡張する案 (却下) | `--backfill` を分離する案 (採用) |
|---|---|---|
| **既存ユーザー影響** | 「seed only, no items」を期待しているユーザーが大量 items 出力で驚く | 後方互換 ✅ |
| **CLI 表現力** | `--bootstrap` 1 flag に "no items" / "all history" の 2 意味が衝突 | 2 flag が排他的、help でも明確 |
| **state 整合性** | bootstrap 時に items を書くと "lastSeenIds に id があるのに items も既に存在する" 矛盾が生まれる | backfill は両方書く、bootstrap は state のみ |
| **mental model** | "bootstrap = seed" の慣用と衝突 | "bootstrap = 静か" / "backfill = 全部取る" で対称 |

`--bootstrap --backfill` の併用は **エラー**とする (排他)。help 文に明示する。

#### 既存 adapter での `--backfill` 挙動

| kind | `--backfill` 対応 | 挙動 |
|---|---|---|
| `rss` | partial | feed が返す範囲のみ。`<lastBuildDate>` / `<pubDate>` で過去履歴がある site は実質 `--bootstrap` と差がない |
| `html` | partial | 1 ページに含まれる items のみ。HTML pagination 追跡は範囲外 |
| `html-js` | partial | 同上 |
| `github-releases` | full | GitHub API は paginated、全 release を辿る |
| `npm-registry` | full | packument には全 version 履歴が含まれる |
| `json-api` | **full** | 本 ADR の主要 use case、`pagination.maxPages` まで辿る |
| `json-feed` | partial | feed が返す範囲のみ (JSON Feed 1.1 仕様に pagination は無い) |

実装側で `--backfill` を「page traversal を有効化する hint」として解釈し、adapter 別に "full" / "partial" を決める。help 文では "fetch all available history pages" と表現する。

### D5. ADR-0009 拡張 (generic adapter 用追加防御)

`kind: json-api` の generic adapter は site 多様性ゆえに **既存 5 adapter より広い attack surface** を持つ:

| Attack vector | 既存 5 adapter | `kind: json-api` |
|---|---|---|
| **大量 response body** | size cap なし (実用上問題なし) | recipe で `pageSize: 1000` 等を書くと巨大 body / DoS リスク |
| **悪意ある host (private IP / localhost / file://)** | adapter 別に host check | recipe 経由で任意 URL を fetch する |
| **credential 漏洩** | github / npm は固定 endpoint | recipe `http.headers` で任意 header を書ける |
| **prompt injection (item content)** | 既存 M1c boundary marker でカバー | 同じく M1c でカバー (差分なし) |

これらに対応するため **ADR-0009 を拡張**する (詳細は [ADR-0009 § JSON API generic adapter 拡張](./0009-untrusted-external-content-handling.md#json-api-generic-adapter-拡張) で本 ADR と同 PR で追記):

#### D5a. レスポンスサイズキャップ (デフォルト 10 MB / page)

- adapter 内部の固定値として強制。recipe からは override 不可
- 超過時は `Source.lastErrorReason: "response too large"` で fail (cf. ADR-0008)
- 巨大 body の OOM / disk fill / agent CLI の context window 食い潰しを防ぐ

#### D5b. host allowlist / blocklist

- 既存 fetch wrapper (`src/core/feeds/_fetch.ts`) で `127.0.0.1` / `localhost` / `0.0.0.0` / RFC1918 private IP / `file://` / `metadata.google.internal` / `169.254.169.254` (cloud metadata) を遮断する設計を `kind: json-api` の `url` および pagination で fetch する後続 URL すべてに適用する
- 既存 adapter は固定 endpoint のため遮断ロジックは事実上 no-op だったが、recipe で任意 URL を書ける `kind: json-api` では **必須**

#### D5c. credential 漏洩防止 (env var interpolation)

recipe の `http.headers` で `Authorization: "Bearer ${GITHUB_TOKEN}"` のように **env var を明示的に interpolation する仕様**を確立する:

- `${VAR}` 形式のみ受け付ける (shell expansion / command substitution は不可)
- recipe YAML に **生の credential 文字列を書かない契約**を docs / schema description に明記
- env var が未定義の場合、interpolation はエラーではなく "header 自体を送信しない" (degraded fetch) として扱う。これにより public API は recipe そのままで動き、認証必須 API は env が無い時点で 401/403 が返って fail-fast する
- log / frontmatter には interpolation 後の値を **絶対に**載せない。`Authorization` ヘッダは log redact 必須 (#170 の credential masking と同じ方針)

#### D5d. JSON body の prompt injection

既存 M1c (boundary marker `<untrusted_item>...</untrusted_item>`) と M1a (regex pre-filter) でカバーする。JSON body は parse 後に item content として通常経路に乗るため、`kind: json-api` 固有の追加防御は不要。

### D6. ADR-0009 信頼境界表の更新

ADR-0009 §A 信頼境界表 (`Source kind` 別) に **2 行追加**する:

| Source kind | コントロール元 | FeedRadar プロセスとの関係 | 追加 attack surface | 備考 |
|---|---|---|---|---|
| `json-api` | サイト運営者 + **recipe 作者** | text 受信 + JSON parse | **中** (任意 URL / 任意 header / レスポンスサイズ多様性、D5 で size cap + host blocklist + env interpolation) | recipe が公式バンドル (`recipes/*.yaml`) か user 手書きかで信頼度が異なる |
| `json-feed` | サイト運営者 | text 受信 + JSON parse | 低 (固定 schema、`jsonfeed.org/version/1.1` 準拠) | parser バグ以外は静的データ |

特記:

- **recipe 作者という第二の信頼境界**が `kind: json-api` で新規に登場する。公式バンドル recipe (`recipes/*.yaml`) はリポ owner のレビューを経るが、user 手書き recipe は user の責任で監査する。ADR-0009 でこの非対称性を明記する
- user-guide で「recipe は YAML config と同等の責任で扱う、悪意ある recipe を copy-paste しない」旨を警告する (#176 で追加)

### D7. スコープ外 (本 ADR 範囲外)

| 項目 | 理由 |
|---|---|
| **GraphQL adapter** | 別 kind (`kind: graphql-api`) で将来検討。query language / variable / persisted query で `json-api` とは独立 |
| **POST + JSON body での search API** | Phase 1 では GET のみ。POST 対応は req body の schema / signing / replay 防御で別検討 |
| **完全な JSONPath 仕様** (filter expression / script expression) | 必要な site が現れたら段階拡張 |
| **Firebase REST / GraphQL 風の non-page-based API** | pagination model が異なる、別 kind で検討 |
| **既存 adapter (`github-releases` / `npm-registry`) の recipe 書き換え** | 特化 adapter は domain logic ゆえに残す (D1) |
| **`--bootstrap` の既存セマンティクス変更** | 後方互換維持 (D4) |

## Consequences

### 良い面

- **AWS What's New / dev.to / Anthropic news など page-based JSON API が一気に動く** → FeedRadar のコア用途のギャップを解消
- **新規 site の対応コストが ~150 LoC → ~30 行 YAML に圧縮** → 漸進的にエコシステム拡大
- **既存 5 adapter は不変** → 破壊変更なし、特化 adapter の domain logic は温存
- **JSON Feed 1.1 標準対応 (`kind: json-feed`)** → 標準準拠 site は URL のみで動く (Phase 2)
- **公式 recipe バンドル (案 A)** → install 直後から動く DX、CI smoke test で公式 recipe の breakage を検知
- **`--backfill` で過去履歴取得が公式 use case 化** → AWS の 16,281 件のような大規模 history を items 化できる
- **ADR-0009 拡張で generic adapter の attack surface を明示** → defense-in-depth スタックの予測可能性を維持

### 悪い面 / 制約

- **recipe メンテ責任が FeedRadar 側に発生** → 公式 recipe (`recipes/*.yaml`) は site 変更で壊れる。CI smoke test で検知するが、site の breaking change を upstream で阻止する手段はない
- **JSON 多様性への対応は部分的** → JSONPath-lite + 5 pagination 形式でカバーできない site は recipe で表現不能 (用例が増えたら段階拡張)
- **generic adapter のセキュリティ脅威面が広がる** → recipe で任意 URL / 任意 header を書けるため、D5 の防御層 (size cap / host blocklist / env interpolation) が新規に必要
- **recipe 作者という第二の信頼境界** → user 手書き recipe が悪意あるエンドポイントを fetch する経路を構造的に許容する (M1c boundary marker + ADR-0009 §A の "全 source untrusted" 前提で防御するが、recipe 内容の audit は user 責任)
- **`--backfill` の partial 対応 adapter で挙動差が出る** → rss / html / html-js は実質 `--bootstrap` と差がない。help / docs で明示する

### 中立

- ADR-0002 (Source Adapter Plug-in Pattern) の adapter 追加手順に `kind: json-api` (汎用 adapter) と `kind: json-feed` (標準対応 adapter) の 2 行を加える
- ADR-0009 §A 信頼境界表に `json-api` / `json-feed` 行を追記 (本 ADR の D6 と同 PR)
- README / user-guide / `init` template (`src/templates/feedradar.md`) の help 文・サンプル URL 一覧に `--backfill` / `kind: json-api` / `kind: json-feed` を反映する作業は **本 ADR 範囲外**で #176 (docs 統合) に委譲する
- `radar source recipes` / `--recipe <name>` の CLI コマンド面は #181 で詳細決定 (本 ADR では「recipe バンドル戦略 = 案 A」のみ確定)

## Alternatives

### 案 X1: AWS 専用 adapter (`kind: aws-whats-new`)

却下理由:

- **1 件のニーズ (AWS) に対して過剰**: dev.to / Anthropic / OpenAI など同形式の site が複数存在し、特化 adapter を毎回追加するのは ADR-0002 の adapter pattern を肥大化させる
- **漸進的汎用化と衝突**: L1-L2 で汎用 adapter + recipe を確立し、必要なら L3 で特化に "降格" するほうが設計余地が広い
- **保守責任の集中**: AWS API の breaking change を FeedRadar 側で adapter コードとして直す責任が発生する。recipe であれば YAML 1 行修正で済む

### 案 X2: 完全 JS expression recipe (`extract: "(json) => json.items.map(...)"`)

却下理由:

- **セキュリティリスク**: recipe 経由で任意 JS を実行する経路を新設する。ADR-0009 の "全 source untrusted" 前提と直接衝突 (recipe 作者の信頼境界が user の手書きまで降りてくる)
- **保守困難**: JSON 構造の宣言的記述 (JSONPath) のほうが diff レビュー / static analysis / LLM discover (#179) と相性が良い
- **デバッグ困難**: JS expression 内のバグは `source test` で raw stack trace を吐く。recipe 作者の体験が悪化
- **YAGNI 違反**: JSONPath-lite + 5 pagination 形式でカバーできない site が **複数蓄積**してから再評価する

### 案 X3: `--bootstrap` を拡張 (新規 flag 不要案)

却下理由 (D4 の表で詳述):

- 既存ユーザーが期待する "no items" semantics を破壊する
- "seed only" と "fetch all history" の 2 意味が衝突する
- state 整合性が崩れる ("lastSeenIds に id があるのに items も存在する" 状態)
- mental model 上 `--bootstrap` (静か) と `--backfill` (全部取る) は対称概念で、別 flag にしたほうが学習コストが低い

### 案 X4: 完全 LLM 駆動の zero-config (URL を渡したら LLM が schema を推論)

却下理由:

- **コスト**: 全 site / 全 fetch ごとに LLM call → 既存 fetch cost が爆発
- **再現性**: LLM 推論結果が site / 時刻 / model version で揺れ、user の `source test` 結果が安定しない
- **失敗時の debuggability**: 推論失敗時に何を直せばよいか user に伝えられない
- **代替案**: 「recipe を LLM が draft 生成」する `radar source discover` (#179) を **Phase 3 で条件付き採用** する方向で、本 ADR では含めない

### 案 X5: ADR-0013 を別途起こして recipe バンドル戦略を独立 ADR 化

却下理由:

- **判断粒度として独立 ADR の実益が薄い**: バンドル戦略は `kind: json-api` 汎用化方針と一体の判断 (公式 recipe を `kind: json-api` のリファレンスとして同梱するか否か)
- **ADR 数を増やすコスト**: 関連 ADR 間の cross-link が複雑化し、navigation が悪化する
- **本 ADR 内に統合する**ことで、`kind: json-api` の "なぜ汎用化したのに公式 recipe を同梱するのか" の因果関係が一読で追える

## Future Work (条件付き再評価)

以下が揃ったら **本 ADR を superseded する形で再設計**する:

### F1. Recipe ライブラリ化 (案 B への移行)

トリガー条件:

- 公式 recipe が **2-3 件の追加ニーズ蓄積** (`recipes/*.yaml` が 10 個以上)
- recipe 内の normalization ロジック (datetime parser / URL canonicalize) で **80% 以上の重複**
- 外部 API smoke test の **運営方針が CI matrix で破綻** (flakiness の許容範囲を超える)

そのときは `@ozzylabs/feedradar-recipes` 別パッケージ化 + normalization ライブラリ化を再評価する。

### F2. LLM ベース recipe discover (#179)

トリガー条件:

- `kind: json-api` adapter が安定稼働 (Phase 1 完了 + ~1 ヶ月の運用)
- user が recipe を手書きする際のつまずきポイントが docs / issue で **3 件以上**集まる
- LLM provider の cost / latency が `radar source discover` を実用化できる水準 (1 site あたり数十円 / 30 秒以内)

そのときは `radar source discover <url>` で LLM が `recipes/<site>.yaml` の draft を生成する CLI を **Phase 3 で追加**する。

### F3. JSONPath 完全仕様 / GraphQL adapter

トリガー条件:

- recipe で **filter expression が必要な site が 3 件以上**蓄積
- GraphQL API を持つ site (GitHub GraphQL API v4 / Shopify Admin / Linear 等) の追跡ニーズが具体化

そのときは `kind: graphql-api` を別 ADR で起こすか、`kind: json-api` の JSONPath を full 仕様に拡張する判断を再評価する。

## 関連

- 親 epic: [#172](https://github.com/ozzy-labs/feedradar/issues/172) feat(feeds): JSON API 汎用 adapter + 標準フィード対応 + LLM 補助 discover
- sub-issues:
  - [#175](https://github.com/ozzy-labs/feedradar/issues/175) docs(adr): 本 ADR + ADR-0009 拡張 + recipe バンドル戦略決定 (本 PR)
  - [#173](https://github.com/ozzy-labs/feedradar/issues/173) feat(feeds): `kind: json-api` adapter 実装 + `--backfill` フラグ
  - [#174](https://github.com/ozzy-labs/feedradar/issues/174) feat(feeds, cli): デフォルト selector chain + CLI 統合 + `source test` pagination 明文化
  - [#176](https://github.com/ozzy-labs/feedradar/issues/176) docs(user-guide): json-api + json-feed + `--backfill` の横断 docs 統合
  - [#177](https://github.com/ozzy-labs/feedradar/issues/177) feat(feeds): `kind: json-feed` adapter (Phase 2)
  - [#181](https://github.com/ozzy-labs/feedradar/issues/181) feat(cli): recipe CLI (`source recipes` / `--recipe`) (Phase 2)
  - [#178](https://github.com/ozzy-labs/feedradar/issues/178) feat(recipes): 公式 recipe 3 個実装 + CI smoke test (Phase 2)
  - [#179](https://github.com/ozzy-labs/feedradar/issues/179) feat(cli): `radar source discover` LLM ベース recipe draft 生成 (Phase 3)
  - [#180](https://github.com/ozzy-labs/feedradar/issues/180) docs: discover docs (Phase 3)
- 関連 ADR:
  - [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) (item normalize 後の agent CLI 経路)
  - [ADR-0002 Source Adapter Plug-in Pattern](./0002-source-adapter-plugin-pattern.md) (本 ADR で `kind: json-api` / `kind: json-feed` を追加)
  - [ADR-0006 Filter Specification](./0006-filter-specification.md) (json-api item も filter 経路に乗る)
  - [ADR-0008 Item Status State Machine](./0008-status-state-machine.md) (D5a の "response too large" を fail として記録する semantics)
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) (本 ADR の D5 / D6 で generic adapter 用に拡張)
  - [ADR-0010 html-js Adapter and Playwright Distribution](./0010-html-js-adapter-and-distribution.md) (recipe バンドル案 B 却下理由の参照、distribution 単純化方針の継承)
- 関連 docs:
  - [`docs/design/threat-model.md`](../design/threat-model.md) (本 ADR で `json-api` / `json-feed` 行を信頼境界表に追加する作業は ADR-0009 改訂と同 PR で実施)
- 関連背景 (公開情報のみ):
  - 公式 API 事例: [aws-samples/whats-new-summary-notifier](https://github.com/aws-samples/whats-new-summary-notifier), [RSSHub](https://docs.rsshub.app/)
  - JSON Feed 仕様: [`jsonfeed.org/version/1.1`](https://jsonfeed.org/version/1.1)
- knowledge:
  - [`ai/practice/prompt-injection`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md) (D5d の M1c boundary marker 継承)
