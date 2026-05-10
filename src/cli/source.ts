import type { Command } from "./index.js";

export const sourceCommand: Command = {
  name: "source",
  summary: "Manage feed sources (add | list | remove)",
  run: async (_args) => {
    console.error("source: not implemented yet (Phase 1)");
    return 1;
  },
};
