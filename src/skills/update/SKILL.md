---
name: update
description: 既存 research レポートを最新情報で再生成し、_v(N+1).md として新バージョンを作成する。旧バージョンは保持 (immutable history)。CLI から渡される前版 frontmatter と本文を読み、rewrite-and-supersede 戦略で全文を書き直し、frontmatter の supersedes に前版 id を記録する。
allowed-tools: Read,Grep,Bash,WebFetch
---

# update - research レポートを更新して新バージョンを生成

`agentic-watch update <research-id> --agent <agent-id>` から起動される。CLI は **stdin に 1 つの JSON ドキュメント** を渡し、本 SKILL は前版 (v(N)) を読み込んで rewrite-and-supersede 戦略で v+1 全文を書き直す ([ADR-0003](../../docs/adr/0003-output-format-and-versioning.md) / [docs/design/skill-design.md §8](../../docs/design/skill-design.md))。

研究 (`research`) を書いた agent と**別の agent** で update を実行することも可能。`agent` フィールドは v+1 で書き換えてよい (skill-design.md §8.3 で mutable と定義)。`reviewedAt` / `reviewedBy` は v+1 で **`null` にリセット** する。

## 入力 (stdin JSON)

CLI は次のスキーマで JSON を 1 件だけ stdin に書き込む:

```json
{
  "agent":        "<agent-id>",
  "templateId":   "<template-id>",
  "templateBody": "<contents of templates/<templateId>.md, or empty string>",
  "prevResearch": {
    "frontmatter": { /* 前版 (v(N)) の parsed frontmatter */ },
    "body":        "<前版ファイル全体 (frontmatter + 本文)>"
  },
  "items":        [ <Item object (src/schemas/item.ts)>, ... ],
  "outputPath":   "<v+1 の絶対パス、例: /workspace/research/<base>_v<N+1>.md>"
}
```

`templateBody` が空文字列のときは `.agents/skills/research/SKILL.md` と同じ既定構造を使う (update は rewrite-and-supersede のため research SKILL の本文構造を再利用する)。

`prevResearch.body` には frontmatter (`---` で囲まれた YAML) と本文の両方が含まれている。前版ファイルを `Read` で再読しても良いが、stdin のスナップショットを正として扱う方が drift を避けられる。

## 手順

### 1. 入力の確認

1. stdin の JSON を読み、`outputPath` / `prevResearch.frontmatter` / `prevResearch.body` / `items` / `agent` / `templateId` / `templateBody` を取り出す
2. `prevResearch.frontmatter.id` が前版 id (`<base>_v<N>`)、`outputPath` のベース名が新版 id (`<base>_v<N+1>`) になっていることを確認する (CLI 側で計算済みのため `outputPath` の値をそのまま信用してよい)
3. 各 `items[*]` から `title` / `url` / `sourceId` / `publishedAt` / `summary` / `matchedKeywords` を確認する
4. 必要なら `sources/<sourceId>.yaml` を Read して source の `name` / `tags` を確認する

### 2. 最新情報の取得

各 item の `url` の原文を再取得し、前版 (`prevResearch.body` の `## 出典` セクションに記載されている URL) との差分を判断する材料を集める:

- 原文ページに公開後の改訂・追記がないか
- 関連リリースノート / 公式 docs の更新を WebFetch で確認
- 同一トピックに関する後続ブログ / 公式アナウンスがあれば取り込む

### 3. 差分の判定 (no-op suppression)

前版と比較して **material change がない** 場合 (typo / レイアウト変更のみ、引用 URL が同じ内容を返す、関連リリースがない、等)、新バージョンを作成せず **何も書き出さない**。CLI 側は SKILL が `outputPath` を生成しなかった場合にエラーとして検出する。

> **Note (Phase 5)**: 「材料の有無」を判断するのは agent の責務。CLI は `{ "decision": "skip", "reason": "<short>" }` の JSON-line を stdout に書く protocol を将来採用予定だが、現バージョンでは「何も書かない」「書く」の 2 択で扱う。skip にする場合は理由を stderr に短く出して終了する。

material な変更がある場合のみ、手順 4 以降を実行する。

### 4. v+1 全文の生成 (rewrite-and-supersede)

`outputPath` に **新規ファイルとして** v+1 全文を書き出す。前版を編集してはいけない (immutable history、[ADR-0003](../../docs/adr/0003-output-format-and-versioning.md))。

#### frontmatter (CLI が schema で検証する)

