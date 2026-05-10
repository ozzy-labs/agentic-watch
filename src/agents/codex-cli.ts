import type { AgentAdapter } from "./types.js";

export const codexCliAdapter: AgentAdapter = {
  id: "codex-cli",
  research: async (_req) => {
    throw new Error("codex-cli adapter: not implemented yet (Phase 2)");
  },
};
