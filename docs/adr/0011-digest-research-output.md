# ADR-0011: Digest Research Output

## Status

Proposed（2026-05-18）— Epic [#131](https://github.com/ozzy-labs/feedradar/issues/131) の foundation。後続実装 PR (#139-142) はすべて本 ADR の決定に従う。

本 ADR は [ADR-0003](./0003-output-format-and-versioning.md)（Output Format and Versioning）を**拡張**する。単体 item 向けの命名規約・supersedes チェーン・status 遷移ルールはそのまま継承し、digest（複数 item を 1 レポートに束ねる出力モード）に固有の差分のみを本 ADR で確定させる。

## Context

短期間に類似トピックの item が複数ヒットすると、1 item につき 1 ファイルの research を生成する現行モードでは `research/` が乱立し、レビュー負荷が上がる。FeedRadar の "multi-agent + multi-feed" を活かして、関連する複数 item を **1 つの digest レポート**にまとめる出力モードを提供する。

設計の前提（Epic #131 の事前調査による）として、既存のスキーマ・抽象は digest 対応に既に流用可能:

- `ResearchFrontmatterSchema.itemIds` は `z.array(z.string().min(1)).min(1)` で複数 item を持てる（[`src/schemas/research.ts`](../../src/schemas/research.ts)）
- `loadTemplate(id, dir)` は任意 ID を読めるため、`templates/digest.md` を足すだけで参照可能
- ADR-0007（skill-bundling）の `init` で bundled template を workspace に配布する経路がある

新たに ADR で確定する必要があるのは、以下 7 項目:

1. digest ID の命名規約
2. slug の導出アルゴリズム
3. source 横断 digest を許可するか
4. supersedes チェーンの扱い
5. 複数 item の status 遷移（[ADR-0008](./0008-status-state-machine.md) との整合）
6. templateId の固定値
7. 構成 item 間の `trustLevel` が異なる場合の解決規則（[ADR-0009](./0009-untrusted-external-content-handling.md) との整合）

本 ADR は Epic #131 の **foundation** であり、後続実装 PR (#139 templates / #140 agents / #141 cli / #142 docs) はすべて本 ADR の決定に従う。実装に持ち込んで再議論にならないよう、各項目を**具体的なアルゴリズム + 動作例**まで落とし込む。

## Decision

### 1. digest ID の命名

```text
research/<YYYYMMDD>_digest_<slug>_v<n>.md
```

- `YYYYMMDD`: digest 生成日（UTC、CLI 起動日）。単体 research（[ADR-0003](./0003-output-format-and-versioning.md)）と同じく `item.publishedAt` ではなく**生成日**を用いる。digest は複数 item の集約であり、構成 item の `publishedAt` は揃わないため
- 固定リテラル `digest`: 単体 research との視覚的識別を容易にする（ファイル一覧で digest が一目で分かる、supersedes チェーンが単体 / digest で disjoint になる）
- `<slug>`: §2 の導出規約に従う
- `_v<n>`: バージョン番号。初回 `v1`、`update` 実行で `v2`, `v3`, ...（単体 research と同じ）

**例**:

```text
research/20260518_digest_claude-code_v1.md
research/20260518_digest_claude-code-anthropic_v1.md
research/20260518_digest_digest_v1.md      # フォールバック (matchedKeywords が空)
research/20260601_digest_claude-code_v2.md  # 同 slug の v+1
```

#### 単体 research との関係

| モード | ファイル名 | 識別子 |
|---|---|---|
| 単体 research | `<YYYYMMDD>_<slug>_v<n>.md` | slug 内に sourceId / title 由来文字列 |
| **digest** | `<YYYYMMDD>_digest_<slug>_v<n>.md` | 固定リテラル `digest` を含む |

固定リテラル `digest` は単体 research の slug が**通常生成しない**プレフィックスである（単体 research の slug は `<sourceId>-<title>` の形を取り、現行 [`src/cli/research.ts`](../../src/cli/research.ts) の `buildSlug()` を参照）。これにより両者は ID 空間上で衝突しない。

### 2. slug の導出

digest に含まれる全 item の `matchedKeywords`（[`src/schemas/item.ts`](../../src/schemas/item.ts) で `z.array(z.string()).default([])` として定義）を集計し、**頻度上位 1〜2 個**を kebab-case で連結する。

#### アルゴリズム

```text
function deriveDigestSlug(items: Item[]): string {
  // 1. 全 item の matchedKeywords を flat に集計
  const freq = new Map<string, number>();
  for (const item of items) {
    for (const kw of item.matchedKeywords) {
      const normalized = kw.toLowerCase().trim();
      if (normalized === "") continue;
      freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
    }
  }

  // 2. 頻度降順、同頻度時は文字列昇順で安定ソート
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kw]) => kw);

  // 3. 上位 1〜2 個を kebab-case 化
  //    - 1 個のみ取れた場合はその 1 個
  //    - 2 個取れた場合は 2 個を "-" で連結
  //    - matchedKeywords が空 or 全て無効 → "digest" にフォールバック
  const top = ranked.slice(0, 2);
  if (top.length === 0) return "digest";
  return top.map(kebabCase).join("-");
}

function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

#### 上位 1 個か 2 個かの選択基準

- 上位 2 個を取る（ただし `ranked.length >= 2` のとき）
- `ranked.length === 1` のとき → 1 個のみ
- `ranked.length === 0` のとき → `digest`（フォールバック）

#### 動作例

| items の matchedKeywords | ranked | slug |
|---|---|---|
| `[["Claude Code"], ["Claude Code", "Anthropic"]]` | `claude-code`, `anthropic` | `claude-code-anthropic` |
| `[["Claude Code"], ["Claude Code"]]` | `claude-code` | `claude-code` |
| `[["LLM"], ["AI"], ["AI"]]` | `ai`, `llm` | `ai-llm` |
| `[[], []]` | (empty) | `digest` |
| `[["GPT-4o"], ["GPT-4o"]]` | `gpt-4o` | `gpt-4o` |

#### 上限文字数

slug 全体（連結後）は **60 文字**で切り詰める（単体 research の `buildSlug()` と同じ制限。ファイル名 = `YYYYMMDD_digest_<slug>_v<n>.md` の合計が典型的なファイルシステム制限 255 バイトを安全に収まる）。切り詰めは末尾の不完全な単語を残さないよう、ハイフン直前で切る:

```text
function clampSlug(s: string, max = 60): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastHyphen = cut.lastIndexOf("-");
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}
```

### 3. source 横断 digest

**許可する**。

理由:

- multi-feed が FeedRadar の強み（Epic #131）
- `ResearchFrontmatterSchema.itemIds` は単なる ID 配列で source 情報を含まないが、item ID は source-prefixed 形式（[ADR-0002](./0002-source-adapter-plugin-pattern.md) の Item ID 派生コントラクト + [`src/core/feeds/derive-id.ts`](../../src/core/feeds/derive-id.ts)）なので、digest を読む側は `itemIds` から source を機械的に解決できる
- 単一 source 限定にする技術的理由がない

```yaml
itemIds:
  - anthropic-news-2026-05-10-claude-code   # source: anthropic-news
  - hacker-news-39876543-claude-code         # source: hacker-news
  - github-releases-anthropics-claude-code-v0-5-0   # source: github-releases
