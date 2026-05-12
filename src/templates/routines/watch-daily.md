---
name: watch-daily
schedule: "0 0 * * *"
description: Run agentic-watch daily to detect new items across configured sources.
---

# watch-daily

Claude Routines が cron スケジュール (`schedule` frontmatter) で実行する routine 定義。
詳細は [ADR-0004 Schedule Strategy](https://github.com/ozzy-labs/agentic-watch/blob/main/docs/adr/0004-schedule-strategy.md) を参照。

## 前提

Routines はクラウド側 (Anthropic 管理 VM) で **fresh clone** されるため、`sources/` / `items/` / `state/` を含む workspace が **git にコミット済み**である必要がある:

```bash
git add sources/ items/ state/ templates/
git commit -m "chore: add agentic-watch workspace"
git push
```

API キー (`ANTHROPIC_API_KEY` 等) は Routine 側の secret として登録する。OAuth トークン (`CLAUDE_CODE_OAUTH_TOKEN`) は **使わない** — Anthropic の利用ポリシー上、ordinary individual use の範囲外 (ADR-0004)。

## 手順

1. `agentic-watch watch run` を実行して新着 item を検出する
2. 変更があれば `items/` / `state/` を git commit して push する (次回 fresh clone で前回の `lastSeenIds` を引き継ぐため)
3. 検出件数 / エラー有無を簡潔に報告する

```bash
agentic-watch watch run
if ! git diff --quiet items/ state/; then
  git add items/ state/
  git commit -m "chore(watch): detected items $(date -u +%Y-%m-%d)"
  git push
fi
```

## スコープ外

- `research` / `review` / `update` の自動実行 — これらは人が triage する設計 (ADR-0004)
- LLM API キーの取り回し — Routine 側の secret 管理に従う
