import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { loadRadarConfig, RadarConfigError } from "../core/config.js";
import {
  CHROMIUM_MISSING_HINT,
  PLAYWRIGHT_MODULE_MISSING_HINT,
  type ProbeOptions,
  probePlaywright,
} from "../core/playwright-check.js";
import { loadSources } from "../core/watcher.js";
import type { Command } from "./index.js";

/**
 * Sinks for the `doctor` command's user-facing output.
 *
 * Mirrors the per-command `IO` convention (see `dismiss.ts`, `watch.ts`): tests
 * inject capturing sinks so we can assert against the structured output without
 * touching real stdio.
 */
export interface DoctorIO {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface DoctorCommandOptions {
  cwd?: string;
  io?: DoctorIO;
  /**
   * Test seam: override the Playwright probe (lets the doctor test stub the
   * `import("playwright")` path without monkey-patching `node:module`).
   */
  probeOptions?: ProbeOptions;
  /**
   * Test seam: override `process.env` lookup so the test can compose a
   * deterministic environment without leaking through `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: override the `which`-style binary lookup (lets tests assert
   * the warn / error transitions for missing agent CLIs without depending on
   * what is actually installed on the host machine).
   */
  whichImpl?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

/**
 * Possible statuses for a single doctor check.
 *
 * - `ok`     — feature is fully functional.
 * - `warn`   — non-blocking issue (e.g. agent CLI missing — only matters if
 *              the user wants to use that specific agent).
 * - `error`  — blocking issue for an enabled feature (e.g. Chromium missing
 *              when an html-js source is configured).
 */
export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  /** Stable identifier for the check (used in tests + structured output). */
  id: string;
  /** Human-friendly status line for terminal output. */
  message: string;
  status: DoctorStatus;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Aggregated counts per status. */
  summary: { ok: number; warn: number; error: number };
}

/**
 * Agent CLIs the `doctor` command probes for. Order matches the AgentId enum
 * declaration so the output is deterministic across runs and easy to scan.
 *
 * The `binary` field is the executable name expected on $PATH. Whether the
 * user actually needs each binary depends on which agent they pick at
 * `research --agent <id>` time, so missing agents are reported as `warn`
 * (not `error`) — only the user knows which subset they use.
 */
const AGENT_BINARIES: ReadonlyArray<{ agent: string; binary: string }> = [
  { agent: "claude-code", binary: "claude" },
  { agent: "codex-cli", binary: "codex" },
  { agent: "gemini-cli", binary: "gemini" },
  { agent: "copilot", binary: "copilot" },
];

/**
 * Workspace directories `init` creates. We check for each so a user who ran
 * `radar source add ...` in a non-initialized directory gets a clear pointer
 * back to `radar init` rather than a cryptic ENOENT later.
 */
const WORKSPACE_DIRS = ["sources", "items", "state", "research", "templates"] as const;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default `which`-style lookup: walk `PATH` and return the first directory
 * containing an executable file named `binary`.
 *
 * We avoid invoking `which`/`where` itself because (a) it differs between
 * platforms (`where.exe` on Windows, `which` elsewhere), and (b) shelling out
 * for what is a simple filesystem walk pulls in process-spawn failure modes
 * (ENOENT for `which` on stripped-down container images, etc.) for no
 * benefit.
 */
async function defaultWhich(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathEnv = env.PATH ?? env.Path ?? "";
  if (!pathEnv) return undefined;
  const entries = pathEnv.split(delimiter).filter((p) => p.length > 0);
  for (const dir of entries) {
    const candidate = join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next directory.
    }
  }
  return undefined;
}

/**
 * Run all doctor checks and return a structured report.
 *
 * Exported separately from `runDoctor` so tests and downstream tooling can
 * consume the structured form without parsing the human-readable log.
 *
 * Check ordering matches the user's likely investigation order:
 *   1. Workspace directories (broken layout → nothing else matters).
 *   2. `radar.config.yaml` (loaders run on every command, so a malformed
 *      config blocks the whole CLI).
 *   3. Agent CLIs (research / review / update prerequisites).
 *   4. Playwright + Chromium (only when an html-js source is configured).
 */
