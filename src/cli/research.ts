import type { Command } from "./index.js";

export const researchCommand: Command = {
  name: "research",
  summary: "Generate Markdown research reports from items via an AI agent",
  run: async (_args) => {
    console.error("research: not implemented yet (Phase 1)");
    return 1;
  },
};
