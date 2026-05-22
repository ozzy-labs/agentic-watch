# FeedRadar workspace

このディレクトリは [`radar`](https://github.com/ozzy-labs/feedradar) でフィード監視 → AI エージェントによる調査レポート生成を回す **user workspace** です。本ドキュメントは workspace を init した人間向けの使い方ガイドで、`AGENTS.md` / `CLAUDE.md` (AI エージェント向け) とは別レイヤーです。

## 前提: エージェント駆動が第一級

FeedRadar は CLI ですが、**主要な使い方は AI エージェント (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) に自然言語または slash command で頼む** スタイルです。CLI 直叩きはスケジュール実行や CI からの自動化用途で残されており、対話的な triage では基本使いません。

理由:

- triage は判断が伴うため、AI エージェントが item を読んで research / dismiss を選別できる方が自然
- 各エージェントの interactive session には `AGENTS.md` / `CLAUDE.md` 経由でこの workspace の文脈が自動投入されるため、ユーザーは「最新の Anthropic news を調べて」のような自然言語で頼める
- 同じ slash command が 4 agent 横断で動くため、エージェント切替コストが低い

## 1 分でセットアップ

```bash
# (a) 監視対象を 1 つ追加 (例: Anthropic news の RSS)
radar source add anthropic-news --kind rss --url https://anthropic.com/news/rss.xml --keywords "Claude Code,agents"

# (b) 取得して新着 item を items/ に貯める
radar watch run

# (c) あとは AI エージェントに頼む (次セクション)
```

`source add` と `watch run` は scheduler 連携を想定して CLI のままです。`--with-actions` / `--with-routines` を付けて init すれば、GitHub Actions / Claude Routines で定期実行する雛形が出ます。後から workflow を追加 / cadence 切替 / watch + 自動 research の連鎖が必要になったら `radar workflow generate watch | combined` で後追い生成できます ([ADR-0014](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/0014-workflow-generate-and-auto-research-safety.md))。

## 主要操作: エージェントに頼む

workspace ディレクトリで好きなエージェント CLI を起動して、interactive session 内で以下のどちらかで指示します。

### A. 自然言語で頼む (推奨)

エージェントは `AGENTS.md` / `CLAUDE.md` 経由で workspace の文脈を読んでいるので、以下のような曖昧な指示でも slash command に解決してくれます。

```text
> 新着 item の中から Claude Code 関連を 1 件選んで research して
> 最新の research を別エージェントでレビューしたい
> v1 が古くなったので最新情報で update して
> この item は不要なので dismiss
```

エージェントが内部で `/research <item-id>` 等の slash command を呼び、結果をユーザーに報告します。`<item-id>` を覚える必要はありません。

### B. slash command を直接打つ

item-id / research-id が分かっているなら slash で直接呼べます。

| Slash | 役割 |
|---|---|
| `/research <item-id> [--agent <id>] [--template <id>]` | 調査レポートを生成 (status: `detected → researched`) |
| `/review <research-id> [--agent <id>]` | 既存レポートに別エージェントのレビューを追記 (status: `researched → reviewed`) |
| `/update <research-id> [--agent <id>]` | 最新情報で `_v<N+1>.md` を生成 (旧版は immutable) |
| `/dismiss <item-id>` | 不要 item を `dismissed` 終端状態へ (LLM 不要) |

`<agent>` は `claude-code` / `codex-cli` / `gemini-cli` / `copilot` のいずれか。省略時は `radar.config.yaml` の `defaultResearchAgent` / `defaultReviewAgent`、未設定なら `claude-code`。

### エージェントごとの slash 発火形式

どのエージェントを起動しても、同じ slash が同じ CLI 動作に解決されます (発火形式と読み取り経路のみ違う)。

| Agent | 起動 | session 内 | 読まれるファイル |
|---|---|---|---|
| Claude Code | `claude` | `/research <item-id>` | `.claude/skills/research/SKILL.md` |
| Copilot CLI | `copilot` | `/research <item-id>` | `.claude/skills/` および `.agents/skills/` (両方読む) |
| Gemini CLI | `gemini` | `/research <item-id>` | `.gemini/commands/research.toml` |
| Codex CLI | `codex` | `$research` mention または `/skills` パネル | `.agents/skills/research/SKILL.md` (dual-mode) |

### 推奨: クロスエージェント運用

research と review は **別のエージェント** に頼むのが推奨です。自然言語で頼むなら:

```text
> 直近の item を copilot で research して、生成された report を claude にレビューさせて
```

slash で直接呼ぶなら:

```bash
# (interactive session 内)
/research <item-id> --agent copilot
/review <research-id> --agent claude-code
```

同一エージェントの盲点 (特定情報源への偏り、用語の取りこぼし) を相互補正できます。

## 典型ワークフロー

```text
1. (scheduler または手動)  radar watch run
       → items/ に新着が detected で書かれる

2. (エージェント interactive)  「新着 item から興味あるやつ research して」
       → /research <item-id> が走り、research/<YYYYMMDD>_<slug>_v1.md が生成される
       → items/.../*.yaml が researched に遷移

3. (エージェント interactive、別エージェントで)  「さっきの report をクロスレビューして」
       → /review <research-id> --agent <別エージェント> が走る
       → research file に「## レビュー」追記、frontmatter スタンプ
       → items/.../*.yaml が reviewed に遷移

4. (任意、時間が経って情報が更新されたら)  「最新で update して」
       → /update <research-id> が走り、_v2.md が生成される (v1 は immutable)
```

不要な item は `/dismiss <item-id>` または「この item は不要」と自然言語で頼めば終端状態に遷移します。

## CLI ベース (スケジュール / CI 用)

エージェントを起動しない自動化文脈では CLI を直接呼びます。`radar <subcommand> --help` で全コマンドのヘルプが出ます。

```bash
radar source add <id> --kind <rss|html|html-js|github-releases|npm-registry|json-feed|json-api> --url <url> [options]
radar source add <id> --recipe <name> [--keywords ... --tags ... --name ...]  # バンドル recipe で 1 行追加 (ADR-0012)
radar source list
radar source recipes                                  # バンドル recipe を一覧表示
radar source test <id> [--limit N] [--show-content]
radar source remove <id>
radar watch run [--source <id>] [--bootstrap | --backfill [--max-pages N]] [-v|--verbose | -q|--quiet]
radar research <item-id> --agent <agent> [--verbose | --quiet]    # 進捗表示・stdout pass-through は --verbose で有効化 (ADR-0015)
radar research --digest <item-id> <item-id> ... [--agent <agent>]   # 複数 item を 1 digest にまとめる (ADR-0011)
radar review <research-id> --agent <agent> [--verbose | --quiet]
radar update <research-id> --agent <agent> [--verbose | --quiet]
radar dismiss <item-id>
radar research --batch [--max-items N] [--filter-tags <list>] [--agent <agent>] [--verbose | --quiet]  # detected を一括 research (ADR-0014)
radar workflow generate watch [--cron "<expr>"] [--agent <agent>] [--output <path>]            # GitHub Actions watch 雛形を後追い生成 (ADR-0014)
radar workflow generate combined [--watch-cron "<expr>"] [--max-items N] [--filter-tags <list>] [--agent <agent>] [--output <path>]   # watch + 自動 research を --max-items ハードキャップ付きで生成 (ADR-0014)
```

JSON API は recipe ベースで、`kind: json-api` を選んで `pagination` を YAML に書く（[ADR-0012](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/0012-json-api-adapter-and-recipe-strategy.md)）。JSON Feed 1.0 / 1.1 標準に準拠したサイトは URL だけで動く zero-config kind (`kind: json-feed`)。過去の全件取り込みは `radar watch run --backfill` を使う (kind: json-api / github-releases / npm-registry 対応)。

長時間実行コマンド (`research` / `review` / `update` / `watch run --backfill` / html-js fetch / `source test`) は stderr に phase markers + spinner + 副次メトリクス (`stdout` / `output` / `page x/N`) を表示します（[ADR-0015](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/0015-progress-reporting-ux.md)）。挙動切替は env > flag > TTY auto-detect の優先順:

- `--verbose`（または `-v`）: agent CLI / Playwright の stdout/stderr を pass-through。デバッグや「フリーズに見える」ときの第一手
- `--quiet`（または `-q`）: reporter を完全に黙らせ、CLI の従来 1 行ログだけ残す
- `RADAR_NO_PROGRESS=1`（env）: 上記より強い escape hatch。CI script で flag を消さずに reporter だけ off にしたいケース向け

詳細・トラブルシュート（`Agent running [mm:ss]` で動いていないように見える時の対処等）は [docs/user-guide.md → 進捗表示 / verbose / quiet](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md#進捗表示--verbose--quiet) を参照。

定期実行の雛形 (GitHub Actions / Claude Routines) は `radar init --with-actions` / `--with-routines` で初回 bootstrap として生成できます。後追いで cadence 切替 / 複数 workflow 共存 / `combined` (watch + 自動 research) を追加したい場合は `radar workflow generate <type>` ([ADR-0014](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/0014-workflow-generate-and-auto-research-safety.md)) を使います。`combined` は `--max-items` ハードキャップを YAML literal + CLI default の二重防御で焼き込むため、暴走 feed (publisher 側 bug / `--backfill` 事故) による LLM cost 爆発を設計レベルで遮断します。

## このディレクトリのレイアウト

```text
.
├── sources/              # 監視対象サイト定義 (YAML)
├── state/                # 既読 ID / etag (差分検出用)
├── items/                # 検出された記事 (YAML、status 管理)
├── research/             # 調査レポート (Markdown + frontmatter)
├── templates/            # Markdown テンプレート (編集可)
├── .agents/skills/       # 4 CLI 共通 engine SKILL (SSoT)
├── .claude/skills/       # Claude Code / Copilot CLI 用 slash-command 雛形
├── .gemini/commands/     # Gemini CLI 用 slash-command 定義 (TOML)
├── AGENTS.md             # AI エージェント向け workspace instructions
├── CLAUDE.md             # Claude Code 用 (@AGENTS.md を import)
└── FEEDRADAR.md      # 本ファイル (人間向けガイド)
```

## データ管理ポリシー

`sources/` `items/` `state/` `research/` `templates/` は git にコミットすることを推奨します。理由:

- 定期実行 scheduler (Claude Routines / GitHub Actions) は実行ごとに fresh clone するため、`state/*.yaml` の `lastSeenIds` が引き継がれないと毎回全件再検出してしまう
- `research/` を git で管理すると過去レポートの履歴・差分が追える ([ADR-0003](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/0003-output-format-and-versioning.md))
- `items/` の status 遷移 (`detected → researched → reviewed`) も git 履歴に残る

`init` は `sources/` `items/` `state/` `research/` に `.gitkeep` を配置するため、`git add .` でディレクトリ構造を保てます。

## セキュリティ警告

FeedRadar が fetch する外部 feed (RSS / HTML / HTML (JS rendered, `kind: html-js`) / GitHub Releases / npm registry / JSON Feed / JSON API) は **untrusted** として扱われます ([ADR-0009](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/0009-untrusted-external-content-handling.md))。攻撃者が feed 内容に prompt injection を仕込む可能性があるため:

- 信頼できる公式 source のみ登録するのが第一の防御線
- `sources/<id>.yaml` の `trustLevel: trusted` で個別 opt-in 可 (既定 `untrusted`)
- 生成された `research/*.md` は人間がレビューしてから運用判断に使う

## さらに詳しく

- 全コマンド仕様: [`docs/user-guide.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md)
- 設計判断 (ADR): [`docs/adr/`](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/README.md)
- アーキテクチャ: [`docs/architecture.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/architecture.md)
