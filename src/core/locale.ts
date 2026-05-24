import { z } from "zod";

/**
 * i18n locale foundation (ADR-0021, epic #307).
 *
 * This module only decides *which language* the CLI runs in; it does not yet
 * translate any user-facing copy (that lands in a later P2 issue). The single
 * responsibility here is resolving an effective {@link Locale} from the layered
 * sources documented in ADR-0021 and exposing a helper to apply that locale to
 * zod's built-in localized error messages.
 */

/** Supported UI locales. Kept deliberately small until P2 adds translations. */
export type Locale = "en" | "ja";

/**
 * zod enum mirroring {@link Locale}. Used both for `config.locale` validation
 * (via `RadarConfigSchema`) and for the lenient {@link resolveLocale} parsing
 * of `--lang` / `RADAR_LANG` inputs.
 */
export const LocaleSchema = z.enum(["en", "ja"]);

/** Hard-coded fallback when no source supplies a (valid) locale. */
export const DEFAULT_LOCALE: Locale = "en";

export interface ResolveLocaleInput {
  /** Value from the `--lang <en|ja>` CLI flag, if the user passed one. */
  flag?: string | undefined;
  /** Value from the `RADAR_LANG` environment variable, if set. */
  env?: string | undefined;
  /** `locale` field from `radar.config.yaml`, if present. */
  config?: string | undefined;
}

export interface ResolveLocaleOptions {
  /**
   * Sink for the "invalid locale, falling back to en" warning. Defaults to
   * `console.warn`; tests inject a spy. Mirrors the `warn` injection pattern in
   * `src/core/watcher.ts`.
   */
  warn?: (message: string) => void;
}

/**
 * Resolve the effective locale from the layered sources.
 *
 * Priority (highest first), per ADR-0021:
 *
 *   `--lang` flag  >  `RADAR_LANG` env  >  `config.locale`  >  default (`en`)
 *
 * Each source is validated independently against {@link LocaleSchema}. An
 * invalid value does **not** fall through to the next source — it emits a warn
 * and resolves to {@link DEFAULT_LOCALE}. Rationale: a user who wrote
 * `--lang frnch` made a mistake at *that* layer; silently honoring a lower
 * layer would mask the typo and surprise them. Empty / unset sources (`""`,
 * `undefined`) are skipped (not treated as invalid) so callers can pass raw
 * argv / env values without pre-filtering.
 */
export function resolveLocale(
  input: ResolveLocaleInput,
  options: ResolveLocaleOptions = {},
): Locale {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const layers: ReadonlyArray<{ source: string; value: string | undefined }> = [
    { source: "--lang", value: input.flag },
    { source: "RADAR_LANG", value: input.env },
    { source: "config.locale", value: input.config },
  ];
  for (const { source, value } of layers) {
    if (value === undefined || value === "") {
      continue;
    }
    const parsed = LocaleSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    warn(
      `invalid locale '${value}' from ${source}; falling back to '${DEFAULT_LOCALE}' (supported: en, ja)`,
    );
    return DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

/**
 * Apply the resolved locale to zod's global error-message locale.
 *
 * Calling this once (per command, right after {@link resolveLocale}) switches
 * zod's built-in messages to the matching language so schema-violation output
 * (e.g. `radar.config.yaml schema violation`) is localized "for free". This is
 * the only place this PR consumes the resolved locale; bespoke message
 * translation arrives in P2.
 *
 * `z.config` mutates global zod state, so this is idempotent — calling it again
 * with a different locale simply overwrites the previous setting.
 */
export function applyZodLocale(locale: Locale): void {
  switch (locale) {
    case "ja":
      z.config(z.locales.ja());
      return;
    case "en":
      z.config(z.locales.en());
      return;
    default: {
      // Exhaustiveness guard — adding a Locale without a branch is a compile
      // error.
      const _exhaustive: never = locale;
      void _exhaustive;
      return;
    }
  }
}
