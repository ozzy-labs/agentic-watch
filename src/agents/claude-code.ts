import type { AgentAdapter } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  research: async (_req) => {
    throw new Error("claude-code adapter: not implemented yet (Phase 1)");
  },
};
