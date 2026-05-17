# ADR-0010: html-js Adapter and Playwright Distribution

## Status

Accepted（2026-05-17）— 親 epic [#111](https://github.com/ozzy-labs/feedradar/issues/111) の起点 ADR。実装は sub-issue (#113 / #114 / #115 / #116) に分割。

## Context

近代的な SaaS の changelog / release notes は Next.js CSR / Notion 埋め込み / Algolia DocSearch 等で構築されることが多く、初期 HTML に item 要素が含まれない。現状の `kind: html` adapter ([`src/core/feeds/html.ts`](../../src/core/feeds/html.ts)) は `node-html-parser` で静的 HTML をパースするのみのため、こうしたページは空配列を返してしまい、FeedRadar のコア用途「公式 changelog / release notes 追跡」と直接衝突する。

[`docs/design/source-html.md`](../design/source-html.md) でも「JavaScript rendering — 別 Phase」とスコープ外宣言済みで、本 ADR で正式に解消する。

### 制約

1. **single-package distribution**: README で「単一 npm パッケージ・依存ゼロ」を売りにしている (README:16)。Playwright を direct dep にすると install footprint が ~300MB 級に膨らみ、HTML scraping を使わないユーザーにも負担を強いる
2. **CI 第一級**: Playwright matrix を CI で回せること (`npx playwright install --with-deps chromium` 1 行で済む形)
3. **security baseline**: ADR-0009 / threat-model.md で確立した「全 source untrusted」前提を破らない。Chromium で page JS を走らせる以上、追加の attack surface (WebRTC IP 漏洩 / drive-by download / 巨大ページ OOM 等) が増える
4. **YAGNI**: fetcher / parser 軸の一般化、CDP / Remote API / AI 抽出は将来需要次第。今 Phase では `kind: html-js` 1 つだけ追加する

### 検討された軸

| 軸 | 選択肢 |
|---|---|
| **kind 設計** | (a) 新 `kind: html-js` / (b) 既存 `kind: html` に `renderer: "static" \| "js"` option / (c) fetcher / parser 抽象を新規導入 |
| **distribution** | (a) direct dep / (b) optional peer dep / (c) 別パッケージ (`@feedradar/html-js`) / (d) playwright-core lazy install |
| **rendering 方式** | (a) Playwright (Chromium) / (b) CDP (既存ブラウザ接続) / (c) Remote API (Jina Reader / Firecrawl) / (d) AI 抽出 |
| **hardening** | headless / accept_downloads / context 再利用 / timeout 等の policy |

## Decision

### D1. 新 `kind: html-js` を追加（既存 `kind: html` は不変）

`SourceKindSchema` に `"html-js"` を追加し、parser 側 ([`src/core/feeds/html.ts`](../../src/core/feeds/html.ts) の selector 適用ロジック) は `SourceSelectorsSchema` を流用して共有する。fetcher のみ Playwright に差し替える。

- 既存 `kind: html` ユーザーは破壊変更なし
- 新規 SPA ターゲットは `kind: html-js` で opt-in
- parser ロジックを共有することで test fixture / selector semantics の不整合を回避

### D2. 抽象化なし (YAGNI)

fetcher / parser 軸を分離して `kind: html` と `kind: html-js` を `renderer` option で切り替える設計は **将来需要時に再評価**する。理由:

- 現時点で「fetcher を差し替えたい」のは Playwright 1 ケースのみ
- 抽象を入れると `SourceSelectorsSchema` の評価コンテキスト (DOM vs 文字列) や state 形式 (`lastEtag` vs Playwright cookie) の差を抽象側が吸収する責務を負う → 過剰設計
- 3 ケース以上の fetcher / parser 組合せが具体化したら、本 ADR を superseded する形で再設計

### D3. Playwright を optional peer dep

`package.json` に以下を追加する:

```json
{
  "peerDependencies": {
    "playwright": "^1.50.0"
  },
  "peerDependenciesMeta": {
    "playwright": {
      "optional": true
    }
  }
}
```

- `kind: html-js` を使わないユーザーは Playwright を install 不要 → 既存 distribution の軽量さを維持
- `kind: html-js` 利用時のみユーザーが `npm i -g playwright` (または `npm i playwright` を user project に) を実行
- adapter 内部の Playwright import は **dynamic import** (`await import("playwright")`) にして、import 失敗時は user-friendly な「`npm i playwright && npx playwright install chromium` を実行してください」エラーを投げる
- lazy 検出は #114 の `radar doctor` / `watch run` 起動時で行う

### D4. Chromium はユーザーが別途 install

Chromium バイナリは Playwright とは別管理で、ユーザーが `npx playwright install chromium` を実行する。FeedRadar は自動 install しない。

- バイナリの暗黙ダウンロードは postinstall hook を要し、`pnpm install` のオフライン実行や CI cache 戦略と衝突する
- CI 側では `npx playwright install --with-deps chromium` 1 行で済む (D5 で言及する CI matrix で実証)
- バージョン整合は Playwright npm package のバージョンと Chromium バイナリのバージョンが結合しているため、両者を分離 install してもユーザー側で混乱は起きない (Playwright 公式 docs の標準フロー)

### D5. Chromium hardening 要件

`kind: html-js` adapter は以下を **オーバーライド不可** な policy として強制する:

| Policy | 値 | 理由 |
|---|---|---|
| `headless` | `true` 強制 | UI 表示は CI 不可、operator UI 偶発操作のリスク回避 |
| `accept_downloads` | `false` 強制 | drive-by download (page JS が `Content-Disposition: attachment` を返す URL を fetch して file 保存させる経路) を遮断 |
| `context` 再利用 | **しない** (fetch ごとに fresh `context`) | Service Worker / IndexedDB / localStorage に injection payload を永続化させない、cross-source の状態混入を防ぐ |
| `timeout` (デフォルト) | 30 秒 | 巨大ページの OOM / 無限 loop による hang を防ぐ。user が source 設定で上書き可能だが上限は別途設定 (sub-issue で詳細決定) |
| `page.close()` | `finally` で必ず実行 | page leak によるメモリ蓄積を防ぐ |
| viewport | デフォルト (1280x720) | 過剰に大きい viewport で巨大 DOM を生成しない |

実装は `src/core/feeds/html-js.ts` 側の固定値とし、user の source 設定 (`Source.selectors` / `Source.rendererOptions` 等) からは触れないようにする。

### D6. スコープ外 (本 ADR 範囲外)

| 項目 | 理由 |
|---|---|
| CDP / Remote DevTools 接続 | ユーザーの既存 Chrome に接続する fetcher。需要が出れば別 epic で再検討 |
| Remote rendering API (Jina Reader / Firecrawl 等) | 外部 SaaS 依存 / API key 管理 / プライバシー懸念。需要が出れば別 epic |
| AI 抽出 parser | selector を LLM 推論で生成 / DOM から item 構造を抽出。コスト / プライバシー / ADR-0009 再評価が必要。別 epic |
| Firefox / WebKit 対応 | Chromium のみで充足 (changelog scraping 用途で browser engine 差は無視可能)。将来需要が出れば追加 |

## Consequences

### 良い面

- **SPA changelog 追跡が可能**になる → FeedRadar のコア用途の主要ギャップを解消
- **distribution は軽量のまま** → 既存 `kind: html` / `kind: rss` ユーザーには transparent
- **CI 1 行で動く** → `npx playwright install --with-deps chromium` で reproducible
- **既存 `kind: html` 不変** → 破壊変更なし、static HTML ターゲットの parse は今まで通り node-html-parser で軽量
- **hardening を policy で強制** → ユーザーが緩める余地を意図的に消すことで attack surface が予測可能

### 悪い面 / 制約

- **Chromium バイナリ脆弱性追跡責任がユーザー側に移る** → `npm audit` で拾えない (Chromium は npm package ではない)。user-guide で `npx playwright install` 定期実行 (週次目安) を推奨する旨を ADR-0009 / user-guide に明記する
- **install footprint** → `kind: html-js` を使うユーザーは Chromium ~300MB を別途確保
- **CI runtime** → matrix job が増えるため CI 実行時間が伸びる (#115 で実測値を取る)
- **Playwright API の追随コスト** → major version up 時に api 差分を吸収する必要 (Renovate で追随)
- **lethal trifecta が広がる** → page JS が任意の `fetch()` を行えるため、injection payload 経由で外部送信される経路が theoretical に増える (hardening D5 で fresh context / no download / timeout で抑える、threat-model.md §C で明示)

### 中立

- 既存 `kind: html` の design doc (`docs/design/source-html.md:106`) の「JS rendering — 別 Phase」記述は本 ADR への link に差し替える
- ADR-0009 §A の信頼境界表に `html-js` 行を追加 (Chromium プロセスは sandbox 有効、FeedRadar プロセスから OS process 境界で隔離されるため `kind: html` と同等以上に強い隔離)
- threat-model.md §A / §C に `html-js` 固有の attack surface (WebRTC IP 漏洩 / drive-by download / 巨大ページ OOM) と対応 hardening を追記

## Alternatives

### 案 A: Playwright を direct dep

却下理由:

- README:16 の「単一 npm パッケージ・依存ゼロ」の売りと衝突
- `kind: html-js` を使わないユーザーにも ~300MB の install を強いる
- `pnpm install` 時の postinstall hook で Chromium を download すると CI cache 戦略 / オフライン install と衝突
- distribution の軽量さは FeedRadar の選択動機の一つ (cf. ADR-0007 Skill Bundling)、これを崩すと初学者の install 体験が悪化

### 案 B: 別パッケージ (`@feedradar/html-js`) で分離配布

却下理由:

- monorepo / 別 publish workflow が必要で release 運用コストが増える
- 現状 [release-please](https://github.com/googleapis/release-please) で `feedradar` 単一 package を回している前提と衝突
- ユーザー視点では「`feedradar` install 後に `@feedradar/html-js` も install」となり、optional peer dep の `npm i playwright` と手数は変わらない
- 将来 adapter が更に増えたら再評価する余地はあるが、今 Phase では 1 adapter 追加のために monorepo 化するのは過剰

### 案 C: playwright-core lazy install

`playwright-core` を runtime に動的 install する案。

却下理由:

- **技術的に不成立**: npm package を runtime に install するには process が npm を spawn する必要があり、user の `node_modules` に書く権限 / project root の特定 / lockfile 整合性 (`pnpm-lock.yaml` の hash mismatch) が壊れる
- global install 経路を強制すると CI で副作用が大きく、test isolation が壊れる
- 「ユーザーが明示的に `npm i playwright` する」optional peer dep のほうが透明で予測可能

### 案 D: 既存 `kind: html` に `renderer: "static" | "js"` option を追加

却下理由:

- `kind` 単位で test fixture / state schema / hardening policy を切り替えるほうが mental model が明快
- option 切替だと「同じ kind なのに fetcher 挙動が劇的に違う」状態が生まれ、bug report の切り分けが困難になる
- D2 で述べたとおり抽象化は YAGNI、新 kind 追加のほうが影響範囲が小さい

### 案 E: CDP 経由でユーザーの既存 Chrome に接続

却下理由:

- ユーザーが daily Chrome を立ち上げる前提が必要 → CI で動かない (D5 要件不成立)
- ユーザーの logged-in session が漏れる risk
- 「CI 第一級」の要件を満たさないため scope 外。将来需要が出れば別 epic

### 案 F: Remote rendering API (Jina Reader / Firecrawl)

却下理由:

- 外部 SaaS 依存 → API key 管理 / 課金 / プライバシー
- 「ローカル完結」が FeedRadar の設計前提 (ADR-0005 User Data Separation)
- offline 動作不能
- 将来需要があれば opt-in adapter として別 epic で検討

## 関連

- 親 epic: [#111](https://github.com/ozzy-labs/feedradar/issues/111) chore(feeds): SPA / CSR support via html-js adapter
- sub-issues:
  - [#112](https://github.com/ozzy-labs/feedradar/issues/112) docs(adr): 本 ADR + ADR-0009 / threat-model 改訂
  - [#113](https://github.com/ozzy-labs/feedradar/issues/113) feat(schemas, feeds): html-js adapter 実装
  - [#114](https://github.com/ozzy-labs/feedradar/issues/114) feat(cli): `radar doctor` + lazy Chromium 検出
  - [#115](https://github.com/ozzy-labs/feedradar/issues/115) ci(workflows): Playwright integration test matrix
  - [#116](https://github.com/ozzy-labs/feedradar/issues/116) docs(user-guide, readme): html-js / Playwright install ガイド
- 関連 ADR:
  - [ADR-0002 Source Adapter Plug-in Pattern](./0002-source-adapter-plugin-pattern.md) (adapter 追加手順)
  - [ADR-0007 Skill Bundling and `init` Distribution](./0007-skill-bundling-and-init-distribution.md) (distribution 設計前提)
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) (本 ADR で §A / Chromium 脆弱性責任セクションを改訂)
- 関連 docs:
  - [`docs/design/source-html.md`](../design/source-html.md) (本 ADR で「JS rendering — 別 Phase」記述を link 差し替え)
  - [`docs/design/threat-model.md`](../design/threat-model.md) (本 ADR で §A / §C に html-js 行を追記)
