# agentic-watch

> **Status: alpha** — Phase 1-5 まで実装済み（7 サブコマンド + 4 agent × 4 source kind + cron 雛形 + [ADR-0009](./docs/adr/0009-untrusted-external-content-handling.md) Adopt 策）。Phase 6（OIDC Trusted Publishers での `0.1.0` npm publish）待機中。

ブログ・公式アップデート・リリースフィードを監視し、キーワードヒットを 4 種の AI エージェント (Claude Code / Codex / Gemini / Copilot) に渡して **Markdown 調査レポートを書かせる CLI**。

## 解決する課題

複数の公式ブログ・ドキュメント・リリースノートを横断的に追い、変更点を要約する作業は AI エージェントとの相性が良いが、ソース管理・差分検出・テンプレート適用・複数エージェントへの委譲を毎回手作業で組むのは煩雑になる。`agentic-watch` はこのループを CLI として固定化し、ユーザーの調査ディレクトリに Markdown レポートを蓄積する。

## 主な特徴

- **多エージェント対応**: Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI を adapter 経由で切り替え。
- **複数フィード種別**: RSS / HTML スクレイプ / GitHub Releases / npm registry を同一の `Source` 抽象で扱う。
- **ユーザー側データ管理**: `sources/` `items/` `state/` `research/` `templates/` は **ユーザーの任意ディレクトリ** に置き、本パッケージは engine のみを提供する。
- **npm 単体配布**: OIDC Trusted Publishers で `@ozzylabs/agentic-watch` を公開予定（Phase 6）。

## インストール（予定）

```bash
# 初版公開後に有効化される
npm i -g @ozzylabs/agentic-watch
```

開発中は本リポを clone し、`pnpm install && pnpm run build` で `dist/index.js` を生成して `node dist/index.js <command>` で起動する。

## 使い方

```bash
agentic-watch init                    # ワークスペース初期化
agentic-watch source add <id> ...     # フィードソースを追加
agentic-watch source list             # ソース一覧
agentic-watch watch run               # 取得 + フィルタ
agentic-watch research <item-id>      # AI エージェントに調査レポート作成を委譲
agentic-watch dismiss <item-id>       # 不要 item を dismissed に遷移（LLM 不要）
agentic-watch review <research-id>    # レポートを別エージェントで相互レビュー
agentic-watch update <research-id>    # 既存レポートを最新 item で更新（v+1）
agentic-watch --help                  # ヘルプ
```

全 7 サブコマンドが実装済み。詳細は [docs/user-guide.md](./docs/user-guide.md) を参照。

## 開発

```bash
pnpm install            # 依存関係インストール
pnpm run build          # tsc でビルド（dist/）
pnpm run typecheck      # 型チェック
pnpm run test           # vitest run
node dist/index.js --help
```

## アーキテクチャ概要

```text
src/
  index.ts              CLI entry point (#!/usr/bin/env node)
  cli/                  init / source / watch / research / dismiss / review / update
  core/
    watcher.ts          source → adapter → items
    filter.ts           keyword / excludeKeyword
    items.ts            items の load / save
    templates.ts        research テンプレートの読み込み
    state.ts            state/<sourceId>.yaml の load / save
    config.ts           radar.config.yaml の load / 検証
    injection-detector.ts  prompt injection regex pre-filter (ADR-0009 M1a)
    feeds/              rss / html / github-releases / npm-registry
  agents/               4 CLI adapters（claude-code / codex-cli / gemini-cli / copilot）
  schemas/              Zod スキーマ（Source / Item / State / Research）
  skills/               engine SKILL bundle (research / review / update; init で .agents/skills/ に配布)
  claude-skills/        Claude Code 用 slash-command 雛形 (init で .claude/skills/ に配布)
  gemini-commands/      Gemini CLI 用 TOML slash-command 雛形 (init で .gemini/commands/ に配布)
  templates/            workspace 既定テンプレート (init で templates/ に配布)
```

## ドキュメント

- [docs/architecture.md](./docs/architecture.md) — システム全体図 / モジュール責務 / データフロー / Phase 別スコープ
- [docs/user-guide.md](./docs/user-guide.md) — インストール / クイックスタート / コマンド仕様
- [docs/adr/](./docs/adr/README.md) — agentic-watch 内部の設計判断記録（Agent / Source / Output / Schedule / User Data / Filter / Skill Bundling / Status State Machine / Untrusted External Content Handling）

## 規約

- **言語**: TypeScript ESM / Node.js 22+ / pnpm
- **コミット**: Conventional Commits（`commitlint` で強制）
- **ブランチ**: GitHub Flow（`main` + feature branch、squash merge のみ）
- **配布**: npm `@ozzylabs/agentic-watch`、OIDC Trusted Publishers（`NPM_TOKEN` は使わない）
- **共通設定**: [`ozzy-labs/commons`](https://github.com/ozzy-labs/commons) から `sync.sh` で配布。
- **共通スキル**: [`ozzy-labs/skills`](https://github.com/ozzy-labs/skills) を `@ozzylabs/skills` Renovate preset で取り込み。

## License

MIT — see [LICENSE](./LICENSE).
