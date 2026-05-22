# ADR-0015: Progress Reporting UX

## Status

Proposed（2026-05-23）— 親 epic [#194](https://github.com/ozzy-labs/feedradar/issues/194) の起点 ADR。実装は sub-issue (#196 / #197 / #198 / #199 / #200) に分割。

## Context

FeedRadar の長時間実行コマンド (`research` / `review` / `update` / `watch run --backfill` / html-js fetch / `source test` 等) は、現状 **進捗がほぼ可視化されていない**:

- `radar research` は agent (claude-code / codex-cli / gemini-cli / copilot) を子プロセスで spawn し、**完了するまで stdout / stderr を string にバッファ**するだけで、実行中は何も表示しない
- agent 実行は **数十秒〜数分** かかるため、user は「フリーズしているのか、進捗しているのか」を判定できない
- 同様の問題は `review` / `update` / `watch run --backfill` (json-api で 80 page 走査) / html-js Playwright fetch / `source test` にも存在
- 現状の唯一の signal は spawn 前後の 2 行のログのみ

### 制約

1. **adapter インターフェース変更は最小に抑える**: 4 種類の agent adapter (claude-code / codex-cli / gemini-cli / copilot) と複数の feed adapter (rss / atom / html / html-js / json-api) が `AgentAdapter` ([ADR-0001](./0001-agent-adapter-interface.md)) / source adapter plug-in pattern ([ADR-0002](./0002-source-adapter-plugin-pattern.md)) の interface に依存している。広範囲な signature 変更は migration コストが高い
2. **CI / non-TTY 環境での regression を起こさない**: 現状の 1 行ログ出力を CI が前提にしているケースがあり、spinner / ANSI escape を CI に流すと log が不可読になる
3. **依存追加を避ける**: README で「単一 npm パッケージ・軽量」を売りにしている。`ora` / `ink` のような progress ライブラリを direct dep に追加するのは過剰
4. **段階的に展開可能であること**: Phase 1 (基盤 + agent 系) / Phase 2 (fetch 系) / Phase 3 (拡張) に分割して merge できる構造にする

## Decision

### D1. `ProgressReporter` 抽象を `src/core/progress.ts` に集約

`src/core/progress.ts` (~150 LoC) に以下の interface を定義し、CLI / agent adapter / feed adapter から共通に使う。canonical 定義は実装 PR (#196) で確定するが、想定 shape は次のとおり:

```typescript
export interface ProgressReporter {
  /** phase 区切りを表示する。例: "Spawning claude-code…" */
  phase(marker: string): void;
  /** heartbeat tick (TTY のみ spinner と elapsed time を更新する) */
  tick(metrics?: ProgressMetrics): void;
  /** 副次メトリクスを更新する (page x/N、stdout bytes 等) */
  update(metrics: ProgressMetrics): void;
  /** 子プロセスの stdout 1 行 pass-through (--verbose 時のみ render) */
  stream(line: string): void;
  /** 完了 / 失敗で reporter を閉じる */
  done(status: "ok" | "error", summary?: string): void;
}

export interface ProgressMetrics {
  elapsedMs?: number;
  stdoutBytes?: number;
  outputBytes?: number;
  pageIndex?: number;
  pageTotal?: number;
}
```

3 層構造で動作する:

1. **Phase markers** — 構造化された節目 (Loaded item / Spawning / Agent completed / Frontmatter validated / Status transition)。常に 1 行で出る (TTY / non-TTY 共通)
2. **Heartbeat spinner** — TTY 時のみ。1 秒間隔で `[mm:ss]` の経過時間と spinner frame を同一行に上書き表示
3. **副次メトリクス** — `stdout bytes`、`output file size`、`page x/N` 等。phase markers の括弧書きまたは spinner 行に併記

### D2. TTY 自動検出 + フラグ / env 切替

挙動切替は以下のルールで決定する。優先度は env > flag > 自動検出:

| 条件 | 挙動 |
| --- | --- |
| `RADAR_NO_PROGRESS=1` | spinner / tick を完全に無効化。phase markers と完了 1 行のみ |
| `--quiet` | 完了 1 行のみ。phase markers / spinner / stream をすべて抑制 |
| `--verbose` | phase markers + spinner + agent stdout pass-through (`reporter.stream()`) |
| TTY 検出: `process.stderr.isTTY === true` かつ上記なし | phase markers + spinner |
| non-TTY（CI / pipe）かつ上記なし | phase markers のみ。spinner を line-by-line plain text に degrade（同一行上書きを使わない） |

判定実装は `ProgressReporter` 内部に閉じる。CLI / adapter 側は判定ロジックを意識しない。

### D3. adapter インターフェース変更は `onProgress` callback の追加のみ

既存 interface の signature を破壊せず、optional な `onProgress?: ProgressReporter` を追加する形に留める。

- `AgentAdapter.research` / `review` / `update` の `ResearchRequest` / `ReviewRequest` / `UpdateRequest` に `onProgress?: ProgressReporter` を追加
- `FeedAdapterOptions` に `onProgress?: ProgressReporter` を追加（html-js / json-api / html / rss / atom 共通）
- 既存呼び出しは `onProgress` を渡さなければ no-op になる

呼び出し側 (`src/cli/*.ts` / `src/core/feeds/*.ts`) は `ProgressReporter` を作って `onProgress` に渡し、adapter 側は受け取った reporter を任意のタイミングで呼ぶ。adapter が reporter を呼ばなくても compile / runtime ともに壊れない（forward-compat）。

### D4. Phase markers 命名規約

phase markers は以下の動詞・形を統一する。新規 phase を追加する際もこの規約に従う:

| パターン | 用途 | 例 |
| --- | --- | --- |
| `Loaded <noun>` | 入力 (item / config / template 等) を読み込み完了 | `Loaded 12 items from queue.jsonl` |
| `Spawning <agent>` | 子プロセスを spawn する直前 | `Spawning claude-code (cwd: /tmp/feedradar-research-…)` |
| `Agent running… [mm:ss]` | heartbeat tick（spinner 行に併記、TTY のみ上書き） | `⠋ Agent running… [01:23]  stdout: 4.2 KB` |
| `Agent completed (<duration>, exit <code>)` | 子プロセス終了 | `Agent completed (1m23s, exit 0)` |
| `<status>` 遷移 | item / pipeline の状態変化 | `Status: detected → researched` |
| `Fetched <noun>` | 外部 fetch 完了 | `Fetched 80/80 pages from api.example.com` |
| `Page <i>/<n>` | pagination 進行中 (副次メトリクス) | `Page 42/80` |
| `Chromium launching` / `Page navigated to <url>` / `Selector matched` | html-js Playwright phase | (Phase 2) |

phase markers は **副作用を伴わない**（exit code / control flow に影響しない）。デバッグ用の追加情報は phase markers の後ろに括弧書きで添える。

PID 等の補助情報は副次メトリクスに統合する（将来 Phase 3 で adapter インターフェース拡張時に再評価）。

### D5. 段階的展開計画

実装は親 epic [#194](https://github.com/ozzy-labs/feedradar/issues/194) で 3 Phase に分割する。本 ADR は Phase 1 着手前の起点として確定する:

| Phase | 範囲 | sub-issue |
| --- | --- | --- |
| **Phase 1: 基盤 + agent 系** | `src/core/progress.ts` 実装、4 agent adapter に `onProgress` callback、`research` / `review` / `update` CLI 統合、`--verbose` / `--quiet` / `RADAR_NO_PROGRESS` 対応 | #196, #197 |
| **Phase 2: fetch 系** | `watch run --backfill` (json-api) の page x/N、html-js Playwright の phase 表示、`source test` 統合 | #198 |
| **Phase 3: 拡張（条件付き）** | hung 検出 (60 秒以上 stdout なしで warning)、token / cost meter、SIGINT 段階的終了 (SIGTERM → 3 秒後 SIGKILL) | #199 |
| **Docs** | user-guide に progress UX ガイド + トラブルシュート | #200 |

各 Phase は独立して merge 可能。Phase 2 / 3 は Phase 1 の基盤 (`ProgressReporter` interface) を前提とする。

## Consequences

### 良い面

- **user の安心感**: 長時間操作で「フリーズしているのか」を判定でき、Ctrl+C 判断・待ち判断ができる
- **debug 用途で stdout pass-through 可能**: `--verbose` で agent CLI 内部のログを直接見られる → support / bug report の質が上がる
- **adapter migration コストが最小**: optional callback のみ追加するため既存 adapter / 呼び出しは破壊変更なし。Phase 1 で agent adapter 4 種、Phase 2 で feed adapter を順次対応できる
- **CI / non-TTY の regression なし**: `process.stderr.isTTY` 判定で plain text 1 行ずつに degrade、既存 CI ログ運用と互換
- **依存追加なし**: ANSI escape / spinner frame の自前実装 ~150 LoC で完結

### 悪い面 / 制約

- **4 agent adapter + 全 long-running CLI に横断的に手が入る**: signature 自体は optional だが、各 adapter が reporter を呼ぶ実装は個別に追加が必要。test mock も増える
- **TTY 検出の境界ケース**: `MINGW64` / WSL / Docker exec 等で `process.stderr.isTTY` が想定外に立つ／立たないケースがある → `RADAR_NO_PROGRESS=1` で escape できる旨を user-guide に明記する
- **agent stdout pass-through のセキュリティ**: agent が untrusted content を含む string を stdout に出した場合、`--verbose` で terminal に流れる。ANSI escape injection には ADR-0009 の untrusted content 方針に沿って sanitization を別途検討（Phase 3 までに最小限）

### 中立

- 将来 agent API 経由で token / cost を取得できるようになれば、`ProgressReporter.update()` の `metrics` を拡張するだけで対応可能（CLI invoke の枠を超えるため Phase 4 以降）
- progress 表示の TUI 化 (`ink` 等) は overkill のため scope 外。CI 互換性が悪く、現状の使用パターン (CLI 1 コマンド = 1 タスク) では spinner で十分

## Alternatives

### 案 A: 既存 `console.log` 直書き + 各箇所で個別に進捗実装

却下理由:

- agent adapter / feed adapter / CLI でそれぞれ独自の出力形式が乱立する → 一貫性なし、phase markers の命名がブレる
- TTY 判定ロジックが各所に散らばる → CI regression を起こしやすい
- `--verbose` / `--quiet` / `RADAR_NO_PROGRESS` の挙動切替を各箇所で実装する必要があり保守困難
- 再利用なし → 新規 CLI コマンドを追加するたびに同じコードを書き直すことになる

### 案 B: 外部ライブラリ (`ora` 等) を direct dep として採用

却下理由:

- README:16 の「単一 npm パッケージ・軽量」と衝突。`ora` 自体は軽量だが、依存追加コストと API 表面の拘束が増える
- 自前実装 ~150 LoC で十分なため (`process.stderr.write` + ANSI escape `\x1b[K\r` の組み合わせ)、外部 lib 採用の justification が弱い
- ライブラリ API の追従コスト（major version up）が増える
- `ora` の API は spinner 中心で、phase markers / 副次メトリクス / stdout pass-through 等の 3 層構造には合わない

### 案 C: リッチ TUI (`ink` 等)

却下理由:

- overkill。CLI 1 コマンド = 1 タスクの shell 連携 (`radar research | tee log.txt` 等) と相性が悪い
- CI 互換性が悪い（TTY 前提の component が多い）
- React 系の依存追加で install footprint が一気に増える
- ユーザーが慣れた CLI 表現 (phase markers + spinner) で十分なため UX 上のメリットが薄い

### 案 D: adapter interface を `EventEmitter` ベースに刷新

却下理由:

- 既存 interface ([ADR-0001](./0001-agent-adapter-interface.md)) を破壊変更する必要があり、migration コストが高い
- adapter ごとに event 名 / payload 形式を揃える追加 ADR が必要になり、scope が肥大化する
- optional callback (`onProgress?: ProgressReporter`) のほうが migration step が最小（D3）

## 関連

- 親 epic: [#194](https://github.com/ozzy-labs/feedradar/issues/194) feat(cli,core): radar コマンドの進捗表示 UX 改善
- sub-issues:
  - [#195](https://github.com/ozzy-labs/feedradar/issues/195) docs(adr): 本 ADR
  - [#196](https://github.com/ozzy-labs/feedradar/issues/196) feat(core): `ProgressReporter` 抽象 + 4 agent adapter に `onProgress` callback
  - [#197](https://github.com/ozzy-labs/feedradar/issues/197) feat(cli): research / review / update に統合 + `--verbose` / `--quiet` フラグ
  - [#198](https://github.com/ozzy-labs/feedradar/issues/198) feat(cli,feeds): watch run --backfill / html-js / source test に進捗統合
  - [#199](https://github.com/ozzy-labs/feedradar/issues/199) feat(cli): hung 検出 + token / cost meter + SIGINT 段階的終了
  - [#200](https://github.com/ozzy-labs/feedradar/issues/200) docs(user-guide): progress UX ガイド + トラブルシュート
- 関連 ADR:
  - [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) — `onProgress` callback の追加先 interface
  - [ADR-0002 Source Adapter Plug-in Pattern](./0002-source-adapter-plugin-pattern.md) — feed adapter 側の callback 追加先
  - [ADR-0009 Untrusted External Content Handling](./0009-untrusted-external-content-handling.md) — agent stdout pass-through の sanitization 方針
  - [ADR-0010 html-js Adapter and Playwright Distribution](./0010-html-js-adapter-and-distribution.md) — Phase 2 で html-js fetch の phase 表示を統合
