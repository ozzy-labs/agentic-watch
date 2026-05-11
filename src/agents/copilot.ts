import type { AgentAdapter } from "./types.js";

export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  research: async (_req) => {
    throw new Error("copilot adapter: not implemented yet (Phase 2)");
  },
  review: async (_req) => {
    throw new Error("copilot adapter: review not implemented yet (Phase 2)");
  },
};