export async function runDoctorChecks(options: DoctorCommandOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const whichImpl = options.whichImpl ?? defaultWhich;
  const checks: DoctorCheck[] = [];

  // 1. Workspace directories. Each missing dir is a `warn` — the user may
  //    not need every directory yet (e.g. `research/` is empty until after
  //    `radar research` runs), but the absence is a real signal that
  //    `radar init` was skipped or partially undone.
  for (const dir of WORKSPACE_DIRS) {
    const abs = join(cwd, dir);
    if (await pathExists(abs)) {
      checks.push({
        id: `workspace:${dir}`,
        status: "ok",
        message: `${dir}/ exists`,
      });
    } else {
      checks.push({
        id: `workspace:${dir}`,
        status: "warn",
        message: `${dir}/ missing — run \`radar init\` to scaffold the workspace`,
      });
    }
  }

  // 2. `radar.config.yaml`. Absence is `ok` (the file is fully optional and
  //    every field has a built-in default). A schema violation is `error`
  //    because `radar` itself fails on every invocation when the config
  //    parses but mismatches the schema — see `core/config.ts#loadRadarConfig`.
  try {
    await loadRadarConfig(cwd);
    checks.push({
      id: "config",
      status: "ok",
      message: "radar.config.yaml valid (or absent — defaults apply)",
    });
  } catch (e) {
    const message = e instanceof RadarConfigError ? e.message : String(e);
    checks.push({
      id: "config",
      status: "error",
      message: `radar.config.yaml invalid: ${message}`,
    });
  }

  // 3. Agent CLIs. Missing agents are `warn` only — a user who only runs
  //    `radar research --agent claude-code` does not care that `gemini` is
  //    absent. The check still surfaces every binary so the user can spot
  //    the one they actually need.
  for (const { agent, binary } of AGENT_BINARIES) {
    const found = await whichImpl(binary, env);
    if (found) {
      checks.push({
        id: `agent:${agent}`,
        status: "ok",
        message: `${agent}: ${binary} found at ${found}`,
      });
    } else {
      checks.push({
        id: `agent:${agent}`,
        status: "warn",
        message: `${agent}: ${binary} not found in PATH (install it to use \`radar research --agent ${agent}\`)`,
      });
    }
  }

  // 4. Playwright + Chromium. Only relevant when at least one source
  //    declares `kind: html-js`; otherwise the user does not need Playwright
  //    installed at all and a missing peer dep should not pollute the
  //    output. We load sources via `core/watcher#loadSources` so the kind
  //    detection matches what `watch run` actually iterates over.
  const sourcesDir = join(cwd, "sources");
  let htmlJsSources: string[] = [];
  if (await pathExists(sourcesDir)) {
    const sources = await loadSources(sourcesDir, () => {
      // Schema / read errors are surfaced separately via the workspace +
      // config checks above; here we only care about the kind distribution.
      // Silently dropping malformed YAMLs is fine for kind detection.
    });
    htmlJsSources = sources.filter((s) => s.kind === "html-js").map((s) => s.id);
  }
  if (htmlJsSources.length === 0) {
    checks.push({
      id: "playwright",
      status: "ok",
      message: "playwright: not required (no html-js sources configured)",
    });
  } else {
    const probe = await probePlaywright(options.probeOptions);
    if (probe.status === "ok") {
      checks.push({
        id: "playwright",
        status: "ok",
        message: `playwright: ok — chromium at ${probe.executablePath}`,
      });
    } else if (probe.status === "module-missing") {
      checks.push({
        id: "playwright",
        status: "error",
        message: `playwright: module not installed (required by html-js sources: ${htmlJsSources.join(
          ", ",
        )})\n  ${PLAYWRIGHT_MODULE_MISSING_HINT}`,
      });
    } else {
      checks.push({
        id: "playwright",
        status: "error",
        message: `playwright: chromium missing at '${probe.executablePath}' (required by html-js sources: ${htmlJsSources.join(
          ", ",
        )})\n  ${CHROMIUM_MISSING_HINT}`,
      });
    }
  }

  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status]++;
      return acc;
    },
    { ok: 0, warn: 0, error: 0 },
  );
  return { checks, summary };
}

interface DoctorArgs {
  help?: boolean;
}

function parseDoctorArgs(args: string[]): DoctorArgs {
  const out: DoctorArgs = {};
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return out;
}

function printDoctorHelp(log: (m: string) => void): void {
  log("Usage: radar doctor");
  log("");
  log("Diagnose the workspace and report dependency / configuration health.");
  log("");
  log("Checks performed:");
  log("  - Workspace directories (sources/, items/, state/, research/, templates/)");
  log("  - radar.config.yaml schema validity");
  log("  - Agent CLI availability (claude / codex / gemini / copilot)");
  log("  - Playwright + Chromium install (only if html-js sources configured)");
  log("");
  log("Exit codes:");
  log("  0  all ok (warnings may appear, but no errors)");
  log("  1  one or more error-level checks failed");
}

/**
 * Implementation of `radar doctor`.
 *
 * Returns 0 if no checks are at `error` status (warnings still pass — they
 * indicate optional dependencies / partial workspace state). Returns 1 if
 * any check is `error` so CI / scripts can gate on a clean doctor run.
 */
export async function runDoctor(
  args: string[],
  options: DoctorCommandOptions = {},
): Promise<number> {
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: DoctorArgs;
  try {
    parsed = parseDoctorArgs(args);
  } catch (e) {
    error(`doctor: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printDoctorHelp(log);
    return 0;
  }

  const report = await runDoctorChecks(options);
  for (const check of report.checks) {
    const tag =
      check.status === "ok" ? "[ok]   " : check.status === "warn" ? "[warn]  " : "[error]";
    log(`${tag} ${check.message}`);
  }
  log("");
  log(
    `doctor: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.error} error`,
  );
  return report.summary.error > 0 ? 1 : 0;
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Diagnose workspace, agent CLIs, and html-js Playwright install",
  run: (args) => runDoctor(args),
};
