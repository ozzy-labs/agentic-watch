---
name: research
description: items/<id>.yaml の検出記事を入力に、最新情報を Web で確認しながら Markdown research レポートを research/<YYYYMMDD>_<slug>_v1.md として生成する。
allowed-tools: Read,Grep,Bash,WebFetch
---

# research - 検出記事から Markdown research レポートを生成

`items/<item-id>.yaml` に記録された検出記事を入力として、Web 上の最新情報も合わせて確認しながら、調査結果を `research/<YYYYMMDD>_<slug>_v1.md` という Markdown ファイルとして生成する。

このスキルは `agentic-watch research <item-id> --agent <agent-id>` から起動され、CLI から **stdin に 1 つの JSON ドキュメント** が渡される。本文の最終仕様は [#9](https://github.com/ozzy-labs/agentic-watch/issues/9) § 2 (`docs/design/skill-design.md`) で確定する。

## 入力 (stdin JSON)

CLI は次のスキーマで JSON を 1 件だけ stdin に書き込む:

```json
{
  "agent":        "<agent-id>",
  "templateId":   "<template-id>",
  "templateBody": "<contents of templates/<templateId>.md, or empty string>",
  "items":        [ <Item object (src/schemas/item.ts)>, ... ],
  "outputPath":   "<absolute path where you MUST write the report>"
}
```

`templateBody` が空文字列のときは本 SKILL の既定構造（後述）を使う。それ以外は `templateBody` の雛形を優先する。

## 手順

### 1. 入力の確認

1. stdin の JSON を読み、`items` / `agent` / `templateId` / `templateBody` / `outputPath` を取り出す
2. 各 `items[*]` から `title` / `url` / `sourceId` / `publishedAt` / `summary` / `matchedKeywords` を確認する
3. 必要なら `sources/<sourceId>.yaml` を Read して source の `name` / `tags` を確認する

### 2. 調査

各 item の `url` の原文を取得して読み、必要に応じて関連する公式ドキュメント・リリースノート・関連ブログを WebFetch で参照する。以下の観点を意識する:

- 何が新しくなったか（diff / 機能追加 / 廃止）
- 誰に関係があるか（対象ユーザー / 業界）
- どの程度の影響があるか（破壊的変更か / オプトインか）
- 一次情報の URL を残す

### 3. レポート生成

`outputPath` のファイルを以下の構造で書き出す。**frontmatter は `ResearchFrontmatterSchema` ([ADR-0003](../../docs/adr/0003-output-format-and-versioning.md) / [src/schemas/research.ts](../../src/schemas/research.ts)) と完全に一致しなければならない**。CLI は書き出されたファイルを schema で検証し、違反すると非ゼロ終了する。

```markdown
---
id: <basename of outputPath without `.md` extension>
itemIds:
  - <items[0].id>
  - <items[1].id>  # 複数 item を統合する場合のみ
agent: <stdin の agent をそのまま>
templateId: <stdin の templateId をそのまま>
createdAt: <ISO 8601 now, e.g. 2026-05-12T01:09:00.000Z>
updatedAt: null
reviewedAt: null
reviewedBy: null
---

# <Title>

## 要約

3-5 行で what / who / impact をまとめる。

## 詳細

- 何が新しい / 変わった
- 既存ワークフローへの影響
- 関連リソース（公式 docs / GitHub release / RFC 等の URL）

## 出典

- 原文: <url>
- 関連: <urls...>
```

### frontmatter フィールド対応表

| field | 値 | 備考 |
|---|---|---|
| `id` | `basename(outputPath, ".md")` | 例: `20260508_github-blog-foo_v1` |
| `itemIds` | `items.map(i => i.id)` の YAML 配列 | 1 件でも配列形式 |
| `agent` | stdin の `agent` をそのまま | `"claude-code"` 等 |
| `templateId` | stdin の `templateId` をそのまま | 既定 `"default"` |
| `createdAt` | 実行時刻 ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`) | UTC |
| `updatedAt` | `null` | 初版は常に null |
| `reviewedAt` | `null` | Phase 2 の `review` コマンドが値を埋める |
| `reviewedBy` | `null` | 同上 |

### 注意

- 旧仕様の `itemId` / `sourceId` / `url` / `publishedAt` / `researchedAt` / `researchedBy` / `version` / `status` / `keywordsMatched` を frontmatter に書かないこと。これらは schema 違反になる
- `outputPath` 以外のファイルへの書き込みは禁止
- `items/*.yaml` を書き換えないこと（CLI が status 遷移を担当）

## 注意事項

- 一次情報を最優先する。二次情報のまとめサイトを引用する場合は、その旨を明記する
- 過剰な憶測や評価は書かない（事実中心）
- 既に同じ `<YYYYMMDD>_<slug>_v1.md` が存在する場合は CLI が事前にエラー終了する（再実行は Phase 4 の `update` で `_v2.md`）
