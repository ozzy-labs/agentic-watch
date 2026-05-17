# ADR-0005: User Data Separation

## Status

Accepted（2026-05-11）

## Context

FeedRadar は CLI engine（コード）とユーザーデータ（sources / items / state / research / templates）の両方を扱う。これらを **同一リポジトリ**に置くか、**分離する**かを決める必要がある。

OzzyLabs 内の先行例:

- `ozzy-labs/writing-studio`（Python / 個人プライベートリポ）: コードと記事・調査結果が同居。**配布パッケージへの転換が困難**な状態にある
- `ozzy-labs/mcp-server-knowledge`（TS / 公開 npm）: コードと knowledge データが同居しているが、`knowledge/_private` を `files` で除外している

## Decision

**engine（npm パッケージ）と user data を分離する**。

- `radar` リポジトリには **コードのみ**を置く（`src/` `tests/` `docs/` 等）
- `sources/` `items/` `state/` `research/` `templates/` `.commons/sync.yaml` 等の **user data は npm パッケージに含めない**
- ユーザーは `radar init` を**任意のディレクトリ**で実行し、そのディレクトリが user workspace になる
- ユーザーがその workspace を git 管理するかどうかは自由（個人 private repo / 共有 repo / 管理しない 全て可）

### `package.json` の `files`

公開対象を明示的に絞る:

```json
{
  "files": ["dist", "LICENSE", "README.md"]
}
```

`pnpm pack --dry-run` で user data 漏れがないことを CI で検証する（Phase 1 で追加予定）。

## Consequences

### 良い面

- engine の更新（`pnpm up -g @ozzylabs/feedradar`）が user data に影響しない
- 個人データを含む workspace を private に、engine を public に**それぞれ独立**して扱える
- writing-studio が抱える「コードと個人データの同居問題」を**構造的に回避**
- 業務利用（プロプライエタリな sources / research を扱うチーム）でも engine を共有可能

### 悪い面 / 制約

- 初学者には「2 つの場所がある」概念の理解コストがある（README で説明）
- engine 側のテストで実 user workspace を再現するための fixture が必要

### 中立

- npm publish 時の `files` 設定ミスで user data が漏れるリスクは pack dry-run の CI で抑止

## Alternatives

### 案 A: 同居（writing-studio スタイル）

- 却下理由: 配布が困難、個人 / 業務利用の境界が曖昧、npm publish 時の漏洩リスク

### 案 B: monorepo（`packages/engine` + `packages/sample-workspace`）

- 却下理由: 単一 CLI のため workspace 化のメリットが薄い。サンプル workspace は別途 `feedradar-examples` 等のリポで提供可能（将来）

## 関連

- writing-studio の構造的問題（observed in 本セッション設計議論、2026-05-10）
- handbook ADR: 該当なし（project-internal な判断）
- Phase 0 PR でこの方針に従って `package.json` `files` と `src/` レイアウトが構築済み
