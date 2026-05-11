# ADR-0004: Schedule Strategy

## Status

Accepted（2026-05-11）

## Context

agentic-watch は手動実行（`agentic-watch watch run`）が必須要件だが、**定期実行**も想定される。Claude Code 系では複数の選択肢があり、認証ポリシー・実行環境・実行間隔の制約が異なる。

詳細な比較表は ozzy-labs 内 knowledge MCP の [`ai/practice/scheduled-tasks`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/scheduled-tasks.md) を参照。

## Decision

`agentic-watch` 本体は **schedule 機構を内蔵せず**、外部 scheduler への接続点だけを `init` で生成する。

| 用途 | 推奨 | `init` で生成 |
|---|---|---|
| 手動実行 | `agentic-watch watch run` | （CLI 自体） |
| クラウド定期実行 | **GitHub Actions** + `ANTHROPIC_API_KEY` 等の API キー認証 | `.github/workflows/watch.yaml` |
| ローカル PC 定期 | Claude Routines（クラウド側）or Desktop scheduled tasks | `claude/routines/watch-daily.md`（`--with-routines` 指定時） |

### 認証ポリシー（重要）

CI 自動化では **`ANTHROPIC_API_KEY` 等の API キー**を使う。OAuth トークン（`CLAUDE_CODE_OAUTH_TOKEN`）は技術的に動くが、Anthropic の利用ポリシー上 "ordinary individual use" の範囲外。違反リスクと個人アカウント枠の浪費の両方を避ける。

### `init --with-routines` の挙動

Claude Routines 用 routine 定義 `claude/routines/watch-daily.md` を生成。Routines はクラウド VM で fresh clone するため、user data はリポにコミット済みである必要がある。生成テンプレートに「sources/ items/ state/ を commit すること」の注記を含める。

### 対象外

- `/loop`: セッションスコープ、7 日失効。長期 cron には不適
- Desktop scheduled tasks: アプリ起動中限定。雛形提供は将来検討

## Consequences

### 良い面

- スケジューラーの選択をユーザーに委ねられる（クラウド使うか、ローカルで完結させるか）
- agentic-watch コア実装が小さく保たれる
- `init` で雛形を吐くため、ユーザーは選んだ scheduler の boilerplate を毎回書く必要がない

### 悪い面 / 制約

- 雛形が古くなった場合の更新方法が暗黙（commons / handbook の改訂を反映するルートが要る）
- GitHub Actions と Routines で **使用する認証方式が異なる**ことをユーザーが理解する必要がある

### 中立

- 将来 self-hosted scheduler（OpenAI Workspace agents 等）対応の要望が出たら、`init` のテンプレ追加で対応可能

## Alternatives

### 案 A: agentic-watch 自体に内蔵 daemon（cron 風）

- 却下理由: ユーザーの PC が常時起動している前提を強制してしまう。既存 scheduler（GitHub Actions / Routines / cron）を活用するほうが筋

### 案 B: GitHub Actions のみサポート

- 却下理由: ローカル完結したいユーザー（API キーを Actions に置きたくない等）を排除してしまう

## 関連

- knowledge: [`ai/practice/scheduled-tasks`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/scheduled-tasks.md)
- Phase 5 で `init` の schedule 雛形生成を実装
