import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dismissCommand } from "./dismiss.js";
import { doctorCommand } from "./doctor.js";
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
  doctorCommand,
];

// Read the installed package's version at runtime so `radar --version`
// tracks release-please bumps without a parallel source edit. The bin
// ships as dist/cli/index.js with package.json two levels up; the path
// is identical in both npm-installed and local-built layouts because
// tsc preserves src/ → dist/ structure.
const PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const VERSION = (JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version: string }).version;

function printHelp(): void {
  console.log("FeedRadar — Multi-agent CLI for blog/release feed research");
  console.log("");
  console.log("Usage: radar <command> [options]");
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
    console.error(`radar: unknown command '${first}'`);
    console.error("Run 'radar --help' for available commands.");
    process.exit(2);
  }
  const code = await command.run(rest);
  if (code !== 0) {
    process.exit(code);
  }
}
