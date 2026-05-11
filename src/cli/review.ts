import type { Command } from "./index.js";

export const reviewCommand: Command = {
  name: "review",
  summary: "Cross-review research reports across multiple AI agents",
  run: async (_args) => {
    console.error("review: not implemented yet (Phase 2)");
    return 1;
  },
};
