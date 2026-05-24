# ADR-0019: Host-agent (in-session) Research Execution Mode

## Status

Accepted（2026-05-23）

> Post-merge review は welcome。指摘がある場合は follow-up issue で起票してください。本 ADR は host-agent モード PoC ([#254](https://github.com/ozzy-labs/feedradar/issues/254)) の実装起点として固定する。

## Context

### interactive 起動が「意図的に spawn へ委譲」している現状

interactive な agent セッション (Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) から `/research <id>` を呼ぶと、`.claude/skills/research/SKILL.md` (thin wrapper) が `radar research $ARGUMENTS` に shell out し、CLI が **別の agent サブプロセスを spawn** ([ADR-0001](./0001-agent-adapter-interface.md)) して research を実行する。

engine SKILL ([`src/skills/research/SKILL.md`](../../src/skills/research/SKILL.md)) の "Invocation modes" は 2 モードを定義しており、interactive invocation は手順を実行せず `radar research` に shell out するよう明記している。つまり「ユーザーが既に対話している有能な agent セッション」があるのに、その中からさらに **nested に新しい agent を起動**する構造になっている。これには次の摩擦がある:

- **二重のモデル起動・二重クォータ消費** — ホストセッション (対話枠) + spawn される `claude -p` の両方を消費する
- **透明性・ステアリング性の喪失** — spawn された agent は headless で動くため、ユーザーは推論過程を見られず、途中で止める・方向修正することもできない (`--verbose` でも事後)
- **コールドスタートのオーバーヘッド** — item ごとに新プロセス起動 + SKILL 再読込 + コンテキスト再ロードが走る
- **概念的ミスマッチ** — 「今 research して」と頼んでいるのに、対話相手ではなく裏の別プロセスに丸投げされる

### 欠けているのは「レポート生成」ではなく finalize プリミティブ

ホストセッションは engine SKILL の手順を技術的には実行できる (手順も `ResearchFrontmatterSchema` も SKILL に全量ある) にもかかわらず、interactive mode はそれを **意図的に避けて spawn に委譲**している。その理由は単純で、**ホストが書いたレポートを finalize する CLI プリミティブが無いから**である。

SKILL は「`items/*.yaml` を書き換えるな (CLI が status 遷移を担当)」と明記しており ([ADR-0008](./0008-status-state-machine.md))、ホストが手順を実行してレポートを書いても `detected → researched` 遷移と `ResearchFrontmatterSchema` 検証 ([ADR-0003](./0003-output-format-and-versioning.md)) を行う standalone の口が無い。結果、status が `detected` のまま取り残される。

| 工程 | 現状 |
|---|---|
| research レポート生成 (engine SKILL の手順) | adapter spawn として実装済み。ホストも技術的には実行可能だが、interactive mode は実行を禁止し spawn に委譲 |
| `detected → researched` 遷移 + `ResearchFrontmatterSchema` 検証 | **standalone コマンドが無い** (spawn 経由でしか走らない) = interactive mode が spawn に委譲する根本理由 |

→ 欠けているのは **CLI の finalize プリミティブ**だけ。これを提供すれば、interactive 起動を「spawn に委譲」から「**ホストセッションで手順実行 → finalize**」へ切り替えられる。

本 ADR は、この finalize プリミティブと、その上に成立する **host-agent (in-session) 実行モード**の設計判断を確定させる ([#254](https://github.com/ozzy-labs/feedradar/issues/254))。

## Decision

`radar research` に **prepare / commit の 2-call protocol** (案 A) を導入する。radar が payload 構築・schema 検証・status 遷移・untrusted 境界の責任を保持したまま、**モデル呼び出しのステップだけをホストセッションに委ねる** opt-in モードである。

### prepare/commit 2-call protocol

1. **`radar research <id> --emit-payload`** (prepare)
   - item ロード + テンプレ解決 + `outputPath` 確定 + **`<untrusted_item>` ラップ済みコンテンツ**を含む payload を **stdout に出力**する。**agent は spawn しない。**
   - item は `detected` のまま (後述「researching ロック status を追加しない」)。
2. ホストセッション (`.claude/skills/research/SKILL.md` の interactive 経路) が `.agents/skills/research/SKILL.md` の手順に従って `outputPath` にレポートを生成する。
3. **`radar research --commit <path>`** (commit)
   - 書かれたファイルを `ResearchFrontmatterSchema` で検証し、`detected → researched` に遷移する。検証失敗時はロールバックして非ゼロ終了。

`radar research <id> --agent <id>` の従来 spawn パスは **default のまま不変**。host モードは `--emit-payload` / `--commit` の opt-in。

### `finalizeResearch()` を spawn パスと commit パスで共有

`detected → researched` 遷移・`ResearchFrontmatterSchema` 検証・frontmatter drift 自動補正 (`reviewedAt` / `reviewedBy` / `supersedes` を `null` に正規化)・「already exists」衝突ガードは、spawn パスと commit パスで **同一の `finalizeResearch()` を共有**する。これにより:

- schema 検証・status 遷移は **CLI が一元担保**する ([ADR-0003](./0003-output-format-and-versioning.md) / [ADR-0008](./0008-status-state-machine.md))
- spawn 後の finalize と外部生成 report の commit が **二重実装ゼロ**で揃う
- host モードと spawn モードの finalize 挙動が常に一致し、drift しない

### `--emit-payload` の出力フォーマット

stdout のみに出力する (一時ファイルは作らない)。**人間可読プロンプト + 末尾に機械可読 JSON フェンス**のハイブリッド形式とする:

- 冒頭に `=== FEEDRADAR RESEARCH PAYLOAD (host-agent mode) ===` ヘッダ
- `Write the Markdown report to: <outputPath>`
- `After writing, run: radar research --commit <outputPath>`
- `Items to research: <ids>`
- `<untrusted_item>...</untrusted_item>` でラップ済みの item ブロック ([ADR-0009](./0009-untrusted-external-content-handling.md) M1c)
- Constraints (frontmatter の `reviewedAt: null` / `reviewedBy: null` / `supersedes: null` 規約 + M2a / M2b / M3b の要約)
- 末尾に、adapter spawn の stdin payload とスキーマ互換な ` ```json {...}``` ` フェンス

人間可読部はホストセッションが手順を読んで実行するために、JSON フェンスは spawn の stdin contract ([`docs/design/skill-design.md`](../design/skill-design.md) §1) との互換を保ち、将来 host adapter 化する場合にも同一 payload を使い回せるようにするため両方を載せる。

### `researching` ロック status を追加しない (PoC)

prepare→commit 間の race を防ぐために `researching` のような中間ロック status を `ItemStatusSchema` に追加することは **PoC では行わない**:

- `outputPath` は決定論的に確定し、既存の **「already exists」衝突ガード**が backstop として機能する (同一 item の commit が二重に走っても 2 回目はファイル存在で reject)
- status set を増やさず、[ADR-0008](./0008-status-state-machine.md) / [ADR-0018](./0018-triage-extension.md) の state machine を不変に保つ

ただし運用上の注意として、**prepare→commit 間に同一 workspace の cron (`research --batch` 等) を重ねない**ことをドキュメントに明記する (interactive と無人 cron を同時に同一 item に向けない)。

## Consequences

### 良い面

- **二重クォータ消費の解消** — ホストセッションが手順を実行するため、nested な `claude -p` spawn が不要になる
- **透明性・ステアリング性** — ユーザーが推論過程を見ながら途中で方向修正できる
- **コールドスタート削減** — warm な既存セッションを使うため、プロセス起動 + SKILL 再読込のオーバーヘッドが消える
- **finalize の SSoT 化** — `finalizeResearch()` 共有で schema 検証・status 遷移が spawn / host の両パスで一致 (二重実装ゼロ)
- **後方互換** — 既存 `--agent <spawn>` は default のまま、host モードは opt-in

### 悪い面・制約

- **interactive 専用** — host モードは CI / headless では使えない (後述セキュリティ posture)。cross-agent review が要るケースは従来 spawn を使う (両立・共存)
- **cross-agent との非両立** — research=claude / review=codex のようなクロス運用は単一ホストセッションでは成立しない。host モードは「ホストと同じ agent で十分な場合」の最適化と位置づける
- **2-call の手続き** — prepare と commit が分離するため、ホストセッションが手順を完遂しないと status が `detected` に取り残される (commit を忘れると未 finalize)
- **race の運用注意** — `researching` ロックを持たないため、prepare→commit 間に同一 item へ cron を重ねない運用注意が必要 (「already exists」ガードが backstop)

#### セキュリティ posture の差 (最重要)

host モードと spawn モードでは untrusted item content の **blast radius が構造的に異なる**。これが host を opt-in / interactive 専用に留め、CI / headless では無効とする根拠である:

- **spawn モード**: untrusted item content は、使い捨ての **headless サブプロセス**のコンテキストに閉じる。prompt injection が成立しても、影響はそのサブプロセスの寿命・権限内に限定される ([ADR-0009](./0009-untrusted-external-content-handling.md) の defense-in-depth スタックがこの前提で設計されている)
- **host モード**: untrusted item content は、ユーザーの **対話セッション本体**のコンテキストに入る。対話セッションは対話的に付与された広い tool 権限や standing approval を持つため、prompt injection が成立した場合の blast radius が大きい

この差ゆえに:

- host モードは **interactive 専用の opt-in** に留める
- CI / headless では host モードを **無効**とし、adapter spawn を SSoT として **CI parity を維持**する
- [ADR-0009](./0009-untrusted-external-content-handling.md) の M1c boundary marker (`<untrusted_item>` ラップ) は `--emit-payload` の payload に含めることで host 実行時にも継続適用される。engine SKILL の M2a / M2b / M3b guidance (untrusted instruction に従わない / tool 呼び出し前 self-check / workspace 外 write 禁止) も host 実行時にそのまま適用される

### 中立

- `--emit-payload` / `--commit` は `radar research` のサブコマンドオプションとして追加 (新 top-level コマンドは増やさない)
- payload の JSON フェンスは spawn の stdin contract とスキーマ互換に保つため、将来 host adapter 化しても payload を使い回せる
- engine SKILL の "Invocation modes" は 2 → 3 モード (Adapter spawn / Interactive shell-out / Host-agent in-session) になり、interactive wrapper (`.claude/skills/` / `.gemini/commands/`) は host モード対応に追随する (slash / mention 起動時のみ。CI / adapter spawn パスは不変)

## triage / review / update への展開方針

本 ADR は **research を PoC** として固定したが、その後の follow-up で **review / update / triage も shipped** 済み (review / update は research と同型、triage は別契約)。各コマンドの展開状況:

- **research** (PoC, #260): prepare/commit 2-call (`--emit-payload` / `--commit`) を確立。`prepareResearch` / `finalizeResearch` 抽出、spawn・emit・commit が単一 finalize を共有。
- **review / update** (follow-up): research と **同型** (Markdown レポート生成 → finalize)。同じ prepare/commit 契約をそのまま適用。`review` は in-place 改変 (`reviewedAt` / `reviewedBy` stamp + review block 追記 → `researched → reviewed`)、`update` は v+1 ファイル生成 (supersedes / createdAt / itemIds drift 検証、items.yaml status 不変 per [ADR-0008](./0008-status-state-machine.md))。いずれも spawn パスと finalize を共有し、`--commit` path は `resolveCommitPathInside` で `<cwd>/research/` に制約 (literal prefix + symlink realpath、M3b をコードで担保)。
- **triage** ([#279](https://github.com/ozzy-labs/feedradar/issues/279), follow-up): per-item の `TriageDecision` を書く **別形** (Markdown レポートファイルが無い、[ADR-0018](./0018-triage-extension.md))。research とは別物の payload / commit 契約として shipped。`--emit-payload` は 1 source の `detected` items を triage する payload (= `buildTriagePrompt` の triage request を host framing で包んだもの) を stdout に出力し、`--commit <path>` は host が書いた decisions JSON (`{ agent, sourceId, decisions: [...] }`) を source policy + on-disk detected items で **再検証** (spawn パスと同じ `parseTriageResponse` — hallucinated-id reject / confidence・digest demotion) してから status 遷移を適用する。`--commit` path は `resolveCommitPathInside` で `<cwd>/triage/` に制約 (M3b をコードで担保)。検証・status 遷移は CLI が一元担保し、host は decisions を書くだけ。[ADR-0020](./0020-claude-routines-generation.md) が routine フルパイプラインの前提として contract を確定させた。

## Alternatives

### 案 B: `--agent host` (stdio contract の擬似 adapter) — 却下

spawn の代わりに、radar が prompt / payload を stdout に出して結果を stdin で受け取る擬似 adapter を 1 つ足す案。既存の adapter 抽象 ([ADR-0001](./0001-agent-adapter-interface.md)) に自然に乗るように見えるが、却下する:

- `AgentAdapter.research` は `(req) => Promise<void>` で、「**子プロセスを spawn してファイル書き込みを同期的に待つ**」契約である。host モードでは書き込みがプロセス外・CLI 終了後 (別 call の `--commit` 時) に起きるため、この synchronous adapter 契約に乗らない
- `--agent` は「**どのモデル / CLI か**」を選ぶ軸であり、host モードは「**誰が制御を握るか**」という制御反転の軸である。両者を `--agent` に混ぜると、adapter interface の意味が二重化する
- → 制御反転は `--emit-payload` / `--commit` という別の surface で表現し、`--agent` には混ぜない

### 案 A の単一 call 化 (radar が結果を stdin で待つ) — 不採用

prepare と commit を 1 call にまとめ、radar が payload を出した後に同一プロセスで結果を待つ案も検討余地があるが、ホストセッションはユーザーの対話ターンをまたいでレポートを生成するため、CLI プロセスが結果を同期的に待ち続けるのは interactive UX に合わない。prepare (emit) と commit を **明示的に分離**することで、ホストセッションが任意のタイミングでレポートを書き、ユーザーが内容を確認してから commit できる。

## 関連

- 親 issue: [#254](https://github.com/ozzy-labs/feedradar/issues/254) (feat: ホストセッション内 research/triage/review)
- 関連 ADR:
  - [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) — 案 B 却下の根拠 (`research: (req) => Promise<void>` の synchronous spawn 契約)
  - [ADR-0003 Output Format and Versioning](./0003-output-format-and-versioning.md) — `finalizeResearch()` が共有する `ResearchFrontmatterSchema` 検証・frontmatter drift 補正
  - [ADR-0008 Item Status State Machine](./0008-status-state-machine.md) — `detected → researched` 遷移を host commit でも CLI が一元担保、`researching` ロック status は追加しない
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) — M1c boundary marker を `--emit-payload` payload に含め、M2a / M2b / M3b guidance を host 実行時にも適用。host / spawn の blast radius 差が本 ADR §Consequences の根拠
  - [ADR-0018 LLM-based Triage Extension](./0018-triage-extension.md) — triage は per-item `TriageDecision` を書く別形のため payload/commit 契約が別物 (host 化は優先度低)
  - [ADR-0020 Claude Routines Generation](./0020-claude-routines-generation.md) — 本 ADR の「対話専用・headless 無効」制約を routine 向けに carve-out。routine は使い捨て VM・fresh clone・standing approval 無し・connector/network 最小化で blast radius を抑え、自セッション処理を解禁する
- 関連 docs:
  - [`docs/user-guide.md`](../user-guide.md) — §クロスエージェント運用 近傍に host-agent モードのサブセクション
  - [`docs/design/skill-design.md`](../design/skill-design.md) — Invocation modes 2 → 3 モード化、§9 open questions に review/update/triage 展開方針
