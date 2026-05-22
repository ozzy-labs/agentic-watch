[English](README.md) | 日本語

# FeedRadar

ブログ・公式アップデート・リリースフィードを監視し、キーワードヒットを 4 種の AI エージェント (Claude Code / Codex / Gemini / Copilot) に渡して **Markdown 調査レポートを書かせる CLI**。

## 解決する課題

複数の公式ブログ・ドキュメント・リリースノートを横断的に追い、変更点を要約する作業は AI エージェントとの相性が良いが、ソース管理・差分検出・テンプレート適用・複数エージェントへの委譲を毎回手作業で組むのは煩雑になる。`radar` はこのループを CLI として固定化し、ユーザーの調査ディレクトリに Markdown レポートを蓄積する。

## 主な特徴

- **多エージェント対応**: Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI を adapter 経由で切り替え。
- **複数フィード種別**: RSS / HTML / **HTML (JS rendered)** / GitHub Releases / npm registry / **JSON Feed (1.0 / 1.1)** / **JSON API (recipe ベース、過去全件取り込みの `--backfill` 対応)** を同一の `Source` 抽象で扱う ([ADR-0012](./docs/adr/0012-json-api-adapter-and-recipe-strategy.md))。
- **バンドル recipe**: `radar source recipes` で同梱済み YAML recipe (例: AWS What's New / dev.to) を一覧、`radar source add <id> --recipe <name>` で 1 行で source 化 ([ADR-0012 §D3](./docs/adr/0012-json-api-adapter-and-recipe-strategy.md))。
- **Digest モード**: 短期間に複数ヒットした item や、複数 feed に跨る同テーマの item を 1 本の横断レポートにまとめる ([ADR-0011](./docs/adr/0011-digest-research-output.md))。
- **ユーザー側データ管理**: `sources/` `items/` `state/` `research/` `templates/` は **ユーザーの任意ディレクトリ** に置き、本パッケージは engine のみを提供する。
- **npm 単体配布**: OIDC Trusted Publishers で `@ozzylabs/feedradar` を npm 配布。

## インストール

```bash
npm i -g @ozzylabs/feedradar
```

`kind: html-js` adapter（JS 実行後に DOM が組み立てられる SPA / CSR ページ向け）を使う場合は Playwright を別途 install する。Playwright は **optional peer dep** として宣言されているため、RSS / static HTML のみ使うユーザーには ~300MB の Chromium footprint を強いない（[ADR-0010](./docs/adr/0010-html-js-adapter-and-distribution.md)）:

```bash
npm i -g playwright
npx playwright install chromium
```

`html-js` source を追加する前に `radar doctor` で Playwright / Chromium が検出できるか確認できる。CI で使う場合の具体例は [docs/user-guide.md → `--kind html-js` → CI で使う](./docs/user-guide.md#ci-で使う) を参照。

開発中は本リポを clone し、`pnpm install && pnpm run build` で `dist/index.js` を生成して `node dist/index.js <command>` で起動する。

## 企業プロキシ環境

社内 HTTP / HTTPS プロキシ越しでも、標準の env var を export して `radar` を
起動するだけで自動検出されて動く（CLI フラグ / 設定ファイルの編集は不要）。
TLS 中継プロキシ (Zscaler / Netskope 等) では証明書検証を切るのではなく
`NODE_EXTRA_CA_CERTS` を設定する:

```bash
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem   # TLS 中継時のみ
radar doctor                                      # 動作確認
```

NTLM / Kerberos プロキシは直接対応しない（`cntlm` / `Px` / `Authoxy` で
ローカル変換）。WSL2 から Windows ホストのプロキシを参照する場合、
`npm install` 自体のプロキシ設定、`radar doctor` の live healthcheck の
詳細は [docs/user-guide/proxy-setup.ja.md](./docs/user-guide/proxy-setup.ja.md) を参照。

## 使い方

```bash
# クイックスタート (anthropics/anthropic-sdk-python の GitHub Releases を監視)
radar init
radar source add anthropic-sdk \
  --kind github-releases \
  --url https://github.com/anthropics/anthropic-sdk-python \
  --keywords "feat,fix,release"
radar watch run
radar research <item-id>

# その他のサブコマンド
radar source list             # ソース一覧
radar source test <id>        # ソースをドライラン実行（state/items を書き換えない）
radar research --digest <id1> <id2> ...  # 複数 item を 1 つの digest レポートに束ねる（ADR-0011）
radar dismiss <item-id>       # 不要 item を dismissed に遷移（LLM 不要）
radar review <research-id>    # レポートを別エージェントで相互レビュー
radar update <research-id>    # 既存レポートを最新 item で更新（v+1）
radar doctor                  # workspace / agent CLI / Playwright の health check
radar --help                  # ヘルプ
```

全 8 サブコマンドが実装済み。詳細は [docs/user-guide.md](./docs/user-guide.md) を参照。

## 開発

```bash
pnpm install            # 依存関係インストール
pnpm run build          # tsc でビルド（dist/）
pnpm run typecheck      # 型チェック
pnpm run test           # vitest run

# ローカルで CLI を呼ぶ場合 (build 後)
pnpm radar --help        # = node dist/index.js --help (package.json scripts の alias)
node dist/index.js --help        # 等価
```

> ローカルの `pnpm radar <cmd>` は `package.json` の `scripts.radar`（`node dist/index.js`）を呼ぶ alias で、事前に `pnpm run build` で `dist/index.js` を生成しておく必要がある。配布版 (`npm i -g @ozzylabs/feedradar`) でユーザーが直接叩く `radar <cmd>` は `package.json` の `bin.radar` 経由で、こちらは publish 済み `dist/` を参照するため build 不要。両者は同名だがレイヤーが違う。なお `pnpm --prefix <path> radar <cmd>` は CWD を `<path>` に切り替えてから scripts を実行する仕様なので、別ディレクトリ（例えば smoke test 用の空ワークスペース）で scripts alias を呼びたい場合は `pnpm --prefix` ではなく `node <repo-root>/dist/index.js <cmd>` を直接呼ぶこと（前者はリポ root に対して `init` 等が走る事故になる）。

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
    feeds/              rss / html / html-js / github-releases / npm-registry / json-feed / json-api
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
- [docs/user-guide/proxy-setup.ja.md](./docs/user-guide/proxy-setup.ja.md) — 企業プロキシ / TLS 中継 / NTLM ブリッジ / WSL2 環境のセットアップ
- [docs/release.md](./docs/release.md) — リリース手順（初回手動 publish + Trusted Publisher 登録 + 以降の OIDC 自動化）
- [docs/adr/](./docs/adr/README.md) — FeedRadar 内部の設計判断記録（Agent / Source / Output / Schedule / User Data / Filter / Skill Bundling / Status State Machine / Untrusted External Content Handling）

## 規約

- **言語**: TypeScript ESM / Node.js 22+ / pnpm
- **コミット**: Conventional Commits（`commitlint` で強制）
- **ブランチ**: GitHub Flow（`main` + feature branch、squash merge のみ）
- **配布**: npm `@ozzylabs/feedradar`、OIDC Trusted Publishers（`NPM_TOKEN` は使わない）
- **共通設定**: [`ozzy-labs/commons`](https://github.com/ozzy-labs/commons) から `sync.sh` で配布。
- **共通スキル**: [`ozzy-labs/skills`](https://github.com/ozzy-labs/skills) を `@ozzylabs/skills` Renovate preset で取り込み。

## License

MIT — see [LICENSE](./LICENSE).
