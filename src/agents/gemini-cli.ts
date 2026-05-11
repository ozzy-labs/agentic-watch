import type { AgentAdapter } from "./types.js";

export const geminiCliAdapter: AgentAdapter = {
  id: "gemini-cli",
  research: async (_req) => {
    throw new Error("gemini-cli adapter: not implemented yet (Phase 2)");
  },
};
