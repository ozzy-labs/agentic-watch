/**
 * English message catalog — the source of truth for the i18n layer (ADR-0021,
 * epic #307 P2).
 *
 * `en` defines the canonical key set and value shapes; every other locale
 * catalog (currently {@link import("./ja.js").ja}) is required by the
 * {@link Messages} type to mirror these keys exactly. A value is either:
 *
 *   - a plain `string` (no interpolation), or
 *   - a function `(params) => string` that receives a typed params object and
 *     returns the rendered string.
 *
 * The function form is the single, unified interpolation scheme for this layer
 * (no `{name}` placeholder string-replacement, no template engine, no new
 * runtime dependency): parameters are ordinary typed function arguments, so a
 * missing or misspelled param is a *compile* error, and `createTranslator`'s
 * `t(key, params?)` signature can derive its param type straight from the
 * catalog entry.
 *
 * Keys are namespaced by domain (`common.*`, `cli.*`) to keep future additions
 * collision-free as later P3/P4/P5 issues add their own message families. This
 * PR only fills the keys needed to prove the wiring on `src/cli/index.ts`'s
 * global help / version / unknown-command paths.
 */

export const en = {
  // --- global help (radar --help / radar / radar help) ----------------------
  /** First line of `radar --help`: the product tagline. */
  "cli.help.tagline": "FeedRadar — Multi-agent CLI for blog/release feed research",
  /** Usage synopsis line. */
  "cli.help.usage": "Usage: radar <command> [options]",
  /** Section heading listing the subcommands. */
  "cli.help.commandsHeading": "Commands:",
  /** Section heading listing the global options. */
  "cli.help.optionsHeading": "Options:",
  /** `-h, --help` option description. */
  "cli.help.optionHelp": "Show this help",
  /** `-v, --version` option description. */
  "cli.help.optionVersion": "Show version",
  /** `--lang <en|ja>` option description. */
  "cli.help.optionLang": "UI language (overrides RADAR_LANG / config)",

  // --- unknown command error ------------------------------------------------
  /** stderr line when an unrecognized subcommand is given. */
  "cli.error.unknownCommand": ({ command }: { command: string }): string =>
    `radar: unknown command '${command}'`,
  /** Follow-up hint pointing the user at `radar --help`. */
  "cli.error.unknownCommandHint": "Run 'radar --help' for available commands.",
} as const;

/** Union of all valid message keys. */
export type MessageKey = keyof typeof en;

/**
 * Widen a single English catalog entry into the shape every locale must
 * satisfy for that key. The `as const` on {@link en} narrows string entries to
 * *literal* types ("Show this help"), which would force `ja` to repeat the
 * English text verbatim — so we widen string entries back to `string` while
 * preserving function entries' precise param/return signature (that is the
 * part that must stay identical across locales, since `t`'s param type is
 * derived from it).
 */
type LocaleEntry<T> = T extends (...args: infer A) => infer R ? (...args: A) => R : string;

/**
 * The catalog shape every locale must satisfy. Derived from the English
 * catalog so that `ja` (and any future locale) is required — at compile time —
 * to provide the exact same key set, with string entries free to differ in
 * wording but function entries pinned to the same param/return shape.
 */
export type Messages = {
  [K in MessageKey]: LocaleEntry<(typeof en)[K]>;
};
