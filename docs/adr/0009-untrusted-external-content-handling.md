# ADR-0009: Untrusted External Content Handling for Agent Prompts

## Status

Accepted（2026-05-16）— 採択した緩和策の実装は **本 ADR 採択後に別 sub-issue として切り出す**。本 ADR は **採用 / 留保 / 却下** の確定のみを行う。

## Context

agentic-watch は外部 feed (RSS / HTML / GitHub Releases / npm-registry) から取得した item content を 4 種の agent CLI に渡す。4 adapter すべて [ADR-0001](./0001-agent-adapter-interface.md) の非対話モード前提により tool 承認を skip して起動するため (`bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox` / `--allow-all-tools` / `-y --skip-trust`)、item content に混入した prompt injection が agent の tool execution を悪用するリスクが構造的に存在する。

詳細な攻撃面 / 被害範囲 / 緩和候補の整理は [`docs/design/threat-model.md`](../design/threat-model.md) を参照。本 ADR はその threat model に対し、`#49` の 5 設計検討項目 (M1〜M5) の **採否を判定**する。

判定基準:

- **コスト**: 実装 + 運用コスト (LOC / API call / 計算量 / UX 悪化)
- **効果**: lethal trifecta ([prompt-injection.md § 0](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md#0-lethal-trifecta致死の三要素)) のどの辺を切れるか
- **副作用**: false positive / UX 悪化 / 既存 ADR との抵触
- **位置づけ**: defense-in-depth のどの層に該当するか ([prompt-injection.md § 防御の階層](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md#防御の階層))

## Decision

5 項目それぞれを以下のように分類する:

| ID | 緩和策 | 判定 | 理由要約 |
|---|---|---|---|
| **M1a** | regex pre-filter | **Adopt (best-effort)** | 低コスト、検出ログ (M5a) と組合せると auditability が上がる |
| **M1b** | LLM-as-a-judge 前処理 | **Reject** | item 数 × API call の cost 爆発、false positive リスク、既存層と effort 重複 |
| **M1c** | boundary marker (`<untrusted_item>...</untrusted_item>`) | **Adopt** | 最重要 layer 1 防御、最小コスト、SKILL 改訂 (M2a) と pair |
| **M2a** | SKILL.md に untrusted instruction を従わない旨を明示 | **Adopt** | M1c の penalty を効かせるための必須 pair |
| **M2b** | tool 呼び出し前 self-check 手順を SKILL に記述 | **Adopt (advisory)** | 完全防御ではないが SKILL の guidance として無害、prompt-injection.md の「過信禁物」前提で記述 |
| **M3a** | sandbox / container 実行 | **Defer** | 抜本的だが UX / 上流非保証で大規模、user-side で dedicated dev container 運用するガイドへ移譲 |
| **M3b** | workspace 外 write 禁止 | **Adopt (SKILL guidance)** | agent CLI の tool 制御は本質的に上流次第、SKILL に instruction として書く以上のことはしない |
| **M4** | `Source.trustLevel` metadata (default `"untrusted"`) | **Adopt** | schema 拡張のみで policy 切替の将来基盤、当面のロジックは「全 source untrusted 扱い」固定 |
| **M5a** | injection 検出を frontmatter / log に記録 | **Adopt** | M1a の検出結果を載せるだけ、auditability 大 |
| **M5b** | 検出時に status=dismissed に自動遷移 | **Reject** | false positive で legitimate item を捨てる、user triage を奪う、安全側に倒すなら別 status (例: `quarantined`) が必要 → 設計判断はさらに別 issue |

### 採用策の defense-in-depth 配置

```text
                  ┌─ M1a (regex pre-filter, best-effort) ─┐
                  │            │                          │
                  │            ▼                          │
                  │     M5a (log/frontmatter 記録) ──────┤
                  │                                       │
[adapter fetch] ──┴────► [item schema parse] ────► items/<id>.yaml
                                                          │
                                                          ▼
                                                  [research/review/update CLI]
                                                          │
                                                          ▼
                                  ┌─ M1c (boundary marker) ─┐
                                  │           │             │
                                  │           ▼             │
                                  ▼   prompt builder        ▼
                          M2a (SKILL: 従わない)  M2b (self-check)
                                                          │
                                                          ▼
                                                   M3b (workspace 外 write guidance、SKILL)
                                                          │
                                                          ▼
                                              [agent CLI spawn] (YOLO 不可避)
```

M4 (`Source.trustLevel`) は **schema レベルの基盤**として上記スタックの判定入力に使う (例: M1a の検出感度を trustLevel 別に切替、将来追加)。

### 留保 / 却下の理由詳細

#### M1b LLM-as-a-judge — Reject

- item 1 件ごとに別 LLM call が必要 → research が 1 item → 1 call の現状から **2x 以上のコスト**
- judge の false positive で legitimate item を block する設計上の責任が agentic-watch 側に集中
- ADR-0008 (status machine) と整合せず、判定結果を載せる status が無い (M5b と相互依存)
- 採用したい場合は **別 ADR / 別 issue で改めて検討** (本 ADR では reject、再評価は禁止しない)

#### M3a sandbox / container — Defer

- 抜本的だが、agent CLI 自身 (claude / codex / gemini / copilot) が container 内動作を保証しない (上流ベンダー依存)
- agentic-watch 側で sandbox wrapper を被せると、agent CLI の認証 / cache / settings dir が container 外参照で壊れる
- user-side の運用ガイダンス (`docs/user-guide.md` の警告: dedicated dev container, [#48](https://github.com/ozzy-labs/agentic-watch/issues/48)) で当面の責務移譲は成立
- Phase 7 (現状 VS Code extension 想定) や別 Phase で **agentic-watch 専用 dev container 雛形を吐く** のは検討余地あり (`init --with-devcontainer` 等)、別 issue で別途

#### M5b auto-dismiss — Reject

- false positive で legitimate item が消える (regex は本質的に弱い)
- user の triage 判断を agentic-watch が奪う形になる
- 安全側に倒すなら新 status (例: `quarantined`) と user 承認手順が必要 → ADR-0008 改訂が必要 → 本 ADR の範囲を越える
- 採用したい場合は **別 ADR / 別 issue で status machine 改訂** とセットで再評価

## Implementation Status (2026-05-17)

採択時 (2026-05-16) は「採用 / 留保 / 却下 の確定のみ、実装は別 sub-issue」と明記していた。2026-05-17 時点で **採用 7 個別策はすべて実装済み**、却下 / 留保策の状態も以下のとおり確定している。

| ID | 緩和策 | 状態 | 実装位置 |
|---|---|---|---|
| **M1a** | regex pre-filter | **Shipped** | [`src/core/injection-detector.ts`](../../src/core/injection-detector.ts) — `detectInjection()` |
| **M1c** | boundary marker (`<untrusted_item>...</untrusted_item>`) | **Shipped** | [`src/agents/_boundary.ts`](../../src/agents/_boundary.ts) — `wrapUntrusted()` / `renderItemForPrompt()` を prompt builder から呼び出し |
| **M2a** | SKILL.md に untrusted instruction を従わない旨を明示 | **Shipped** | [`src/skills/research/SKILL.md`](../../src/skills/research/SKILL.md) / [`src/skills/review/SKILL.md`](../../src/skills/review/SKILL.md) / [`src/skills/update/SKILL.md`](../../src/skills/update/SKILL.md) の "Untrusted content boundary" セクション |
| **M2b** | tool 呼び出し前 self-check 手順 | **Shipped** | 同上 "Untrusted content boundary" セクション (advisory) |
| **M3b** | workspace 外 write 禁止 (SKILL guidance) | **Shipped** | 同上 "Untrusted content boundary" セクション |
| **M4** | `Source.trustLevel` metadata (default `"untrusted"`) | **Shipped** | [`src/schemas/source.ts`](../../src/schemas/source.ts) — `TrustLevelSchema.default("untrusted")` |
| **M5a** | injection 検出を frontmatter / log に記録 | **Shipped** | [`src/schemas/item.ts`](../../src/schemas/item.ts) — `injectionFlags: z.array(z.string()).default([])`、M1a の検出結果が item frontmatter に載る |
| M1b | LLM-as-a-judge 前処理 | Reject — **未実装、再評価予定なし** | (なし) |
| M5b | 検出時 status=dismissed 自動遷移 | Reject — **未実装、status machine 改訂と pair で再評価** | (なし) |
| M3a | sandbox / container 実行 | Defer — **agentic-watch 側では未実装、user-side dedicated dev container 運用で代替** | (なし、[`docs/user-guide.md`](../user-guide.md) § Security 警告 + ADR-0009 § Defer 理由を参照) |

実装は採択時の sub-issue 分割 (schema → core → agents → skills) に従って段階的に shipped され、Phase 5 終了時点で 7 個別策が出揃った。本 ADR の **判定そのものは不変** — 状態 callout は実装側の trace 用記録。

## Consequences

### 良い面

- **layer 1 防御 (M1c + M2a) が確立** → cheapest かつ最も効果のある対策が入る
- **auditability 向上 (M5a)** → 事後追跡が可能、incident 対応の起点ができる
- **schema 拡張 (M4)** → 将来 policy 拡張時の breaking change を回避
- **defense in depth スタック** → 単層が破られても他層が残る

### 悪い面 / 制約

- **完全防御は不可能** (`docs/design/threat-model.md` § 残留リスク に明記)
- **sandbox を入れていない** ため lethal trifecta の "sensitive data access" + "exfiltration" は切れない
- **user 側の最終責務 (`docs/user-guide.md` 警告) は引き続き必須** — agentic-watch だけで安全運用は完結しない
- **agent CLI 上流の挙動変更** (LLM の素直さ / tool 制御方針) に防御の最後尾が依存

### 中立

- 4 source kind すべてを untrusted 扱い → M4 の trustLevel default は `"untrusted"`、`"trusted"` は **明示 opt-in** (user が source 設定 yaml で書く)
- 採用した緩和策 5 件 (M1a / M1c / M2a / M2b / M3b / M4 / M5a — 計 7 個別策) の **実装は各 sub-issue で別途切り出す**:
  - sub-issue 候補:
    1. `feat(schemas): add Source.trustLevel field (default untrusted)` (M4)
    2. `feat(core): regex pre-filter + frontmatter/log audit on detection` (M1a + M5a)
    3. `feat(agents): boundary marker in prompt builder` (M1c)
    4. `docs(skills): instruct agents not to follow untrusted_item instructions` (M2a + M2b + M3b)
- ADR-0001 改訂は **本 ADR の範囲外**: adapter interface 自体に sanitize hook を生やすかは別 ADR (M1a が prompt builder 側でなく adapter 側に来る設計を選ぶ場合のみ)

## Alternatives

### 案 X: 全 mitigation を一気に実装する monolithic PR

却下理由: design 段階で全部決め切るには各層の trade-off の実測値が必要。defense-in-depth は段階的に積む方が選択肢を保てる。

### 案 Y: 何もしない (user 責務に完全移譲)

却下理由: 現状の `docs/user-guide.md` 警告 ([#48](https://github.com/ozzy-labs/agentic-watch/issues/48)) だけでは、layer 1 防御 (信頼境界の明確化) を実装側が担保しない設計になっている。最低限 M1c + M2a は必須。

### 案 Z: sandbox を最優先で入れる

却下理由: 効果は最大だが、上流ベンダー (claude / codex / gemini / copilot) の保証が無く、また `init` 時に user 側に大規模インフラ (Docker / firejail) を要求する。Phase 7 以降の dev container 雛形 ([#48](https://github.com/ozzy-labs/agentic-watch/issues/48) の方向性) で再検討。

## 関連

- 親 issue: [#49](https://github.com/ozzy-labs/agentic-watch/issues/49) chore(security) design prompt injection mitigation
- threat model: [`docs/design/threat-model.md`](../design/threat-model.md)
- 関連 ADR:
  - [ADR-0001 Agent Adapter Interface](./0001-agent-adapter-interface.md) (4 adapter の YOLO 起動の出所)
  - [ADR-0006 Filter Specification](./0006-filter-specification.md) (filter 層との配置整合)
  - [ADR-0008 Item Status State Machine](./0008-status-state-machine.md) (M5b 却下理由の出所)
- 関連 docs: [`docs/user-guide.md`](../user-guide.md) § Security 警告 ([#48](https://github.com/ozzy-labs/agentic-watch/issues/48))
- knowledge:
  - [`ai/practice/prompt-injection`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/ai/practice/prompt-injection.md) (6 layer 防御階層、lethal trifecta、OWASP LLM01)
  - OWASP Top 10 for LLM Applications 2025 LLM01:2025 Prompt Injection
