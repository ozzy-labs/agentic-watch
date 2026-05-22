# User Guide

> 本ドキュメントは現行 CLI 仕様を記述する。実装と乖離している箇所は issue で報告してほしい。

## インストール

```bash
pnpm add -g @ozzylabs/feedradar
# または
npx @ozzylabs/feedradar <command>
```

要件:

- Node.js 22+
- pnpm（globally install する場合）
- 監視対象に応じてネットワーク到達性

エージェント CLI は **ユーザー側で別途インストール・認証**しておく必要がある。`radar` 自体はこれらの CLI を子プロセスとして起動する。

### 対応 agent CLI 一覧

| `--agent` 値 | 実装状況 | 必要な CLI | 認証方法 | 起動コマンド（非対話） |
|---|---|---|---|---|
| `claude-code` | 実装済み | [Claude Code](https://docs.claude.com/en/docs/claude-code) | `claude` 内で対話ログイン | `claude -p "<prompt>" --output-format text --permission-mode bypassPermissions` |
| `codex-cli` | 実装済み | [Codex CLI](https://github.com/openai/codex) | `codex login` | `codex exec "<prompt>" --cd <workspace> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` |
| `gemini-cli` | 実装済み | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini` 内で対話ログイン（OAuth）または `GEMINI_API_KEY` 環境変数 | `gemini -p "<prompt>" -y --skip-trust --output-format text` |
| `copilot` | 実装済み | [GitHub Copilot CLI](https://docs.github.com/copilot/github-copilot-in-the-cli) | `copilot auth login` | `copilot -p "<prompt>" --allow-all-paths --allow-all-tools --no-color` |

4 agent 全てが利用可能 (`claude-code` / `codex-cli` / `gemini-cli` / `copilot`)。

## クイックスタート

```bash
mkdir my-watch && cd my-watch
radar init
radar source add anthropic-sdk \
  --kind github-releases \
  --url https://github.com/anthropics/anthropic-sdk-python \
  --keywords "feat,fix,release"
radar watch run
radar research <item-id> --agent claude-code
```

> `--keywords` を省略すると filter で 0 件になり、`watch run` が item を作らない仕様（`filter.ts` は keywords 空 = match nothing）。クイックスタートでは必ず `--keywords` を渡す。

## コマンド

### `radar init`

カレントディレクトリをワークスペースとして初期化する。

生成するもの:

```text
.
├── sources/             # サイト定義 (YAML)
├── state/               # 既読 ID / etag
├── items/               # 検出記事 (YAML)
├── research/            # 調査結果 (Markdown)
├── templates/           # 既定テンプレートのコピー (`default.md` 単体 / `digest.md` 複数 item digest、`--no-templates` で skip)
├── CLAUDE.md            # Claude Code 用 workspace instructions (`@AGENTS.md` を import、`--no-claude-md` で skip)
├── AGENTS.md            # Codex / Gemini / Copilot が auto-read する instructions (`--no-agents-md` で skip)
├── FEEDRADAR.md     # 人間向け workspace ガイド (自然言語 / slash による使い方、`--no-feedradar-md` で skip)
├── .agents/skills/      # engine SKILL (SSoT): research / review / update
├── .claude/skills/      # Claude Code / Copilot CLI 用 slash-command 雛形 (薄い wrapper、`--no-claude-skills` で skip)
├── .gemini/commands/    # Gemini CLI 用 TOML slash-command 雛形 (`--no-gemini-commands` で skip)
├── .github/workflows/   # 定期実行ワークフロー (`--with-actions` 指定時のみ)
└── claude/routines/     # Claude Routines (`--with-routines` 指定時のみ)
```

`--with-routines` / `--with-actions` を指定すると、定期実行 scheduler への接続用雛形が追加で生成される（詳細は本ドキュメントの「[スケジュール実行](#スケジュール実行)」セクション）。

#### 挙動

- `sources/` `state/` `items/` `research/` `templates/` を作成（既存ディレクトリは温存）
- `sources/` `items/` `state/` `research/` に **`.gitkeep`** を配置（空ディレクトリでも `git add .` で追跡される。`state/*.yaml` の `lastSeenIds` を fresh clone 環境で引き継ぐためにはこれらのディレクトリの git コミットが前提）。既存ファイルは温存され `--force` でも上書きしない
- **engine SKILL** (`.agents/skills/{research,review,update}/SKILL.md`) を **bundled** からコピー。adapter (`claude` / `codex` / `gemini` / `copilot`) が spawn 時に読む procedure 本体
- **Claude Code slash-command 雛形** (`.claude/skills/{research,review,update,dismiss}/SKILL.md`) を bundled からコピー。Claude Code interactive で `/research` 等として発火する薄い wrapper (内部で `radar <subcommand>` を呼ぶだけ)。`--no-claude-skills` で skip 可
- **Gemini CLI slash-command 雛形** (`.gemini/commands/{research,review,update,dismiss}.toml`) を bundled からコピー。Gemini CLI interactive で `/research` 等として発火する TOML 形式の薄い wrapper (`.claude/skills/` と並列の discovery 層)。`--no-gemini-commands` で skip 可
- **`AGENTS.md`** (workspace root) を bundled からコピー。Codex CLI / Gemini CLI / GitHub Copilot CLI が auto-read する agent-agnostic な instructions (workspace 概要、主要コマンド、典型ワークフロー、docs pointer)。`--no-agents-md` で skip 可
- **`CLAUDE.md`** (workspace root) を bundled からコピー。Claude Code は `AGENTS.md` を auto-read しないため、最小の `CLAUDE.md` (`@AGENTS.md` を import するだけ) を default で出力し、業界標準の "SSoT は AGENTS.md、CLAUDE.md は再エクスポート" パターンを成立させる。`--no-claude-md` で skip 可 (`--no-agents-md` 指定時は `@AGENTS.md` がリンク切れになるため自動 skip + 警告)
- **`templates/default.md`** と **`templates/digest.md`** を bundled からコピー。`default.md` は単体 research の fallback 構造 (要約 / 詳細 / 出典) を、`digest.md` は digest research の構造 (各 item の要点 / 共通テーマ / 差分・対立点 / 推奨アクション / 出典、[ADR-0011](./adr/0011-digest-research-output.md)) を持つ Markdown 雛形 (body のみ、frontmatter は engine SKILL 側で生成)。ユーザーが「テンプレを編集して使う」第一歩となる編集可能なファイル。`--no-templates` で skip 可
- **`FEEDRADAR.md`** (workspace root) を bundled からコピー。**人間向け** の workspace ガイドで、AI エージェントへの自然言語指示や slash command による使い方を主、CLI 直叩きを副として説明する。`AGENTS.md` / `CLAUDE.md` (AI エージェント向け instructions) とは別レイヤー。`--no-feedradar-md` で skip 可
- 既存ファイルは warning + skip で保護。`--force` で上書き

#### AGENTS.md について

`init` は workspace の root に **`AGENTS.md`** (agent-agnostic instructions) を default で生成する。Codex CLI / Gemini CLI / GitHub Copilot CLI はこのファイルを auto-read するため、interactive session を開いた agent に workspace の文脈 (主要コマンド、典型ワークフロー、docs pointer) を即座に伝えられる ([ADR-0007 Revision 2026-05-17 b](./adr/0007-skill-bundling-and-init-distribution.md))。

| Agent | AGENTS.md auto-read |
|---|---|
| Claude Code | ❌ (`CLAUDE.md` 経由 — `CLAUDE.md` から `@AGENTS.md` で取り込むパターンが業界標準) |
| Codex CLI | ✅ (project root → CWD、`project_doc_max_bytes` 32 KiB 制限) |
| Gemini CLI | ✅ (project root、`.gemini/settings.json` の `context.fileName` でも追加可) |
| GitHub Copilot CLI | ✅ (repo root / CWD / `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) |

`--no-agents-md` を使うべきケース:

- workspace に既に独自の `AGENTS.md` (monorepo 全体の指示等) があり、FeedRadar の boilerplate と衝突させたくない
- `AGENTS.md` を別ツール (`@ozzylabs/skills` 等) で集中管理している

```bash
radar init --no-agents-md   # AGENTS.md 生成を skip
```

Claude Code と併用する場合、`CLAUDE.md` 側で AGENTS.md を取り込んで SSoT を維持するパターンが推奨:

```markdown
# CLAUDE.md

共通方針は @AGENTS.md を参照。以下は Claude Code 固有の設定。

## Claude Code 固有
...
```

#### AI agent interactive での利用 (slash commands)

`init` で配置される slash commands は **4 agent 横断** で利用できる。発火形式と読み取り経路は agent ごとに違うが、最終的にはどれも `radar <subcommand>` を呼んで engine SKILL (`.agents/skills/<name>/SKILL.md`、SSoT) の procedure に流れる:

| Agent | 発火形式 | 経路 |
|---|---|---|
| Claude Code | `/research <item-id>` | `.claude/skills/research/SKILL.md` (薄い wrapper) |
| Copilot CLI | `/research <item-id>` 等 | `.claude/skills/` を auto-read |
| Codex CLI | `$research` mention or `/skills` panel | `.agents/skills/research/SKILL.md` (engine SKILL の dual-mode、interactive 発火時は CLI に shell out) |
| Gemini CLI | `/research <item-id>` | `.gemini/commands/research.toml` (薄い wrapper、TOML 形式) |

利用できる slash commands (全 agent 共通):

| Slash | 動作 | 中身 |
|---|---|---|
| `/research <item-id> [--agent ...]` | research を実行 | `radar research $ARGUMENTS` を呼ぶ |
| `/review <research-id> [--agent ...]` | review を実行 | `radar review $ARGUMENTS` を呼ぶ |
| `/update <research-id> [--agent ...]` | v+1 を生成 | `radar update $ARGUMENTS` を呼ぶ |
| `/dismiss <item-id>` | item を dismiss | `radar dismiss $ARGUMENTS` を呼ぶ (LLM 不要) |

各 slash command は **薄い wrapper** で、procedure 本体は engine SKILL (`.agents/skills/<name>/SKILL.md`) を SSoT として参照する。Codex CLI は専用の slash wrapper を持たず、engine SKILL の冒頭 "Invocation modes" セクションが adapter spawn と interactive 起動の両方を捌く (interactive 起動時は `radar <subcommand>` に shell out)。

#### `--no-claude-skills` を使うべきケース

`@ozzylabs/skills` Renovate preset 等で `.claude/skills/` を集中管理している workspace では、`radar init --no-claude-skills` で discovery 層 (`.claude/skills/`) を skip すると preset 側との衝突 / 上書き競合を避けられる。engine SKILL (`.agents/skills/`) は SSoT として常に書かれる。

#### `--no-gemini-commands` を使うべきケース

`.gemini/commands/` を別の方法で管理している (またはそもそも Gemini CLI を使わない) workspace では、`radar init --no-gemini-commands` で `.gemini/commands/` 配置のみ skip できる。Gemini CLI interactive session も engine SKILL (`.agents/skills/`) の dual-mode 動作で正しく機能するため、`/research` slash の代わりに `$research` mention 経由になる。

#### `--no-claude-md` を使うべきケース

workspace に既に独自の `CLAUDE.md` (project 全体の Claude Code 指示等) があり、FeedRadar の boilerplate (`@AGENTS.md` のみを含む最小ファイル) と衝突させたくない場合は `radar init --no-claude-md` で `CLAUDE.md` 配置のみ skip できる。`AGENTS.md` 側は引き続き生成されるため、CLAUDE.md 内で `@AGENTS.md` 等の取り込みを自前で行うか、別の運用を選べる。

なお `--no-agents-md` を指定した場合、bundled CLAUDE.md の `@AGENTS.md` import がリンク切れになるため、`CLAUDE.md` も自動的に skip される (warning が出る)。

#### `--no-templates` を使うべきケース

`templates/` を別の方法で管理している、または独自の `templates/default.md` / `templates/digest.md` を既に持っている workspace では、`radar init --no-templates` で starter テンプレ生成のみを skip できる。`templates/` ディレクトリ自体は作成される。`research` engine SKILL は `templateBody` が空のとき内蔵 fallback 構造 (単体 = 要約 / 詳細 / 出典、digest = 各 item の要点 / 共通テーマ / 出典) を使う設計のため、skip しても動作上の問題は無い (編集可能な雛形ファイルが置かれないだけ)。

#### `--no-feedradar-md` を使うべきケース

workspace に既に独自の人間向けドキュメント (`README.md` 等) があり、FeedRadar の boilerplate を追加で置きたくない場合は `radar init --no-feedradar-md` で `FEEDRADAR.md` 生成のみを skip できる。`AGENTS.md` / `CLAUDE.md` (AI エージェント向け instructions) は引き続き生成されるため、エージェント側の挙動には影響しない (skip するのは人間向けガイドのみ)。

### `radar source add <id> --kind <kind> --url <url> [options]`

新規 source を `sources/<id>.yaml` に追加。

| 引数 | 説明 |
|---|---|
| `<id>` | source 識別子（slug） |
| `--kind` | `rss` / `html` / `html-js` / `github-releases` / `npm-registry` / `json-feed` / `json-api` |
| `--url` | fetch 対象の URL |
| `--name` | 表示名（省略時は `<id>`） |
| `--tags` | カンマ区切りタグ |
| `--keywords` | カンマ区切り、ヒット対象キーワード |
| `--exclude-keywords` | カンマ区切り、除外キーワード |

なお `sources/<id>.yaml` は **`trustLevel: "trusted" | "untrusted"`** フィールドも持つ（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M4）。default は `"untrusted"` で、`source add` で生成される YAML には `trustLevel: untrusted` が書き出される。`"trusted"` への opt-in は YAML を手で編集する（CLI flag は提供しない。後述「[trustLevel: 信頼境界の opt-in](#trustlevel-信頼境界の-opt-in)」を参照）。

#### 対応 kind 一覧

| `--kind` | 用途 | recipe / selector | conditional GET | `--backfill` 対応 | ADR |
|---|---|---|---|---|---|
| `rss` | 標準 RSS / Atom feed | 不要（URL のみ） | ETag + Last-Modified | ― | ADR-0002 |
| `html` | 任意 HTML ページの CSS スクレイピング | `selectors.*` 必須 | ETag + content-hash fallback | ― | ADR-0002 / `design/source-html.md` |
| `html-js` | JS 実行後 DOM が必要な SPA / CSR ページ | `selectors.*` 必須 + `js.*` 任意 | content-hash のみ | ― | [ADR-0010](./adr/0010-html-js-adapter-and-distribution.md) |
| `github-releases` | GitHub Releases API | 不要（`<owner>/<repo>` を URL から抽出） | ETag | partial | ADR-0002 |
| `npm-registry` | npm registry packument | 不要（パッケージ名のみ） | ETag | partial | ADR-0002 |
| `json-feed` | JSON Feed 1.0 / 1.1 標準 | 不要（URL のみ） | ETag + Last-Modified | partial（`next_url` を辿る範囲） | [ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) |
| `json-api` | 任意 JSON API（recipe ベース） | `pagination.*` 必須、`jsonSelectors.*` 任意（default chain あり） | ETag + content-hash fallback | **full**（recipe の `pagination.maxPages` まで辿る） | [ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) |

L0 / L1 tier の整理（recipe 不要かどうか）:

- **L0 tier (URL のみで動く)**: `rss` / `json-feed` / `github-releases` / `npm-registry`。標準フォーマットまたは fixed endpoint。
- **L1 tier (recipe / selector が必要)**: `html` / `html-js` / `json-api`。サイトごとに調整が要る。

`json-api` の recipe は基本的に **page-based** API なら `jsonSelectors` を完全に省略でき（default chain が `$.items[*]` 等を試す）、`pagination` のみ書けば動くことが多い。詳細は「[`--kind json-api`](#--kind-json-api)」を参照。

#### `--kind github-releases`

GitHub の Releases API (`GET /repos/<owner>/<repo>/releases`) からリリースを取得する。

```bash
# 例: anthropic-sdk-python の releases を監視する
radar source add anthropic-sdk \
  --kind github-releases \
  --url https://github.com/anthropics/anthropic-sdk-python
```

`--url` は以下のいずれの形式でも受け付ける（`<owner>/<repo>` を抽出する）:

- `https://github.com/<owner>/<repo>`
- `https://github.com/<owner>/<repo>.git`
- `https://github.com/<owner>/<repo>/tree/<branch>` 等の末尾パスは無視される
- `<owner>/<repo>` ショートハンド

正規化マッピング:

| Item フィールド | GitHub Release フィールド |
|---|---|
| `title` | `name`（空なら `tag_name` にフォールバック） |
| `url` | `html_url` |
| `summary` | `body` |
| `publishedAt` | `published_at`（なければ `created_at`） |
| `id` | `<title-slug>-<8 hex of sha256(<tag_name>#<release.id>)>`（[ADR-0002](./adr/0002-source-adapter-plugin-pattern.md)） |
| `raw` | API レスポンス全体 |

`tag_name` と GitHub 側 `release.id` を組み合わせて stable id を作るため、再タグ付け（`tag_name` 変化・`release.id` 不変）と削除→再作成（`tag_name` 不変・`release.id` 変化）のどちらでも別 item として検出される。

##### `GITHUB_TOKEN` で rate limit を上げる

GitHub Releases API は環境変数 `GITHUB_TOKEN` で認証する:

| 認証状態 | rate limit |
|---|---|
| 認証なし | 60 req/h（IP 単位） |
| 認証あり (`GITHUB_TOKEN`) | 5000 req/h |

設定例 (bash / zsh):

```bash
# Personal Access Token (classic) または Fine-grained PAT を発行し、
# `repo` 権限（public のみなら不要）を付与する
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
radar watch run --source anthropic-sdk
```

GitHub Actions 上では自動注入される `GITHUB_TOKEN` (`secrets.GITHUB_TOKEN`) をそのまま使える。

残量が 10 req を下回ると stderr に warning が出る:

```text
github-releases: rate limit low (5/60 remaining) for anthropics/anthropic-sdk-python (resets at 2026-05-12T13:00:00.000Z). Set GITHUB_TOKEN to raise the quota from 60 to 5000 req/h.
```

quota 枯渇時 (HTTP 403 + `X-RateLimit-Remaining: 0`) は user-friendly なエラーで終了する:

```text
github-releases adapter: rate limit exhausted for anthropics/anthropic-sdk-python (resets at 2026-05-12T13:00:00.000Z). Set GITHUB_TOKEN to raise the quota from 60 to 5000 req/h.
```

##### スコープ外（現時点）

- `prerelease` / `draft` のフィルタ（必要なら filter 設計拡張で対応予定）
- GitHub Tags / Commits 監視（別 source kind で将来検討）
- GitHub Enterprise (self-hosted) URL（public github.com のみ対応）

#### `--kind html`

任意の HTML ページから CSS セレクタで item 一覧を抽出する。RSS が無いブログや変更履歴ページ向け。

```bash
radar source add anthropic-changelog \
  --kind html \
  --url https://docs.anthropic.com/changelog \
  --selector-item "article.changelog-entry" \
  --selector-title "h2" \
  --selector-link "h2 a" \
  --selector-summary "p.summary" \
  --selector-publishedAt "time"
```

`--selector-<field>` フラグでセレクタを指定する:

| フィールド | 必須 | 説明 |
|---|---|---|
| `item` | ✅ | 各 item を囲む親要素のセレクタ。例: `article.post` |
| `title` | ✅ | item 内の title 要素 |
| `link` | ✅ | item 内の link 要素。`<a href>` を優先、なければ text を URL として扱う |
| `summary` | | 概要要素（任意） |
| `publishedAt` | | 公開日時要素（任意）。`<time datetime>` / `<meta content>` を優先、フォールバックで text |
| `body` | | 本文要素（任意）。Item.raw に保存される |
| `tags` | | タグ要素のセレクタ（任意）。複数一致を配列として収集する |

挙動の要点:

- 相対リンク (`href="/path"`) は source の `--url` を base として解決される
- `Item.id` は `<title-slug>-<8 hex>`（ADR-0002 の id 派生コントラクト、stableKey は url）
- ETag を返すサーバには `If-None-Match` で条件付き GET。返さないサーバには body の sha256 を `state.lastEtag` slot に `sha256:` プレフィックス付きで保存し、次回の dedup に使う
- title / link が解決できない item は silent drop（RSS adapter 同様の fail-soft）

詳細な設計判断 (parser 選定、selector contract) は [`docs/design/source-html.md`](./design/source-html.md) を参照。

#### `--kind html-js`

JavaScript で DOM が組み立てられる SPA / CSR 系のページ（Next.js / Notion 埋め込み / Algolia DocSearch など、初期 HTML に item 要素が含まれないページ）から item を抽出する。fetcher のみ headless Chromium (Playwright) に差し替え、selector の評価ロジックは `kind: html` と共有する（[ADR-0010](./adr/0010-html-js-adapter-and-distribution.md)）。

##### いつ使うか

- `kind: html` で空配列が返る／item 数が明らかに少ない（static HTML に item が含まれない）
- 対象ページが Next.js / React / Vue 等の SPA で、`<script>` 実行後に DOM が組み立てられる
- Notion 埋め込み / Algolia DocSearch など、XHR でコンテンツが後から差し込まれる

「まず `kind: html` を試して空ならば `kind: html-js` に切り替える」運用が推奨。`kind: html` で取れる static HTML サイトに対して `kind: html-js` を使うと Chromium 起動コストが無駄になる。

##### `kind: html` との違い

| 項目 | `kind: html` | `kind: html-js` |
|---|---|---|
| Fetcher | `fetch()` + `node-html-parser` | headless Chromium (Playwright) |
| selectors の評価対象 | サーバから返る static HTML | **JS 実行後の DOM** (`page.content()`) |
| 依存パッケージ | なし（npm 単体配布の範囲内） | `playwright` (optional peer dep)、Chromium バイナリ |
| HTTP ETag による dedup | ✅ サーバが返せば利用 | ❌ 不可（`page.content()` から ETag は観察できない） |
| Content hash dedup | ✅ ETag フォールバック | ✅ 唯一の dedup signal |
| 起動コスト | 数百 ms | 数秒〜（Chromium 起動 + page render） |

> **selector の意味が変わる点に注意**: `kind: html` の selector は HTTP 応答の static HTML に対して評価するが、`kind: html-js` の selector は **JS 実行後の DOM** に対して評価する。同じ URL でも初期 HTML と最終 DOM では構造が違うため、`kind: html` 用の selector がそのまま動くとは限らない。ブラウザの DevTools で「Elements パネルに見えている DOM」を基準に selector を組み直すこと。

##### セットアップ手順

`html-js` adapter は Playwright を **optional peer dep** として参照する。`kind: html-js` を使うユーザーのみ Playwright と Chromium バイナリを別途 install する。`kind: rss` / `kind: html` のみ使うユーザーには影響しない（ADR-0010 §D3）。

```bash
# 1. Playwright npm package を install (user project または global)
npm i playwright
# または global install:
npm i -g playwright

# 2. Chromium バイナリを install
npx playwright install chromium
```

`radar` 自体は Chromium バイナリの自動 install を行わない。`postinstall` hook 経由の暗黙 download は CI cache 戦略 / オフライン install と衝突するため、ユーザー側で明示的に実行する設計（ADR-0010 §D4）。

不在検出は 2 箇所で行う:

- **`radar doctor`**: `html-js` source が登録された状態で実行すると、Playwright module と Chromium binary の存在確認結果を `ok` / `warn` / `error` で報告する
- **`radar watch run`**: `html-js` source を処理する直前に lazy detection。不在なら当該 source のみ skip し、他 source の処理は継続する。エラーメッセージで `npm i -g playwright && npx playwright install chromium` を案内する

CI 等で自動 install したい場合は環境変数 `RADAR_AUTO_INSTALL_CHROMIUM=1` を設定すると `radar` が `npx playwright install chromium` を spawn して install を試みる（Playwright npm package 自体の install は代行しない）。

##### 設定例（YAML を直接編集）

`--kind html-js` は `radar source add --kind html-js` で雛形を作れるが、`js:` ブロックは `source add` の flag で渡せないため、生成後に YAML を直接編集する。

```yaml
# sources/anthropic-changelog-js.yaml
id: anthropic-changelog-js
kind: html-js
url: https://example.com/changelog
selectors:
  item: ".changelog-item"
  title: "h3"
  link: "a"
  publishedAt: "time"
js:
  waitFor: ".changelog-item"   # 省略時は selectors.item を使う
  waitUntil: networkidle       # load | domcontentloaded | networkidle (default: networkidle)
  timeout: 30000               # 1 step (goto / waitForSelector) ごとの timeout (ms)
  # userAgent: "Mozilla/5.0 ..."  # 通常は default Chromium UA で OK
filters:
  keywords: ["release", "fix"]
trustLevel: untrusted
```

`js.*` フィールドは optional:

| フィールド | 既定値 | 説明 |
|---|---|---|
| `waitFor` | `selectors.item` | `page.content()` を読む前に待つ CSS selector |
| `waitUntil` | `networkidle` | Playwright `page.goto()` の lifecycle event。XHR で item が後から到達する SPA は `networkidle` が安全 |
| `timeout` | `30000` (ms) | 1 step ごとの timeout。pathological page による OOM / 無限 loop を防ぐキャップ |
| `userAgent` | Chromium default | UA gating を行うサイト向けの上書き。通常は不要 |

##### 挙動の要点

- selector の評価は `kind: html` と同一実装を共有する (`parseHtmlDocument`)。`Item.id` は `<title-slug>-<8 hex>`、`stableKey` は URL（ADR-0002）
- dedup は **content hash のみ**。`page.content()` を sha256 し、`state.lastEtag` slot に `sha256:` プレフィックス付きで保存する（`kind: html` で ETag を返さないサーバ向けと同じ slot を流用）
- 1 fetch ごとに fresh `browser context` を起動し、Service Worker / IndexedDB / localStorage 経由の状態混入を防ぐ
- title / link が解決できない item は silent drop（`kind: html` 同様の fail-soft）

##### Chromium hardening（オーバーライド不可）

`html-js` adapter は以下の policy を **ハードコード** で強制する（ADR-0010 §D5）。ユーザー設定 (`source.js.*`) からは触れない:

| Policy | 値 | 理由 |
|---|---|---|
| `headless` | `true` 強制 | UI 表示は CI 不可、operator UI 偶発操作のリスク回避 |
| `acceptDownloads` | `false` 強制 | drive-by download (page JS が file 保存を triggers する経路) を遮断 |
| context 再利用 | しない (fetch ごとに fresh context) | SW / IndexedDB / localStorage に injection payload を永続化させない、cross-source の状態混入を防ぐ |
| `page.close()` | `finally` で必ず実行 | page leak によるメモリ蓄積を防ぐ |
| viewport | Playwright default (1280x720) | 過剰に大きい viewport で巨大 DOM を生成しない |

これらは脅威モデル上の前提（ADR-0009 / `docs/design/threat-model.md`）であり、緩めるオプションは提供しない。

##### セキュリティ注意

- **任意 origin の JavaScript を Chromium で実行する**。signature 検証は無く、対象サイトの JS が「`fetch()` 経由で外部に何かを送信する」「巨大 DOM で OOM を引き起こす」等の振る舞いをしても止められない。`trustLevel: untrusted` 前提で運用すること
- 上記の hardening により drive-by download / SW persistence は遮断されるが、**Chromium バイナリ自体の脆弱性追跡はユーザー責任**。`npm audit` では拾えない（Chromium は npm package ではない）。週次目安で `npx playwright install chromium` を再実行し、最新の Chromium 系列に追随することを推奨（ADR-0010 §"悪い面"）
- `kind: html-js` source の workspace では特に、`.env` / 認証 token / 秘密鍵を CWD 配下に置かないこと（万一 prompt injection が agent 起動経路に到達した場合の被害範囲を限定する）

##### トラブルシュート

| 症状 | 対処 |
|---|---|
| `kind: html` で空配列が返る | `kind: html-js` を試す。selector は JS 実行後の DOM に合わせて組み直す |
| `html-js adapter: failed to load Playwright (...)` | `npm i -g playwright` (または user project に `npm i playwright`) を実行 |
| `Executable doesn't exist at ...chromium...` | `npx playwright install chromium` を実行 |
| `waitForSelector timeout` | `js.waitFor` を実際に DOM に出現する selector に変更する／`js.timeout` を伸ばす／`js.waitUntil` を `domcontentloaded` 等に切り替える |
| `radar watch run` が html-js source を skip し他は完走 | lazy detection が Playwright / Chromium 不在を検知した。`radar doctor` で詳細を確認 |
| 巨大ページで Chromium が hang する | `js.timeout` を短く設定する（既定 30 秒）。それでも改善しないなら `kind: html` 対象外サイトとして dismiss を検討 |
| プロキシ越しで `html-js` source が失敗する | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` を設定する。Playwright は Node の `--use-env-proxy` を読まないが、`html-js` adapter が env を probe して `launch({ proxy: { server, bypass } })` に自動注入する。`NO_PROXY` は Node 形式（`,` 区切り・`.suffix`）から Playwright 形式（`;` 区切り・`*.suffix`）に自動変換 |

詳細な設計判断は [ADR-0010](./adr/0010-html-js-adapter-and-distribution.md) を参照。

##### CI で使う

GitHub Actions で `kind: html-js` source を含む workspace の `watch run` を回す場合、Chromium binary を cache すると 2 回目以降の install 時間を大幅に短縮できる。

```yaml
# .github/workflows/watch.yaml の steps 抜粋
- uses: actions/checkout@v4

- uses: actions/setup-node@v4
  with:
    node-version: "22.21" # or "24"; radar requires Node 22.21+ / 24.5+ for HTTPS_PROXY support

- run: npm i -g @ozzylabs/feedradar playwright

# 同じ Playwright バージョンが lock されている限り Chromium バイナリを再利用
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json', 'pnpm-lock.yaml') }}

- run: npx playwright install --with-deps chromium

- run: radar watch run
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--with-deps` は OS パッケージ (libnss3 / libatk1.0-0 等の Chromium 実行に必要な shared library) を `apt-get install` する。Ubuntu runner では推奨。

#### `--kind npm-registry`

npm パッケージの新バージョン公開を監視する。`registry.npmjs.org/<package>` の packument を取得し、`versions` を Item として正規化する（認証不要 / rate limit 1000 req/h 程度）。

`--url` には次のどちらの形式も指定できる:

- パッケージ名そのまま: `@anthropic-ai/sdk` / `react`
- 公開 URL: `https://www.npmjs.com/package/<package>`（`/v/<version>` 付きも可）

例:

```bash
radar source add anthropic-sdk-js --kind npm-registry --url @anthropic-ai/sdk
```

挙動の要点:

- 1 バージョン = 1 Item。`Item.id` は `<package-slug>-<version-slug>-<8 hex>`（ADR-0002 の id 派生コントラクト）
- `Item.title` = `<package>@<version>`、`Item.url` = `https://www.npmjs.com/package/<package>/v/<version>`
- `Item.publishedAt` = packument の `time[<version>]`
- ETag-based 条件付き GET をサポート。サーバが `304` を返すと items 処理をスキップ
- 既知バージョンは state の `lastSeenIds` で除外されるため、2 回目以降は新バージョンのみ検出される

#### `--kind json-feed`

[JSON Feed 1.0 / 1.1](https://jsonfeed.org/version/1.1) 標準に準拠したサイトを **URL のみ** で監視する zero-config adapter。RSS と同じ L0 tier（recipe 不要）として位置付けられる（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §C / §D3）。

```bash
# 例: micro.blog ユーザーフィード
radar source add example-microblog \
  --kind json-feed \
  --url https://example.micro.blog/feed.json \
  --keywords "release,announce"
```

##### いつ json-feed を使うか

- 対象サイトが `application/feed+json` または `application/json` で JSON Feed を配信している
- `<link rel="alternate" type="application/feed+json" href="...">` が HTML に張られている
- 代表例: [micro.blog](https://micro.blog) のユーザーフィード、Daring Fireball、一部の静的サイトジェネレーター

JSON Feed は仕様で `id` / `url` / `title` / `content_text` / `content_html` / `date_published` / `tags` 等のフィールドが固定されているため、サイトごとの recipe 調整は不要。

##### 1.0 と 1.1 の違い

両 version 共に `version` フィールドの URI で識別する:

| version | URI | 受け付け |
|---|---|---|
| 1.0 | `https://jsonfeed.org/version/1` | ✅ |
| 1.1 | `https://jsonfeed.org/version/1.1` | ✅ |
| 上記以外 | ― | ❌ ハードエラー（typo / 別フォーマットを fail-fast で検出） |

adapter が読む item フィールドは 1.0 / 1.1 で共通のため、version 差は version 受け付け判定のみに使う。1.1 で追加された `authors[]` / `language` 等の拡張は `Item.raw` に保持されるが `Item` schema には surface しない。

##### Item フィールドへの正規化

| Item フィールド | JSON Feed フィールド |
|---|---|
| `title` | `items[].title`（spec 上 optional のため未指定 item は空文字） |
| `url` | `items[].url`（必須。これが無い item は silent drop） |
| `summary` | `items[].content_html` → なければ `content_text` → なければ `summary` |
| `publishedAt` | `items[].date_published`（ISO 8601、parse 失敗時は `undefined`） |
| `id` | `<title-slug>-<8 hex of sha256(<publisherId-or-url>)>`（[ADR-0002](./adr/0002-source-adapter-plugin-pattern.md)、`publisherId` = `items[].id`、なければ `url`） |
| `raw` | item 全体 + `tags` 正規化済み |

##### pagination (`next_url`)

JSON Feed は仕様で `top.next_url` による pagination を許す。adapter は **最大 50 ページ**まで `next_url` を transitively 辿り、全 item を 1 fetch round で取得する。

- ループ防止: 訪問済み URL は再訪しない（cycle 検出）
- 50 ページ cap: 個人ブログ規模では実質無制限。`--backfill` フラグでさらに広げる予定は無い（JSON Feed は記事点数が支配的に少ない）

##### json-feed の挙動の要点

- ETag (`If-None-Match`) と Last-Modified (`If-Modified-Since`) の両条件付き GET をサポート。サーバが `304 Not Modified` を返すと items 処理をスキップしつつ `lastFetchedAt` のみ更新
- malformed item（`url` 欠落、parse 不能な `date_published` 等）は silent drop（1 item の不正で feed 全体を落とさない）
- 信頼境界は `rss` と同じく **サイト運営者のみ**（recipe 作者の信頼境界は無い — [ADR-0009](./adr/0009-untrusted-external-content-handling.md) §A）

#### `--kind json-api`

任意 JSON API を **recipe** で記述して監視する汎用 adapter（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D2）。AWS What's New / dev.to / Anthropic news 等、固定 schema を持たない JSON エンドポイントが対象。`--backfill` で過去全記事の一括取り込みもサポート。

##### いつ json-api を使うか

- 対象 API が **JSON** で応答する（HTML / XML なら `kind: html` / `kind: rss` を使う）
- `kind: json-feed` 標準には準拠していない（独自 schema）
- HTTP `GET` のみで取得できる（POST / GraphQL は範囲外）

代表例:

| サイト | endpoint | pagination | 備考 |
|---|---|---|---|
| AWS What's New | `https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new&size=100&page=0&...` | `page` (page-number) | 16,000+ 件、`--backfill` の主要 use case |
| dev.to | `https://dev.to/api/articles?per_page=30&page=1` | `page` | zero-config（default chain で動く） |
| 任意の REST API | `Link: ...; rel="next"` 形式 | `link-header` | GitHub-style pagination |

##### 設定 YAML 完全例（AWS What's New）

`source add` は flag で `pagination.*` を渡せるが、`jsonSelectors.*` は **YAML を直接編集**して指定する（フィールドが多いため flag では現実的でない）。AWS What's New の完全な recipe:

```yaml
# sources/aws-whats-new.yaml
id: aws-whats-new
kind: json-api
url: https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new&sort_by=item.additionalFields.postDateTime&sort_order=desc&size=100&page=0&tags.id=whats-new%23general-products%23amazon-bedrock
name: AWS What's New
tags: ["aws", "cloud"]
filters:
  keywords: ["Bedrock", "Claude", "agents"]
  matchMode: "word"
http:
  method: GET
  headers:
    accept: "application/json"
pagination:
  type: page
  param: page
  start: 0
  pageSize: 100
  pageSizeParam: size
  maxPages: 200      # ≈ 20,000 件まで遡れるキャップ（--backfill 用）
  totalPath: "$.metadata.totalHits"   # backfill 早期停止のヒント
jsonSelectors:
  items: "$.items[*].item"
  title: "$.additionalFields.headline"
  link: "$.additionalFields.headlineUrl"
  publishedAt: "$.additionalFields.postDateTime"
  summary: "$.additionalFields.postBody"
  publisherId: "$.id"
trustLevel: untrusted
```

##### 設定 YAML 完全例（dev.to、default chain で zero-config）

dev.to API は `$.items` 直下に article 配列、各 article 直下に `title` / `url` / `description` / `published_at` を持つ「素直な」shape のため、`jsonSelectors` を完全に省略できる。default chain（`$.items[*]` → `$.title` → `$.url` → `$.published_at` → `$.description`）が動く:

```yaml
# sources/devto-claude.yaml
id: devto-claude
kind: json-api
url: https://dev.to/api/articles?tag=claude&per_page=30
name: dev.to Claude tag
filters:
  keywords: ["Claude Code", "Anthropic"]
pagination:
  type: page
  param: page
  start: 1
  pageSize: 30
  pageSizeParam: per_page
  maxPages: 10
trustLevel: untrusted
```

`jsonSelectors` ブロック自体を書かなくても動くのが json-api の zero-config 路線（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D2 default chain / #174）。

##### CLI で `source add` する場合（flag）

```bash
# AWS What's New: --pagination-* flag を使う
radar source add aws-whats-new \
  --kind json-api \
  --url "https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new&size=100&page=0" \
  --keywords "Bedrock,Claude" \
  --pagination-strategy page \
  --pagination-param page \
  --pagination-start 0 \
  --page-size 100 \
  --page-size-param size \
  --max-pages 200 \
  --total-path "$.metadata.totalHits"

# 生成された sources/aws-whats-new.yaml を編集して jsonSelectors を追記
$EDITOR sources/aws-whats-new.yaml
```

`source add` 直後の YAML には `jsonSelectors` ブロックが入らないため、AWS のような non-standard shape を扱う場合は手動で追記する。default chain で済む API（dev.to 等）は flag だけで完結する。

##### `http.*` リファレンス

| フィールド | 型 | 説明 |
|---|---|---|
| `method` | `"GET"` | Phase 1 では GET のみ（POST / GraphQL は範囲外） |
| `headers` | `Record<string, string>` | カスタムヘッダ。`${VAR}` 形式で環境変数を補間（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D5c）。未解決の `${VAR}` を含む header は **omit される**（fail-fast を runtime の 401/403 で出すため、recipe 側は env を必須前提で書ける） |

env interpolation の例:

```yaml
http:
  headers:
    authorization: "Bearer ${DEV_TO_TOKEN}"   # DEV_TO_TOKEN 未設定なら header omit (= 401)
    user-agent: "feedradar-corp/1.0"          # 静的値はそのまま
```

interpolated 値は **ログ・frontmatter に出力しない**（ADR-0012 §D5c）。`source test --show-content` でも header dump は出さない。

##### `pagination.*` リファレンス（5 戦略）

| `type` | 適用 query | 主要オプション | 代表例 |
|---|---|---|---|
| `page` | `?<param>=K&<pageSizeParam>=N` | `param` (default `page`), `start` (default `0`), `pageSize`, `pageSizeParam` (default `pageSize`) | AWS What's New, dev.to |
| `offset` | `?<param>=K&<pageSizeParam>=N` | `param` (default `offset`), `start` (default `0`), `pageSize`, `pageSizeParam` (default `limit`) | 古典的な offset/limit |
| `cursor` | `?<param>=<cursorValue>` | `param` (default `after`), `nextCursorPath` (必須) | GraphQL connection-like |
| `token` | `?<param>=<tokenValue>` | `param` (default `pageToken`), `nextCursorPath` (必須) | Google API, Vimeo |
| `link-header` | (URL は HTTP `Link: <url>; rel="next"` から取得) | ― | GitHub-style |
| `none` | (1 リクエストのみ) | ― | 単一 endpoint |

共通フィールド:

| フィールド | 説明 |
|---|---|
| `maxPages` | ハードキャップ（default `20`）。recipe 側の暴走 / DoS 防御。`--backfill` で `--max-pages` から override 可能 |
| `totalPath` | 全件数を表す JSONPath-lite（例: `$.metadata.totalHits`）。`--backfill` 時に「`pageSize * 想定ページ数 >= total`」になった時点で early-stop |

##### pagination 戦略の選び方

1. **HTTP `Link: <...>; rel="next"` ヘッダが返るか** → `link-header`（最も堅牢）
2. **next_cursor / next_token が応答 body にあるか** → `cursor` / `token`（`nextCursorPath` で JSONPath-lite 指定）
3. **page index または offset を query で渡せるか** → `page` / `offset`
4. **そもそも単一 endpoint** → `none`

「page と offset どちらでも書けるとき」は **page を優先**する。`?page=0&size=100` と `?offset=0&limit=100` は表現力が同じだが、page-based の方が AWS / dev.to 等で慣習化されているため recipe が読みやすい。

##### `jsonSelectors.*` と default chain

`jsonSelectors` 配下の selector は **JSONPath-lite** 式（後述「[JSONPath-lite の表現力上限](#jsonpath-lite-の表現力上限)」を参照）。完全省略可能で、省略時は per-field default chain が走る:

| field | default chain | 必須 |
|---|---|---|
| `items` | `$.items[*]` → `$.data[*]` → `$.results[*]` → `$.posts[*]` → `$.entries[*]` → `$[*]` | ― |
| `title` | `$.title` → `$.name` → `$.headline` | ― |
| `link` | `$.url` → `$.link` → `$.permalink` → `$.html_url` | ― |
| `publishedAt` | `$.publishedAt` → `$.published_at` → `$.date` → `$.created_at` → `$.pubDate` | ― |
| `summary` | `$.summary` → `$.description` → `$.excerpt` → `$.body` | ― |
| `publisherId` | (default chain なし) | optional |
| `body` | (default chain なし、recipe 明示時のみ参照される) | optional |
| `tags` | (default chain なし、現状 `Item.raw` 経由でのみ surface) | optional |
| `linkBase` | (default chain なし、未指定時は `source.url` を base に相対 link を絶対化 / #204) | optional |

明示 selector を指定する判断基準:

- API が AWS のように **`additionalFields.headlineUrl` のようなネストパス**を使う → 明示
- 同じ field 名が default chain にない（例: `byline` → title） → 明示
- default chain で取れているか不安 → `source test --show-content` で **adoption 表**を確認（後述）

##### `--backfill` フラグ（過去全履歴の取り込み）

通常 `watch run` は新着検出に最適化されており、`lastSeenIds` に当たった時点でページネーションを打ち切る。**`--backfill` モード**を使うと、recipe の `pagination.maxPages` まで全ページを辿って items を一括取り込みする（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D4）。

```bash
# AWS What's New の過去 16,000+ 件を取り込む
radar watch run --source aws-whats-new --backfill --max-pages 200

# default の maxPages（recipe 値）で backfill
radar watch run --source aws-whats-new --backfill
```

挙動の要点:

- 通常モードの early-stop（`lastSeenIds` ヒット / `pageSize` 未満 / 空ページ）が **無効化**される（`pageSize` 未満 / 空ページは引き続き termination）
- conditional GET (`If-None-Match`) も **無効化**される（前回 `lastEtag` が stale な normal-mode の値だと 304 で early-out してしまうため）
- `pagination.totalPath` が指定されていれば early-stop の上限を計算（例: `totalHits: 16281`, `pageSize: 100` → 163 ページで停止）
- `--max-pages N` は `pagination.maxPages` と `N` の **小さい方** が effective cap（recipe の安全網は維持しつつユーザー側で更に絞れる）
- `--bootstrap` と **mutually exclusive**（`--bootstrap` は seen 化のみで items を生成しない、`--backfill` は items を全件生成、目的が逆）。同時指定で exit code 2

`--backfill` と `--bootstrap` の比較:

| フラグ | items 生成 | state 更新 | conditional GET | early-stop | 用途 |
|---|---|---|---|---|---|
| (なし、通常モード) | 新着のみ | `lastSeenIds` 追加 + `lastEtag` | 有効 | `lastSeenIds` ヒットで止まる | 定期実行 |
| `--bootstrap` | **生成しない** | `lastSeenIds` に全 id を seed | 有効 | 通常通り | 初回導入時のノイズ抑制 |
| `--backfill` | **全件生成** | `lastSeenIds` に全 id 追加 + `lastEtag` | **無効** | `pagination.maxPages` または `totalPath` 由来の cap | 過去履歴の一括取り込み |

##### `source test` の page 0 限定挙動

`radar source test <id>` は dry-run なので、json-api でも **page 0 のみ fetch**して終了する。`--limit N` は表示件数の上限であり、ページ予算は変えない:

```bash
radar source test aws-whats-new --show-content
# → fetched: 100 / filtered: <n> / matched: <m>
#   selector adoption:
#     items ← $.items[*].item を採用
#     title ← $.additionalFields.headline を採用
#     ...
#   pagination preview (page 0 only — state not mutated):
#     strategy:  page
#     nextUrl:   https://.../search?page=1&size=100
```

`--show-content` を付けると **selector adoption 表**（どの JSONPath で値が取れたか）と **pagination preview**（page 1 として叩く URL / Link header / nextCursor の予測）が出る。recipe の `jsonSelectors` / `pagination` を tune するときの主要ツール。

`source test` は `state/<id>.yaml` を書き換えないため、何度走らせても `lastSeenIds` は汚れない。tune 用途で安心して連打できる。

過去全件を見たい場合は `radar watch run --source <id> --backfill` を使う（dry-run ではないので state / items は更新される）。

##### JSONPath-lite の表現力上限

selector に書ける JSONPath は `src/core/feeds/_jsonpath.ts` の **lite 版**で、依存パッケージなしで実装されている。サポート機能:

| 機能 | 例 | サポート |
|---|---|---|
| ルート | `$` | ✅ |
| プロパティアクセス | `$.foo.bar` | ✅ |
| 配列 index | `$.items[0]` | ✅ |
| 配列展開（全要素） | `$.items[*]` | ✅ |
| ネスト展開 | `$.items[*].item.headline` | ✅ |
| ブラケット記法 | `$["items"][*]["title"]` | ✅ |
| 数値 / 文字列リテラル | ― | ✅（path 終端の値取得） |

**サポートしない機能**（標準 JSONPath では使えるが lite では未実装）:

- フィルタ式 `$.items[?(@.published == true)]`
- スライス `$.items[1:5]`
- 再帰下降 `$..title`（任意の深さ）
- script expression `$.items[(@.length-1)]`
- union `$.items[0,1,2]`
- ワイルドカード property `$.items[*].*`

これらが必要な場合は **`raw` 経由でデータを保持しておき、後段 filter で対処**する（recipe 側で複雑な filter を書かない）。または adapter 改修を別 issue で検討。

##### `source add` flag 一覧（json-api 固有）

`radar source add --kind json-api` で受け付ける flag:

| flag | 説明 |
|---|---|
| `--pagination-strategy <s>` | `page` / `offset` / `cursor` / `link-header` / `token` / `none`（default `page`） |
| `--pagination-param <name>` | page / offset / cursor の query param 名 |
| `--pagination-start N` | initial page / offset 値（default `0`） |
| `--page-size N` | 1 ページの item 数 |
| `--page-size-param <name>` | page-size の query param 名 |
| `--max-pages N` | ハードキャップ（default `20`） |
| `--next-cursor-path <jp>` | cursor / token strategy の `nextCursorPath` |
| `--total-path <jp>` | `--backfill` 早期停止のヒント JSONPath |

`jsonSelectors.*` は flag では指定できない（YAML を直接編集する）。

##### 信頼境界 / 防御層

`kind: json-api` は recipe で任意 URL / 任意 header を許すため、既存 5 adapter より広い attack surface を持つ（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) §A / [ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D5）:

| 防御層 | 内容 |
|---|---|
| **D5a** 応答サイズキャップ | 1 ページあたり **10 MB** で hard cap。recipe からは override 不可（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D5a） |
| **D5b** host allowlist / blocklist | `127.0.0.1` / loopback / RFC1918 private IP / `file://` / `169.254.169.254` (cloud metadata) を遮断（共通 fetch wrapper が SSRF 防御を持つ前提、現状は wrapper 側で実装中） |
| **D5c** env interpolation の固定 policy | `${VAR}` 未解決時は header omit（degraded fetch）、interpolated 値は **ログ・frontmatter に出さない** |
| **信頼境界の再評価** | サイト運営者 **+ recipe 作者**（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) §A）。公式バンドル recipe（将来）と user 手書き recipe で監査責任が異なる |

##### json-api のトラブルシュート

| 症状 | 対処 |
|---|---|
| `items` が 0 件で返る | `radar source test <id> --show-content` で **selector adoption 表** を確認。`items: (no candidate matched)` なら default chain が当たっていないので `jsonSelectors.items` を明示。`title: (no candidate matched)` なら `jsonSelectors.title` を明示。実際の JSON は `curl <url> \| jq .` で構造を確認すると早い |
| `publishedAt: Invalid Date` で個別 item が drop | `jsonSelectors.publishedAt` が `new Date()` で parse 不能な形式（独自タイムスタンプ / 数値 epoch 等）を指している。ISO 8601 / RFC 2822 に変換できるパスを選ぶか、recipe 側で `publishedAt` を諦めて `raw` 経由で見る |
| 同じ page を繰り返し取得する（無限ループに見える） | `pagination.type: cursor` / `token` で `nextCursorPath` が間違っており、毎回同じ cursor を抽出している。`source test --show-content` の pagination preview で `nextCursor: <値>` が一定でないか確認。`pagination.type: page` で `start` を間違えて固定値を返している場合も発生 |
| `json-api adapter: response too large (>10485760 bytes cap) from ...` | 1 page で 10 MB を超えている。`pagination.pageSize` を下げる（例: 100 → 30）。API が pageSize 無視で全件返す仕様なら別 endpoint を探すか kind を切り替える |
| `json-api adapter: HTTP 304` 後も何も取れない | normal mode で前回 `lastEtag` が hit。`--backfill` を付けると conditional GET が skip されるので、過去履歴を取り直したいなら `--backfill` で再実行 |
| `${VAR}` を含む header を入れたのに 401 が出る | env が未解決で header が omit されている。`echo $VAR` で実値を確認し、`radar watch run` を呼ぶ shell に export されているか check |
| `pagination.maxPages` が小さくて backfill が途中で打ち切られる | `--max-pages N` でその場限り上書き（`pagination.maxPages` と min を取る）。恒久的に上げるなら recipe 側の `maxPages` を編集 |
| `items` の `url` が相対パス（`/about-aws/...` 等）で全件 drop される | API が link を相対パスで返す場合、adapter は自動的に `jsonSelectors.linkBase`（未指定なら `source.url`）を base として絶対化する（#204）。`source test --show-content` の `items` が 0 件で `selector adoption` 表は埋まっている時はこの症状を疑う。明示的に base を指定したいときは `jsonSelectors.linkBase: https://<host>` を追加（fully-qualified http(s) URL のみ受け付ける） |

詳細な設計判断は [ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) を参照。

### `radar source recipes`

バンドルされている recipe（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D3 採用案 A — リポ同梱）を一覧表示する。recipe は `recipes/*.yaml` として `radar` npm パッケージに同梱されており、`radar source add <id> --recipe <name>` で 1 行で source 化できる。

```bash
radar source recipes
# NAME            KIND      DESCRIPTION
# aws-whats-new   json-api  AWS What's New feed (full-history backfill)
# devto           json-api  dev.to articles (page-based pagination)
# ...
```

recipe の **NAME** は `recipes/<name>.yaml` のファイル名 stem（拡張子なし）であり、`--recipe <name>` で指定する識別子になる。YAML 側に内部 `name:` フィールドを持たせている場合、それは生成される `Source.name`（表示名）にマップされる別レイヤー。

バンドル recipe が 1 件もない（または `recipes/` ディレクトリ自体が無い）場合は `no recipes bundled` を返して exit 0 する。malformed な recipe があると `Recipes with errors:` ブロックで個別に報告するが、それ以外の有効 recipe は通常通り一覧表示される（fail-soft）。

#### 同梱されている公式 recipe（Phase 1）

現在リポに同梱されている公式 recipe は次の通り（#178 / [ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D3 strategy A）。各 recipe の生身の YAML は `recipes/<name>.yaml` を参照する（docs 側に再掲すると site 仕様変更との同期コストが二重に発生するため、`recipes/` を SSoT とする）。

| recipe id (`--recipe <name>`) | 対象サイト | kind | pagination 戦略 | jsonSelectors | 主なトラブルシュート |
|---|---|---|---|---|---|
| `aws-whats-new` | [AWS What's New](https://aws.amazon.com/about-aws/whats-new/recent/) (JSON API) | `json-api` | `page` (`size=100`, `maxPages=200`, `totalPath=$.metadata.totalHits`) | 明示（`$.items[*].item` 経由で `headline` / `headlineUrl` / `postDateTime` / `postBody`）。`headlineUrl` は相対パスのため `linkBase: https://aws.amazon.com` で絶対化（#204） | `--backfill` で AWS の全履歴 16,000+ 件を取り込み可能。site 仕様変更で selector drift する場合は [`#--kind-json-api`](#--kind-json-api) の selector adoption 表で原因を切り分け |
| `dev-to` | [dev.to articles API](https://developers.forem.com/api) | `json-api` | `page` (`per_page=30`, `maxPages=10`) | 省略（default chain で動く） | URL に `&tag=<name>` を足すと特定タグに絞れる（`source add` 後に `sources/<id>.yaml` を編集） |

> **note:** Phase 1 では公式 recipe は 2 個から開始。issue [#178](https://github.com/ozzy-labs/feedradar/issues/178) のスコープには Anthropic news も含まれていたが、`https://www.anthropic.com/api/news` 等の候補 endpoint がいずれも 404（2026-05 時点）で公開 JSON / RSS が確認できなかったため、別 issue で endpoint 再調査することにした（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §F1 「recipe ライブラリ化」評価のトリガー条件を満たした時に合わせて再検討）。

CI smoke test ([`.github/workflows/recipes-smoke.yaml`](../.github/workflows/recipes-smoke.yaml)) が週次 cron で上記 recipe の page 0 fetch + parse を流し、selector drift / API breakage を早期検知する。失敗は `::warning::` annotation で surface するのみで release を block しない（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D3）。

#### 自分で recipe を追加するには

現時点では「バンドル recipe（リポ同梱）」のみがサポートされており、user-local の recipe ディレクトリは未対応。新しい公式 recipe を追加したい場合は [ozzy-labs/feedradar](https://github.com/ozzy-labs/feedradar) リポの `recipes/*.yaml` に PR を送る。recipe 1 件あたり ~30 行 YAML で済むため、対応 site を増やすコストは低い（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D1）。

recipe schema は `src/schemas/recipe.ts` の `RecipeFileSchema` を SSoT とする。主要フィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `kind` | enum | `rss` / `html` / `html-js` / `github-releases` / `npm-registry` / `json-feed` / `json-api` |
| `url` | string | fetch 対象（必須） |
| `name` | string? | 表示名（recipe → Source.name） |
| `description` | string? | `radar source recipes` で表示される 1 行説明（生成 YAML には**書き出さない**） |
| `tags` | string[]? | 既定 tag セット |
| `filters` | object? | recipe author 提案のキーワード / matchMode / matchFields / caseSensitive |
| `pagination` / `jsonSelectors` / `http` | object? | `kind: json-api` 用 |
| `selectors` / `js` | object? | `kind: html` / `html-js` 用 |
| `trustLevel` | `"trusted"` / `"untrusted"` | 既定 `"untrusted"` |

`id` は recipe には書かない（ユーザーが apply 時に与える）。

#### CI smoke test との関係

バンドル recipe は site の breaking change で壊れる可能性があるため、`recipes-smoke` ジョブ（#178 で実装予定）で外部 fetch 検証を行う。main CI は flaky な外部 API に依存させず、smoke job 単独で fail させる設計（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D3）。

### `radar source add <id> --recipe <name> [overrides]`

`radar source add` の **recipe モード**。バンドル recipe を 1 行で source 化する:

```bash
# AWS What's New を `aws-watch` という id で追加し、キーワードだけ上書き
radar source add aws-watch --recipe aws-whats-new --keywords "Bedrock,Quick"

# 直後に過去全件を取り込む
radar watch run --source aws-watch --backfill --max-pages 200
```

`--recipe` を指定すると、`--kind` / `--url` / `--selector-*` / `--pagination-*` は **明示的に拒否される**（recipe author が責任を持つ structural フィールドだから）。上書き可能な flag は以下のみ:

| flag | 役割 |
|---|---|
| `--name <display>` | recipe の `name` を上書き |
| `--tags <a,b>` | recipe の `tags` を replace（merge ではない） |
| `--keywords <a,b>` | recipe の `filters.keywords` を replace |
| `--exclude-keywords <a,b>` | recipe の `filters.excludeKeywords` を replace |

その他 (`matchMode` / `matchFields` / `caseSensitive` / `selectors` / `pagination` / `jsonSelectors`) は recipe 側の値が必ず使われる。これらを変えたい場合は `sources/<id>.yaml` を生成後に直接編集する（既存の flag-based `source add` と同じ運用）。

失敗時の挙動:

| 状況 | exit | メッセージ |
|---|---|---|
| recipe 名が存在しない | 1 | `recipe 'X' not found (available: ...)` で候補一覧 |
| recipe の YAML が malformed | 1 | `invalid YAML in recipe 'X': <yaml error>` |
| recipe が schema 違反 | 1 | `recipe 'X' failed schema validation: <issue list>` |
| `--kind` / `--url` / `--selector-*` / `--pagination-*` を併用 | 2 | `the following flags are not allowed with --recipe: ...` |
| `sources/<id>.yaml` が既存 | 1 | `'<id>' already exists` (上書きしない) |

### `radar source list [-v|--verbose] [--enabled-only]`

`sources/*.yaml` を一覧表示。

| オプション | 説明 |
|---|---|
| `-v`, `--verbose` | source ごとに `keywords` / `excludeKeywords` / `trustLevel` / `lastFetchedAt` を含む詳細ブロックを表示する。キーワード未設定の source の発見にも使う |
| `--enabled-only` | 将来の `enabled: false` フラグ向けに予約 (現状 no-op、将来追加予定) |

### `radar source remove <id>`

`sources/<id>.yaml` を削除。`state/<id>.yaml` と紐づく `items/` は残す（履歴保持）。

### `radar source test <id> [--limit N] [--show-content]`

指定 source を **ドライラン** で 1 回 fetch し、フィルタを適用したうえで matched item を標準出力に表示する。`state/<id>.yaml` と `items/<id>/` は**一切更新されない**。

| 引数 / オプション | 説明 |
|---|---|
| `<id>` | `sources/<id>.yaml` の id |
| `--limit N` | matched item の表示件数上限（既定: `10`） |
| `--show-content` | 各 matched item の本文先頭 200 文字も併せて表示する |

出力フォーマット例:

```text
source test: anthropic-news
  fetched: 12 / filtered: 3 / matched: 3

Showing 3 of 3 matched item(s):

  1. Claude Code releases agents
     url:             https://anthropic.com/news/claude-code-agents
     matchedKeywords: agents,claude
     content:         Anthropic announced new agents features...
  ...
```

**ユースケース**: 新規 source を `radar source add` で追加した直後、`--keywords` の hit 状況を**確認しながら段階的に調整**する。`watch run` を実行すると `state/<id>.yaml` の `lastSeenIds` に id が記録されてしまい同じ item が二度と検出されなくなるため、本コマンドで keywords を試行錯誤する。

```bash
# 新規 source を追加して keywords を試行錯誤する典型フロー
radar source add anthropic-news \
  --kind rss \
  --url https://www.anthropic.com/news/rss.xml \
  --keywords "Claude,agents"

# まず dry-run でヒット具合を確認
radar source test anthropic-news --limit 5

# 想定より少なすぎる / 多すぎる場合は YAML を直接編集してキーワードを調整し、
# 再び test で確認。state/items は一切汚れない
$EDITOR sources/anthropic-news.yaml
radar source test anthropic-news --show-content

# 納得したら本番 ingest を開始
radar watch run --source anthropic-news
```

挙動の要点:

- `watchRun({ ..., dryRun: true })` を内部で呼ぶ。fetch + filter + injection pre-filter までは通常どおり動くが、`items/<id>/*.yaml` の書き込みと `state/<id>.yaml` の保存をスキップする
- `<id>` が `sources/<id>.yaml` に存在しないと exit code `1` で失敗（user-friendly メッセージ）
- `<id>` 未指定や不正なオプションは exit code `2`
- fetch / parse エラーは `watch run` 同様の per-source エラーとして stderr に出力され exit code `1` を返す

### `radar watch run [--source <id>] [--bootstrap | --backfill [--max-pages N]]`

すべての source（または `--source` で指定）を fetch、filter を適用、新規 item を `items/<sourceId>/<item-id>.yaml` に追加。

| オプション | 説明 |
|---|---|
| `--source <id>` | 単一 source のみ fetch する。未指定なら `sources/*.yaml` 全件 |
| `--bootstrap` | 既存記事を全て **検出済み (seen)** として state に取り込み、items は作らない。初回導入時のノイズ抑制用 |
| `--backfill` | recipe の `pagination.maxPages` まで全ページを辿って items を全件生成する（[ADR-0012](./adr/0012-json-api-adapter-and-recipe-strategy.md) §D4）。`kind: json-api` / `github-releases` / `npm-registry` のみ完全対応、他 kind は通常 fetch と同じ |
| `--max-pages N` | `--backfill` 時の上限を `min(pagination.maxPages, N)` で絞る。`--backfill` 必須（単独指定は exit code 2） |

`--bootstrap` と `--backfill` は **mutually exclusive**（同時指定は exit code 2）:

| フラグ | items 生成 | state 更新 | conditional GET | early-stop | 用途 |
|---|---|---|---|---|---|
| (なし、通常モード) | 新着のみ | `lastSeenIds` 追加 + `lastEtag` | 有効 | `lastSeenIds` ヒットで止まる | 定期実行 |
| `--bootstrap` | **生成しない** | `lastSeenIds` に全 id を seed | 有効 | 通常通り | 初回導入時のノイズ抑制 |
| `--backfill` | **全件生成** | `lastSeenIds` に全 id 追加 + `lastEtag` | **無効** | `pagination.maxPages` または `totalPath` 由来の cap | 過去履歴の一括取り込み |

`--backfill` の詳細な挙動と使用例は「[`--kind json-api` の `--backfill` フラグ](#--backfill-フラグ過去全履歴の取り込み)」を参照。

挙動:

- 各 source の `kind` に応じた feed adapter を呼び出す（7 種すべて `rss` / `html` / `html-js` / `github-releases` / `npm-registry` / `json-feed` / `json-api` が実装済み。`html-js` は Playwright を optional peer dep として動的 import する — ADR-0010）
- adapter は `If-None-Match` ヘッダ（前回 `lastEtag`）を付けて GET し、サーバが `304 Not Modified` を返した場合は items 処理をスキップしつつ `lastFetchedAt` のみ更新する（adapter 別の対応状況・304 時の詳細な挙動は [`docs/architecture.md` の "Fetch efficiency / conditional GET"](./architecture.md#fetch-efficiency--conditional-get) を参照）
- fetch した item に [filter](./design/filter-spec.md) を適用し、`lastSeenIds` に無いもののみを `items/<sourceId>/` に書き出す（`status: detected`、`matchedKeywords` 付き）
- 実行後 `state/<sourceId>.yaml` の `lastFetchedAt` / `lastEtag` / `lastSeenIds` が更新される
- 一部 source で失敗した場合でも他 source は続行し、exit code は `1` を返す（CI で検知可能）

#### Fetch のタイムアウトとリトライ

全 feed adapter (`rss` / `html` / `npm-registry` / `github-releases` / `json-feed` / `json-api`) は共通の fetch wrapper を経由する。プロキシ越し / 不安定な公衆 RSS / 一時的な 5xx でも `watch run` が止まらないよう、デフォルトで次の挙動が入っている:

- **タイムアウト**: 1 attempt あたり 30 秒（`AbortSignal.timeout` 実装）
- **リトライ**: 5xx 応答および transient なネットワークエラー (`ECONNRESET` / `ETIMEDOUT` / `ENETUNREACH` / `EAI_AGAIN`) で最大 2 回
- **バックオフ**: 200ms → 800ms の指数バックオフ
- **リトライしないケース**: 4xx（404 / 401 / 403 等の恒久エラー）、呼び出し側からの abort

挙動は環境変数で上書きできる:

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `RADAR_FETCH_TIMEOUT_MS` | `30000` | 1 attempt あたりのタイムアウト (ms) |
| `RADAR_FETCH_RETRIES` | `2` | 初回失敗後のリトライ回数（`0` で即失敗） |
| `RADAR_FETCH_HOST_ALLOWLIST` | (空) | SSRF host blocklist の override (カンマ区切り host literal、testing 用)。詳細は下記「[SSRF host blocklist](#ssrf-host-blocklist)」 |

```bash
# 例: タイムアウトを 10 秒、リトライを 4 回に
export RADAR_FETCH_TIMEOUT_MS=10000
export RADAR_FETCH_RETRIES=4
radar watch run
```

#### SSRF host blocklist

[ADR-0009 §D5b](./adr/0009-untrusted-external-content-handling.md#d5b-host-allowlist--blocklist) に従い、共通 fetch wrapper は次のホストへの fetch を **常時遮断** する (`kind: json-api` で recipe 経由の任意 URL を許容する都合上、`fetchWithRetry` を通る全 adapter に効かせている):

- **loopback / 内部ネットワーク**: `127.0.0.0/8`、`localhost`、`0.0.0.0/8`、RFC1918 private IP (`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16`)
- **cloud metadata service**: `169.254.0.0/16` (AWS / GCP / Azure metadata の `169.254.169.254` 等を含む link-local 全体)
- **IPv6**: loopback (`::1`)、link-local (`fe80::/10`)、ULA (`fc00::/7`)、IPv4-mapped 形式 (`::ffff:127.0.0.1` 等)
- **非 HTTP scheme**: `file://` / `data:` / `gopher://` / `ftp://` / `javascript:` 等

遮断されると `radar watch run` 等は次の形のエラーで止まる:

```text
refused to fetch private / loopback IPv4 address "192.168.1.10" (http://192.168.1.10/feed.xml). Set RADAR_FETCH_HOST_ALLOWLIST=192.168.1.10 to override (testing only).
```

##### 対処: 意図的に private IP / localhost を叩きたい場合 (testing / 社内 fixture)

`RADAR_FETCH_HOST_ALLOWLIST` にカンマ区切りで host literal を列挙すると、その host だけ blocklist を bypass できる:

```bash
# 例: ローカル開発サーバ (127.0.0.1:8080) で fixture を配信している
export RADAR_FETCH_HOST_ALLOWLIST=127.0.0.1
radar watch run

# 複数 host を列挙
export RADAR_FETCH_HOST_ALLOWLIST=127.0.0.1,192.168.1.5,localhost
```

注意点:

- CIDR / glob は未サポート、exact host literal の match のみ
- IPv6 は `[::1]` でも `::1` でもよい (角括弧は内部で剥がす)
- `RADAR_FETCH_HOST_ALLOWLIST` を恒久的に設定すると SSRF 防御が無効になる host が増えるため、**testing scope 限定** で使うこと。production / 公開 source 運用では未設定が既定
- DNS rebinding (公開 DNS が `127.0.0.1` を返す攻撃) は防げない (URL hostname literal のみ check)

### `radar research <item-id> [--agent <agent-id>] [--template <id>]`

```text
radar research <item-id> [--agent <agent-id>] [--template <id>]                            # single-item
radar research --digest <item-id> <item-id> ... [--agent <agent-id>] [--template <id>]     # digest mode
```

指定 item に対して、指定 agent で調査レポートを生成。`--digest` を付けて 2 件以上の `<item-id>` を渡すと、複数 item を 1 本の digest レポートにまとめる（[ADR-0011](./adr/0011-digest-research-output.md)、詳細は後述「[Digest research](#digest-research)」）。

| 引数 | 説明 |
|---|---|
| `<item-id>` | `items/<sourceId>/*.yaml` の `id` フィールド。形式は `<title-slug>-<8 hex>`（例: `claude-code-releases-agents-438eddad`）。元のフィード GUID は `items/<sourceId>/<item-id>.yaml` の `raw` 内に保持される。`--digest` 時は 2 件以上を空白区切りで指定する |
| `--digest` | 複数 item を 1 つの digest レポートにまとめる（ADR-0011）。2 件以上の `<item-id>` が必須。出力は `research/<YYYYMMDD>_digest_<slug>_v1.md` |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（既定: `claude-code`） |
| `--template` | テンプレ id（既定: 単体 = `default`、digest = `digest`、`templates/<id>.md` を参照） |

挙動:

- `items/<sourceId>/<item-id>.yaml` を読み込み、`agent` adapter に渡す
- adapter は `<agent> -p "<prompt>"` を子プロセスで起動し、`.agents/skills/research/SKILL.md` を実行する
- adapter が `research/<YYYYMMDD>_<slug>_v1.md` を書き出す
- CLI 側で frontmatter を `ResearchFrontmatter` schema で検証する。違反時は exit code 1
- 検証が通れば `items/<sourceId>/<item-id>.yaml` の `status` を `researched` に遷移
- 既存ファイルが既にある場合は上書きせずエラー終了する（再実行は `radar update` 経由）

出力: `research/<YYYYMMDD>_<slug>_v1.md`。命名規則とフォーマットは [ADR-0003](./adr/0003-output-format-and-versioning.md)。`reviewedAt` / `reviewedBy` は **常に `null`** で書き出される（`radar review` で書き換わる）。agent が誤って `reviewedAt` / `reviewedBy` / `supersedes` を populate した場合、CLI は warning を出しつつ frontmatter を `null` に自動補正する（drift 防止）。

4 agent (`claude-code` / `codex-cli` / `gemini-cli` / `copilot`) 全てが利用可能 (#19, #44, #45, #32, #46)。`templates/default.md` が存在しない場合は SKILL に同梱された既定構造でレポートが生成される。

Codex CLI は非対話モード `codex exec "<prompt>" --cd <workspace>` で起動する。`--skip-git-repo-check` と `--dangerously-bypass-approvals-and-sandbox` が必須（unattended 実行のため。Claude Code の `--permission-mode bypassPermissions` 相当）。stdin に JSON で構造化入力を渡し、`outputPath` への書き込みは agent に委ねる（[ADR-0001](./adr/0001-agent-adapter-interface.md)）。Codex CLI が未認証の場合 `codex login` の実行を案内する user-friendly エラーになる。

Gemini CLI は非対話モード `gemini -p "<prompt>" -y --skip-trust` で起動する (`-y` は YOLO mode で承認をスキップ、`--skip-trust` は folder trust チェックを bypass。Claude Code の `--permission-mode bypassPermissions` 相当)。`--skip-trust` は他 3 adapter (`claude-code` / `codex-cli` / `copilot`) と同じ「全権モード起動」の整合性回復であり、新たな権限付与ではない (folder trust は Gemini CLI 側の UI 制約)。stdin に JSON で構造化入力を渡し、`outputPath` への書き込みは agent に委ねる ([ADR-0001](./adr/0001-agent-adapter-interface.md))。Gemini CLI が未認証の場合 `gemini` を対話起動して OAuth するか、`GEMINI_API_KEY` を設定するよう案内する user-friendly エラーになる。

#### Digest research

`--digest` を付けて 2 件以上の `<item-id>` を渡すと、複数 item を 1 本の **digest レポート**にまとめる ([ADR-0011](./adr/0011-digest-research-output.md))。単体 research（1 item につき 1 ファイル）が `research/` に乱立するのを避け、関連 item を横断的に読みたい場面で使う。

```bash
radar research --digest <item-id-1> <item-id-2> <item-id-3>
```

##### いつ使うか (digest)

- **短期間に類似トピックの item が複数ヒットしたとき**: 例えば 1 日に同じプロダクトのリリース・ブログ・SNS 投稿が連続検出された場合、それぞれ単体 research を回すよりも 1 本の digest にまとめたほうがレビュー負荷が下がる
- **関連トピックの item を横断的にまとめたいとき**: 別 source（例: 公式 blog + GitHub Releases + npm registry）に跨る同テーマの item を、横断視点で 1 レポートに集約する。FeedRadar の multi-feed 強みを digest にも継承（ADR-0011 §3 で source 横断 digest を許可）
- **共通テーマ・差分・対立点を可視化したいとき**: digest テンプレート（`templates/digest.md`）は「各 item の要点」「共通テーマ」「差分・対立点」「推奨アクション」の 4 観点で agent に書かせるため、単体 research では拾えない横断的な気づきを得られる

##### 出力ファイル名

```text
research/<YYYYMMDD>_digest_<slug>_v1.md
```

- `<YYYYMMDD>`: digest 生成日（UTC、CLI 起動日）。単体 research と違い、構成 item の `publishedAt` は揃わないため**生成日**を使う
- 固定リテラル `digest`: 単体 research との視覚的識別を容易にする（`ls research/ | grep digest` で digest だけ列挙できる）
- `<slug>`: 含まれる全 item の `matchedKeywords` を頻度集計し、上位 1〜2 個を kebab-case で連結（例: `claude-code-anthropic`）。`matchedKeywords` が空の場合はフォールバックとして `digest` が入る

命名規約・slug 導出アルゴリズム・supersedes チェーン・複数 item の status 遷移の詳細は [ADR-0011](./adr/0011-digest-research-output.md)（特に §1, §2, §4, §5）を参照。

##### 制約

- **2 件以上必須**: `--digest` に 1 件しか渡さないと exit code `2` で拒否（1 件 digest は単体 research と区別がつかないため）
- **`dismissed` item は含められない**: 含まれていると exit code `1` で拒否（ADR-0011 §5）。digest 対象から外すか、対象 item が誤って dismiss されていたなら `items/<sourceId>/<item-id>.yaml` の `status` を手で戻してから再実行する
- **digest v+1 の itemIds は不変**: `radar update` で v+1 を生成する際、含まれる item 集合は v1 と同じ。後から item を追加したい場合は新規 digest を作る（ADR-0011 §4）

##### template のカスタマイズ

digest レポートのテンプレートは `templates/digest.md` で、`radar init` が bundled default を workspace に配布する（[ADR-0007](./adr/0007-skill-bundling-and-init-distribution.md) の bundled skills / templates 配布経路の一部）。**このファイルを手で編集すれば、以後の `radar research --digest` 実行に自動で反映される**（再 init 不要、CLI は実行時に `loadTemplate("digest", templates/)` で読み直す）。

```bash
# digest テンプレートを編集して digest 全体のフォーマットを変える
$EDITOR templates/digest.md

# 次回以降の digest 生成に即反映
radar research --digest <id-1> <id-2>
```

`--template <id>` を明示すれば `templates/<id>.md` を使うこともできる（例: `--template digest-detailed`）。明示しない場合、`--digest` 時は `templates/digest.md`、単体 research 時は `templates/default.md` がそれぞれ default として選択される。

`templates/digest.md` を削除した場合、次回の `radar init` で再配布される（既存ファイル保護仕様のため、編集を残したまま新 default を取り込みたい場合は `--force` を併用する）。digest テンプレートが workspace に無く `--digest` を実行した場合は、SKILL に同梱された内蔵 fallback 構造（要約 / 各 item の要点 / 共通テーマ / 出典）でレポートが生成される。

##### 例

```bash
# 同日にヒットした Claude Code 関連 3 件を 1 digest にまとめる
radar research --digest \
  claude-code-announcement-a1b2c3d4 \
  claude-code-blog-e5f6a7b8 \
  claude-code-release-9c0d1e2f
# → research/20260518_digest_claude-code_v1.md

# source 横断 digest (anthropic-news + hacker-news + github-releases)
radar research --digest \
  anthropic-news-claude-code-agents-438eddad \
  hacker-news-39876543-claude-code-feedback-7a8b9c \
  github-releases-anthropics-claude-code-v0-5-0-cafe1234
# → research/20260518_digest_claude-code-agents_v1.md
```

#### `radar research --batch` (バッチモード)

`--batch` を付けると、`items/` 配下から status 条件にマッチする item を自動的に選別し、`--max-items` のハードキャップ内で順次 research を実行する ([ADR-0014](./adr/0014-workflow-generate-and-auto-research-safety.md) D3a)。GitHub Actions の `combined` workflow から呼ばれる主要モードだが、ローカルでも「未 research の detected を一括処理する」用途で直接呼べる。

```bash
# detected 全件を一括 research (max 10 件まで)
radar research --batch

# 上限を 20 件に変更
radar research --batch --max-items 20

# tag (matchedKeywords) でさらに絞り込む
radar research --batch --filter-tags "security,breaking-change"

# claude-code 以外の agent で
radar research --batch --agent codex-cli
```

##### バッチモードのフラグ

| フラグ | 既定 | 説明 |
|---|---|---|
| `--status <status>` | `detected` | 対象 item の status (`detected` / `researched` / `reviewed` / `dismissed`)。通常は `detected` のまま使う |
| `--max-items N` | `10` | 1 実行で処理する item 数のハードキャップ。N を超える match があると、超過分は **dropped** され warn() に件数が出力される (次回 cron で続きを処理) |
| `--filter-tags <list>` | (なし) | カンマ区切りの allow-list。各 item の `matchedKeywords` と大小無視で照合し、いずれか 1 つでも一致すれば対象。未指定なら全 match item が対象 |
| `--agent <agent-id>` | `claude-code` (config あれば config 値) | バッチ全体で使う agent |

##### 暴走防止 (hard-cap の二重防御)

`--max-items` は CLI と workflow YAML の **2 箇所**で同じ値を強制する設計 (ADR-0014 D3a "二重防御"):

- **YAML literal**: `radar workflow generate combined --max-items 20` で生成した workflow は `radar research --batch --max-items 20` を埋め込む (PR diff / audit で上限が一目で分かる)
- **CLI 側**: workflow YAML を手で書き換えて `--max-items` を消しても、CLI の default (`10`) が二重防御として効く

これにより、ある日 RSS source が `--backfill` 事故 / publisher bug で過去履歴を一気に吐いても、1 cron tick あたり最大 `--max-items` 件で打ち止まる。

##### 順次実行とエラー時の挙動

- match 件数 > `--max-items` の場合、超過分は **dropped** され、warn() に件数が出力される (次回 cron で続きを処理)
- match を `publishedAt` (なければ `fetchedAt`) 昇順でソートしてから先頭 `--max-items` 件を順次処理する (古い順)
- **fail-fast**: 1 件失敗した時点でバッチ全体が halt し、その exit code をそのまま返す (`research: --batch halted on item '<id>' (exit N)` を stderr に出力)。残り未処理 item は次回 cron で再選別される
- 既に同日 `<YYYYMMDD>_<slug>_v1.md` が存在する item は上書きせずエラーで halt する (通常モードと同じ挙動、再 research は `radar update` 経由)
- 各 item の処理成功時に status を `detected → researched` に遷移する

### `radar dismiss <item-id>`

検出 (`detected`) 状態の item を `dismissed`（terminal）に遷移させる。research しないと決めた item を `items/<sourceId>/<item-id>.yaml` から取り除かずに状態だけで除外する用途で使う ([ADR-0008](./adr/0008-status-state-machine.md))。

| 引数 | 説明 |
|---|---|
| `<item-id>` | `items/<sourceId>/*.yaml` の `id` フィールド |

挙動:

- 対象 item を `items/` 配下から探索し、`status` を `detected → dismissed` に更新する
- `status` が `detected` 以外（`researched` / `reviewed` / `dismissed`）の item に対してはエラーで終了する（dismiss は detected からのみ有効。ADR-0008）
- item が見つからない場合は exit code `1` で user-friendly なエラーを返す
- agent を起動しないため、tokens は消費しない

復元 (`undismiss`) や 1 source 全件 dismiss (`--source <id>`) は現状未対応（要望次第で別 issue）。

### `radar review <research-id> [--agent <agent-id>] [--template <id>]`

既存 research に対し、指定 agent でレビューを生成。

| 引数 | 説明 |
|---|---|
| `<research-id>` | `research/<id>.md` の id（拡張子 `.md` は省略可。例: `20260510_anthropic-news-claude-code_v1`） |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（既定: `claude-code`） |
| `--template` | レビュー観点テンプレ id（既定: `default`、`templates/<id>.md` を参照） |

**更新先は 2 箇所**（厳密にはファイル 2 つ、フィールド 3 箇所）:

| 更新先 | 内容 |
|---|---|
| `items/<sourceId>/<item-id>.yaml` | `status: researched → reviewed` |
| `research/<id>.md` frontmatter | `reviewedAt` / `reviewedBy` |
| `research/<id>.md` 本文末尾 | `## レビュー (<agent>, <ISO 8601>)` セクションを追記 |

両者は同一コマンド内でアトミックに更新される（部分失敗時は両方ロールバック）。CLI は agent 起動前にスナップショットを取り、以下のいずれかで失敗するとリストアする:

- adapter が非ゼロ終了 / 例外を投げた
- 書き換え後の frontmatter が `ResearchFrontmatterSchema` に違反
- `reviewedAt` / `reviewedBy` が未スタンプ、または `reviewedBy` が起動 agent と不一致
- immutable フィールド（`id` / `itemIds` / `agent` / `templateId` / `createdAt`）が改変された
- `items/*.yaml` の書き込みが失敗

rollback 自体が失敗した場合（同じファイルシステム障害が継続している等）は「workspace may be in an inconsistent state」を出力して exit 1 する。ユーザーは `git status` / `git diff` で復旧する。

詳細は [ADR-0003](./adr/0003-output-format-and-versioning.md) / [ADR-0008](./adr/0008-status-state-machine.md) / [`docs/design/skill-design.md` §7](./design/skill-design.md)。

#### 再レビュー (re-review)

同一 research 版に対する再レビューは拒否する（`reviewedAt != null` を CLI が検知）。レビューが古くなった場合は `radar update` で `_v2.md` を作成してから review し直す。

4 agent (`claude-code` / `codex-cli` / `gemini-cli` / `copilot`) 全てが review に対応する。

#### クロスエージェント運用（推奨）

research を書いた agent と**別の agent** で review を実行することを推奨する:

```bash
# 例: copilot で書いて claude にレビューさせる
radar research <item-id> --agent copilot
radar review <research-id> --agent claude-code
```

なぜクロスチェック:

- 同一 agent の盲点（特定の情報源への偏り、用語の取りこぼし）を相互補正できる
- review が research と同じ思い込みを引きずらない
- 4 種類の agent プランを契約しているなら、利用枠を分散できる

CLI 側で agent の組合せを強制はしない（ユーザー判断）。`radar.config.yaml` で default agent を指定すれば、`--agent` を毎回付けずに済む（[後述](#radarconfigyaml)）。

### `radar update <research-id> [--agent <agent-id>] [--template <id>]`

既存 research を最新情報で再生成。新バージョン (`_v2.md`, `_v3.md`, …) を作成し、旧バージョンは保持（immutable history、[ADR-0003](./adr/0003-output-format-and-versioning.md)）。

| 引数 | 説明 |
|---|---|
| `<research-id>` | `research/<id>.md` の id（拡張子 `.md` は省略可。例: `20260510_anthropic-news-claude-code_v1`） |
| `--agent` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot`（既定: `claude-code`、`radar.config.yaml` の `defaultResearchAgent` を fallback として使う） |
| `--template` | テンプレ id（既定: `default`、`templates/<id>.md` を参照） |

挙動:

- 前版 (`<base>_v<N>.md`) を読み込み、その frontmatter / 本文を adapter に渡す
- adapter は `<agent> -p "<prompt>"` を子プロセスで起動し、`.agents/skills/update/SKILL.md` を実行する
- adapter が新ファイル `research/<base>_v<N+1>.md` を書き出す（rewrite-and-supersede 戦略、[`docs/design/skill-design.md` §8.2](./design/skill-design.md)）
- CLI 側で v+1 frontmatter を `ResearchFrontmatter` schema で検証し、v+1 invariants を assert する:
  - `itemIds` / `templateId` / `createdAt` が前版と一致
  - `supersedes` が前版 id と一致
  - `reviewedAt` / `reviewedBy` が `null`
- 違反が検出された場合は警告ログを出して frontmatter を自動修正する（agent の drift から保護）
- 旧版 (`_v<N>.md`) は**書き換えない**（immutable history）
- `items/<sourceId>/<itemId>.yaml` の `status` は**変更しない**（[ADR-0008](./adr/0008-status-state-machine.md) / [`docs/design/skill-design.md` §8.4](./design/skill-design.md)）。`reviewed` だった item は `reviewed` のまま、`researched` だった item は `researched` のまま
- `detected` / `dismissed` の item に対する update は拒否する（v1 research がないため supersede 対象がない）

出力: `research/<base>_v<N+1>.md`。命名規則とフォーマットは [ADR-0003](./adr/0003-output-format-and-versioning.md)。

例:

```bash
# v1 を元に v2 を生成（v1 と同じ claude-code で）
radar update 20260510_anthropic-news-claude-code_v1 --agent claude-code

# v2 を生成しつつ agent を切り替え（v1 は claude-code、v2 は codex-cli）
radar update 20260510_anthropic-news-claude-code_v1 --agent codex-cli

# v2 を更に更新 (v3 を生成)
radar update 20260510_anthropic-news-claude-code_v2 --agent claude-code
```

#### v+1 で `reviewedAt` / `reviewedBy` をリセットする理由

v1 に対して `review` を実行した内容は v2 には引き継がない（v2 は v1 と内容が変わっているため、v1 のレビュー結論をそのまま使えない）。v+1 の内容を改めてレビューしたい場合は、`radar review <new-id> --agent <id>` を v+1 に対して実行する（[`docs/design/skill-design.md` §8.6](./design/skill-design.md)）。

#### items.yaml の status が動かないことの含意

「`reviewed` の item の最新 research が v2 で、まだ review されていない」状態が出現することがある。`items.yaml` の `status` 単独では「最新 research が review 済みか」を判定できないので、必要に応じて `research/*.md` 側の `reviewedAt` を確認すること。これは ADR-0003 / ADR-0008 の意図的な設計（item lifecycle と research version を直交させる）であり、自動 promote はしない。

#### update の対象が無い場合 (no-op suppression)

agent が最新情報を取得しても material な変更が無いと判断した場合は、v+1 ファイルを作らずスキップする（[`docs/design/skill-design.md` §8.5](./design/skill-design.md)）。空 diff の v+1 を作らない設計のため、再実行で v3, v4 が無限に増えることはない。

### `radar doctor`

ワークスペース / 依存ツールの health check を実行する。`html-js` source を使う前の事前確認、`watch run` / `research` が想定どおり動かないときの切り分け、企業プロキシ環境での疎通確認に使う。

実行内容（[#114](https://github.com/ozzy-labs/feedradar/issues/114) / [#163](https://github.com/ozzy-labs/feedradar/issues/163)）:

1. workspace ディレクトリ (`sources/` `items/` `state/` `research/` `templates/`) の存在確認
2. `radar.config.yaml` / `sources/*.yaml` の妥当性確認（schema 違反を列挙）
3. agent CLI (`claude` / `codex` / `gemini` / `copilot`) の install 確認 (`which` 相当)
4. **`html-js` source が登録されている場合のみ**:
   - `import("playwright")` を試行 → 失敗なら `npm i -g playwright` を案内
   - Chromium binary の存在確認 (`playwright` の `chromium.executablePath()`) → 失敗なら `npx playwright install chromium` を案内
5. プロキシ環境変数 (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`) の検出。`http://user:pass@host:port` 形式の URL は **`http://***:***@host:port` にマスクされて出力される**（認証情報がスクロールバック / CI ログに漏れない）
6. `NODE_USE_ENV_PROXY` の有効化状態（radar の self-respawn 経由で `--use-env-proxy` が有効化されているか）
7. `NODE_EXTRA_CA_CERTS` の設定状態（TLS-intercepting proxy 環境で必須）
8. **proxy が検出された場合のみ** `api.github.com` への HTTPS round-trip を実行し、`200 OK` / `407 Proxy Authentication Required` / TLS エラー / `ECONNREFUSED` / DNS エラー / タイムアウトを分類して表示。TLS エラー (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` 等) を検知した場合は `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem` を案内する

オプション:

| フラグ | 用途 |
|---|---|
| `--no-proxy-check` | live healthcheck をスキップ（オフライン環境 / CI のネットワーク隔離ジョブ向け）。proxy:env / proxy:active / tls:ca の静的チェックは引き続き実行される |

出力フォーマットは各チェックを `ok` / `warn` / `error` の 3 段階で列挙し、最後に集計サマリ。warn は exit code に影響しない、error が 1 件でもあれば exit code `1`。proxy healthcheck の失敗は **`error` だが、proxy が検出されていない・`--no-proxy-check` 指定時はスキップ扱い**（`ok`）で exit code には影響しない。

CI で自動 install したい場合は環境変数 `RADAR_AUTO_INSTALL_CHROMIUM=1` を `radar watch run` 側でセットすると Chromium 不在時に `npx playwright install chromium` を spawn する（`radar doctor` 自体は read-only で install を行わない）。Playwright npm package 自体の install (`npm i -g playwright`) は radar が代行しない（global npm install の権限問題を避けるため、ユーザー側で実行を強制する設計）。

## 進捗表示 / verbose / quiet

長時間実行コマンド (`radar research` / `review` / `update` / `radar research --batch` / `radar watch run --backfill` / `kind: html-js` の fetch / `radar source test`) は、進捗を **phase markers + spinner + 副次メトリクス** の 3 層で stderr に出力する（[ADR-0015](./adr/0015-progress-reporting-ux.md)）。stdout には CLI の本来の出力（`research:` の完了 1 行、`watch run:` のサマリ等）のみが流れるため、`radar research > out.md` のような pipe は従来どおり機能する。

### default の挙動

- **TTY（対話 terminal）**: phase markers を 1 行ずつ stderr に出力しつつ、同一行で spinner と elapsed time `[mm:ss]` を上書き表示する。`stdout: 4.2 KB` / `output: 1.2 KB` / `page: 3/80` のような副次メトリクスが spinner 行に併記される
- **non-TTY（CI / pipe / リダイレクト）**: spinner / `\r` 上書きを無効化し、phase markers を **1 行ずつ plain text** で出力する。各 phase が独立行として残るため `tee log.txt` / GitHub Actions の log でも narrative が読める
- **`radar watch run` のヒューリスティック**: source 数 3 件以上、または `kind: html-js` / `kind: json-api + --backfill` を 1 件でも含む場合のみ per-source の progress を出す。小規模 workspace（RSS 1-2 件、~3 秒で終わる）では spinner が flash するだけで価値が無いため、暗黙に抑制する（後述 [`shouldEnableProgress` ヒューリスティック](#shouldenableprogress-ヒューリスティック)）

### `--verbose` / `--quiet` / `RADAR_NO_PROGRESS=1` の優先順

| 条件 | 挙動 |
|---|---|
| `RADAR_NO_PROGRESS=1`（env） | spinner / phase markers / `raw()` をすべて無効化（no-op reporter）。CI / 静かにしたい script 向けの強制 escape hatch |
| `--quiet`（flag） | reporter を no-op 化。`io.log("research: wrote …")` 等の従来の完了 1 行だけが残る |
| `--verbose`（flag） | phase markers + spinner（TTY 時のみ）+ **agent CLI の stdout / stderr pass-through**。tool call のログ等を直接見られる |
| 既定（flag なし） | TTY 検出に応じて phase markers + spinner（TTY）または plain text phase markers（non-TTY） |

優先順は **env > flag > TTY auto-detect**。`RADAR_NO_PROGRESS=1` は `--verbose` を併用しても勝つ（CI で flag を消さずに reporter だけ off にしたいケースに対応）。`--verbose` と `--quiet` の同時指定は `--verbose and --quiet are mutually exclusive` で exit code 2。

```bash
# 既定（TTY で spinner + phase markers）
radar research <item-id>

# agent stdout を見たい（デバッグ / bug report 用）
radar research <item-id> --verbose

# CI script で reporter を完全に黙らせる
RADAR_NO_PROGRESS=1 radar watch run

# pipe で stdout だけ使い、stderr は捨てる
radar research <item-id> 2>/dev/null | tee report.md
```

`--verbose` / `--quiet` は以下のコマンドで利用可能（[#197](https://github.com/ozzy-labs/feedradar/pull/197) / [#198](https://github.com/ozzy-labs/feedradar/pull/198)）:

| コマンド | `--verbose` | `--quiet` | 備考 |
|---|---|---|---|
| `radar research <item-id>` | ✅ | ✅ | agent stdout pass-through |
| `radar review <research-id>` | ✅ | ✅ | 同上 |
| `radar update <research-id>` | ✅ | ✅ | 同上 |
| `radar research --batch` | ✅ | ✅ | バッチ内の各 item で適用される |
| `radar watch run` | ✅ (`-v`) | ✅ (`-q`) | source 単位の phase markers + html-js / json-api の sub-phases |
| `radar source test <id>` | ✅ (`-v`) | ✅ (`-q`) | 1 source 1 fetch なのでヒューリスティックを介さず常に有効 |

### Phase markers の意味

phase markers は ADR-0015 D4 の命名規約に従い、動詞・形が統一されている。代表的なものと典型時間:

| Phase | 意味 | 典型時間 |
|---|---|---|
| `Loaded item <id>` / `Loaded template <id>` | 入力 YAML / template を読み終えた | <100ms |
| `Spawning <agent> (cwd: <path>)` | 子プロセス spawn 直前 | <50ms（spawn 自体は次行） |
| `Agent process started (PID <N>)` | spawn 直後、stdin を流す前 | <100ms |
| `Agent running… [mm:ss]` | heartbeat tick（TTY のみ同一行更新）。`stdout: 4.2 KB` `output: 1.2 KB` が併記 | 数十秒〜数分 |
| `Agent completed (<duration>, exit <code>)` | 子プロセス終了 | ― |
| `Frontmatter validated` | `ResearchFrontmatterSchema` 検証通過 | <50ms |
| `Status: detected → researched` | items.yaml の status 遷移 | <50ms |
| `[<source-id>] Fetching… (kind: <kind>)` | watch run の per-source 開始 | ― |
| `[<source-id>] Page <i>/<n>: <m> items fetched` | json-api pagination 進行（[#198](https://github.com/ozzy-labs/feedradar/pull/198)） | 数百ms / page |
| `Launching Chromium…` / `Navigating to <url>…` / `Waiting for selector "<sel>" (timeout: <N>ms)…` / `Capturing page content…` / `Closing browser…` | html-js Playwright lifecycle | 数秒〜数十秒 |
| `Still waiting for "<sel>"… [mm:ss]` | `waitForSelector` が 10 秒以上かかったときの定期 reminder（既定の `js.timeout` 30 秒の ~33%） | timeout まで継続 |
| `[<source-id>] Completed: <n> total, <m> new (<duration>)` | watch run の per-source 完了 | ― |

phase markers は **副作用を伴わない**（exit code / control flow に影響しない）。debug 用の追加情報は phase markers の後ろに括弧書きで添えられる。

### メトリクスの読み方

spinner 行に表示される副次メトリクス:

| キー | 単位 | 出所 | 目的 |
|---|---|---|---|
| `stdout` | バイト（`4.2 KB` 等） | agent CLI が stderr に書いた累積量 | agent が黙っていないか／token を消費しているかの代理指標 |
| `output` | バイト | `research/<id>.md` 等の出力ファイルを `fs.stat` 500ms 間隔で polling した最新サイズ | レポート本体の生成進捗。完了直前にどっと増えるパターンが多い |
| `page` | `i/N` | json-api pagination の現在ページ | `--backfill` 進捗 |
| `items` | 整数 | 直近 page で取れた item 数 | filter 通過前の生 fetch カウント |

非 TTY 環境では spinner 行が無いため、これらは phase marker の括弧書き（`Page 3/80: 100 items fetched`）として 1 行ずつ出力される。

### `shouldEnableProgress` ヒューリスティック

`radar watch run` は次のいずれかを満たす場合のみ per-source の progress を出す（[`src/core/watcher.ts`](https://github.com/ozzy-labs/feedradar/blob/main/src/core/watcher.ts) の `shouldEnableProgress`）:

1. source 数が 3 件以上
2. `kind: html-js` source を 1 件でも含む
3. `kind: json-api` source を含み、かつ `--backfill` 指定

このヒューリスティックは **user-configurable ではない**（ADR-0015 D5）。「1 RSS source で spinner が flash するだけ」のケースを避けるための設計判断。これでも spinner を消したい場合は `--quiet` / `RADAR_NO_PROGRESS=1`、逆に「常に progress を見たい」なら現状の解は無く、future issue で扱う。

`radar source test` は 1 source 1 fetch という性質上、ヒューリスティックを介さず常に reporter を有効化する（recipe を tune する場面では phase markers が主目的のため）。

### トラブルシュート: フリーズに見える時の対処

長時間実行で「進んでいるのか止まっているのか」分からなくなったときの判定手順:

| 症状 | 想定される原因 | 対処 |
|---|---|---|
| `Agent running… [mm:ss]` から `stdout` / `output` のメトリクスが伸びない | agent が思考中（tool call の前後で何分も無音になる場合あり）／API rate limit 待ち／ネットワーク待ち | まず `--verbose` で再実行して stdout を直接見る。tool call の trace が出ていれば進行中。30 秒以上完全沈黙なら Ctrl+C で中断して `radar doctor` で agent CLI / 認証を確認 |
| `Still waiting for "<selector>"… [mm:ss]` が連続して出続ける | `kind: html-js` の `js.waitFor` セレクタが JS 実行後の DOM に出現しない | 別 terminal で `radar source test <id> --show-content` を実行し、実際の DOM に当該 selector が存在するかを確認。出ないなら selector を組み直す。`js.timeout` 経過後（既定 30 秒）に hard error で止まる |
| `Launching Chromium…` から進まない | Chromium 起動 / shared library 不在（Linux で `libnss3` 等） | `radar doctor` で Playwright / Chromium の検出状況を確認。CI なら `npx playwright install --with-deps chromium` で OS 依存も入れる |
| `[<source-id>] Page <i>/<n>` が伸びない | json-api endpoint が遅い／pagination 終端が見えない API | `--max-pages N` で上限を下げて完了させ、recipe の `pagination.totalPath` / `maxPages` を見直す |
| spinner が表示されない | TTY 判定が false（WSL / Docker exec / MINGW64 の境界ケース）／`RADAR_NO_PROGRESS=1` が設定済み | `env \| grep RADAR_NO_PROGRESS` を確認。non-TTY 検出なら phase markers は 1 行ずつ出力されているはずなので `2>&1 \| less` で stderr を確認 |
| 文字化け（spinner frame `⠋⠙⠹` が `???` 等になる） | terminal の locale が UTF-8 でない／日本語 IME 経路で文字幅が崩れる | `LANG=C.UTF-8` / `LANG=ja_JP.UTF-8` を設定。それでも崩れるなら `--quiet` で spinner を回避 |

#### Phase 3 機能（未実装）

[ADR-0015 D5](./adr/0015-progress-reporting-ux.md) の Phase 3 として下記が予定されているが、現状は未実装（[#199](https://github.com/ozzy-labs/feedradar/issues/199) で追跡）:

- **hung 検出**: 60 秒以上 agent stdout が無いと warning を出す
- **SIGINT 段階的終了**: Ctrl+C 時に SIGTERM を送り 3 秒後 SIGKILL する 2 段階 graceful shutdown（現状は Node default の `setTimeout` ベース、子プロセスが即時に死なないことがある）
- **token / cost meter**: agent CLI が token usage を出すようになったら spinner 行に追加

Phase 1 / 2（本セクションが扱う範囲）は実装済み。Phase 3 が必要になったら #199 を参照。

## radar.config.yaml

ワークスペースルート（`sources/` と同じ階層）に `radar.config.yaml` を置くと、`research` / `review` コマンドの `--agent` 省略時に使う default agent を指定できる。設定ファイルは任意で、無ければハードコードされた `claude-code` がそのまま fallback として使われる。

例:

```yaml
# radar.config.yaml
defaultResearchAgent: codex-cli
defaultReviewAgent: claude-code
```

### 設定可能フィールド

| フィールド | 対応コマンド | 値 |
|---|---|---|
| `defaultResearchAgent` | `radar research` | `claude-code` / `codex-cli` / `gemini-cli` / `copilot` |
| `defaultReviewAgent` | `radar review` | 同上 |

両フィールドとも optional。未指定のフィールドはハードコード default にフォールバックする。

### Agent 解決の優先順位

`research` / `review` コマンドが起動時に使う agent は、以下の優先順位で決定する:

1. 明示 `--agent <id>` （CLI 引数）
2. `radar.config.yaml` の対応フィールド（`defaultResearchAgent` / `defaultReviewAgent`）
3. ハードコード default: `claude-code`

たとえば `defaultResearchAgent: codex-cli` を設定したワークスペースで:

```bash
radar research <item-id>                      # codex-cli が使われる (config)
radar research <item-id> --agent gemini-cli   # gemini-cli が使われる (明示優先)
```

### エラー時の挙動

`radar.config.yaml` が schema 違反（未知の agent id、不正な YAML 構文など）の場合、`research` / `review` は exit code `2` で終了し、違反箇所を stderr に出力する。typo を黙ってフォールバックで隠さないための仕様。

### スコープ外

- `update` コマンド専用の default agent: 現状 `update` は `defaultResearchAgent` を借用する（前版を書いた agent と同じ系統で v+1 を生成するため）。dedicated `defaultUpdateAgent` フィールドは将来別 issue で追加
- agent 固有の設定（timeout / API key / モデル指定など）: 必要が出てから別 issue で追加

## スケジュール実行

`radar` 本体は scheduler を内蔵しない（[ADR-0004](./adr/0004-schedule-strategy.md) / [ADR-0014](./adr/0014-workflow-generate-and-auto-research-safety.md)）。`init` の opt-in フラグでクラウド scheduler 向けの**接続用雛形**を生成する。後追いで workflow を追加・複数共存させたい場合は `radar workflow generate` を使う（後述「[`radar workflow generate`](#radar-workflow-generate)」）。

| フラグ / コマンド | 生成先 | 用途 |
|---|---|---|
| `radar init --with-routines` | `claude/routines/watch-daily.md` | Claude Routines (Anthropic 管理クラウド VM) |
| `radar init --with-actions` | `.github/workflows/watch.yaml` | GitHub Actions (cron + workflow_dispatch、初回 init 時の bootstrap 用) |
| `radar workflow generate watch` | `.github/workflows/feedradar-watch.yaml` (既定) | GitHub Actions watch 雛形を **後追い生成**（複数 cadence / agent 切替対応、ADR-0014） |
| `radar workflow generate combined` | `.github/workflows/feedradar-combined.yaml` (既定) | watch → 自動 research の連鎖（ハードキャップ + rebase リトライ内蔵、ADR-0014） |

既存ファイル保護 + `--force` 上書きは bundled skills と同じ挙動。

> **後追い生成**: `init --with-actions` は初回 workspace setup 用の "1 度だけ" 生成、`workflow generate` は **複数 workflow を共存させたい / 後から追加したい** ユースケース向け。詳細は「[`radar workflow generate`](#radar-workflow-generate)」を参照。

### `radar workflow generate`

`init --with-actions` が生成する workflow は 1 種類 (`watch.yaml`) かつ初期化時にしか作れない。後から `watch` を別 cadence で追加したい / `combined` (watch + 自動 research) を追加したい / agent を切り替えたい場合は **`radar workflow generate <type>`** を使う ([ADR-0014](./adr/0014-workflow-generate-and-auto-research-safety.md))。

```text
radar workflow generate <type> [options]
```

#### サポートされる workflow タイプ

| `<type>` | 用途 | 主要 step | 実装状況 |
|---|---|---|---|
| `watch` | `radar watch run` のみを定期実行 | `radar watch run` | **実装済み (#188)** |
| `combined` | watch → 自動 research → commit の連鎖 (ハードキャップ付き) | `watch run` → `research --batch --max-items N` | **実装済み (#189)** |
| `research` | `detected` item を batch research する単独 workflow | `radar research --batch ...` | Phase 2 (#191) |
| `review` | researched item を別 agent でレビュー | `radar review <ids...>` | Phase 2 (#191) |

`research` / `review` 単独タイプは現状未実装で、Phase 2 (sub-issue [#191](https://github.com/ozzy-labs/feedradar/issues/191)) で追加される。当面は `combined` で watch + 自動 research を 1 workflow にまとめる構成を推奨する (検出 → research 連鎖の遅延が無い、ADR-0014 §X5)。

#### タイプ別 設定 YAML 完全例

##### `radar workflow generate watch`

```bash
# 既定値で生成 (cron: 0 0 * * *, agent: claude-code)
radar workflow generate watch

# 1 時間ごと + 別ファイル名で生成
radar workflow generate watch \
  --cron "0 * * * *" \
  --output .github/workflows/watch-hourly.yaml \
  --agent claude-code

# Codex CLI で生成
radar workflow generate watch --agent codex-cli
```

生成される `.github/workflows/feedradar-watch.yaml` の主要箇所:

```yaml
name: feedradar-watch

on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: feedradar-watch-${{ github.ref }}
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with: { node-version: "22.21" }
      - run: npm install -g @ozzylabs/feedradar
      - name: Run watch
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: radar watch run
      - name: Commit and push with retry
        run: |
          # ... git add items/ state/, commit, push with 3-attempt rebase retry
```

ポイント:

- `concurrency.group: feedradar-watch-...` は **watch 専用 group**。`combined` と同じ branch にあっても互いに cancel しない (ADR-0014 D4)
- `Commit and push with retry` step は `git push` が `non-fast-forward` で失敗したら `git pull --rebase --autostash` を最大 3 回試行する (`combined` と同時刻に発火しても自動回復)

##### `radar workflow generate combined`

```bash
# 既定値で生成 (cron: 0 0 * * *, max-items: 10, agent: claude-code)
radar workflow generate combined

# 週次 cadence + 自動 research 上限 20 + tag 絞り込み
radar workflow generate combined \
  --watch-cron "0 0 * * 1" \
  --max-items 20 \
  --filter-tags "security,breaking-change" \
  --output .github/workflows/combined-weekly.yaml

# Gemini CLI 版
radar workflow generate combined --agent gemini-cli
```

生成される `.github/workflows/feedradar-combined.yaml` の主要箇所:

```yaml
name: feedradar-combined

on:
  schedule:
    - cron: "0 0 * * 1"
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: feedradar-combined-${{ github.ref }}
  cancel-in-progress: false

jobs:
  combined:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: "22.21" }
      - run: npm install -g @ozzylabs/feedradar

      - name: Run watch
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: radar watch run

      - name: Skip research when no new items
        id: detect_changes
        run: |
          if [ -z "$(git status --porcelain items/)" ]; then
            echo "has_changes=false" >> "$GITHUB_OUTPUT"
          else
            echo "has_changes=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Run research on detected items (capped at 20, agent=claude-code)
        if: steps.detect_changes.outputs.has_changes == 'true'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        # ハードキャップ 20 + tag filter が YAML literal として焼き込まれる
        run: radar research --batch --status detected --max-items 20 --filter-tags security,breaking-change --agent claude-code

      - name: Commit and push with retry
        if: steps.detect_changes.outputs.has_changes == 'true'
        run: |
          # ... git add items/ state/ research/, commit, push with 3-attempt rebase retry
```

ポイント:

- **`--max-items` ハードキャップが YAML literal として焼き込まれる** (ADR-0014 D3a)。`radar research --batch --max-items 20` が直接 step の `run:` に書かれるため、workflow を読めば上限が即わかる
- **二重防御**: YAML を手で書き換えて `--max-items` を消しても、CLI の default (`10`) が効く
- 「Skip research when no new items」ガード step が `items/` に変更が無いときの research step 全体をスキップする (`watch run` が空だった日に LLM cost を 0 に抑える)

#### `--max-items` / `--filter-tags` の自動 research セーフティ

`combined` workflow の最大の懸念は **自動 research の暴走** (ADR-0014 §Context):

- ある日 RSS source が **過去履歴を一気に吐く** (publisher 側 bug / `--backfill` の事故起動)
- 検出 item 数が想定の 10 → 数百〜数千件に膨らむ
- 自動 research が全件に走り、**LLM cost が爆発** / agent CLI の rate limit / billing alert を一気に踏み抜く

これを防ぐため `combined` は以下 2 段の防御を持つ:

1. **`--max-items N` ハードキャップ** (既定 `10`): 1 cron tick で処理する item 数の上限。N を超える match は **dropped** (warn() に件数を出力、次回 cron で続きを処理)
2. **`--filter-tags <list>` allow-list**: `matchedKeywords` (item の filter ヒット結果) を allow-list で絞る。例: `--filter-tags security,breaking-change` なら security / breaking-change tag が付いた item だけ research

両方とも **workflow YAML に literal として焼き込まれる** ため、PR diff レビューで「`--max-items 1000` のような暴走設定が混入していないか」を audit できる。

##### `--max-items` の既定値が `10` の根拠

- 通常運用での 1 cron tick の検出件数は経験的に 1〜5 件
- その 2〜10 倍の余裕を見つつ、暴走時のコスト爆発を「LLM 1 call ~0.01 USD × 10 = 0.1 USD」程度に押さえる水準

「もっと多く処理したい」場合は明示的に `radar workflow generate combined --max-items 100` 等で生成しなおす。後から workflow YAML を手編集することも可能だが、CLI 再生成のほうが意図が記録される。

#### agent 別 secrets 設定例

`--agent` で 4 種類の agent から選べる ([ADR-0014](./adr/0014-workflow-generate-and-auto-research-safety.md) D5)。**OAuth トークンは禁止**: すべて API key 認証 (Anthropic 利用ポリシー上、unattended workflow で OAuth は "ordinary individual use" の範囲外)。

| `--agent` | 必要な secret (`Settings → Secrets and variables → Actions`) | OAuth |
|---|---|---|
| `claude-code` (default) | `ANTHROPIC_API_KEY` | **禁止** (`CLAUDE_CODE_OAUTH_TOKEN` を使わない) |
| `codex-cli` | `OPENAI_API_KEY` | **禁止** |
| `gemini-cli` | `GEMINI_API_KEY` | **禁止** |
| `copilot` | (`secrets.GITHUB_TOKEN` を自動利用、ユーザー登録不要) | n/a (個人 OAuth ではない) |

すべての agent で `GITHUB_TOKEN` は `secrets.GITHUB_TOKEN` (Actions が自動付与) を forward する。これは `github-releases` adapter の rate limit を 60 → 5000 req/h に引き上げるため (ADR-0002 / Phase 3)。

##### agent 切替の実例

```bash
# 各 agent ごとに workflow を生成
radar workflow generate combined --agent claude-code   # ANTHROPIC_API_KEY が必要
radar workflow generate combined --agent codex-cli     # OPENAI_API_KEY が必要
radar workflow generate combined --agent gemini-cli    # GEMINI_API_KEY が必要
radar workflow generate combined --agent copilot       # secret 登録不要
```

`radar workflow generate <type>` 実行時、必要な secret 名は CLI の stdout に明示される (Settings → Secrets で何を登録すればよいか迷わない設計):

```text
workflow generate combined: wrote .github/workflows/feedradar-combined.yaml
  agent:       gemini-cli
  cron:        0 0 * * *
  max-items:   10
  filter-tags: (none)

Required GitHub Actions secrets (Settings → Secrets and variables → Actions):
  GEMINI_API_KEY
  GITHUB_TOKEN (auto-provisioned)
```

#### push 競合とリトライ機構

`watch` / `combined` を **同一 branch で複数 workflow 並走** させると、片方が `items/` / `state/` を push した直後にもう一方が push しようとして `non-fast-forward` エラーで失敗するケースが構造的に発生する (例: `0 * * * *` の watch と `0 */6 * * *` の combined は 6 時間ごとに 1 回必ず衝突する)。

ADR-0014 D4 で採用した対策: **生成された workflow の `Commit and push with retry` step に `git pull --rebase --autostash` リトライを最大 3 回内蔵する**。

```yaml
- name: Commit and push with retry
  run: |
    set -euo pipefail
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add items/ state/
    git diff --cached --quiet && exit 0
    git commit -m "chore(watch): detected items $(date -u +%Y-%m-%d)"
    for attempt in 1 2 3; do
      if git push origin "${GITHUB_REF_NAME}"; then
        exit 0
      fi
      echo "push failed (attempt ${attempt}/3), rebasing..."
      git pull --rebase --autostash origin "${GITHUB_REF_NAME}"
    done
    echo "push failed after 3 attempts" >&2
    exit 1
```

ポイント:

- `concurrency.group` を **type ごとに分ける** (`feedradar-watch-...` / `feedradar-combined-...`) ことで、watch と combined は同時に走れる (互いに cancel しない)。同 type 内の overlapping のみ `concurrency` で serialize
- `git pull --rebase --autostash`: `--autostash` で bot 側の uncommitted 変更が rebase の邪魔をしないようにする
- **3 回上限**: GitHub Actions の rate limit / cron スロット競合の経験的な収束回数。4 回以降の失敗は workflow 外の問題 (branch protection / token 失効 / true merge conflict) なので、retry より fail-fast (`exit 1`) のほうが debuggability が高い

#### コスト試算とコスト警告

`combined` workflow は **自動的に LLM API を叩く** ため、cost monitoring が運用上の必須事項になる。目安:

| 構成 | 1 cron tick あたりの LLM call 数 | 試算 cost (USD) | 月次 cost (24 cron tick/日 × 30 日 = 720 tick) |
|---|---|---|---|
| `combined --max-items 10` (default) | 最大 10 | ~$0.10 (1 call ≒ $0.01 想定) | ~$72 |
| `combined --max-items 50` | 最大 50 | ~$0.50 | ~$360 |
| `combined --max-items 100` | 最大 100 | ~$1.00 | ~$720 |
| watch のみ (`watch` type) | 0 (research を呼ばない) | $0 | $0 |

> **試算は LLM call 1 回あたり ~$0.01 (Claude 3.5 Sonnet で 1 件の research レポート生成想定)** という大雑把な目安。実際の cost は agent / 入力サイズ / 出力長で大きく変動する。**自分の最初の 1 週間は billing dashboard を毎日確認する** ことを推奨。

##### 暴走時の止め方

cost が想定外に増えていることに気付いた場合の止め方:

1. **即時停止 (推奨)**: GitHub UI → リポジトリ → `Actions` タブ → 該当 workflow を選択 → 右上の `...` メニューから **`Disable workflow`** を選ぶ。次回 cron 起動が即座に停止する (UI 上で 1 click)
2. **branch から削除**: `git rm .github/workflows/feedradar-combined.yaml && git commit -m 'chore: stop combined workflow' && git push`。確実に消えるが PR / commit が必要
3. **secret を失効させる (最終手段)**: `ANTHROPIC_API_KEY` 等の secret を Settings → Secrets から削除する。次回 cron 起動時に agent CLI が認証エラーで失敗するため、副作用として cron 自体は走り続ける (が cost は発生しない)。**他 workflow も同じ secret を使っているなら影響範囲に注意**

##### cost 暴走を予防する設計

`combined` 採用時のチェックリスト:

- [ ] `--max-items` を最小限に設定 (まずは default `10` で運用、必要なら段階的に増やす)
- [ ] `--filter-tags` を併用して research 対象を絞る (全 detected を一括 research しない)
- [ ] agent provider の billing alert を設定 (Anthropic / OpenAI / Google それぞれの billing dashboard で月次予算上限を設定)
- [ ] 最初の 1 週間は毎日 billing dashboard を確認
- [ ] 新規 source 追加時は `radar source test <id>` で検出件数を確認してから `watch run` を回す (`--backfill` の事故起動を防ぐ)

#### workflow generate のトラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `Error: cron expression invalid` (workflow generate 時) | `--cron` / `--watch-cron` の値が 5 field POSIX cron でない。例: `"0 0 * * *"` (毎日 0 時 UTC)。`@daily` 等の alias は GitHub Actions が受け付けないため、CLI 側でも拒否 |
| `output file already exists: ... (use --force to overwrite)` | 同名 file が既存。意図的な再生成なら `--force` を付ける。複数 cadence を共存させたいなら `--output .github/workflows/<type>-<cadence>.yaml` で別名で生成 |
| `Process completed with exit code 128.` + `non-fast-forward` (Actions ログ) | 同時刻に複数 workflow が `items/` / `state/` を push し合った。内蔵の 3 回 rebase retry が走るが、4 回以上失敗する場合は branch protection / token 失効 / true merge conflict を確認 |
| `research: --max-items 10 cap reached; dropping N excess item(s)` warning が毎回出る | 検出件数が `--max-items` 上限を超えている。`--filter-tags` で絞る or `--max-items` を増やす or `--backfill` の事故起動を疑う |
| `Error: ANTHROPIC_API_KEY is not set` (Actions ログ) | Settings → Secrets → Actions で agent 別 secret を登録していない (`--agent <name>` に応じた secret 名は ADR-0014 D5 / 本セクションの「agent 別 secrets 設定例」を参照) |
| billing dashboard で LLM cost が想定の 10 倍 | `--max-items` を意図せず高く設定した / `--filter-tags` 無しで全件 research している / `combined` workflow を複数 branch で並走させている。「[暴走時の止め方](#暴走時の止め方)」を参照して即座に disable する |
| `permission denied to push` (Actions ログ) | `permissions: contents: write` が org / repo 設定で抑制されている。リポジトリ Settings → Actions → General → `Workflow permissions` を `Read and write permissions` にする |
| `Run`radar`not found` (Actions ログ) | `npm install -g @ozzylabs/feedradar` step が失敗している (npm registry 到達性 / 一時的な outage)。re-run か、`npm install -g @ozzylabs/feedradar@<specific-version>` で version pin する |
| 生成された workflow を手で編集後、`--force` で再生成して編集が消えた | warning + skip の既定挙動で守られていたが `--force` を明示するとその保護が外れる。手編集する場合は `--force` を使わない or 編集内容を git で復元 |
| `combined` で `--max-items` を YAML から削除しても暴走しない | CLI 側の二重防御 (default `10`) が効く設計 (ADR-0014 D3a)。期待通り |

### 認証ポリシー

- **`ANTHROPIC_API_KEY` を secret として登録する**。OAuth トークン (`CLAUDE_CODE_OAUTH_TOKEN`) は Anthropic 利用ポリシー上の制約により雛形では使わない（ADR-0004 / ADR-0014 D5）
- GitHub Releases adapter の rate limit を 5000 req/h に引き上げるため、`watch.yaml` 雛形は `secrets.GITHUB_TOKEN` を `GITHUB_TOKEN` env として forward する
- `radar workflow generate <type> --agent <name>` で生成する workflow も同じ方針 (OAuth 禁止)。詳細は「[agent 別 secrets 設定例](#agent-別-secrets-設定例)」を参照

### GitHub Actions 雛形の検証手順

生成された `.github/workflows/watch.yaml` を実 cron で動かして items / state が更新されることを確認する手順:

1. `radar init --with-actions` で workspace 直下に雛形が出来ていることを確認する
2. workspace を GitHub に push する（`sources/` `items/` `state/` も含めて commit）
3. リポジトリ設定で secret `ANTHROPIC_API_KEY` を登録する（[Settings → Secrets and variables → Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)）
4. **Actions タブから `radar` workflow を `Run workflow` で手動実行**する（`workflow_dispatch` トリガー）
5. ジョブが緑になり、`watch run` が新着 item を検出した場合は `items/` / `state/` の更新を含む commit が自動 push されることを確認する
6. cron スケジュール (`"0 0 * * *"`) を必要に応じて編集する。次回 cron 起動時に同様に動くはず

なお `permissions: contents: write` は新しい commit を push するために必須。Org level で `Workflow permissions` を `Read repository contents permission` に絞っている場合は workflow 単位の設定で override する必要がある。

cron cadence を変えたい / `combined` (watch + 自動 research) を追加したい / agent を切り替えたい場合は **[`radar workflow generate`](#radar-workflow-generate)** を使う。後追い生成 / 複数 workflow の共存 / `--max-items` ハードキャップ付きの自動 research に対応する。

### Claude Routines 雛形の検証手順

1. `radar init --with-routines` で `claude/routines/watch-daily.md` が生成される
2. Claude Routines に routine を登録する（取り込み方法は Claude Routines 側の手順に従う）
3. Routine 実行画面で API キー (`ANTHROPIC_API_KEY` 等) を secret として渡す
4. 1 回手動実行（Routines UI から）して `watch run` が成功すること、`items/` / `state/` の commit が push されることを確認する

### スコープ外（CLI 側）

- 雛形 file が実 cron で動くかの自動テストは行わない（実機検証はユーザー側責務、ADR-0004）
- `update` を cron で自動実行する雛形は提供しない（人が triage する設計）。`research` の自動化は `radar workflow generate combined` で `--max-items` ハードキャップ付きで提供 (ADR-0014)、`review` 単独 workflow は Phase 2 (#191) で予定
- desktop scheduled tasks（macOS launchd / Linux systemd timer 等）への対応は将来検討
- `radar workflow list / update / delete` (生成済み workflow の管理 CLI) は Phase 2 (#191) で必要性を再評価 (ADR-0014 D7)

## セキュリティ

### 全 adapter は「全権モード」で起動する

`radar research` / `radar review` が起動する 4 種類の agent CLI は、いずれも tool 承認なしで自動実行できるモードで spawn される（headless / 非対話実行を成立させるための前提）:

| adapter | 起動モード |
|---|---|
| `claude-code` | `--permission-mode bypassPermissions` |
| `codex-cli` | `--dangerously-bypass-approvals-and-sandbox` |
| `gemini-cli` | `-y` (YOLO mode) + `--skip-trust` (folder trust bypass) |
| `copilot` | `--allow-all-paths --allow-all-tools` |

つまり、agent が読み込む **任意の文字列が tool execution の指示として解釈されうる**。RSS feed の item content や HTML 抽出結果に攻撃者が prompt injection を仕込むと、agent がワークスペース内のファイル読み書きや任意コマンド実行を承認なしで行ってしまう経路が成立する。

### 信頼できる feed source のみ登録する

現時点では FeedRadar 側に包括的な prompt injection sanitize レイヤーを持たない ([ADR-0009](./adr/0009-untrusted-external-content-handling.md) M1a の regex pre-filter は audit-only)。ユーザー側の運用で feed source を選別することが第一の防御線になる。

**推奨される source**:

- 公式ベンダーの blog / news feed（例: anthropic.com/news/rss.xml、openai.com/blog/rss.xml）
- GitHub Releases feed（プロジェクト maintainer が release notes を直接書くもの）
- npm registry / PyPI などの公式 registry feed
- publisher が認証済みかつ信頼できる発信元

**注意が必要な source**:

- Hacker News / Reddit / Lobsters など、任意の third-party がコンテンツを投稿できるアグリゲータ
- ユーザー投稿型のフォーラム / コメント欄を含む feed
- 信頼境界が不明確な mirror / aggregator サイト

これらを source として登録する場合、item content 内に「Ignore previous instructions and ...」「以下を実行してください: ...」といった prompt injection 文字列が混入する可能性を許容したうえで運用する必要がある。少なくとも `radar research` 実行時のワークスペースには機密情報（`.env`、認証 token、秘密鍵など）を置かないこと。

### 包括的な sanitize 対策

FeedRadar 全体での prompt injection 緩和レイヤー（item content の sanitize、agent prompt の分離、出力検証など）は別 Phase で取り組む予定（[#49](https://github.com/ozzy-labs/feedradar/issues/49)）。それまでは上記の運用ガイドラインで mitigate する。

### `trustLevel`: 信頼境界の opt-in

`sources/<id>.yaml` の **`trustLevel`** フィールドで、その source のコンテンツを信頼境界の内側として扱うかを宣言する（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M4）。

| 値 | 意味 |
|---|---|
| `"untrusted"` (default) | 外部 feed と同等に扱う。`source add` で生成される YAML はすべてこれ |
| `"trusted"` | ユーザーが自分でコンテンツを掌握している source（自社内部 feed、社内 wiki エクスポート、release notes を maintainer 自身が書く GitHub Releases など）に opt-in |

ファイル例（明示 opt-in。CLI flag は提供されないため YAML を直接編集する）:

```yaml
# sources/internal-blog.yaml
id: internal-blog
kind: rss
url: https://blog.internal.example.com/feed.xml
trustLevel: trusted   # 既定は untrusted。社内 feed のみ明示的に格上げする
tags: ["internal"]
filters:
  keywords: ["release", "changelog"]
```

`trustLevel` 未指定の既存 YAML（[#17](https://github.com/ozzy-labs/feedradar/pull/17) 以前に作成したもの）は schema が default `"untrusted"` を補うため、migration は不要。

**現時点の挙動**: 本フィールドは schema のみの拡張で、実際の policy 分岐（regex 検出感度の調整、prompt builder の boundary marker 強度など）はまだ実装されていない。すべての source は `trustLevel` の値に関わらず untrusted 扱いで運用される。downstream で `trustLevel` を参照するロジックは [#49](https://github.com/ozzy-labs/feedradar/issues/49) 配下の sub-issue で順次入れていく。それまで `trustLevel: trusted` を設定しても挙動上の差は出ない（将来の policy 分岐に備えた宣言として機能する）。

### prompt injection の audit ログ (`injectionFlags`)

`radar watch run` 実行時、各 item の `title` / `summary` / `raw` に対し best-effort の regex pre-filter を走らせる（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M1a / M5a — Adopt）。検出された pattern label の一覧は `items/<sourceId>/<item-id>.yaml` の `injectionFlags` フィールドに記録される。

検出対象 (8 種類):

- `system-tag` — `[SYSTEM]` 形式の偽システムタグ
- `chatml-token` — `<|im_start|>` / `<|im_end|>` (OpenAI ChatML special token)
- `ignore-previous` — `Ignore previous instructions` 系（語形ゆれ吸収）
- `disregard-above` — `Disregard the above` 系
- `system-override` — `SYSTEM OVERRIDE` / `SYSTEM PROMPT OVERRIDE`
- `role-reassignment` — `You are now ...` 形式の役割再付与
- `instruction-fence` — `BEGIN/END INSTRUCTIONS` フェンス
- `endoftext-token` — `<|endoftext|>` (GPT family special token)

**重要**: あくまで auditability のための観察層であり、検出されたからといって item は変更されない（status は `detected` のまま、本文も sanitize しない）。判断は user に委ねる（ADR-0009 M5b — Reject: auto-dismiss しない）。

**既知の限界 (false negative)**:

- zero-width / 同型字 (homoglyph) による難読化（例: `i​gnore`）
- base64 / hex などの encoding 経由のペイロード
- 文字どおりの marker を含まない自然言語ジェイルブレイク（例: "Forget what you were told"）
- 英語以外の言語による paraphrase

これらは pre-filter では検出できないため、引き続き「信頼できる source のみ登録する」運用ルールが第一の防御線になる。

#### injection flag が立った item の手動 dismiss 手順

`watch run` 後に warn ログ `watch run: '<sourceId>' N item(s) tripped the prompt-injection pre-filter` が出た場合、または `research` / `review` / `update` 実行時に `item 'X' has N injection flag(s): ...` が表示された場合、以下のいずれかで運用する:

1. **内容を確認したうえで dismiss する** (推奨):

   ```bash
   # flag が立っている item のみを列挙する
   # (空の `injectionFlags: []` は除外し、配列要素がある形式だけ match させる)
   grep -lE '^injectionFlags:$' items/*/*.yaml
   cat items/<sourceId>/<item-id>.yaml

   # 攻撃ペイロードだと判断したら dismiss (detected → dismissed)
   radar dismiss <item-id>
   ```

2. **誤検知 (false positive) だと判断したらそのまま research を進める**:

   ```bash
   # flag が立っていても research は普通に動作する（audit-only）
   radar research <item-id>
   ```

   `injectionFlags` は `items/<id>.yaml` に残るので、後から `grep -rE '^injectionFlags:$' items/` で監査ログを追える。

3. **source 自体が信頼できないと判断したら source を外す**:

   ```bash
   radar source remove <sourceId>
   ```

   `items/<sourceId>/` 配下は履歴として残る（ADR-0008）。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| agent CLI が見つからない | `claude` / `codex` / `gemini` / `copilot` が `PATH` に存在し認証済みであることを確認。`radar doctor` で各 agent の install 状況を確認できる |
| `codex login` / `gemini` OAuth / `copilot auth login` が未完了でエラー | 該当 agent CLI を一度対話起動して認証を完了させる。`radar` は子プロセスとして spawn するだけで認証ループは持たない |
| `html-js` source が空配列を返す / item が取れない | selector を JS 実行後の DOM に合わせて組み直す。詳細は「[`--kind html-js` のトラブルシュート](#--kind-html-js)」 |
| `html-js adapter: failed to load Playwright (...)` | `npm i -g playwright` を実行し、`npx playwright install chromium` で Chromium も install。詳細は「[`--kind html-js` のセットアップ手順](#--kind-html-js)」。`radar doctor` でも検出される |
| OIDC 認証エラー（publish 時） | maintainer 向け。`standards/npm-trusted-publishers` を参照 |
| workspace の `items/` / `state/` をリセットしたい | `state/` ディレクトリと `items/<sourceId>/` ディレクトリを削除してから `watch run` を再実行する。`state/<sourceId>.yaml` に記録された `lastSeenIds` が消えるので、`watch run` が source 全件を再検出して `items/<sourceId>/*.yaml` を作り直す（[#24](https://github.com/ozzy-labs/feedradar/pull/24) の Item.id refactor 前後で id 形式が変わったため、古い workspace を引き継ぎたい場合の標準手順）。`sources/` `templates/` `.agents/skills/` は触らない |
| 社内 HTTP プロキシ越しに fetch が失敗する | `HTTPS_PROXY` / `HTTP_PROXY` を設定して `radar` を起動する。Node 22.21+ / 24.5+ では `radar` が `NODE_OPTIONS=--use-env-proxy` を自動付与して self-respawn するので追加設定は不要。自動 spawn を止めたい場合は `RADAR_AUTO_PROXY=0`（`false` / `off` でも可）を設定する。`ALL_PROXY` のみ設定すると Node の `--use-env-proxy` は無視するため `HTTPS_PROXY` も併設すること（`radar` が warning を出す）。TLS 中継 / NTLM / WSL2 を含む詳細は [docs/user-guide/proxy-setup.ja.md](./user-guide/proxy-setup.ja.md) を参照 |
| `kind: html-js` source がプロキシ越しに失敗する | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` のいずれかを設定すれば `html-js` adapter が Playwright の `launch({ proxy })` に自動注入する。`NO_PROXY` も尊重し、Node 形式（`,` 区切り・`.example.com` で suffix match）から Playwright 形式（`;` 区切り・`*.example.com` glob）へ自動変換される。fetch 系 adapter と違い Playwright は `--use-env-proxy` を読まないため、この自動注入が必要 |
| `refused to fetch private / loopback IPv4 address ...` / `refused to fetch URL with non-HTTP scheme ...` / `refused to fetch loopback hostname ...` | ADR-0009 §D5b の SSRF host blocklist (cloud metadata / RFC1918 / loopback / `file://` 等を遮断) が発火している。意図した遮断ならそのまま (recipe の URL を見直す)。testing 等で意図的にローカル fixture を叩きたい場合は `RADAR_FETCH_HOST_ALLOWLIST=<host>` を設定する。詳細は「[SSRF host blocklist](#ssrf-host-blocklist)」を参照 |
| `Agent running… [mm:ss]` から動いていないように見える / `Still waiting for "<selector>"…` が連続する | progress reporter の表示で、内部では agent / Playwright が稼働している可能性が高い。`--verbose` で agent stdout を直接見るか、`radar source test <id> --show-content` で DOM を確認する。詳細は「[進捗表示 / verbose / quiet](#進捗表示--verbose--quiet)」を参照 |
