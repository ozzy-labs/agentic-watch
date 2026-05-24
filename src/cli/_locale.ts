/**
 * Shared `--lang` / `RADAR_LANG` extraction for the CLI commands (ADR-0021,
 * epic #307).
 *
 * Modeled on {@link import("./_progress.js").parseProgressFlags}: locale
 * resolution happens *per command* (there is no global config-load point — see
 * `src/core/config.ts` `loadRadarConfig`, read inside each command), so every
 * command strips `--lang` from its argv with {@link parseLangFlag} before
 * handing the remainder to its own `parseArgs`, then resolves the effective
 * locale via {@link import("../core/locale.js").resolveLocale}.
 *
 * This helper deliberately does **not** validate the locale value — invalid
 * values are tolerated here and dealt with by `resolveLocale` (which warns and
 * falls back to `en`). Keeping validation in one place avoids two divergent
 * "supported locales" lists.
 */

import { loadRadarConfig, RadarConfigError } from "../core/config.js";
import { type Locale, resolveLocale } from "../core/locale.js";

/** Environment variable name carrying the locale override. */
export const RADAR_LANG_ENV = "RADAR_LANG";

export interface LangFlagState {
  /** Argv with `--lang <value>` / `--lang=<value>` stripped. */
  rest: string[];
  /** Raw `--lang` value if supplied (unvalidated), else `undefined`. */
  flag: string | undefined;
}

export class LangFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LangFlagError";
  }
}

/**
 * Strip `--lang <value>` (or `--lang=<value>`) from `argv` and return the raw
 * value plus the remaining argv for the command's own parser.
 *
 * Supports both the space-separated (`--lang ja`) and `=`-joined
 * (`--lang=ja`) forms, matching how `parseArgs` accepts options elsewhere. A
 * trailing `--lang` with no following token raises {@link LangFlagError} so the
 * caller can surface an exit-code-2 usage error, consistent with the
 * `ProgressFlagError` style in `_progress.ts`.
 *
 * The value is returned verbatim (no validation); {@link
 * import("../core/locale.js").resolveLocale} owns validation + fallback.
 */
export function parseLangFlag(argv: string[]): LangFlagState {
  const rest: string[] = [];
  let flag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--lang") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new LangFlagError("--lang requires a value (en|ja)");
      }
      flag = next;
      i++; // consume the value token
      continue;
    }
    if (arg.startsWith("--lang=")) {
      flag = arg.slice("--lang=".length);
      continue;
    }
    rest.push(arg);
  }
  return { rest, flag };
}

/**
 * Read the `RADAR_LANG` override from an environment bag (defaults to
 * `process.env`). Returns `undefined` when unset or empty so it composes
 * cleanly with {@link import("../core/locale.js").resolveLocale}'s skip-empty
 * behavior.
 */
export function readLangEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[RADAR_LANG_ENV];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolve the effective {@link import("../core/locale.js").Locale} for a
 * report-producing command (`research` / `review` / `update`, #316).
 *
 * Strips `--lang` from `argv` (so the command's own `parseArgs` never sees it)
 * and resolves the effective locale honoring the ADR-0021 priority chain:
 *
 *   `--lang` flag  >  `RADAR_LANG` env  >  `config.locale`  >  default (`en`)
 *
 * Unlike `init` (which establishes a workspace and deliberately ignores any
 * pre-existing `config.locale`), these commands run *inside* an existing
 * workspace, so `config.locale` IS consulted as the lowest-priority layer.
 *
 * Returns the locale plus the lang-stripped argv. `--lang` with no value
 * throws {@link LangFlagError} so callers surface an exit-code-2 usage error.
 */
export function resolveCommandLocale(
  argv: string[],
  configLocale: string | undefined,
  options: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): { rest: string[]; locale: Locale } {
  const { rest, flag } = parseLangFlag(argv);
  const locale = resolveLocale(
    { flag, env: readLangEnv(options.env), config: configLocale },
    options.warn ? { warn: options.warn } : {},
  );
  return { rest, locale };
}

/**
 * Resolve the effective UI locale for a command that runs *inside* an
 * initialized workspace (workflow / routine generators), honoring all three
 * layers per ADR-0021:
 *
 *   `--lang` flag  >  `RADAR_LANG` env  >  `config.locale`  >  default (`en`)
 *
 * Unlike `init` — which deliberately ignores `config.locale` because it is the
 * command that *establishes* the workspace locale — these commands run against
 * an existing workspace, so a persisted `config.locale` should select the
 * language of the generated YAML's user-facing copy (#315).
 *
 * A malformed `radar.config.yaml` is tolerated here: the config layer is
 * dropped (treated as absent) and resolution falls through to flag/env/default.
 * The generators surface their own config errors when they actually need the
 * config; locale selection alone should not hard-fail a generate run.
 */
export async function resolveWorkspaceLocale(args: {
  flag: string | undefined;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): Promise<Locale> {
  const { flag, cwd, warn } = args;
  const env = args.env ?? process.env;
  let configLocale: string | undefined;
  try {
    configLocale = (await loadRadarConfig(cwd)).locale;
  } catch (e) {
    if (!(e instanceof RadarConfigError)) {
      throw e;
    }
    // Malformed config: skip the config layer rather than abort locale
    // resolution. The command's own config consumer (if any) reports the error.
    configLocale = undefined;
  }
  return resolveLocale(
    { flag, env: readLangEnv(env), config: configLocale },
    { warn: warn ?? ((m: string) => console.warn(m)) },
  );
}
