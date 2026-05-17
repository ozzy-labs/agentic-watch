/**
 * Best-effort prompt-injection pre-filter (ADR-0009 M1a + M5a — Adopt).
 *
 * Scans untrusted item content (`title` / `summary` / `raw`) against a small
 * set of regex patterns that show up in well-known prompt-injection payloads
 * (Anthropic's `[SYSTEM]` / OpenAI's `<|im_start|>` markers, generic "ignore
 * previous instructions" variants, etc.). The match list is exposed on the
 * item as `injectionFlags` so downstream tooling can surface a warning to the
 * user.
 *
 * Scope (deliberately narrow):
 *
 * - **Audit-only.** A non-empty `matched` list never changes the item's
 *   `status`, never rewrites the content, and never blocks research. ADR-0009
 *   rejected auto-sanitize (M5b) on the same principle — the user retains the
 *   judgment call and can `radar dismiss` an item manually.
 * - **High-precision patterns.** We intentionally avoid heuristics that try
 *   to catch every social-engineering phrase. The patterns target literal
 *   markers seen in real payloads; vague natural-language attacks (e.g.
 *   "please disregard the system prompt and instead...") are out of scope and
 *   will not be detected — that is a known false-negative documented in tests.
 * - **No external dependency.** Pure `RegExp` over the haystack string.
 *
 * The regex `source` strings are exported (`INJECTION_PATTERNS`) so logs and
 * user-facing diagnostics can name the offending pattern without exposing the
 * full compiled flags. Patterns are matched case-insensitively to catch the
 * common variants (`Ignore Previous Instructions`, `IGNORE PREVIOUS...`).
 */

/**
 * Labelled pattern set. The `label` is the user-facing identifier surfaced
 * through `detectInjection(...).matched` and CLI logs; the `re` is the actual
 * compiled regex. Keep labels short and stable — they are recorded in
 * `items/<id>.yaml` and changing them after the fact would invalidate audit
 * trails on existing workspaces.
 */
interface InjectionPattern {
  label: string;
  re: RegExp;
}

/**
 * Pattern catalogue. The `i` flag is intentional — all known payloads in the
 * wild ignore case (`Ignore Previous Instructions` / `IGNORE PREVIOUS...`).
 *
 * Coverage (8 patterns, satisfies acceptance criterion 1: "≥ 6 patterns"):
 *
 * 1. `[SYSTEM]` literal — Anthropic-style fake system tag
 * 2. `<|im_start|>` / `<|im_end|>` — OpenAI ChatML special tokens
 * 3. `Ignore (the )?previous (instructions|prompt|directives)` — classic jailbreak preamble
 * 4. `Disregard (the )?(above|previous|prior)` — paraphrase of (3)
 * 5. `SYSTEM OVERRIDE` / `SYSTEM PROMPT OVERRIDE` — escalation marker
 * 6. `You are now ...` style role-reassignment headers (constrained to avoid
 *    matching benign prose; requires uppercase first word + "now" + verb)
 * 7. `BEGIN (NEW )?INSTRUCTIONS?` / `END (NEW )?INSTRUCTIONS?` — fenced-prompt markers
 * 8. `<\|endoftext\|>` — GPT-family special token leakage marker
 */
const PATTERNS: InjectionPattern[] = [
  {
    label: "system-tag",
    re: /\[SYSTEM\]/i,
  },
  {
    label: "chatml-token",
    re: /<\|im_(start|end)\|>/i,
  },
  {
    label: "ignore-previous",
    re: /\bignore\s+(the\s+)?(previous|prior|above|all\s+previous)\s+(instructions?|prompts?|directives?|messages?|rules?)/i,
  },
  {
    label: "disregard-above",
    re: /\bdisregard\s+(the\s+)?(above|previous|prior|all\s+(previous|prior))/i,
  },
  {
    label: "system-override",
    re: /\bsystem(\s+prompt)?\s+override\b/i,
  },
  {
    label: "role-reassignment",
    re: /\byou\s+are\s+now\s+(a\s+|an\s+|the\s+)?(?:[A-Za-z][\w-]*\s+)?(assistant|ai|bot|agent|chatbot|system)\b/i,
  },
  {
    label: "instruction-fence",
    re: /\b(begin|end)\s+(new\s+)?instructions?\b/i,
  },
  {
    label: "endoftext-token",
    re: /<\|endoftext\|>/i,
  },
];

/**
 * Public list of pattern labels. Kept as a `readonly` constant so callers can
 * enumerate the catalogue without reaching into the regex internals (logs,
 * docs, etc.).
 */
export const INJECTION_PATTERN_LABELS: readonly string[] = PATTERNS.map((p) => p.label);

export interface DetectInjectionResult {
  /**
   * Sorted-by-pattern-declaration list of pattern labels that fired. The list
   * is deduplicated so multiple hits of the same pattern in the same haystack
   * still result in a single entry, which keeps the persisted
   * `injectionFlags` field stable across re-runs.
   */
  matched: string[];
}

/**
 * Run all patterns against `text` and return the set of labels that fired.
 *
 * Non-string inputs (undefined / null / numbers) return an empty result —
 * callers are responsible for stringifying structured payloads (e.g. `raw`)
 * before passing them in. The watcher does this via `JSON.stringify` so
 * embedded strings inside structured payloads are still scanned.
 *
 * Empty / whitespace-only input returns an empty result without touching any
 * regex, both as a fast-path and to avoid accidental matches on weird empty
 * patterns down the line.
 */
export function detectInjection(text: string): DetectInjectionResult {
  if (typeof text !== "string" || text.length === 0) {
    return { matched: [] };
  }
  const matched: string[] = [];
  for (const { label, re } of PATTERNS) {
    if (re.test(text)) {
      matched.push(label);
    }
  }
  return { matched };
}
