---
name: review
description: 既存 research レポート（research/<id>.md）を別エージェントの視点でレビューし、本文末尾にレビューコメントを追記、frontmatter と items の status を reviewed に更新する。
allowed-tools: Read,Grep,Bash,WebFetch
---

# review - research レポートをクロスチェックする (stub)

> **Status (Phase 1):** stub プロンプト。本文の最終仕様は [#9](https://github.com/ozzy-labs/agentic-watch/issues/9) § 2 (`docs/design/skill-design.md`) と並走で Phase 2 までに確定する。

このスキルは `agentic-watch review <research-id> --agent <agent-id>` から起動される。research を書いた agent と**別の agent** に依頼することを推奨する（クロスエージェント運用、user-guide.md 参照）。

## 入力

- `<research-id>`: `research/<id>.md` の id（`<YYYYMMDD>_<slug>_v<N>`）
- `<agent-id>`: `claude-code` / `codex-cli` / `gemini-cli` / `copilot`

## 手順（暫定）

### 1. レポートの読み込み

1. `research/<id>.md` を Read し、frontmatter と本文を取り出す
2. `items/<itemId>.yaml` を Read し、`status` が `researched` であることを確認する
3. 必要に応じて原文 (`url`) や関連 docs を WebFetch で参照する

### 2. レビュー

以下の観点で簡潔にレビューする（**Phase 2 で正典化予定**）:

- 事実関係に誤りがないか（一次情報との突合）
- 抜けている重要なポイントがないか
- 過剰な憶測 / 主観が混じっていないか
- 出典が十分か

### 3. アトミック更新

以下の 2 ファイルを**同一コマンド内でアトミックに**更新する。部分失敗時はロールバックする（[ADR-0003](../../docs/adr/0003-output-format-and-versioning.md) / [ADR-0008](../../docs/adr/0008-status-state-machine.md)）。

1. `research/<id>.md`:
   - frontmatter に `reviewedAt: <ISO 8601>` / `reviewedBy: <agent-id>` を追加
   - 本文末尾に `## レビュー (<agent-id>, <ISO 8601>)` セクションを追記
2. `items/<itemId>.yaml`:
   - `status: researched -> reviewed`

## 注意事項

- research を書いた agent と同じ agent での review は推奨されない（盲点が補正されない）
- 本文書き換え（research 内容の修正）はしない。指摘は末尾セクションに集約する
- Phase 2 で観点表 (perspectives) を正典化する予定。それまでは上記の暫定観点で運用する
