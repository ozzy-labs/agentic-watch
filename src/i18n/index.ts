/**
 * Type-safe translator factory (ADR-0021, epic #307 P2).
 *
 * `createTranslator(locale)` returns a `t(key, params?)` function bound to a
 * locale. The design constraints (from issue #310):
 *
 *   - **Type-safe keys.** `key` is `keyof typeof en` (= {@link MessageKey}); a
 *     typo is a compile error.
 *   - **Type-safe params.** Whether `t` accepts (and requires) a `params`
 *     argument is derived per-key from the catalog entry: string entries take
 *     no params, function entries require their declared params object. This is
 *     the single unified interpolation scheme — function args, no placeholder
 *     string-replacement.
 *   - **en fallback for missing keys.** If a locale catalog is somehow missing
 *     a key at runtime (it cannot be under the {@link Messages} type, but we
 *     stay defensive for hand-edited / future dynamically-merged catalogs), the
 *     English entry is used.
 *   - **No global singleton.** Each command resolves its own locale (config is
 *     cwd-dependent and read per command — see `src/core/config.ts`) and builds
 *     its own translator; there is no module-level shared translator.
 *   - **No new runtime dependency.**
 *
 * Wiring convention established here (followed by later P3/P4/P5 issues): a
 * command resolves its locale (`src/cli/_locale.ts` + `resolveLocale`, plus
 * `loadRadarConfig` for config-aware commands), calls {@link createTranslator},
 * and threads the resulting `t` through `options` alongside the existing
 * `options.io` log/warn/error sinks. `t` produces the strings, `io` writes
 * them — same output path as today, just localized copy.
 */

import type { Locale } from "../core/locale.js";
import { en, type MessageKey, type Messages } from "./messages/en.js";
import { ja } from "./messages/ja.js";

/** Locale → catalog lookup. `en` is also the missing-key fallback source. */
const catalogs: Record<Locale, Messages> = { en, ja };

/**
 * Params accepted by a single catalog entry. A `string` entry has no params
 * (`undefined`); a function entry has the type of its first argument.
 */
type ParamsOf<K extends MessageKey> = (typeof en)[K] extends (params: infer P) => string
  ? P
  : undefined;

/**
 * `t` overloads keep call sites honest: keys whose catalog value is a plain
 * string reject a params argument, keys whose value is a function require the
 * matching params object.
 */
export interface Translator {
  <K extends MessageKey>(key: ParamsOf<K> extends undefined ? K : never): string;
  <K extends MessageKey>(key: K, params: ParamsOf<K>): string;
}

/**
 * Build a translator bound to `locale`.
 *
 * Resolution order per key: the requested locale's entry, else the English
 * entry (defensive fallback — see module docs). The resolved entry is rendered
 * by calling it with `params` when it is a function, or returned verbatim when
 * it is a string.
 */
export function createTranslator(locale: Locale): Translator {
  const primary = catalogs[locale] ?? en;
  return ((key: MessageKey, params?: unknown): string => {
    const entry = (primary[key] ?? en[key]) as string | ((params: unknown) => string);
    return typeof entry === "function" ? entry(params) : entry;
  }) as Translator;
}

export type { Locale } from "../core/locale.js";
export type { MessageKey, Messages } from "./messages/en.js";