```yaml
---
id: <basename of outputPath without `.md` extension>
itemIds:
  - <items[0].id>
  # 前版と同じ itemIds を保持
agent: <stdin の agent をそのまま>
templateId: <prevResearch.frontmatter.templateId と同じ値>
createdAt: <prevResearch.frontmatter.createdAt と同じ値 — 検出時系列を保持>
updatedAt: <ISO 8601 now, e.g. 2026-06-12T00:00:00.000Z>
reviewedAt: null
reviewedBy: null
supersedes: <prevResearch.frontmatter.id — 前版 id、ファイル名から `.md` を除いたもの>
---
```

| field | 値 | 備考 |
|---|---|---|
| `id` | `basename(outputPath, ".md")` | 例: `20260612_anthropic-claude-3-7_v2` |
| `itemIds` | 前版から引き継ぐ | 追加・削除しない |
| `agent` | stdin の `agent` | v+1 では研究 agent を切り替えてよい |
| `templateId` | 前版から引き継ぐ | rewrite-and-supersede 戦略のため同じテンプレートを使う |
| `createdAt` | 前版から引き継ぐ | 検出から report までの時系列が保持される ([ADR-0003](../../docs/adr/0003-output-format-and-versioning.md)) |
| `updatedAt` | 実行時刻 ISO 8601 (UTC) | この v+1 ファイルの作成時刻 |
| `reviewedAt` | `null` | v+1 では reset。v1 の review は v+1 には引き継がない ([ADR-0003](../../docs/adr/0003-output-format-and-versioning.md)) |
| `reviewedBy` | `null` | 同上 |
| `supersedes` | 前版 id (`prevResearch.frontmatter.id`) | ファイル名から `.md` を除いたもの |

CLI 側で drift を検出した場合は自動で frontmatter を書き直す (ID / itemIds / templateId / createdAt / supersedes / reviewedAt / reviewedBy / agent の差異を一括で訂正)。ただし agent はこの保険に依存せず、上記表どおりに書き出すこと。

#### 本文構造

前版を読みつつ、最新情報を反映した全文を新たに書き出す。冒頭に **`## v<N+1> での変更点`** セクションを置き、前版との material な差分を簡潔に要約する (これは利用者向けの diff narrative、[`docs/design/skill-design.md` §8.2](../../docs/design/skill-design.md))。残りは `research` SKILL と同じ構造 (`# Title` → `## 要約` → `## 詳細` → `## 出典`) で書く。

```markdown
# <Title>

## v<N+1> での変更点

- <v1 から変わった点 1>
- <v1 から変わった点 2>
- <影響: 誰に / どの程度>

## 要約

3-5 行で what / who / impact を最新情報を反映してまとめる (v1 と差し替え可)。

## 詳細

- 何が新しい / 変わった (前版時点との差分)
- 既存ワークフローへの影響 (v1 で書いた前提が変わっていればその旨)
- 関連リソース (公式 docs / GitHub release / RFC 等の URL)

## 出典

- 原文: <url>
- 関連: <urls...>
- 前版: <prevResearch.frontmatter.id> ← supersedes チェーンを人間向けにも残す
```

### 5. 書き出し

`outputPath` に対し、`Bash` の `cat <<EOF > path` 等で frontmatter + 本文をまとめて書き出す。`outputPath` 以外のファイルへの書き込みは禁止 (前版 v(N) ファイル、`items/*.yaml`、`state/*.yaml` はいずれも触らない)。

## 注意事項

- **旧バージョンは immutable**。書き換え / 削除しない ([ADR-0003](../../docs/adr/0003-output-format-and-versioning.md))
- **items.yaml の status は不変** ([ADR-0008](../../docs/adr/0008-status-state-machine.md))。`update` は item lifecycle を進めない。CLI が status を一切書き換えない (`reviewed` だった item は `reviewed` のまま、`researched` だった item は `researched` のまま)
- **v+1 では `reviewedAt` / `reviewedBy` を `null` にリセット**する。v1 に対する review は v+1 には引き継がない (v+1 の内容を review したい場合は別途 `agentic-watch review` を v+1 に対して実行する、[`docs/design/skill-design.md` §8.6](../../docs/design/skill-design.md))
- 差分が無い場合 (再取得しても情報が変わらない場合) は新バージョンを作らずスキップする (§3)
- `prevResearch.frontmatter.id` を `supersedes` にそのまま書く (ファイル名ではなく id。`.md` 拡張子なし)
- 一次情報を最優先する。二次情報のまとめサイトを引用する場合は、その旨を明記する
- 過剰な憶測や評価は書かない (事実中心)
