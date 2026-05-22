/**
 * JSONPath-lite — minimal expression evaluator for the `kind: json-api` adapter
 * (ADR-0012 §D2).
 *
 * Supports the smallest subset of JSONPath that covers the page-based JSON
 * APIs FeedRadar targets (AWS What's New, dev.to, Anthropic news, …) without
 * bringing in a 30 KB dep:
 *
 *   $                        — root
 *   .field                   — property access (dotted form)
 *   ['field']                — property access (bracket form, single key)
 *   [N]                      — array index (non-negative integer)
 *   [*]                      — array wildcard (returns all elements)
 *   .*                       — object wildcard (returns all values)
 *   $.a.b.c                  — chained property access
 *   $.array[*].field         — chain after wildcard
 *
 * Out of scope (throws `JsonPathError` at compile time):
 *
 *   ..field                  — recursive descent
 *   [?(...)]                 — filter expressions
 *   [N:M]                    — slicing
 *   ['a','b']                — multi-key
 *   length() / min() / ...   — functions
 *
 * Two evaluation modes:
 *
 * - `selectOne(path, root)`: returns a single value (the first match), or
 *   `undefined` when nothing matches. Used for scalar selectors like
 *   `selectors.title` / `selectors.url`.
 *
 * - `selectAll(path, root)`: returns an array of all matches. Used for
 *   `selectors.items` which is expected to yield the per-item list.
 *
 * Errors:
 *
 * - `JsonPathError` (compile time): syntactically invalid or unsupported.
 * - At runtime, missing properties / out-of-range indices simply return
 *   `undefined` / `[]` so recipe authors can selectors-and-shrug their way
 *   through optional fields like `summary` / `publishedAt`.
 */

/** Error thrown when a path expression is syntactically invalid or uses an unsupported feature. */
export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathError";
  }
}

/**
 * Compiled step in the path. Kept as a tagged union so the evaluator stays
 * branch-on-`kind` rather than re-parsing strings per step.
 */
type Step =
  | { kind: "prop"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard-array" }
  | { kind: "wildcard-object" };

/** Tokens that mark an unsupported (out-of-scope) construct. Detected pre-parse. */
const UNSUPPORTED_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\.\./, message: "recursive descent ('..') is not supported" },
  { pattern: /\[\?/, message: "filter expression ('[?(...)]') is not supported" },
  { pattern: /\[\s*\d+\s*:/, message: "slice ('[N:M]') is not supported" },
  { pattern: /\[\s*['"][^'"]+['"]\s*,/, message: "multi-key ('[a,b]') is not supported" },
];

/**
 * Compile a path expression into an array of steps.
 *
 * The expression must start with `$`. Trailing whitespace is tolerated; any
 * other deviation throws so misconfigured recipes surface at parse time
 * (rather than silently returning empty selectors on every fetch).
 */
function compile(path: string): Step[] {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new JsonPathError("path is empty");
  }
  for (const { pattern, message } of UNSUPPORTED_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new JsonPathError(`jsonpath-lite: ${message} (path: '${path}')`);
    }
  }
  if (trimmed[0] !== "$") {
    throw new JsonPathError(`jsonpath-lite: path must start with '$' (path: '${path}')`);
  }

  const steps: Step[] = [];
  let i = 1; // past the '$'
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === ".") {
      i++;
      // Object wildcard: `.*`
      if (trimmed[i] === "*") {
        steps.push({ kind: "wildcard-object" });
        i++;
        continue;
      }
      // Property: `.field` — consume identifier-ish chars.
      const start = i;
      while (i < trimmed.length && /[A-Za-z0-9_-]/.test(trimmed[i] ?? "")) {
        i++;
      }
      if (start === i) {
        throw new JsonPathError(
          `jsonpath-lite: expected property name after '.' at position ${i} (path: '${path}')`,
        );
      }
      steps.push({ kind: "prop", name: trimmed.slice(start, i) });
      continue;
    }
    if (ch === "[") {
      // Find the matching close bracket.
      const close = trimmed.indexOf("]", i);
      if (close === -1) {
        throw new JsonPathError(`jsonpath-lite: unclosed '[' at position ${i} (path: '${path}')`);
      }
      const inner = trimmed.slice(i + 1, close).trim();
      if (inner === "*") {
        steps.push({ kind: "wildcard-array" });
      } else if (/^-?\d+$/.test(inner)) {
        const idx = Number.parseInt(inner, 10);
        if (idx < 0) {
          throw new JsonPathError(`jsonpath-lite: negative index not supported (path: '${path}')`);
        }
        steps.push({ kind: "index", index: idx });
      } else if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        // Single-key bracket form: ['field'] / ["field"]
        const name = inner.slice(1, -1);
        if (name.length === 0) {
          throw new JsonPathError(
            `jsonpath-lite: empty bracket key not supported (path: '${path}')`,
          );
        }
        steps.push({ kind: "prop", name });
      } else {
        throw new JsonPathError(
          `jsonpath-lite: unsupported bracket expression '[${inner}]' (path: '${path}')`,
        );
      }
      i = close + 1;
      continue;
    }
    throw new JsonPathError(
      `jsonpath-lite: unexpected character '${ch}' at position ${i} (path: '${path}')`,
    );
  }
  return steps;
}

/** Apply one step to a single value, producing zero or more values. */
function applyStep(step: Step, value: unknown): unknown[] {
  if (value == null) return [];
  switch (step.kind) {
    case "prop": {
      if (typeof value !== "object") return [];
      // Arrays do not expose arbitrary string properties for JSON purposes;
      // we restrict to plain objects so `$.items.title` does not accidentally
      // match `Array.prototype.title`.
      if (Array.isArray(value)) return [];
      const obj = value as Record<string, unknown>;
      // `hasOwnProperty` avoids picking up prototype-chain pollution.
      if (!Object.hasOwn(obj, step.name)) return [];
      return [obj[step.name]];
    }
    case "index": {
      if (!Array.isArray(value)) return [];
      if (step.index >= value.length) return [];
      return [value[step.index]];
    }
    case "wildcard-array": {
      if (!Array.isArray(value)) return [];
      return value.slice();
    }
    case "wildcard-object": {
      if (typeof value !== "object" || Array.isArray(value)) return [];
      return Object.values(value as Record<string, unknown>);
    }
  }
}

/**
 * Walk every compiled step, fanning out at wildcards. Returns the full set
 * of matches in document order.
 */
function evaluate(path: string, root: unknown): unknown[] {
  const steps = compile(path);
  let frontier: unknown[] = [root];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const v of frontier) {
      next.push(...applyStep(step, v));
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier;
}

/**
 * Return the first match for `path` against `root`, or `undefined` when the
 * path does not match anything. Used by scalar selectors.
 */
export function selectOne(path: string, root: unknown): unknown {
  const matches = evaluate(path, root);
  return matches.length > 0 ? matches[0] : undefined;
}

/**
 * Return all matches for `path` against `root`. Used by `selectors.items` to
 * pick the per-item list. Always returns an array (never `undefined`) so the
 * adapter can iterate without a null check.
 */
export function selectAll(path: string, root: unknown): unknown[] {
  return evaluate(path, root);
}
