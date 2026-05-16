import { dismissCommand } from "./dismiss.js";
import { initCommand } from "./init.js";
import { researchCommand } from "./research.js";
import { reviewCommand } from "./review.js";
import { sourceCommand } from "./source.js";
import { updateCommand } from "./update.js";
import { watchCommand } from "./watch.js";

export interface Command {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
}

const commands: Command[] = [
  initCommand,
  sourceCommand,
  watchCommand,
  researchCommand,
  dismissCommand,
  reviewCommand,
  updateCommand,
];

const VERSION = "0.0.0";

function printHelp(): void {
  console.log("agentic-watch — Multi-agent CLI for blog/release feed research");
  console.log("");
  console.log("Usage: agentic-watch <command> [options]");
  console.log("");
  console.log("Commands:");
  for (const c of commands) {
    console.log(`  ${c.name.padEnd(10)} ${c.summary}`);
  }
  console.log("");
  console.log("Options:");
  console.log("  -h, --help     Show this help");
  console.log("  -v, --version  Show version");
  console.log("");
  console.log("Status: alpha — Phase 1-5 complete, Phase 6 (npm publish 0.1.0) pending.");
}

export async function run(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (!first || first === "-h" || first === "--help" || first === "help") {
    printHelp();
    return;
  }
  if (first === "-v" || first === "--version" || first === "version") {
    console.log(VERSION);
    return;
  }
  const command = commands.find((c) => c.name === first);
  if (!command) {
    console.error(`agentic-watch: unknown command '${first}'`);
    console.error("Run 'agentic-watch --help' for available commands.");
    process.exit(2);
  }
  const code = await command.run(rest);
  if (code !== 0) {
    process.exit(code);
  }
}