```

CLI 側（[ADR-0011 採択後の #141](https://github.com/ozzy-labs/feedradar/issues/141)）は item ID から source を解決して各 item.yaml を loadItems で取得する。

### 4. supersedes

digest の `supersedes` は **「同じ slug の前バージョン」のみ**を指す。単体 research との混在は不可。

#### 規約

| 版 | `supersedes` 値 |
|---|---|
| digest v1（初版） | `null` |
| digest v+1（v2 以降） | 直前版 digest の `id`（拡張子を除いたファイル名） |

例: `20260601_digest_claude-code_v2.md` の frontmatter:

```yaml
---
id: 20260601_digest_claude-code_v2
itemIds:
  - anthropic-news-2026-05-10-claude-code
  - hacker-news-39876543-claude-code
agent: claude-code
templateId: digest
createdAt: "2026-05-18T00:00:00Z"   # v1 の createdAt を引き継ぐ (ADR-0003 と整合)
updatedAt: "2026-06-01T00:00:00Z"   # この v+1 ファイルの作成時刻
reviewedAt: null
reviewedBy: null
supersedes: 20260518_digest_claude-code_v1
---
```

#### disjoint 制約

- 単体 research（`<YYYYMMDD>_<slug>_v<n>.md`、ファイル名に `digest_` を含まない）の `supersedes` には digest ID を**書けない**
- digest（`<YYYYMMDD>_digest_<slug>_v<n>.md`）の `supersedes` には単体 research ID を**書けない**

§1 の命名規約で両者の ID 空間が分離されているため、`supersedes` の値を見るだけで「これは digest 系か単体系か」が一意に判定できる。実装側は `update` コマンドで v+1 を作る際、直前版のファイル名が `_digest_` を含むか否かで分岐するだけでよい（パース不要）。

#### 含まれる item の変化

digest v+1 を作る際、`itemIds` は **v1 と同じ集合**を保持する（[ADR-0003 §Update 系譜](./0003-output-format-and-versioning.md) の v+1 不変項目と整合）。新しい item を追加したい場合は v+1 ではなく、**新規 digest（別 slug or 別日付）**として作成する。これは:

- update セマンティクスを単純に保つ（"同じスコープの最新化"）
- 含まれる item が変わると digest のテーマも変わるため、別 digest として分けたほうが履歴として読みやすい

### 5. 複数 item の status 遷移

digest 生成時、含まれる **全 item** を `new` → `researched` に遷移させる（[ADR-0008](./0008-status-state-machine.md) の単体 research と整合）。

#### 遷移ルール

- 入力 item の `status` が `new`（detected） → `researched` に遷移
- 入力 item の `status` が既に `researched` / `reviewed` → そのまま（再 research による下方遷移なし、[ADR-0008](./0008-status-state-machine.md) の terminal 状態保護と整合）
- 入力 item の `status` が `dismissed` → digest に含めてはならない。CLI は事前にバリデートし、`dismissed` item が混じっていれば exit 非ゼロでエラー

#### アトミシティ

digest 生成は次の 2 つの side effect を持つ:

1. `research/<id>.md` を 1 ファイル書き出し
2. 含まれる N item の `items/<sourceId>/<itemId>.yaml` を `status: researched` に更新

これらは [ADR-0003 §Review の二重更新](./0003-output-format-and-versioning.md) と同じく、同一コマンド実行内でアトミックに行う（部分失敗時は両方ロールバック）。N 件 yaml の書き戻し中に失敗した場合、研究ファイル自体も削除（または書き出さない）して整合を保つ。

### 6. templateId

固定文字列 `digest`。

```yaml
templateId: digest
```

#### 解決順序（[`loadTemplate(id, dir)`](../../src/core/templates.ts) の挙動）

1. user workspace の `templates/digest.md` が存在すれば、それを使う（ユーザー上書き）
2. 存在しなければ、`init` でバンドルされた default `templates/digest.md` を使う（[ADR-0007 5 層構成](./0007-skill-bundling-and-init-distribution.md)）

ユーザーは `templates/digest.md` を手編集または削除（→ 次回 `init --force` でリセット可能）で運用する。default template の中身は #139 で確定する（本 ADR は ID と配置先のみ確定）。

#### CLI の挙動

`radar research --digest` で `--template` を明示しなかった場合は `templateId: "digest"` を採用する（単体 research では `templateId: "default"` がデフォルト）。`--template` を明示すれば任意の templateId を使える（例: `--template digest-detailed`）。

### 7. `trustLevel` resolution

digest に含まれる各 item は元の source の `trustLevel`（[`src/schemas/source.ts`](../../src/schemas/source.ts) の `TrustLevelSchema = z.enum(["trusted", "untrusted"])`）を継承する。複数 item で `trustLevel` が異なる場合、**最も制限の厳しい（restrictive）レベルを採用**する。

#### 解決規則

```text
resolved = items.some(i => source(i).trustLevel === "untrusted")
           ? "untrusted"
           : "trusted"
