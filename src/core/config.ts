import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentId, ConfigurableCommand, RadarConfig } from "../schemas/index.js";
import { RadarConfigSchema } from "../schemas/index.js";

/** File name of the workspace config, located at the workspace root. */
export const CONFIG_FILENAME = "radar.config.yaml";

/**
 * Hard-coded fallback when neither `--agent` nor `radar.config.yaml` sets a
 * default. Documented in user-guide.md and architecture.md (ADR-0001).
 */
export const HARDCODED_DEFAULT_AGENT: AgentId = "claude-code";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Error raised when `radar.config.yaml` exists but fails to parse or violates
 * `RadarConfigSchema`. Throws (rather than fall-back to defaults) because the
 * user explicitly authored a config and silently ignoring it would surprise
 * them and mask typos like `defaultResarchAgent`.
 */
export class RadarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RadarConfigError";
  }
}

/**
 * Load `radar.config.yaml` from a workspace root.
 *
 * Behavior:
 *   - File missing -> returns an empty config (`{}`).
 *   - File present and valid -> returns the parsed `RadarConfig`.
 *   - File present but malformed (YAML parse error / schema violation)
 *     -> throws `RadarConfigError` with a contextual message.
 *
 * Returning `{}` for the missing-file case lets callers treat absence as
 * "use the hard-coded default" without an extra `await pathExists` round-trip.
 */
export async function loadRadarConfig(cwd: string): Promise<RadarConfig> {
  const file = join(cwd, CONFIG_FILENAME);
  if (!(await pathExists(file))) {
    return {};
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    throw new RadarConfigError(
      `failed to read ${CONFIG_FILENAME}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new RadarConfigError(
      `failed to parse ${CONFIG_FILENAME} as YAML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // An empty file parses to `null` / `undefined`; normalize to `{}` so the
  // schema validation treats it the same as an absent file.
  const candidate = parsed ?? {};
  const result = RadarConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new RadarConfigError(`${CONFIG_FILENAME} schema violation:\n${issues}`);
  }
  return result.data;
}

/**
 * Resolve the agent to use for a given command, honoring the priority order
 * mandated by [#30]:
 *
 *   explicit `--agent` > `radar.config.yaml` default > hard-coded default
 *
 * `explicit` is the value the caller pulled from the CLI args (already
 * validated against `AgentIdSchema`); pass `undefined` when the user did not
 * supply `--agent`. The config is read fresh on each call so the resolver
 * stays stateless — the caller is free to load once per command and pass it
 * in via `configOverride` when chaining multiple resolves.
 *
 * Adding a new configurable command:
 *   1. Extend `ConfigurableCommand` in `src/schemas/config.ts`.
 *   2. Add the corresponding field to `RadarConfigSchema`.
 *   3. Add a branch to the switch below.
 *
 * The switch is exhaustive (TypeScript flags missing branches via the
 * `never` arm), so step 3 is enforced at compile time.
 */
export interface GetDefaultAgentOptions {
  /** Explicit `--agent <id>` value, if the user supplied one. */
  explicit?: AgentId;
  /** Workspace root containing `radar.config.yaml`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Pre-loaded config; skips disk read when supplied. */
  configOverride?: RadarConfig;
}

export async function getDefaultAgent(
  command: ConfigurableCommand,
  options: GetDefaultAgentOptions = {},
): Promise<AgentId> {
  if (options.explicit) {
    return options.explicit;
  }
  const config = options.configOverride ?? (await loadRadarConfig(options.cwd ?? process.cwd()));
  const fromConfig = pickConfigDefault(command, config);
  if (fromConfig) {
    return fromConfig;
  }
  return HARDCODED_DEFAULT_AGENT;
}

function pickConfigDefault(
  command: ConfigurableCommand,
  config: RadarConfig,
): AgentId | undefined {
  switch (command) {
    case "research":
      return config.defaultResearchAgent;
    case "review":
      return config.defaultReviewAgent;
    default: {
      // Exhaustiveness check — adding a new `ConfigurableCommand` without
      // updating this switch becomes a compile error.
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}
