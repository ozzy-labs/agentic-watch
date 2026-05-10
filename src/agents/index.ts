import type { AgentId } from "../schemas/index.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexCliAdapter } from "./codex-cli.js";
import { copilotAdapter } from "./copilot.js";
import { geminiCliAdapter } from "./gemini-cli.js";
import type { AgentAdapter } from "./types.js";

const adapters = new Map<AgentId, AgentAdapter>([
  [claudeCodeAdapter.id, claudeCodeAdapter],
  [codexCliAdapter.id, codexCliAdapter],
  [geminiCliAdapter.id, geminiCliAdapter],
  [copilotAdapter.id, copilotAdapter],
]);

export function getAgentAdapter(id: AgentId): AgentAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`No agent adapter registered for id: ${id}`);
  }
  return adapter;
}

export type { AgentAdapter, ResearchRequest } from "./types.js";
