---
name: review
description: 既存 research レポート (research/<id>.md) を別エージェント視点でクロスレビューし、本文末尾にレビューコメントを追記、frontmatter の reviewedAt / reviewedBy を更新する。items.yaml の status 遷移は CLI が担当する。
allowed-tools: Read,Grep,Bash,WebFetch
---

# review - research レポートをクロスチェックする

`agentic-watch review <research-id> --agent <agent-id>` から起動される。CLI は **stdin に 1 つの JSON ドキュメント** を渡す。本 SKILL は 4 agent (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) すべてに共通で、agent 固有の挙動は各 adapter の薄いラッパで吸収する ([ADR-0001](../../docs/adr/0001-agent-adapter-interface.md))。

research を書いた agent と**別の agent** に依頼することを推奨する (クロスエージェント運用、[user-guide.md](../../docs/user-guide.md))。

## 入力 (stdin JSON)

CLI は次のスキーマで JSON を 1 件だけ stdin に書き込む:

```json
{
  "agent":               "<agent-id>",
  "templateId":          "<template-id>",
  "templateBody":        "<contents of templates/<templateId>.md, or empty string>",
  "researchPath":        "<absolute path to research/<id>.md>",
  "researchFrontmatter": { /* parsed pre-review frontmatter */ },
  "researchBody":        "<full file body including frontmatter>"
}
```

`templateBody` が空文字列のときは本 SKILL の既定観点 (後述) を使う。それ以外は `templateBody` の雛形を優先する。

`researchBody` には frontmatter (`---` で囲まれた YAML) と本文の両方が含まれている。`Read` で `researchPath` を再読してもよいが、stdin のスナップショットを正として扱ったほうが drift を避けられる。

## 手順

### 1. レポートの読み込みと事前確認

1. stdin の JSON を読み、`researchPath` / `researchFrontmatter` / `researchBody` を取り出す
2. `researchFrontmatter.reviewedAt` が **`null`** であることを確認する (非 null なら CLI 側で先に弾かれているはずだが、念のため stop して報告)
3. `researchFrontmatter.itemIds[*]` の `items/<sourceId>/<itemId>.yaml` を Read し、`status: researched` であることを確認する (`sourceId` は items dir を `Grep` で逆引きする)
4. 必要なら `researchBody` の `## 出典` セクションに記載された URL を `WebFetch` で再取得し、レビューの根拠とする

### 2. レビュー観点

`templateBody` が空文字列の場合、以下の **4 観点** で簡潔にレビューする。各観点 2-3 行が目安:

- **事実関係**: 一次情報との突合。誤った日付・バージョン・人名・機能名がないか
- **抜け**: 重要な変更点・破壊的変更・対象ユーザー・コスト等の漏れがないか
- **憶測 / 主観の混入**: 「〜だろう」「〜が望ましい」等、事実ベースでない記述
- **出典の妥当性**: 一次情報 URL が記載されているか。二次情報のみで断定していないか

`templateBody` が空でない場合は、その雛形が指示する観点を優先する (workspace 側でレビュー方針をカスタマイズできるエスケープハッチ)。

レビュー内容は research 本文を**書き換えない**こと。指摘はすべて末尾の review セクションに集約する。

### 3. レビューブロックの追記

`researchPath` のファイル末尾に以下のフォーマットで **単一のレビューセクション** を追記する。複数 review セクションを並べないこと (`update` 後の再 review については ADR-0008 が未定義であり、Phase 2 では single block を契約とする)。

```markdown

## レビュー (<agent-id>, <ISO 8601 UTC>)

### 事実関係

- ...

### 抜け

- ...

### 憶測 / 主観の混入

- ... (なければ「指摘なし」)

### 出典の妥当性

- ...
```

`<agent-id>` は stdin の `agent` をそのまま、`<ISO 8601 UTC>` は実行時刻 (`YYYY-MM-DDTHH:mm:ss.sssZ`)。

### 4. frontmatter の更新

同じファイルの frontmatter について、以下のフィールドを**置き換える**:

| field | 値 | 備考 |
|---|---|---|
| `reviewedAt` | 手順 3 と同じ ISO 8601 文字列 | UTC |
| `reviewedBy` | stdin の `agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot` |

それ以外の frontmatter フィールド (`id` / `itemIds` / `agent` / `templateId` / `createdAt` / `updatedAt`) は**変更しないこと**。CLI 側で diff を検出して mutation を rollback する。

### 5. 書き出し

`researchPath` に対し、`Bash` の `cat <<EOF > path` 等で frontmatter + 本文 + 追記したレビューセクションをまとめて書き出す。`researchPath` 以外のファイルへの書き込みは禁止 (CLI が `items/*.yaml` の status 遷移を担当する)。

## アトミック更新と CLI 側の責務

`agentic-watch review` 実行時に**同一コマンド内で 2 ファイルが更新される**:

1. `research/<id>.md` — frontmatter `reviewedAt` / `reviewedBy` + 本文末尾のレビュー
2. `items/<sourceId>/<itemId>.yaml` — `status: researched → reviewed`

CLI 側は agent 起動前に両ファイルのスナップショットを保持し、以下の場合に**両方をロールバック**する ([ADR-0003](../../docs/adr/0003-output-format-and-versioning.md) / [ADR-0008](../../docs/adr/0008-status-state-machine.md)):

- adapter が非ゼロ終了した
- 書き換え後の frontmatter が `ResearchFrontmatterSchema` に違反した
- `reviewedAt` / `reviewedBy` が未スタンプ、または `reviewedBy` が起動 agent と一致しない
- immutable フィールド (`id` / `itemIds` / `agent` / `templateId` / `createdAt`) が改変された
- `items/*.yaml` の write が失敗した

agent 側でやるべきことは「`researchPath` を 1 回だけ正しく書き換える」ことだけ。`items/*.yaml` は触らないこと。

## 注意事項

- research を書いた agent と同じ agent での review は推奨されない (盲点が補正されない)
- research 本文 (要約・詳細・出典等の既存セクション) を書き換えないこと。指摘は末尾のレビューセクションに集約する
- 既に `reviewedAt` が non-null の研究レポートに対する re-review は CLI が拒否する。`update` で `_v2.md` を作ってから review し直すフロー (Phase 4 連携)
- `WebFetch` でレートリミットや 4xx に当たった場合は、本文中にその旨を「事実関係」観点で記録し、判断材料が不足している旨を明示する
