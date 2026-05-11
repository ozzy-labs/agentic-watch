# ADR-0001: Agent Adapter Interface

## Status

Accepted（2026-05-11）

## Context

agentic-watch は 4 種類のエージェント CLI（Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI）に対し**同じ調査タスクを発注**する必要がある。各 CLI の非対話実行フラグは異なり、出力の取り出し方も異なる:

```text
claude   : claude -p "<prompt>" --output-format text --permission-mode bypassPermissions
codex    : codex exec "<prompt>"  (--cd <dir>)
gemini   : gemini -p "<prompt>"   (-y で承認スキップ)
copilot  : copilot -p "<prompt>"  --allow-all-paths --allow-all-tools --no-color
```

差異を CLI 呼び出し側に染み出させると、`research` / `review` / `update` 各コマンドが 4 通りの分岐を持ち、保守が破綻する。

## Decision

`src/agents/types.ts` に共通 interface を定義し、各 CLI に対応する adapter を `src/agents/{agent-id}.ts` に置く。

```typescript
import type { AgentId, Item } from "../schemas/index.js";

export interface ResearchRequest {
  agent: AgentId;
  templateBody: string;
  items: Item[];
  outputPath: string;
}

export interface AgentAdapter {
  id: AgentId;
  research: (req: ResearchRequest) => Promise<void>;
}
```

- `AgentId` は `"claude-code" | "codex-cli" | "gemini-cli" | "copilot"`（[schemas/research.ts](../../src/schemas/research.ts)）
- Phase 1 では `research` メソッドのみ。Phase 2 で `review`、Phase 4 で `update` を追加（同 interface へ拡張）
- 各 adapter は子プロセスとして対応 CLI を起動し、`outputPath` への Markdown 書き込みは agent 側に委ねる

呼び出し側は `src/agents/index.ts` の registry から `AgentAdapter` を取得し、interface 経由でのみアクセスする。

## Consequences

### 良い面

- CLI 呼び出し側（`cli/research.ts` 等）は agent 差を意識しない
- 新 agent CLI（例: 仮想 `mistral-cli`）追加は adapter 実装 + registry 登録のみ
- agent 別のテスト差し替えが容易（mock adapter で unit test）

### 悪い面 / 制約

- CLI 機能差を interface に押し込めない部分（例: thinking mode、tool restriction）は **adapter 内部で吸収**するか、`ResearchRequest` のオプション欄を増やす必要がある
- agent 側で Markdown を書く前提のため、**agent が指定 path に書かない** ケース（書式ミス・パス無視）への耐性は別途必要

### 中立

- プロンプト構造は Skill に閉じ込め、interface には流さない（[ADR-0002 of skills repo](https://github.com/ozzy-labs/skills) を参照）

## Alternatives

### 案 A: agent ごとに別コマンド (`research-claude` / `research-codex` ...)

- 却下理由: CLI コマンドが 4 倍に膨れ、user-guide が複雑化。internal な agent 差をユーザーに露出させてしまう

### 案 B: 1 つの巨大な adapter で switch 分岐

- 却下理由: agent 数が増えると 1 ファイルが肥大。テストもしにくい

### 案 C: agent CLI を内部 SDK 経由で直接呼ぶ

- 却下理由: SDK の更新追従コストが高く、4 SDK 分の依存が増える。子プロセス + 標準的な非対話フラグのほうが薄くて堅牢

## 関連

- 実装: [`src/agents/types.ts`](../../src/agents/types.ts)
- handbook ADR: [0018 agent-adapter-architecture](https://github.com/ozzy-labs/handbook/blob/main/adr/0018-agent-adapter-architecture.md)（org-wide adapter 思想）
