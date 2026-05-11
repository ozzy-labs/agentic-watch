import type { Command } from "./index.js";

export const updateCommand: Command = {
  name: "update",
  summary: "Refresh existing research reports against the latest items",
  run: async (_args) => {
    console.error("update: not implemented yet (Phase 4)");
    return 1;
  },
};
