---
name: research
description: items/<id>.yaml の検出記事を入力に、最新情報を Web で確認しながら Markdown research レポートを research/<YYYYMMDD>_<slug>_v1.md として生成する。
allowed-tools: Read,Grep,Bash,WebFetch
---

# research - 検出記事から Markdown research レポートを生成

`items/<item-id>.yaml` に記録された検出記事を入力として、Web 上の最新情報も合わせて確認しながら、調査結果を `research/<YYYYMMDD>_<slug>_v1.md` という Markdown ファイルとして生成する。

このスキルは `agentic-watch research <item-id> --agent <agent-id>` から起動される。本文の最終仕様は [#9](https://github.com/ozzy-labs/agentic-watch/issues/9) § 2 (`docs/design/skill-design.md`) で確定する。Phase 1 の暫定運用としては以下の手順に従う。

## 入力

- `<item-id>`: `items/<item-id>.yaml` の `id`
- `<agent-id>`: `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（Phase 1 では `claude-code` のみ動作保証）
- 任意で `--template <id>` (既定 `default`)

## 手順

### 1. 入力の確認

1. `items/<item-id>.yaml` を Read し、以下を取り出す:
   - `title` / `url` / `sourceId` / `publishedAt` / `summary`（あれば）
   - `keywordsMatched`（フィルタにヒットしたキーワード）
2. `sources/<sourceId>.yaml` を Read し、source の `name` / `tags` を確認する
3. `templates/<template-id>.md`（既定 `templates/default.md`）が存在する場合は、その雛形に従う

### 2. 調査

`<url>` の原文を取得して読み、必要に応じて関連する公式ドキュメント・リリースノート・関連ブログを WebFetch で参照する。以下の観点を意識する:

- 何が新しくなったか（diff / 機能追加 / 廃止）
- 誰に関係があるか（対象ユーザー / 業界）
- どの程度の影響があるか（破壊的変更か / オプトインか）
- 一次情報の URL を残す

### 3. レポート生成

`research/<YYYYMMDD>_<slug>_v1.md` を以下の構造で書き出す。`<YYYYMMDD>` は記事の `publishedAt`（無ければ実行日）、`<slug>` は `<sourceId>-<簡潔な英 slug>`。

```markdown
---
itemId: <item-id>
sourceId: <source-id>
url: <original url>
publishedAt: <ISO 8601>
researchedAt: <ISO 8601 now>
researchedBy: <agent-id>
version: 1
status: researched
keywordsMatched: [<keyword>, ...]
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

詳細フォーマットの正典は [ADR-0003](../../docs/adr/0003-output-format-and-versioning.md)。

### 4. items の更新

`items/<item-id>.yaml` の `status` を `researched` に更新し、`researchPath: research/<filename>.md` を記録する。

## 注意事項

- 一次情報を最優先する。二次情報のまとめサイトを引用する場合は、その旨を明記する
- 過剰な憶測や評価は書かない（事実中心）
- 既に同じ `<YYYYMMDD>_<slug>_v1.md` が存在する場合はエラーにし、再実行は `update` スキル経由で `_v2.md` を作る
