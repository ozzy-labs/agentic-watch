# ADR-0009: Untrusted External Content Handling for Agent Prompts

## Status

Accepted（2026-05-16）— 採択した緩和策の実装は **本 ADR 採択後に別 sub-issue として切り出す**。本 ADR は **採用 / 留保 / 却下** の確定のみを行う。

## Context

FeedRadar は外部 feed (RSS / HTML / html-js / GitHub Releases / npm-registry) から取得した item content を 4 種の agent CLI に渡す。4 adapter すべて [ADR-0001](./0001-agent-adapter-interface.md) の非対話モード前提により tool 承認を skip して起動するため (`bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox` / `--allow-all-tools` / `-y --skip-trust`)、item content に混入した prompt injection が agent の tool execution を悪用するリスクが構造的に存在する。

詳細な攻撃面 / 被害範囲 / 緩和候補の整理は [`docs/design/threat-model.md`](../design/threat-model.md) を参照。本 ADR はその threat model に対し、`#49` の 5 設計検討項目 (M1〜M5) の **採否を判定**する。

判定基準:

- **コスト**: 実装 + 運用コスト (LOC / API call / 計算量 / UX 悪化)
- **効果**: lethal trifecta ([prompt-injection.md § 0](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md#0-lethal-trifecta致死の三要素)) のどの辺を切れるか
- **副作用**: false positive / UX 悪化 / 既存 ADR との抵触
- **位置づけ**: defense-in-depth のどの層に該当するか ([prompt-injection.md § 防御の階層](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md#防御の階層))

### Source kind 別の信頼境界 (2026-05-17 html-js 追加 / 2026-05-22 json-api・json-feed 追加)

[ADR-0010](./0010-html-js-adapter-and-distribution.md) の `kind: html-js` 採択、および [ADR-0012](./0012-json-api-adapter-and-recipe-strategy.md) の `kind: json-api` / `kind: json-feed` 採択に伴い、本 ADR が前提とする信頼境界表を以下のとおり拡張する (threat-model.md §A と整合):

| Source kind | コントロール元 | FeedRadar プロセスとの関係 | 追加 attack surface | 備考 |
|---|---|---|---|---|
| `rss` | サイト運営者 | text 受信のみ | 低 | parser バグ以外は静的データ |
| `html` | サイト運営者 | text 受信 + node-html-parser | 低 (CSS selector 評価のみ) | DOM 構築なし |
| `html-js` | サイト運営者 | **Chromium (別 OS process) で page JS 実行** | **中** (WebRTC IP 漏洩 / drive-by download / 巨大ページ OOM 等。Chromium プロセスは sandbox 有効 + headless + accept_downloads=false で FeedRadar プロセスから OS process 境界で隔離。詳細は [ADR-0010 §D5](./0010-html-js-adapter-and-distribution.md#d5-chromium-hardening-要件) と [`docs/design/threat-model.md`](../design/threat-model.md) §C-2) | page JS が抽出するテキストも untrusted item として M1c boundary marker で wrap される |
| `github-releases` | リポジトリ owner / collaborator | API JSON 受信のみ | 低 | release body は contributors が書ける |
| `npm-registry` | パッケージ maintainer | packument JSON 受信のみ | 低 | typosquat / 乗っ取り maintainer の risk |
| `json-api` | サイト運営者 + **recipe 作者** | text 受信 + JSON parse + JSONPath-lite 評価 | **中** (任意 URL / 任意 header / レスポンスサイズ多様性。下記「JSON API generic adapter 拡張」の D5a〜D5c で size cap / host blocklist / env interpolation を強制) | recipe 作者という第二の信頼境界が新規。公式バンドル recipe (`recipes/*.yaml`) と user 手書き recipe で監査責任が異なる ([ADR-0012 D6](./0012-json-api-adapter-and-recipe-strategy.md#d6-adr-0009-信頼境界表の更新) 参照) |
| `json-feed` | サイト運営者 | text 受信 + JSON parse | 低 (固定 schema、`jsonfeed.org/version/1.1` 準拠) | parser バグ以外は静的データ。recipe 不要のため recipe 作者の信頼境界は無い |

**`json-api` 特記**: `kind: html-js` の Chromium 隔離と異なり、`kind: json-api` の追加 attack surface は **JSON parser 自体の脆弱性ではなく recipe 設定経由の任意 URL fetch** に集中する。これは Chromium バイナリ脆弱性追跡責任 (html-js) と同様、recipe 監査責任が user 側 (user 手書き recipe の場合) または FeedRadar repo owner 側 (公式バンドル recipe の場合) に分かれる構造になる。下記「JSON API generic adapter 拡張」で固定 policy として強制する防御層を確立する。

**`html-js` 特記**: Chromium 自体は FeedRadar プロセスとは別の OS process で動作し、Chromium 内蔵の sandbox + headless により page JS は FeedRadar ホスト上の sensitive ファイル (`~/.ssh/`, `~/.aws/credentials`, `.env` 等) に **直接アクセスできない**。ただし Chromium バイナリ自体の脆弱性 (例: V8 0-day) が悪用された場合は sandbox escape の可能性がある。詳細は次節「Chromium バイナリ脆弱性追跡責任」参照。

### Chromium バイナリ脆弱性追跡責任 (2026-05-17 html-js 追加)

`kind: html-js` の Chromium は **npm package ではなく `npx playwright install chromium` で配布される独立バイナリ**であり、以下の責任分担となる:

| 項目 | 担当 | 検知手段 |
|---|---|---|
| Playwright npm package の脆弱性 | FeedRadar 側 (Renovate / `npm audit`) | `pnpm audit` / Renovate alerts |
| Chromium バイナリの脆弱性 | **ユーザー側** | `npx playwright install` の定期実行で最新化、Chromium 公式 release notes / [chrome releases blog](https://chromereleases.googleblog.com/) を購読 |

`npm audit` / Renovate は Chromium バイナリ部分を検知できない。FeedRadar の user-guide で以下を推奨する:

- `npx playwright install chromium` を **週次** (または Playwright minor version up 時) に実行する
- 重大な Chromium 脆弱性が公開された際は即時 update
- `kind: html-js` を実運用する場合は、Chromium 脆弱性アラート (CISA KEV / Chrome Releases) を購読する

詳細は [ADR-0010](./0010-html-js-adapter-and-distribution.md) を参照。

### JSON API generic adapter 拡張 (2026-05-22 json-api 追加)

[ADR-0012](./0012-json-api-adapter-and-recipe-strategy.md) の `kind: json-api` 採択に伴い、generic adapter 用の追加防御策を確立する。既存 5 adapter は固定 endpoint / 固定 schema を持つのに対し、`kind: json-api` は recipe 経由で **任意 URL / 任意 header / 任意ページサイズ** を許容するため、attack surface が広がる。下記は adapter 内部で固定値として強制する policy であり、recipe 側から override 不可。

| ID | 防御策 | 状態 |
|---|---|---|
| **D5a** | レスポンスサイズキャップ (デフォルト 10 MB / page) | Adopt (ADR-0012 D5 で確立、実装は #173 で sub-issue 化) |
| **D5b** | host allowlist / blocklist (private IP / loopback / file:// / cloud metadata 遮断) | **Shipped (#206)** — `validateFetchUrl()` を `src/core/feeds/_fetch.ts` に実装、`fetchWithRetry` 経由の全 adapter (`rss` / `html` / `json-feed` / `json-api` / `github-releases` / `npm-registry`) に適用 |
| **D5c** | credential 漏洩防止 (env var interpolation: `${VAR}` のみ、log redact) | Adopt |
| **D5d** | JSON body の prompt injection | 既存 M1c (boundary marker) で十分 — 追加策不要 |

#### D5a レスポンスサイズキャップ

- デフォルト 10 MB / page を adapter 内部の固定値として強制する
- 超過時は [ADR-0008](./0008-status-state-machine.md) の状態機械に従い `Source.lastErrorReason: "response too large"` で fail
- 巨大 body の OOM / disk fill / agent CLI の context window 食い潰しを防ぐ
- recipe からは override 不可 (信頼できないユーザー recipe からの DoS 経路を断つ)

#### D5b Host allowlist / blocklist

`kind: json-api` の `url` および pagination で fetch する後続 URL すべてに対し、既存 fetch wrapper (`src/core/feeds/_fetch.ts`) が遮断する以下のホスト集合を必ず通す。

| 遮断対象 | 理由 |
|---|---|
| `127.0.0.0/8` / `localhost` / `0.0.0.0` | SSRF: user の localhost で動く管理画面 / dev server を fetch される |
| RFC1918 private IP (`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16`) | SSRF: 同一 VPC / LAN 内の internal service へ到達 |
| `169.254.0.0/16` (AWS / GCP / Azure metadata service: `169.254.169.254` 等) | cloud instance metadata service: IAM role credentials の窃取 |
| IPv6 loopback (`::1`) / link-local (`fe80::/10`) / ULA (`fc00::/7`) | IPv6 経路での同等 SSRF |
| `file://` / `data:` / `gopher://` / `ftp://` / その他 non-http(s) scheme | local filesystem / 異プロトコル経由の任意 read |
| DNS rebinding 経路 (動的 IP 変化) | resolver hook で fetch 時の IP も確認 (本実装は URL hostname literal のみチェック、DNS rebinding 防御は将来検討) |

既存 5 adapter は固定 endpoint のため遮断ロジックは事実上 no-op だったが、recipe で任意 URL を書ける `kind: json-api` では **必須**。

**実装** (#206): `validateFetchUrl(url, env)` を `src/core/feeds/_fetch.ts` に追加し、`fetchWithRetry` の retry loop に入る前に呼び出す。`fetchWithRetry` を経由する全 adapter (`rss` / `html` / `json-feed` / `json-api` / `github-releases` / `npm-registry`) で有効。`kind: html-js` は Playwright (`page.goto()`) 経由のため本 wrapper を通らず、Chromium 自体の sandbox + headless 防御 ([ADR-0010 §D5](./0010-html-js-adapter-and-distribution.md#d5-chromium-hardening-要件)) に依存する別経路。

**override**: `RADAR_FETCH_HOST_ALLOWLIST=<host1>,<host2>,...` 環境変数で個別 host literal を allowlist できる。testing (e2e CLI smoke test が `127.0.0.1` のローカル fixture を fetch する用途) や user の明示 opt-in 用途を想定。CIDR / glob は未サポート (exact match のみ)。

**scope の限界**: 本実装は URL hostname literal の単純チェックであり DNS は引かない。公開 DNS レコードが `127.0.0.1` を指す DNS rebinding 攻撃は防げない。defense-in-depth として metadata IP / `localhost` / `file://` 等の典型 SSRF レシピは確実に切れるが、より深い防御 (resolver hook での fetch 時 IP 再確認) は将来検討。

#### D5c Credential 漏洩防止 (env var interpolation)

recipe の `http.headers` で `Authorization` 等の sensitive header を扱う場合、env var を明示的に interpolation する仕様を確立する。

- **構文**: `${VAR_NAME}` の形のみ受け付ける
- **不可**:
  - shell expansion (`$VAR` / `${VAR:-default}` / `$((arith))`)
  - command substitution (`$(cmd)` / `` `cmd` ``)
  - file 参照 (`@/path/to/secret`)
- **recipe YAML に生の credential 文字列を書かない契約** を schema description (`http.headers` の field doc) と user-guide で明文化する
- **env var が未定義の場合**: interpolation はエラーではなく **header 自体を送信しない** (degraded fetch) として扱う
  - public API は recipe そのままで動く
  - 認証必須 API は env が無い時点で 401/403 が返って fail-fast する
- **log redact 必須**:
  - log / frontmatter / error message に interpolation **後**の値を絶対に載せない
  - `Authorization` / `X-Api-Key` / `Cookie` / `Proxy-Authorization` / その他 `*-Token` / `*-Secret` 系を含む header 名を redact 対象とする
  - 既存 [#170](https://github.com/ozzy-labs/feedradar/pull/170) の credential masking 方針 (proxy 認証情報の masking) と同じ実装パターンを踏襲する

#### D5d JSON body の prompt injection

`kind: json-api` で取得した item content (`title` / `summary` / `body` / `tags`) は、既存 5 adapter と同じく item normalize 後 prompt builder で **M1c boundary marker (`<untrusted_item>...</untrusted_item>`) でラップ**される。M1a regex pre-filter / M5a 検出ログも既存経路で動く。`kind: json-api` 固有の追加対策は不要。

#### Recipe 作者という第二の信頼境界

`kind: json-api` で初めて登場する「recipe 作者」を信頼境界の構成要素として明示する:

| Recipe 経路 | 信頼境界 | 監査責任 |
|---|---|---|
| **公式バンドル recipe** (`recipes/*.yaml`、本 repo 同梱) | FeedRadar repo owner + reviewer | PR review で host / header / pageSize / pagination をレビュー、CI smoke test で endpoint reachability を継続検証 |
| **user 手書き recipe** (user が `~/.config/feedradar/recipes/` 等に置く) | user 自身 | user 自身が recipe 内容を audit。FeedRadar 側の防御は D5a〜D5c の固定 policy が backstop |
| **第三者配布 recipe** (将来検討、現状は範囲外) | 配布元 | F1 (recipe ライブラリ化) で再評価 ([ADR-0012 Future Work](./0012-json-api-adapter-and-recipe-strategy.md#future-work-条件付き再評価)) |

user-guide で「recipe は YAML config と同等の責任で扱う、悪意ある recipe を copy-paste しない、公式 recipe 以外は内容を必ず確認する」旨を警告する (作業は #176 docs 統合に委譲)。

## Decision

5 項目それぞれを以下のように分類する:

| ID | 緩和策 | 判定 | 理由要約 |
|---|---|---|---|
| **M1a** | regex pre-filter | **Adopt (best-effort)** | 低コスト、検出ログ (M5a) と組合せると auditability が上がる |
| **M1b** | LLM-as-a-judge 前処理 | **Reject** | item 数 × API call の cost 爆発、false positive リスク、既存層と effort 重複 |
| **M1c** | boundary marker (`<untrusted_item>...</untrusted_item>`) | **Adopt** | 最重要 layer 1 防御、最小コスト、SKILL 改訂 (M2a) と pair |
| **M2a** | SKILL.md に untrusted instruction を従わない旨を明示 | **Adopt** | M1c の penalty を効かせるための必須 pair |
| **M2b** | tool 呼び出し前 self-check 手順を SKILL に記述 | **Adopt (advisory)** | 完全防御ではないが SKILL の guidance として無害、prompt-injection.md の「過信禁物」前提で記述 |
| **M3a** | sandbox / container 実行 | **Defer** | 抜本的だが UX / 上流非保証で大規模、user-side で dedicated dev container 運用するガイドへ移譲 |
| **M3b** | workspace 外 write 禁止 | **Adopt (SKILL guidance)** | agent CLI の tool 制御は本質的に上流次第、SKILL に instruction として書く以上のことはしない |
| **M4** | `Source.trustLevel` metadata (default `"untrusted"`) | **Adopt** | schema 拡張のみで policy 切替の将来基盤、当面のロジックは「全 source untrusted 扱い」固定 |
| **M5a** | injection 検出を frontmatter / log に記録 | **Adopt** | M1a の検出結果を載せるだけ、auditability 大 |
| **M5b** | 検出時に status=dismissed に自動遷移 | **Reject** | false positive で legitimate item を捨てる、user triage を奪う、安全側に倒すなら別 status (例: `quarantined`) が必要 → 設計判断はさらに別 issue |

### 採用策の defense-in-depth 配置

```text
                  ┌─ M1a (regex pre-filter, best-effort) ─┐
                  │            │                          │
                  │            ▼                          │
                  │     M5a (log/frontmatter 記録) ──────┤
                  │                                       │
[adapter fetch] ──┴────► [item schema parse] ────► items/<id>.yaml
                                                          │
                                                          ▼
                                                  [research/review/update CLI]
                                                          │
                                                          ▼
                                  ┌─ M1c (boundary marker) ─┐
                                  │           │             │
                                  │           ▼             │
                                  ▼   prompt builder        ▼
                          M2a (SKILL: 従わない)  M2b (self-check)
                                                          │
                                                          ▼
                                                   M3b (workspace 外 write guidance、SKILL)
                                                          │
                                                          ▼
                                              [agent CLI spawn] (YOLO 不可避)
```

M4 (`Source.trustLevel`) は **schema レベルの基盤**として上記スタックの判定入力に使う (例: M1a の検出感度を trustLevel 別に切替、将来追加)。

### 留保 / 却下の理由詳細

#### M1b LLM-as-a-judge — Reject

- item 1 件ごとに別 LLM call が必要 → research が 1 item → 1 call の現状から **2x 以上のコスト**
- judge の false positive で legitimate item を block する設計上の責任が FeedRadar 側に集中
- ADR-0008 (status machine) と整合せず、判定結果を載せる status が無い (M5b と相互依存)
- 採用したい場合は **別 ADR / 別 issue で改めて検討** (本 ADR では reject、再評価は禁止しない)

#### M3a sandbox / container — Defer

- 抜本的だが、agent CLI 自身 (claude / codex / gemini / copilot) が container 内動作を保証しない (上流ベンダー依存)
- FeedRadar 側で sandbox wrapper を被せると、agent CLI の認証 / cache / settings dir が container 外参照で壊れる
- user-side の運用ガイダンス (`docs/user-guide.md` の警告: dedicated dev container, [#48](https://github.com/ozzy-labs/feedradar/issues/48)) で当面の責務移譲は成立
- Phase 7 (現状 VS Code extension 想定) や別 Phase で **FeedRadar 専用 dev container 雛形を吐く** のは検討余地あり (`init --with-devcontainer` 等)、別 issue で別途

#### M5b auto-dismiss — Reject

- false positive で legitimate item が消える (regex は本質的に弱い)
- user の triage 判断を FeedRadar が奪う形になる
- 安全側に倒すなら新 status (例: `quarantined`) と user 承認手順が必要 → ADR-0008 改訂が必要 → 本 ADR の範囲を越える
- 採用したい場合は **別 ADR / 別 issue で status machine 改訂** とセットで再評価

## Implementation Status (2026-05-17)

採択時 (2026-05-16) は「採用 / 留保 / 却下 の確定のみ、実装は別 sub-issue」と明記していた。2026-05-17 時点で **採用 7 個別策はすべて実装済み**、却下 / 留保策の状態も以下のとおり確定している。

| ID | 緩和策 | 状態 | 実装位置 |
|---|---|---|---|
| **M1a** | regex pre-filter | **Shipped** | [`src/core/injection-detector.ts`](../../src/core/injection-detector.ts) — `detectInjection()` |
| **M1c** | boundary marker (`<untrusted_item>...</untrusted_item>`) | **Shipped** | [`src/agents/_boundary.ts`](../../src/agents/_boundary.ts) — `wrapUntrusted()` / `renderItemForPrompt()` を prompt builder から呼び出し |
| **M2a** | SKILL.md に untrusted instruction を従わない旨を明示 | **Shipped** | [`src/skills/research/SKILL.md`](../../src/skills/research/SKILL.md) / [`src/skills/review/SKILL.md`](../../src/skills/review/SKILL.md) / [`src/skills/update/SKILL.md`](../../src/skills/update/SKILL.md) の "Untrusted content boundary" セクション |
| **M2b** | tool 呼び出し前 self-check 手順 | **Shipped** | 同上 "Untrusted content boundary" セクション (advisory) |
| **M3b** | workspace 外 write 禁止 (SKILL guidance) | **Shipped** | 同上 "Untrusted content boundary" セクション |
| **M4** | `Source.trustLevel` metadata (default `"untrusted"`) | **Shipped** | [`src/schemas/source.ts`](../../src/schemas/source.ts) — `TrustLevelSchema.default("untrusted")` |
| **M5a** | injection 検出を frontmatter / log に記録 | **Shipped** | [`src/schemas/item.ts`](../../src/schemas/item.ts) — `injectionFlags: z.array(z.string()).default([])`、M1a の検出結果が item frontmatter に載る |
| **D5b** | SSRF host blocklist (private IP / loopback / file:// / cloud metadata 遮断) | **Shipped (#206)** | [`src/core/feeds/_fetch.ts`](../../src/core/feeds/_fetch.ts) — `validateFetchUrl()` を `fetchWithRetry` から呼び出し、`RADAR_FETCH_HOST_ALLOWLIST` で override 可 |
| M1b | LLM-as-a-judge 前処理 | Reject — **未実装、再評価予定なし** | (なし) |
| M5b | 検出時 status=dismissed 自動遷移 | Reject — **未実装、status machine 改訂と pair で再評価** | (なし) |
| M3a | sandbox / container 実行 | Defer — **FeedRadar 側では未実装、user-side dedicated dev container 運用で代替** | (なし、[`docs/user-guide.md`](../user-guide.md) § Security 警告 + ADR-0009 § Defer 理由を参照) |

実装は採択時の sub-issue 分割 (schema → core → agents → skills) に従って段階的に shipped され、Phase 5 終了時点で 7 個別策が出揃った。本 ADR の **判定そのものは不変** — 状態 callout は実装側の trace 用記録。

## Amendment: M1c boundary delivery — argv → stdin (2026-05-24, #270 / #272)

### 背景

agent CLI への prompt 受け渡しが OS の **単一引数長上限 `MAX_ARG_STRLEN` (Linux 128KB)** に抵触する事象が判明した。`getconf ARG_MAX` (~2MB) とは別に、引数 **1 本あたり** 128KB の制限がある。

- `#270` (triage channel): 全 item を 1 プロンプトに連結し `gemini -p "<prompt>"` 等の **単一 argv 引数**として渡していたため、backfill 直後の大量 item (例: 45 件 × ~3KB ≒ 135KB) で `execve()` が `spawn E2BIG` で即死、全件 `unsure` に倒れた。**stdin 移送で修正済み** (`#273`、`src/core/triage/adapter.ts`)。
- `#272` (research / review / update channel): 同根。`src/agents/{gemini,claude-code,codex,copilot}-cli.ts` の `buildXxxPrompt` が `renderItemsForPrompt(items)` / `wrapUntrusted(researchBody)` の出力 (= **M1c 境界マーカーで wrap した untrusted content**) を argv prompt に埋め込む。大きな item バッチ / 大きな research body で同じ `spawn E2BIG` を踏み得る (潜在)。

問題の核心は、**M1c の `<untrusted_item>` 境界マーカーが argv prompt 側で付与されている**点にある。bulk を argv から外すと、この最重要 layer-1 防御のテキスト境界が prompt から失われる。一方 `src/skills/{research,review,update}/SKILL.md` の「§1 入力の確認」は、データの正本を **stdin JSON payload の `items`** から取り出す契約になっており、argv の rendered content とは二層構造になっている。

### 決定

**M1c 境界マーカーの判定 (Decision 表の "Adopt") は不変。適用 (delivery) チャネルのみ argv prompt → stdin payload に移す。**

具体的には、spawn 経路の stdin を **host-agent モード (ADR-0019) の payload と同形式に統一**する。すなわち `src/agents/_boundary.ts` の `renderResearchPayloadBlock` / `renderReviewPayloadBlock` / `renderUpdatePayloadBlock` が既に確立している「`<untrusted_item>` 境界付き本文 + 末尾 machine-readable JSON fence」形式を、spawn 経路の stdin payload としても再利用する。argv は agent を stdin payload に誘導する **thin invocation** に縮小する (triage `#273` の `STDIN_INVOCATION` と同型)。

```text
Before (spawn):
  argv:  <skill 起動文 + renderItemsForPrompt(items) [<untrusted_item> 包み] + constraints>   ← E2BIG 源
  stdin: JSON.stringify({agent, templateId, templateBody, items[raw], outputPath})

After (spawn、本改訂):
  argv:  <thin invocation: "request は stdin payload にある。SKILL を実行せよ">
  stdin: renderXxxPayloadBlock(...)  ← <untrusted_item> 境界保持 + 末尾 JSON fence
```

これにより:

- **M1c のテキスト境界マーカーを保持**したまま (防御の後退なし) argv のサイズ制限を回避する。
- spawn / host-agent の payload 形式が **統一**され、`renderXxxPayloadBlock` を SSoT として両経路で共用できる (現状の argv prompt builder と host payload builder の二重メンテを解消)。
- triage (`#273`) の「thin argv + bulk on stdin」と方向性が一致する。

### 検討した代替案

| 案 | 内容 | 却下理由 |
|---|---|---|
| **A: 構造境界 + directive** | テキストマーカーを廃止し、stdin JSON の `items[*]` 構造 + SKILL directive を M1c とする | 最重要 layer-1 防御の**テキストマーカーを廃止**する判断になり、ADR-0009 の "Adopt" 判定の実質的な後退。防御層を弱める変更を E2BIG 回避のついでに行うべきでない |
| **C: JSON 値内に wrap した string field** | stdin JSON 内に `untrustedContent: "<untrusted_item>...</untrusted_item>"` を持たせる | マーカーは保持できるが JSON 値内タグが不自然で、host-mode payload との形式統一の利得が得られない |

### 実装計画 (本改訂採択後の sub-issue: `#272`)

| 対象 | 変更 |
|---|---|
| `src/agents/{gemini,claude-code,codex,copilot}-cli.ts` | `buildXxxPrompt` を thin invocation に縮小、stdin を `renderXxxPayloadBlock(...)` 出力に変更 (4 ファイル) |
| `src/agents/_boundary.ts` | spawn / host で payload renderer を共用化。finalize 文言の差分 (spawn は CLI が commit、host は `radar … --commit` 案内) はパラメータ化 |
| `src/skills/{research,review,update}/SKILL.md` | stdin 契約を host-mode payload 形式に統合 (「§入力 (stdin JSON)」と「--emit-payload output」を 1 つの payload 契約に集約) |
| tests | prompt-builder の byte-pin (#140 の単一 item レイアウト regression guard 含む) を更新。e2e fake を stdin 読みに (triage `#273` で実績あり) |

### 検証の限界

モデルが **stdin 経由**で渡された `<untrusted_item>` を確実に untrusted data として扱うかは、実 agent CLI なしには完全検証できない (LLM の素直さ依存、prompt-injection.md レイヤー 1 の「過信禁物」前提は不変)。ただし host-agent モード (ADR-0019) と triage (`#273`) が既に同形式を採用しており前例がある。e2e fake では「stdin への配送 + `<untrusted_item>` マーカーの存在」までは機械検証できる。

### 関連 (本改訂)

- `#270` (triage E2BIG、stdin 移送で修正済み `#273`) / `#272` (本改訂の実装 sub-issue)
- [ADR-0019 Host-agent Execution Mode](./0019-host-agent-execution-mode.md) (payload 形式の出所、本改訂で spawn 経路と統一)
- [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) (adapter ↔ SKILL の stdin 契約)

## Consequences

### 良い面

- **layer 1 防御 (M1c + M2a) が確立** → cheapest かつ最も効果のある対策が入る
- **auditability 向上 (M5a)** → 事後追跡が可能、incident 対応の起点ができる
- **schema 拡張 (M4)** → 将来 policy 拡張時の breaking change を回避
- **defense in depth スタック** → 単層が破られても他層が残る

### 悪い面 / 制約

- **完全防御は不可能** (`docs/design/threat-model.md` § 残留リスク に明記)
- **sandbox を入れていない** ため lethal trifecta の "sensitive data access" + "exfiltration" は切れない
- **user 側の最終責務 (`docs/user-guide.md` 警告) は引き続き必須** — FeedRadar だけで安全運用は完結しない
- **agent CLI 上流の挙動変更** (LLM の素直さ / tool 制御方針) に防御の最後尾が依存

### 中立

- 4 source kind すべてを untrusted 扱い → M4 の trustLevel default は `"untrusted"`、`"trusted"` は **明示 opt-in** (user が source 設定 yaml で書く)
- 採用した緩和策 5 件 (M1a / M1c / M2a / M2b / M3b / M4 / M5a — 計 7 個別策) の **実装は各 sub-issue で別途切り出す**:
  - sub-issue 候補:
    1. `feat(schemas): add Source.trustLevel field (default untrusted)` (M4)
    2. `feat(core): regex pre-filter + frontmatter/log audit on detection` (M1a + M5a)
    3. `feat(agents): boundary marker in prompt builder` (M1c)
    4. `docs(skills): instruct agents not to follow untrusted_item instructions` (M2a + M2b + M3b)
- ADR-0001 改訂は **本 ADR の範囲外**: adapter interface 自体に sanitize hook を生やすかは別 ADR (M1a が prompt builder 側でなく adapter 側に来る設計を選ぶ場合のみ)

## Alternatives

### 案 X: 全 mitigation を一気に実装する monolithic PR

却下理由: design 段階で全部決め切るには各層の trade-off の実測値が必要。defense-in-depth は段階的に積む方が選択肢を保てる。

### 案 Y: 何もしない (user 責務に完全移譲)

却下理由: 現状の `docs/user-guide.md` 警告 ([#48](https://github.com/ozzy-labs/feedradar/issues/48)) だけでは、layer 1 防御 (信頼境界の明確化) を実装側が担保しない設計になっている。最低限 M1c + M2a は必須。

### 案 Z: sandbox を最優先で入れる

却下理由: 効果は最大だが、上流ベンダー (claude / codex / gemini / copilot) の保証が無く、また `init` 時に user 側に大規模インフラ (Docker / firejail) を要求する。Phase 7 以降の dev container 雛形 ([#48](https://github.com/ozzy-labs/feedradar/issues/48) の方向性) で再検討。

## 関連

- 親 issue: [#49](https://github.com/ozzy-labs/feedradar/issues/49) chore(security) design prompt injection mitigation
- threat model: [`docs/design/threat-model.md`](../design/threat-model.md)
- 関連 ADR:
  - [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) (4 adapter の YOLO 起動の出所)
  - [ADR-0006 Filter Specification](./0006-filter-specification.md) (filter 層との配置整合)
  - [ADR-0008 Item Status State Machine](./0008-status-state-machine.md) (M5b 却下理由の出所)
  - [ADR-0010 html-js Adapter and Playwright Distribution](./0010-html-js-adapter-and-distribution.md) (§A 信頼境界表に `html-js` 行追加、Chromium バイナリ脆弱性追跡責任の所在)
  - [ADR-0012 JSON API Adapter and Recipe Bundling Strategy](./0012-json-api-adapter-and-recipe-strategy.md) (§A 信頼境界表に `json-api` / `json-feed` 行追加、generic adapter 用追加防御 D5a〜D5c、recipe 作者という第二の信頼境界)
  - [ADR-0020 Claude Routines Generation](./0020-claude-routines-generation.md) (M1c 境界マーカー / M2a / M2b / M3b self-check guidance を routine の自セッション実行時にも継続適用、D5b host allowlist で通信先を購読フィードに限定)
- 関連 docs: [`docs/user-guide.md`](../user-guide.md) § Security 警告 ([#48](https://github.com/ozzy-labs/feedradar/issues/48))
- knowledge:
  - [`ai/practice/prompt-injection`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md) (6 layer 防御階層、lethal trifecta、OWASP LLM01)
  - OWASP Top 10 for LLM Applications 2025 LLM01:2025 Prompt Injection
