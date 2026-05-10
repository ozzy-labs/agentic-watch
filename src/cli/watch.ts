import type { Command } from "./index.js";

export const watchCommand: Command = {
  name: "watch",
  summary: "Fetch sources and produce filtered items (run)",
  run: async (_args) => {
    console.error("watch: not implemented yet (Phase 1)");
    return 1;
  },
};
