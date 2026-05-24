# ADR-0014: Workflow Generate (後追い生成) と自動 research セーフティ方針

## Status

Accepted（2026-05-23、実装完了 2026-05-23）— 親 epic [#186](https://github.com/ozzy-labs/feedradar/issues/186) の起点 ADR。`radar workflow generate` サブコマンドの設計判断と、自動 research の暴走防止セーフティを記録する。sub-issue (#188 `workflow generate watch` / #189 `workflow generate combined` / #190 `research --batch` ハードキャップ / 他) は全て merge 済み。`research` / `review` 単独 type の workflow generate は Phase 2 ([#191](https://github.com/ozzy-labs/feedradar/issues/191)) として残置。

## Context

### ADR-0004 が抱える制約

[ADR-0004 (Schedule Strategy)](./0004-schedule-strategy.md) では、`radar init --with-actions` で `.github/workflows/watch.yaml` を **1 度だけ** 生成する設計を採った。これは「scheduler 接続点を `init` で生成する」というコア方針の最小実装として正しいが、以下の現実ニーズに対応できない:

1. **後追い生成**: `init` 完了後に「やっぱり Actions も使いたい」となった場合、CLI から再生成する手段がない（手で YAML を書くか `init --force` で他のテンプレも上書きするしかない）
2. **複数 cadence の共存**: `watch run` を 1 時間ごと、`research` は週次、といった **別 cadence で複数 workflow** を回したいユースケースが構造的に表現できない
3. **検出 → 自動 research の連鎖**: 検出された item を **自動で research** したいユースケース（例: AWS What's New を検出したら即座に summary 生成）は手動操作が前提
4. **agent 別 boilerplate の不在**: ADR-0004 は claude-code 向けテンプレを基準にしているが、codex / gemini / copilot の boilerplate が存在しない

### 自動 research の暴走リスク

「検出 → 自動 research の連鎖」を素直に実装すると、以下の暴走経路が生まれる:

- ある日 RSS source が **過去履歴を一気に吐く** (publisher 側の bug / feed url 変更 / `--backfill` の事故起動)
- 検出 item 数が想定の 10 → 数百〜数千件に膨らむ
- 自動 research が全件に対して走る → **LLM cost が爆発**、agent CLI の rate limit / billing alert を一気に踏み抜く

この経路を **設計レベルで遮断する** 必要がある。「ユーザーが気付いたら止める」運用は事後対応であり、cost 暴走は秒〜分単位で発生するため間に合わない。

### push 競合

複数 workflow が **同一 branch を push し合う** ケース（例: `watch.yaml` と `combined.yaml` が同時刻にトリガーされて両方が `items/` を commit + push する）は、片方が non-fast-forward error で失敗する。現状の `watch.yaml` template には rebase リトライが無く、cron 2 本目以降は手動介入が必要になる。

### agent 認証ポリシーの継続

[ADR-0004 § 認証ポリシー](./0004-schedule-strategy.md#認証ポリシー重要)で `ANTHROPIC_API_KEY` などの API キー方式を採り、OAuth トークン (`CLAUDE_CODE_OAUTH_TOKEN` 等) は Anthropic の利用ポリシー上 "ordinary individual use" の範囲外として禁止している。本 ADR で新設する workflow テンプレでも **この方針を継続**することを明示する（agent が増えても OAuth 路線に分岐しないこと）。

## Decision

### D1. `radar workflow generate <type>` サブコマンドを新設

`radar` CLI に **新しいサブコマンド namespace** `radar workflow` を切り、`generate` を最初の verb として実装する。

```text
radar workflow generate <type> [options]
```

`init --with-actions` は **温存** する（後方互換）。`init --with-actions` は今後も初回 workspace setup 用、`workflow generate` は後追い生成・複数共存用と用途を分離する。

#### D1 採用理由

- **責務分離**: `init` は workspace 初期化（sources/ items/ state/ ディレクトリ作成 + skill 配布）が主目的で、workflow は副作用の 1 つに過ぎない。後追い生成の入り口を `init` に混ぜると `init` の責務が肥大化する
- **複数 workflow の自然な表現**: `radar workflow generate watch --output .github/workflows/watch-hourly.yaml` のように output path で複数生成できる
- **`--force` 衝突回避**: `init --force` は workspace 全体に対する強い flag で、workflow だけ再生成したい場合に過剰。`workflow generate --force` は workflow ファイルだけにスコープが限定される

### D2. Workflow タイプ 4 種

`<type>` には以下 4 種を採用する。各 type は独立した workflow YAML として生成され、cron / agent / 副作用が type ごとに最適化される。

| type | 用途 | 主要 step | 副作用 |
|---|---|---|---|
| `watch` | `watch run` のみを定期実行 | `radar watch run` | `items/` + `state/` を commit/push |
| `research` | 既存 `detected` item を batch research | `radar research <ids...>` (一括) | item frontmatter status を `researched` に更新、`items/` を commit/push |
| `combined` | watch → 自動 research → commit の連鎖 | `radar watch run` → 検出 ids 抽出 → `radar research --max-items N` | 上記両方を 1 commit に集約 |
| `review` | researched item を別 agent でレビュー | `radar review <ids...>` | item frontmatter に review コメント追記 |

#### タイプ間の関係

- **`combined` は `watch` の上位互換ではない**: watch 単独で運用したい (cost 低・低頻度 research でよい) ユーザーは `watch` を選ぶ
- **`research` / `review` 単独 type は Phase 2** (#191 で実装): Phase 1 では `watch` / `combined` 2 種でカバー、`research` / `review` のニーズが具体化したら追加
- **agent 切り替え**: `--agent claude-code|codex|gemini|copilot` で workflow テンプレ内の secrets / 環境変数 / step 名を切り替える。secrets 名は `<AGENT>_API_KEY` 形式で統一する（例: `CODEX_API_KEY`, `GEMINI_API_KEY`）

### D3. 自動 research セーフティ: ハードキャップを workflow テンプレに焼き込む

`combined` および将来の `research` 単独 type で、以下を **workflow テンプレに literal value として展開する**。CLI flag ではなく **YAML 内に直接書き込む** ことで「workflow を読めば上限が明らか」「人間が編集しない限り上限が外れない」状態を作る。

#### D3a. `--max-items N` (既定 10)

`radar workflow generate combined --max-items 20` で `20` を YAML に焼き込む。

```yaml
# .github/workflows/combined.yaml (生成結果の例)
- name: Run research on detected items (capped at 20)
  run: |
    DETECTED_IDS=$(radar items list --status detected --format ids)
    radar research --max-items 20 $DETECTED_IDS
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- 既定値 `10` の根拠: 通常運用での 1 cron tick の検出件数（経験的に 1-5 件）に対して **2-10 倍の余裕** を見つつ、暴走時の cost 爆発を「LLM 1 call ~0.01 USD × 10 = 0.1 USD」程度に押さえる水準
- ユーザーが「もっと多く処理したい」場合は **明示的に** `--max-items 100` 等で生成しなおす（後から workflow YAML を手編集することも可能だが、CLI 再生成のほうが意図が記録される）
- `radar research` 側にも `--max-items` を実装し、N を超える ids が引数として渡されたら **超過分を切り捨て + warning を log に出す**（CLI 層の二重防御）

#### D3b. `--filter-tags <list>`

検出 item のうち特定 tag を持つもののみ research する。例: `--filter-tags security,breaking-change`。

```yaml
- name: Run research on tagged items
  run: |
    DETECTED_IDS=$(radar items list --status detected --tags security,breaking-change --format ids)
    radar research --max-items 10 $DETECTED_IDS
```

- 既定は **未指定** (全 detected item が対象)。ユーザーが scope を絞りたい場合のみ指定
- tag filter は CLI 側で評価される（workflow YAML 上には `--tags <list>` literal で焼き込み）

#### D3c. workflow YAML から CLI flag を消す選択肢を採用しない

「workflow からは flag を消し、CLI default を変える」案は **却下** する。理由:

- workflow を読んだ第三者（あるいは数ヶ月後の自分）が「上限がどこで決まっているか」を CLI source に潜らないと分からない
- CLI default を変えると `radar research` 単独実行 (手動) でも cap がかかってしまう。手動実行は意図的なので cap 不要
- YAML literal 化は audit / 静的レビューが容易（PR diff で `--max-items 1000` を見つけたら警告できる）

### D4. push 競合対策: `git pull --rebase` リトライをテンプレに内蔵

各 workflow type の最終 commit/push step に **rebase リトライ** を組み込む。

```yaml
- name: Commit and push with retry
  run: |
    git config user.name "feedradar-bot"
    git config user.email "feedradar-bot@users.noreply.github.com"
    git add items/ state/
    git diff --cached --quiet && exit 0
    git commit -m "chore(feedradar): update items/state"
    for attempt in 1 2 3; do
      if git push origin "${GITHUB_REF_NAME}"; then
        exit 0
      fi
      echo "push failed (attempt $attempt/3), rebasing..."
      git pull --rebase --autostash origin "${GITHUB_REF_NAME}"
    done
    echo "push failed after 3 attempts" >&2
    exit 1
```

#### D4 採用理由

- **同時刻 cron firing の構造的並走**: `0 * * * *` (`watch`) と `0 */6 * * *` (`combined`) が 6 時間に 1 回必ず衝突する。リトライ無しだと 6 時間ごとに 1 回ずつ手動再 run が必要になる
- **`concurrency.cancel-in-progress: false` だけでは不十分**: 1 workflow 内の overlapping は防げるが、異 workflow 間の同時 push は防げない（ADR-0004 では同 workflow 内の cron firing しか想定していなかった）
- **3 回上限の根拠**: GitHub Actions の rate limit / cron スロット競合の経験的な収束回数。4 回以降の失敗は workflow 外の問題（branch protection / token 失効 / merge conflict）なので、retry より fail-fast のほうが debuggability が高い

### D5. agent 認証ポリシーの継続: OAuth 禁止を明文化

ADR-0004 で確立した `ANTHROPIC_API_KEY` 等の API キー方式を **本 ADR でも継続** する。`workflow generate` で生成されるすべての type / agent 向けテンプレに以下を適用する:

| agent | secrets 名 | OAuth 採否 |
|---|---|---|
| claude-code | `ANTHROPIC_API_KEY` | **禁止** (`CLAUDE_CODE_OAUTH_TOKEN` を使わない) |
| codex | `OPENAI_API_KEY` (Codex CLI が要求する key 名に合わせる) | **禁止** |
| gemini | `GEMINI_API_KEY` | **禁止** |
| copilot | `GITHUB_TOKEN` (copilot CLI の認証は GH token 経由、Actions 上では `secrets.GITHUB_TOKEN` 自動付与) | n/a (個人 OAuth ではない) |

CLI 側で `--agent` 指定時に必要な secrets 名を `radar workflow generate combined --agent gemini` 実行ログに **明示する** ことで、ユーザーが Settings → Secrets に何を登録すればよいか迷わない設計とする。

#### D5 採用理由

- ADR-0004 の方針が CI 自動化全般に適用される普遍的な制約のため、type / agent 個別に再定義しない
- agent が増えるたびに OAuth 路線を許す/許さないの議論が再燃すると design entropy が増える。**「自動化 = API キーのみ」**を本 ADR で再確認することで、Phase 2 以降の agent 追加時にこの判断を蒸し返さない

### D6. workflow ファイル命名 / 配置

```text
.github/workflows/
  watch.yaml             # 既存 init --with-actions が生成
  watch-hourly.yaml      # workflow generate watch --output で命名
  combined-weekly.yaml   # workflow generate combined --output で命名
```

- デフォルト output path: `.github/workflows/<type>.yaml`（`<type>.yaml` がすでにある場合は `--force` なしで warning + skip）
- 複数 cadence で並走させる場合、`--output .github/workflows/<type>-<cadence>.yaml` をユーザーが指定する想定（CLI は `--output` の値をそのまま使う）

### D7. スコープ外 (本 ADR 範囲外)

| 項目 | 理由 |
|---|---|
| `radar workflow list / update / delete` CLI | Phase 2 (#191) で必要性を再評価 |
| 4 agent 別 secrets テンプレートの完全実装 | claude-code を Phase 1 で完成、他は Phase 2 |
| self-hosted scheduler (n8n / temporal 等) 対応 | Phase 3 候補、別 ADR で検討 |
| `--bootstrap` / `--backfill` ([ADR-0012](./0012-json-api-adapter-and-recipe-strategy.md)) との連動 | combined type で `--backfill` を流すと **max-items を簡単に踏み抜く** ため、workflow テンプレで `--backfill` を有効化する経路は提供しない（手動運用に限定） |
| 既存 `init --with-actions` の挙動変更 | 後方互換維持（D1） |
| Recipe 機構 ([#172 epic](https://github.com/ozzy-labs/feedradar/issues/172)) との統合 | recipe 機構が定着した後の Phase 3 で "workflow recipes" として再評価 |

## Consequences

### 良い面

- **後追い生成が CLI で完結する**: `init` を再実行することなく workflow を追加・再生成できる
- **複数 cadence の workflow が共存できる**: `watch-hourly.yaml` + `combined-weekly.yaml` のような構成が宣言的に表現できる
- **自動 research の暴走を設計レベルで遮断**: ハードキャップが workflow YAML に焼き込まれるため、ユーザーが YAML を編集しない限り cost 暴走が起きない。「気付いたら止める」ではなく「そもそも踏めない」防御
- **push 競合の運用負荷が減る**: 3 回までの自動 rebase で大半の cron 衝突が自動回復する
- **agent 認証ポリシーの一貫性**: ADR-0004 の OAuth 禁止が type / agent を増やしても揺らがない

### 悪い面 / 制約

- **workflow ファイルが複数に増える**: メンテナンス対象が増え、テンプレ更新時にすべての type / agent 組み合わせをカバーする必要がある（agent 別 secrets テンプレ + ハードキャップ展開 + rebase リトライの 3 軸の組み合わせ爆発）
- **agent 別 secrets の管理コスト**: 4 agent × secrets 名の対応表を CLI / docs / template の 3 箇所で同期する必要がある。差分が出ると CLI が要求する secrets と Settings 登録値がずれて debug が困難になる
- **手書き編集との衝突**: 生成された workflow を手で編集したユーザーが `--force` で再生成すると編集が失われる。warning + skip の既定挙動 (ADR-0004 で確立) で守るが、`--force` を明示した場合の保護策はない
- **`combined` 暴走経路の残存**: workflow YAML を手で編集して `--max-items` を消すと cap が外れる。これは「YAML literal 化のトレードオフ」で、CLI 層の二重防御 (D3a 末尾) で緩和する

### 中立

- ADR-0004 は **改訂しない**。本 ADR は ADR-0004 の拡張であり、`init --with-actions` の挙動は変えない。代わりに ADR-0004 文末から本 ADR への pointer を追加する
- `radar workflow generate` の CLI surface は本 ADR で確定するが、内部実装 (テンプレエンジン / placeholder 構文) は #188 / #189 の実装 PR で詳細決定する

## Alternatives

### 案 X1: `init --with-actions` を強化して複数 workflow / 後追い生成に対応

却下理由:

- `init` のスコープが workspace 初期化から workflow 管理に肥大化する
- `init` を再実行すると sources/ / skills/ など他のテンプレも触る経路が混ざり、`init --with-actions-only` のような flag が必要になって複雑化
- 「ある type の workflow だけ再生成したい」要求に対し `init --with-actions --force-watch-only` のような flag が必要になり、CLI surface が崩壊する
- 別 namespace (`radar workflow`) を切るほうが将来 `list` / `update` を加えやすい

### 案 X2: 完全プログラム生成 (js-yaml で workflow を AST 構築)

却下理由:

- **YAGNI**: 現状の Variation は (type × agent × cadence × max-items) の組み合わせのみで、placeholder 置換のテンプレで十分カバーできる
- AST 構築は LoC が増え、テンプレと挙動の対応関係が読みづらくなる（PR diff が AST 構築コード vs 出力 YAML の 2 経路になる）
- workflow YAML は **読まれる成果物** であり、生成過程よりも生成結果のレビュー容易性が重要
- 将来「conditional step を変数で挿入」みたいな要求が出たら再評価する

### 案 X3: 1 つの workflow ファイルに複数 job を入れる

却下理由:

- **cadence 独立性が崩れる**: 1 workflow 内で `on.schedule` は配列にできるが、job 別に異なる cron を割り当てる構文がない（matrix 経由は複雑、可読性低い）
- 「watch を 1 時間ごと、combined を週次」を 1 ファイルで表現すると job 内に `if: ${{ github.event.schedule == '...' }}` 分岐が大量に発生し、可読性が壊滅
- 失敗時のリトライ単位 (re-run failed jobs) が workflow 単位なので、watch だけ再 run したい場合に過剰な job が動く
- 複数ファイルにすると `concurrency` group も type ごとに分離でき、cancel ポリシーが調整しやすい

### 案 X4: 自動 research のハードキャップを CLI default として組み込み、workflow には書かない

却下理由（D3c でも触れる）:

- workflow を読んだ第三者が「上限がどこで決まっているか」を CLI source に潜らないと分からない
- CLI default を変えると手動実行 (`radar research <ids...>`) でも cap がかかり、意図的な大量 research を阻害する
- workflow YAML literal 化は audit / 静的レビュー / PR diff レビューと相性が良い

### 案 X5: 自動 research を別の cron workflow に分離 (combined を作らない)

却下理由:

- watch と research の連鎖が **遅延** する: watch cron → 1 時間後 research cron では、検出から research まで最大 1 時間のラグが発生する
- 「検出 → 即 research」が `combined` の最大の動機であり、これを満たすには 1 workflow 内連鎖が必要
- research workflow を別にする経路は **既に Phase 2 の `research` 単独 type** として確保しているため、本 ADR の `combined` と並存できる

## Future Work (条件付き再評価)

### F1. Recipe 機構との統合 (workflow recipes)

トリガー条件:

- ADR-0012 / [#172 epic](https://github.com/ozzy-labs/feedradar/issues/172) の recipe 機構が完成し、`recipes/*.yaml` に **20 個以上**の公式 recipe が蓄積
- workflow templates にも site 特化のチューニング (例: AWS 用 max-items / filter-tags の prefab) を求めるニーズが具体化

そのときは「workflow recipe (`workflow-recipes/<usecase>.yaml`)」として workflow template + source recipe の組み合わせをバンドル提供する設計を再評価する。

### F2. agent 自動検出 / multi-agent workflow

トリガー条件:

- 4 agent 以上の運用例が複数蓄積
- 「watch は gemini, research は claude」のような agent 使い分けニーズが具体化

そのときは `workflow generate combined --watch-agent gemini --research-agent claude-code` のような split CLI を Phase 3 で追加する。

### F3. self-hosted scheduler 対応

トリガー条件:

- n8n / temporal / OpenAI Workspace agents の対応要望が複数蓄積

そのときは `radar workflow generate combined --target n8n` のような target switch を別 ADR で起こす。

## 関連

- 親 epic: [#186](https://github.com/ozzy-labs/feedradar/issues/186) feat(cli): `radar workflow generate` サブコマンド
- sub-issues:
  - [#187](https://github.com/ozzy-labs/feedradar/issues/187) docs(adr): 本 ADR
  - [#188](https://github.com/ozzy-labs/feedradar/issues/188) feat(cli): `radar workflow generate watch` 実装
  - [#189](https://github.com/ozzy-labs/feedradar/issues/189) feat(cli): `radar workflow generate combined` (watch + 自動 research + hard cap)
  - [#190](https://github.com/ozzy-labs/feedradar/issues/190) docs(user-guide): `radar workflow` 利用ガイド + 横断 docs 更新
  - [#191](https://github.com/ozzy-labs/feedradar/issues/191) feat(cli): research/review/list/update + agent 別 secrets (Phase 2)
- 関連 ADR:
  - [ADR-0004 Schedule Strategy](./0004-schedule-strategy.md) (本 ADR の起点。`init --with-actions` の責務を保ったまま `workflow generate` で拡張)
  - [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) (`--agent` 切替で agent CLI 経路に乗る)
  - [ADR-0012 JSON API Adapter and Recipe Bundling Strategy](./0012-json-api-adapter-and-recipe-strategy.md) (D7 で `--backfill` 連動を範囲外とする理由 / Future F1 の recipe 統合)
  - [ADR-0020 Claude Routines Generation](./0020-claude-routines-generation.md) (本 ADR の GHA = spawn + API キー方式に対し、routine = 自セッション完結を carve-out。件数上限を literal 化で担保する思想を継承)
- knowledge:
  - [`ai/practice/scheduled-tasks`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/scheduled-tasks.md) (scheduler 比較、ADR-0004 から継承)