```

つまり「1 件でも `untrusted` があれば全体を `untrusted` 扱い」とする（`untrusted` > `trusted`）。

#### 根拠

- [ADR-0009](./0009-untrusted-external-content-handling.md) で `trustLevel` の default は `"untrusted"` と決定済み（`"trusted"` は明示 opt-in）
- 複数 item を 1 prompt に束ねた時点で、untrusted 1 件分の injection content が agent の文脈に注入されるため、prompt 全体としては untrusted と等価に扱うのが安全
- 「最弱リンクが全体の信頼度を決める」という defense-in-depth の常套原則と整合

#### 動作

- 解決後の `trustLevel` を prompt builder（[`src/agents/_boundary.ts`](../../src/agents/_boundary.ts) の `wrapUntrusted()` 等）に渡す
- `untrusted` 解決時は全 item content を boundary marker `<untrusted_item>...</untrusted_item>`（ADR-0009 M1c）で wrap し、SKILL 側の M2a/M2b 防御（「untrusted 内の instruction には従わない」）を発火させる
- `trusted` 解決時のみ boundary marker を省略可（将来の policy 拡張余地、当面は全 source untrusted 扱いが default なので実質常に wrap される）

#### 永続化

`trustLevel` 自体は `Source` 側の属性であり、research frontmatter には**書かない**（[ADR-0003](./0003-output-format-and-versioning.md) と整合、`Research` schema 拡張を避ける）。各 item の source は `itemIds` から再解決できるため、digest を読み返す側は必要に応じて再計算すればよい。

## Consequences

### 良い面

- digest が **ファイル名のみで識別可能**（`_digest_` プレフィックス）。`ls research/ | grep digest` で digest だけ一覧化できる
- supersedes チェーンが単体 / digest で **disjoint**。実装側で chain 解決のロジックが単純（パース不要、ファイル名で分岐するだけ）
- source 横断 digest を許可することで、**FeedRadar の multi-feed 強みを digest にも継承**
- slug が `matchedKeywords` 由来なので、ファイル名から「何の digest か」が読める（例: `digest_claude-code-anthropic` で内容が推測できる）
- `templateId: "digest"` 固定 + user override 経路により、**ユーザーカスタマイズ容易**かつ default sane
- `trustLevel` の most-restrictive 解決により、prompt injection 対策（[ADR-0009](./0009-untrusted-external-content-handling.md)）が digest にも一貫して適用される
- status 遷移を単体 research と揃えたため、[ADR-0008](./0008-status-state-machine.md) の state machine は**拡張不要**

### 悪い面 / 制約

- `matchedKeywords` が空の item ばかりだと slug がフォールバックの `digest` に揃い、同日複数 digest を作ると `20260518_digest_digest_v1.md` / `20260518_digest_digest_v2.md` のように衝突しやすい（CLI 側で同 slug + 同日 + v1 重複時は既存 [ADR-0003](./0003-output-format-and-versioning.md) の rule に従いエラーにする）
- slug が頻度上位 1〜2 keyword に偏るため、3 つ以上のトピックを混ぜた digest では slug が内容を十分表現しない（運用ガイドで「テーマを絞って digest にする」ことを推奨）
- digest v+1 で `itemIds` 不変としたため、後から item を追加したいケースは新規 digest として作る必要がある（運用学習コスト）
- 単体 research と digest の supersedes チェーンが交差できないため、「単体 research v1 → digest にまとめて v2 として継承」のような系譜は表現不可（YAGNI、必要性が出たら別 ADR で改訂）

### 中立

- digest の `templateId` は固定文字列 `digest` であり、`Research` schema 側に enum 制約は持たせない（`z.string().min(1)` のまま）。任意の templateId を許す柔軟性は単体 research と同じ
- `trustLevel` の解決ロジックは [ADR-0009](./0009-untrusted-external-content-handling.md) の "全 source untrusted 扱い固定" の現状方針下では実質常に `untrusted` に解決される。将来 `trusted` source が実装された際の policy 切替基盤として機能する
- digest は単体 research と同じ `research/` ディレクトリに置く（別ディレクトリにしない）。ファイル名で識別可能なので分離する利益が薄く、git diff / git log での履歴追跡も統一されたパスのほうが扱いやすい

## Alternatives

### 案 A: ID 命名で `digest` プレフィックスを使わず、単体 research と同じ命名

候補: `<YYYYMMDD>_<auto-slug>_v<n>.md`

却下理由: ファイル一覧で digest が単体 research に紛れて視認性が下がる。supersedes チェーン解決にも frontmatter `itemIds.length > 1` のパースが必要になり、ファイル名だけで分岐できる本 ADR の方針より複雑。

### 案 B: slug を完全フリーテキスト（ユーザー指定）

候補: `radar research --digest --slug my-topic ...`

却下理由: ユーザーに毎回考えさせる UX が悪く、命名揺れも発生する。`matchedKeywords` 由来の機械生成 + フォールバックで運用上十分。将来必要なら `--slug` フラグを追加するのは breaking change にならない（拡張余地）。

### 案 C: digest を単一 source 限定

却下理由: §3 で述べたとおり、multi-feed が FeedRadar の強み。技術的制約も無いため制限する積極理由がない。

### 案 D: digest v+1 で item を追加可能にする

候補: v+1 で `itemIds` を superset にする運用を許可

却下理由: §4 で述べたとおり、update セマンティクスが "同じスコープの最新化" から "スコープも変化" に拡散すると、frontmatter の意味が壊れる（"このレポートは何の集約か" が版間で変わる）。新規 digest を作る運用のほうが履歴として読みやすい。

### 案 E: `trustLevel` を per-item でレポート frontmatter に保持

候補: digest frontmatter に `trustLevels: ["untrusted", "trusted", "untrusted"]` を持つ

却下理由: source 側に既にある情報を二重に持つだけで drift リスクがあり、digest を読む側は `itemIds` から source を解決して取り直すほうが整合性が確実。`Research` schema を拡張せずに済む（[ADR-0003](./0003-output-format-and-versioning.md) の "ファイル単体で完結" 要件は `itemIds` 経由の解決で満たせる）。

## 関連

- 親 Epic: [#131](https://github.com/ozzy-labs/feedradar/issues/131) — feat(cli, agents): Digest モード — 複数 item を 1 レポートに束ねる
- 子 Issue（本 ADR の決定に従う）:
  - [#139](https://github.com/ozzy-labs/feedradar/issues/139) feat(templates, init): bundle default digest template
  - [#140](https://github.com/ozzy-labs/feedradar/issues/140) feat(agents): support multi-item digest prompts
  - [#141](https://github.com/ozzy-labs/feedradar/issues/141) feat(cli): add radar research --digest with multi-item input
  - [#142](https://github.com/ozzy-labs/feedradar/issues/142) docs(user-guide, readme): document digest mode
- 関連 ADR:
  - [ADR-0003 Output Format and Versioning](./0003-output-format-and-versioning.md) — 本 ADR は ADR-0003 の拡張。ファイル命名・supersedes・update 不変仕様の出所
  - [ADR-0007 Skill Bundling and `init` Distribution](./0007-skill-bundling-and-init-distribution.md) — `templates/digest.md` を `init` でバンドル配布する経路の出所
  - [ADR-0008 Item Status State Machine](./0008-status-state-machine.md) — `new → researched` 遷移ルールの出所。digest 生成時の全 item 遷移は ADR-0008 と整合
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) — `trustLevel` schema、boundary marker（M1c）、SKILL 側 untrusted 防御（M2a/M2b）の出所。digest の most-restrictive 解決は ADR-0009 と整合
- 実装関連:
  - [`src/schemas/research.ts`](../../src/schemas/research.ts) — `ResearchFrontmatterSchema.itemIds` / `templateId` は本 ADR の決定で値ドメインを確定
  - [`src/schemas/item.ts`](../../src/schemas/item.ts) — `matchedKeywords` を slug 導出の入力に使用
  - [`src/schemas/source.ts`](../../src/schemas/source.ts) — `TrustLevelSchema` を per-item 信頼度の出所に使用
  - [`src/cli/research.ts`](../../src/cli/research.ts) `buildSlug()` — 単体 research の slug 導出。digest 用 `deriveDigestSlug()` は #141 で別関数として実装
