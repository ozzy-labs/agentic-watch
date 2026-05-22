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
| `--kind` | `rss` / `html` / `html-js` / `github-releases` / `npm-registry` |
| `--url` | fetch 対象の URL |
| `--name` | 表示名（省略時は `<id>`） |
| `--tags` | カンマ区切りタグ |
| `--keywords` | カンマ区切り、ヒット対象キーワード |
| `--exclude-keywords` | カンマ区切り、除外キーワード |

なお `sources/<id>.yaml` は **`trustLevel: "trusted" | "untrusted"`** フィールドも持つ（[ADR-0009](./adr/0009-untrusted-external-content-handling.md) M4）。default は `"untrusted"` で、`source add` で生成される YAML には `trustLevel: untrusted` が書き出される。`"trusted"` への opt-in は YAML を手で編集する（CLI flag は提供しない。後述「[trustLevel: 信頼境界の opt-in](#trustlevel-信頼境界の-opt-in)」を参照）。

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

### `radar watch run [--source <id>] [--bootstrap]`

すべての source（または `--source` で指定）を fetch、filter を適用、新規 item を `items/<sourceId>/<item-id>.yaml` に追加。

| オプション | 説明 |
|---|---|
| `--source <id>` | 単一 source のみ fetch する。未指定なら `sources/*.yaml` 全件 |
| `--bootstrap` | 既存記事を全て **検出済み (seen)** として state に取り込み、items は作らない。初回導入時のノイズ抑制用 |

挙動:

- 各 source の `kind` に応じた feed adapter を呼び出す（5 種すべて `rss` / `html` / `html-js` / `github-releases` / `npm-registry` が実装済み。`html-js` は Playwright を optional peer dep として動的 import する — ADR-0010）
- adapter は `If-None-Match` ヘッダ（前回 `lastEtag`）を付けて GET し、サーバが `304 Not Modified` を返した場合は items 処理をスキップしつつ `lastFetchedAt` のみ更新する（adapter 別の対応状況・304 時の詳細な挙動は [`docs/architecture.md` の "Fetch efficiency / conditional GET"](./architecture.md#fetch-efficiency--conditional-get) を参照）
- fetch した item に [filter](./design/filter-spec.md) を適用し、`lastSeenIds` に無いもののみを `items/<sourceId>/` に書き出す（`status: detected`、`matchedKeywords` 付き）
- 実行後 `state/<sourceId>.yaml` の `lastFetchedAt` / `lastEtag` / `lastSeenIds` が更新される
- 一部 source で失敗した場合でも他 source は続行し、exit code は `1` を返す（CI で検知可能）

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

ワークスペース / 依存ツールの health check を実行する。`html-js` source を使う前の事前確認や、`watch run` / `research` が想定どおり動かないときの切り分け用。

実行内容（[#114](https://github.com/ozzy-labs/feedradar/issues/114)）:

1. `radar.config.yaml` / `sources/*.yaml` の妥当性確認（schema 違反を列挙）
2. agent CLI (`claude` / `codex` / `gemini` / `copilot`) の install 確認 (`which` 相当)
3. **`html-js` source が登録されている場合のみ**:
   - `import("playwright")` を試行 → 失敗なら `npm i -g playwright` を案内
   - Chromium binary の存在確認 (`playwright` の `chromium.executablePath()`) → 失敗なら `npx playwright install chromium` を案内
4. workspace ディレクトリ (`sources/` `items/` `state/` `research/` `templates/`) の存在確認

出力フォーマットは各チェックを `ok` / `warn` / `error` の 3 段階で列挙し、最後に集計サマリ。warn は exit code に影響しない、error が 1 件でもあれば exit code `1`。

CI で自動 install したい場合は環境変数 `RADAR_AUTO_INSTALL_CHROMIUM=1` を `radar watch run` 側でセットすると Chromium 不在時に `npx playwright install chromium` を spawn する（`radar doctor` 自体は read-only で install を行わない）。Playwright npm package 自体の install (`npm i -g playwright`) は radar が代行しない（global npm install の権限問題を避けるため、ユーザー側で実行を強制する設計）。

> このサブコマンドの実装は #114 で進行中（2026-05-17 時点）。実装が確定したら本ドキュメントの記述と差異があれば別 follow-up PR で同期する。

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

`radar` 本体は scheduler を内蔵しない（[ADR-0004](./adr/0004-schedule-strategy.md)）。`init` の opt-in フラグでクラウド scheduler 向けの**接続用雛形**を生成する。

| フラグ | 生成先 | 用途 |
|---|---|---|
| `radar init --with-routines` | `claude/routines/watch-daily.md` | Claude Routines (Anthropic 管理クラウド VM) |
| `radar init --with-actions` | `.github/workflows/watch.yaml` | GitHub Actions (cron + workflow_dispatch) |

既存ファイル保護 + `--force` 上書きは bundled skills と同じ挙動。

### 認証ポリシー

- **`ANTHROPIC_API_KEY` を secret として登録する**。OAuth トークン (`CLAUDE_CODE_OAUTH_TOKEN`) は Anthropic 利用ポリシー上の制約により雛形では使わない（ADR-0004）
- GitHub Releases adapter の rate limit を 5000 req/h に引き上げるため、`watch.yaml` 雛形は `secrets.GITHUB_TOKEN` を `GITHUB_TOKEN` env として forward する

### GitHub Actions 雛形の検証手順

生成された `.github/workflows/watch.yaml` を実 cron で動かして items / state が更新されることを確認する手順:

1. `radar init --with-actions` で workspace 直下に雛形が出来ていることを確認する
2. workspace を GitHub に push する（`sources/` `items/` `state/` も含めて commit）
3. リポジトリ設定で secret `ANTHROPIC_API_KEY` を登録する（[Settings → Secrets and variables → Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)）
4. **Actions タブから `radar` workflow を `Run workflow` で手動実行**する（`workflow_dispatch` トリガー）
5. ジョブが緑になり、`watch run` が新着 item を検出した場合は `items/` / `state/` の更新を含む commit が自動 push されることを確認する
6. cron スケジュール (`"0 0 * * *"`) を必要に応じて編集する。次回 cron 起動時に同様に動くはず

なお `permissions: contents: write` は新しい commit を push するために必須。Org level で `Workflow permissions` を `Read repository contents permission` に絞っている場合は workflow 単位の設定で override する必要がある。

### Claude Routines 雛形の検証手順

1. `radar init --with-routines` で `claude/routines/watch-daily.md` が生成される
2. Claude Routines に routine を登録する（取り込み方法は Claude Routines 側の手順に従う）
3. Routine 実行画面で API キー (`ANTHROPIC_API_KEY` 等) を secret として渡す
4. 1 回手動実行（Routines UI から）して `watch run` が成功すること、`items/` / `state/` の commit が push されることを確認する

### スコープ外（CLI 側）

- 雛形 file が実 cron で動くかの自動テストは行わない（実機検証はユーザー側責務、ADR-0004）
- `research` / `review` / `update` を cron で自動実行する雛形は提供しない（人が triage する設計）
- desktop scheduled tasks（macOS launchd / Linux systemd timer 等）への対応は将来検討

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
