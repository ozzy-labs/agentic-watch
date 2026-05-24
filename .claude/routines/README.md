# Claude Code Routines

[Claude Code Routines](https://code.claude.com/docs/en/routines)（Anthropic クラウド側で動く非対話エージェント）の設定をリポジトリで管理するためのディレクトリ。

## ⚠️ `.claude/skills/` とは別物

| 項目         | `.claude/skills/`        | `.claude/routines/` (このディレクトリ)     |
| ------------ | ------------------------ | ------------------------------------------ |
| ロード       | Claude Code が auto-load | **Anthropic クラウド側に手動コピー**       |
| 実行場所     | ローカル CLI             | Anthropic クラウド VM                      |
| 自動連携     | あり                     | **なし**（リポは正本のコピー先にすぎない） |
| シークレット | `.env` から読める        | Web UI 側の secret として別管理            |

このディレクトリのファイルを編集しても**自動では Web UI に反映されない**。必ず手動で同期する。

## ディレクトリ構造

```text
.claude/routines/
├── README.md              # このファイル
├── _template.yaml         # 新規 routine 作成のひな形（1 file 1 routine）
└── <routine-name>.yaml    # 各 routine。Web UI のフォーム欄と 1:1 で対応
```

1 ルーチンあたり 1 ファイル。`instructions`（Web UI の Prompt 欄）と `environment.setup_script`（Setup script 欄）も同じ YAML 内に文字列として持つ。

各 `<routine-name>.yaml` は **CLI 生成（`radar routine generate <type>`）** か **手動（`_template.yaml` から起こす）** のどちらでも作れる（使い分けは後述「[新規追加](#新規追加)」）。

## Web UI 欄 ↔ YAML フィールド対応表

| Web UI 欄                                 | YAML フィールド                           |
| ----------------------------------------- | ----------------------------------------- |
| Name                                      | `name`                                    |
| Instructions                              | `instructions`                            |
| Model                                     | `model`                                   |
| Repositories                              | `repositories`                            |
| Environment > Name                        | `environment.name`                        |
| Environment > Network access              | `environment.network_access`              |
| Environment > Environment variables       | `environment.variables`                   |
| Environment > Setup script                | `environment.setup_script`                |
| Trigger                                   | `triggers`                                |
| Connectors                                | `connectors`                              |
| Behavior > Auto-fix pull requests         | `behavior.auto_fix_pull_requests`         |
| Permissions > Allow unrestricted git push | `permissions.allow_unrestricted_git_push` |

リポ管理用フィールド（Web UI に対応欄なし）:

| フィールド   | 用途                                                            |
| ------------ | --------------------------------------------------------------- |
| `notes`      | 一行サマリ + 運用メモ。1 行目が一行サマリ、空行後にメモを続ける |
| `status`     | `active`（Web UI 登録済み） / `draft`（未登録）                 |
| `routine_id` | Web UI 登録後に発行される `trig_xxxx`。draft の間は空           |

## 運用ルール

### 正本はリポ

- Web UI で直接編集**しない**
- 変更は必ずリポの PR → マージ → Web UI に手で反映、の順で行う
- Anthropic 側に GET routine API がないため drift の機械検知は不可能。規約で守る

### 新規追加

routine YAML を起こす方法は 2 通りある。どちらで作っても**置き場所（`.claude/routines/*.yaml`）・正本運用ルール・Web UI 反映手順は同じ**。

| 方法                                            | 向いているケース                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI 生成（`radar routine generate <type>`）** | `radar` CLI があるリポでの第一選択。`watch`（detection のみ）/ `pipeline`（watch → triage → research → review を自セッションで順次）の定型を、安全策込みで一発生成できる |
| **手動（`_template.yaml` から起こす）**         | `radar` CLI が無いリポ、または定型に当てはまらない独自 routine を 1 から組む場合                                                                                            |

#### CLI 生成（generate）

`radar` CLI を持つリポでは、定型 routine を生成できる:

```bash
# detection だけの watch routine を毎時で生成
radar routine generate watch --repo <owner>/<repo> --cron "0 * * * *"

# watch → triage → research → review のフルパイプライン（1 回 5 件上限）
radar routine generate pipeline --repo <owner>/<repo> --cron "0 */6 * * *" --max-items 5
```

- 出力先は既定で `.claude/routines/<name>.yaml`（`--output` で上書き可、`--force` で既存上書き）。
- 生成 YAML は `status: draft` で出る。安全策（`permissions.allow_unrestricted_git_push: false` / `behavior.auto_fix_pull_requests: false` / `connectors: []`・件数上限の literal 焼き込み）はあらかじめ埋まっている。
- type・オプション一覧・FeedRadar 固有の安全策は [`docs/user-guide.md` §routine workflow](../../docs/user-guide.md#routine-workflow) を参照。

生成後は下記「[手動 / 生成 共通の続き](#手動--生成-共通の続き)」へ進む。

#### 手動（`_template.yaml` から起こす）

1. `cp .claude/routines/_template.yaml .claude/routines/<new-name>.yaml`
2. ファイル内のフィールドを編集
   - `name` を `<new-name>` に揃える
   - `repositories:` を実際の `<owner>/<repo>` に置換
   - `instructions` の `ROUTINE_NAME` / `<owner>/<repo>` を実値に置換
   - `environment.setup_script` の **project-specific install** 領域に対象リポの依存解決コマンドを追加

#### 手動 / 生成 共通の続き

1. `status: draft` のまま PR 作成・マージ
2. [claude.ai/code/routines](https://claude.ai/code/routines) で **New routine** → 各欄に YAML から該当フィールドの内容を貼る
3. 表示された `routine_id` を YAML に書き戻し、`status: active` に変更する小コミットを `main` に追加

### 更新

1. PR で `<routine-name>.yaml` を更新 → マージ
2. Web UI に手で反映

### 削除

1. Web UI で routine を削除
2. `git rm .claude/routines/<name>.yaml`

### 外部からの起動（fire）

スケジュール（cron）以外に、登録済み routine を API で「今すぐ 1 回」起動できる。`radar` CLI があるリポでは `radar routine fire <trig_id>` ヘルパが使える:

```bash
export FEEDRADAR_ROUTINE_FIRE_TOKEN='...'   # Web UI で 1 回だけ表示された per-routine token
radar routine fire trig_abc123
radar routine fire trig_abc123 --text "manual run after release v1.2.0"  # 起動コンテキスト
```

- `<trig_id>` は Web UI 登録後に発行される `trig_` プレフィックスの routine ID（= YAML の `routine_id`）。
- token は **環境変数からのみ**読む（既定 `FEEDRADAR_ROUTINE_FIRE_TOKEN`、`--token-env <NAME>` で別名指定可）。リポ・YAML・コマンドライン引数には**書かない**（後述「[シークレットの取り扱い](#シークレットの取り扱い)」）。
- API・認証の詳細は [`docs/user-guide.md` §routine を外部から起動する（`/fire`）](../../docs/user-guide.md#routine-を外部から起動するfire) を参照。

### シークレットの取り扱い

- 値は**絶対に commit しない**
- `environment.variables` には**名前だけ**書く
- API trigger の fire token は password manager 等で別管理

## yq での Web UI 貼り付け抽出

複数行フィールドはターミナルから直接貼り付けできるよう、`yq` で抽出する:

```bash
# Instructions 欄に貼る本文
yq -r '.instructions' .claude/routines/<name>.yaml

# Setup script 欄に貼る本文
yq -r '.environment.setup_script' .claude/routines/<name>.yaml
```

## ファイルの約束ごと

### `instructions`

- 完全自律実行を前提に self-contained に書く（`AskUserQuestion` は使わない）
- ローカル MCP サーバー（`knowledge` / `context7` 等）はクラウド環境に存在しない前提で書く
- `claude/*` ブランチで PR を立てる運用に揃える（main 直 push を要求しない）
- YAML リテラルブロック（`|`）でインデントを保ったまま格納する

### `environment.setup_script`

- shebang（`#!/usr/bin/env bash`）を含めて格納する
- ローカル検証は `yq -r '.environment.setup_script' .claude/routines/<name>.yaml | bash` で動く形に保つ
- ターゲット環境は **Routines クラウド VM (Ubuntu)** 前提
- `sudo apt-get` 等の Ubuntu 依存コマンドの利用は OK だが、ローカル検証は WSL/Linux で行う
- mise を介して言語ツールチェーンを揃える前提（`.mise.toml` がリポルートにある想定）
- 重複が増えたら共通化を検討（**3 routine 目を作る前**を目安）

### メタデータ

- 必須: `name`, `status`, `repositories`, `model`, `triggers`, `instructions`, `environment.setup_script`
- `status` は `active` または `draft` の 2 値（Web UI 未登録は `draft`）
- `routine_id` は Web UI 登録後に書き戻す。空でよいのは `status: draft` のときだけ
- `triggers` は配列（schedule / api / github を将来混在可能）

## バリデーション（任意）

`scripts/routines/validate.py` を用意すれば必須フィールド・cron 妥当性・`status: active` なら `routine_id` が空でないか等を検証できる。Lefthook の **pre-push** に組み込むのが推奨（pre-commit には入れない）。

## opt-out

特定リポでこのディレクトリを管理したくない場合は、`.commons/sync.yaml` の `pinned:` に `.claude/routines/` 配下のパスを追加して同期対象から外す。

## 参考

- [Automate work with routines](https://code.claude.com/docs/en/routines)
- [Trigger a routine via API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
- [Claude Code on the web（cloud environment）](https://code.claude.com/docs/en/claude-code-on-the-web)
- knowledge MCP: `ai/agents/claude-code-routines`, `ai/practice/scheduled-tasks`
