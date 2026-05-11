---
name: update
description: 既存 research レポートを最新情報で再生成し、_v(N+1).md として新バージョンを作成する。旧バージョンは保持 (immutable history)。
allowed-tools: Read,Grep,Bash,WebFetch
---

# update - research レポートを更新して新バージョンを生成 (stub)

> **Status (Phase 1):** stub プロンプト。本文の最終仕様は [#9](https://github.com/ozzy-labs/agentic-watch/issues/9) § 2 (`docs/design/skill-design.md`) と並走で Phase 4 までに確定する。

このスキルは `agentic-watch update <research-id> --agent <agent-id>` から起動される。既存 research を最新情報で再生成し、新バージョン (`_v(N+1).md`) を作成する。旧バージョンは消さない (immutable history、[ADR-0003](../../docs/adr/0003-output-format-and-versioning.md))。

## 入力

- `<research-id>`: `research/<id>.md` の id（`<YYYYMMDD>_<slug>_v<N>`）
- `<agent-id>`: `claude-code` / `codex-cli` / `gemini-cli` / `copilot`

## 手順（暫定）

### 1. 既存レポートの読み込み

1. `research/<id>.md` を Read し、frontmatter と本文を取り出す
2. `items/<itemId>.yaml` から原文 URL / `keywordsMatched` を取得する
3. 既存のバージョン番号 `<N>` を特定する

### 2. 最新情報の取得

- 原文 URL を再取得し、公開後の改訂・追記がないか確認する
- 関連リリースノート / docs の更新を WebFetch で確認する
- 同一トピックに関する後続ブログ・公式アナウンスがあれば取り込む

### 3. 新バージョンの生成

`research/<YYYYMMDD>_<slug>_v(N+1).md` を生成する:

- `version: <N+1>` に更新
- `researchedAt` / `researchedBy` を新規実行時点に更新
- frontmatter に `supersedes: <previous filename>` を追加
- 本文冒頭に「## v<N+1> での変更点」セクションを追加し、前バージョンとの差分を要約

旧バージョン (`_v<N>.md`) は**書き換えない**。

### 4. items の更新

`items/<itemId>.yaml` の `researchPath` を新バージョンのパスに差し替え、`status` は適切に再設定する（`researched`、または既に review 済みなら `reviewed` を維持しつつ frontmatter の `version` 更新に追従する詳細は Phase 4 で確定）。

## 注意事項

- 旧バージョンは immutable。書き換え / 削除しない
- 差分が無い場合（再取得しても情報が変わらない場合）は新バージョンを作らずスキップする
- Phase 4 で本仕様を正典化する予定
