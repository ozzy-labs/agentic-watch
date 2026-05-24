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
