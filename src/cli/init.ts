import type { Command } from "./index.js";

export const initCommand: Command = {
  name: "init",
  summary: "Initialize a workspace (sources/items/state/research/templates)",
  run: async (_args) => {
    console.error("init: not implemented yet (Phase 1)");
    return 1;
  },
};
