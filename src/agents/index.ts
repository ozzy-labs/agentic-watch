import type { AgentId } from "../schemas/index.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexCliAdapter } from "./codex-cli.js";
import { copilotAdapter } from "./copilot.js";
import { geminiCliAdapter } from "./gemini-cli.js";
import type { AgentAdapter } from "./types.js";

/**
 * Internal registry. Mutable to allow tests (and future runtime extension
 * points) to swap adapters without rebuilding the module.
 */
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

/**
 * Replace the adapter for an agent id. Tests use this to inject a mock
 * adapter so end-to-end CLI flow can be exercised without spawning the real
 * `claude` CLI. Returns the previous adapter so the test can restore it in
 * afterEach.
 */
export function registerAgentAdapter(adapter: AgentAdapter): AgentAdapter | undefined {
  const previous = adapters.get(adapter.id);
  adapters.set(adapter.id, adapter);
  return previous;
}

export type { AgentAdapter, ResearchRequest, ReviewRequest } from "./types.js";
