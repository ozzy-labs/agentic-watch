import type { TriageRunner, TriageRunResult } from "../../src/core/triage/index.js";
import type { Item, TriageDecisionValue } from "../../src/schemas/item.js";

/**
 * Faithful mock for the triage agent runner used across triage tests.
 *
 * "Faithful" here means: the mock simulates the boundary-marker enforcement
 * the real agent CLIs are *expected* to perform. When a triage call hands
 * the mock a prompt that contains a `<untrusted_item>` or `<policy>` block,
 * the mock parses out the trusted metadata (id attribute) and policy/item
 * fields, then classifies the items per a programmable rule table. Crucially,
 * the mock IGNORES embedded "instructions" inside those boundaries — that's
 * the property the injection / policy-injection tests rely on.
 *
 * The mock is intentionally minimal: it understands enough of the prompt to
 * route decisions per item id, but it does NOT try to be smart about
 * keyword analysis. Tests configure decisions by id via `decisions`.
 */

/**
 * Configurable mock behaviour. Defaults yield a 1-shot success with
 * `decision: research, confidence: 0.9` for every item, which is the
 * happy-path baseline most tests can extend.
 */
export interface TriageMockOptions {
  /**
   * Per-item decision map. Each entry overrides the default `research`
   * decision for the matching id. Omitted ids get the default.
   */
  decisions?: Map<
    string,
    {
      decision: TriageDecisionValue;
      confidence?: number;
      reason?: string;
      group?: string;
    }
  >;
  /**
   * Default applied to ids missing from `decisions`. Defaults to
   * `{ decision: "research", confidence: 0.9, reason: "default mock decision" }`.
   */
  defaultDecision?: {
    decision: TriageDecisionValue;
    confidence?: number;
    reason?: string;
    group?: string;
  };
  /**
   * Failure mode. `none` (default) returns a clean JSON array. Other
   * modes simulate the cheap-model failure surfaces tests need to
   * exercise (CLI down, rate limit, parse-broken response).
   */
  failureMode?:
    | "none"
    | "cli-down"
    | "rate-limit-once"
    | "rate-limit-persistent"
    | "garbage-json"
    | "empty-output"
    | "non-array-json"
    | "hallucinate-id";
  /**
   * Counter exposed so tests can assert retry behaviour. Mutated by the
   * runner on every invocation; reset by calling `mock.reset()` in
   * `beforeEach`.
   */
  callLog?: Array<{ agent: string; prompt: string; cwd: string }>;
  /**
   * Optional hook invoked before producing the result. Tests use this to
   * inject side effects (e.g. assert on the prompt mid-run, or flip
   * `failureMode` between calls).
   */
  beforeRun?: (call: { agent: string; prompt: string; cwd: string }, callIndex: number) => void;
  /**
   * Extra entries to splice into the response payload — useful for
   * hallucinated-id tests that need to inject ids the input set never
   * contained.
   */
  extraEntries?: Array<{
    id: string;
    decision: TriageDecisionValue;
    confidence: number;
    reason: string;
    group?: string;
  }>;
  /**
   * Duplicate the entry for the given ids so the parser's dedup logic
   * runs. The second copy carries `_dup` appended to the reason so tests
   * can tell which was kept.
   */
  duplicateIds?: string[];
}

/**
 * Parse the `<untrusted_item id="..." ...>` attributes out of the prompt.
 *
 * This is the same id list the real agent would walk; the mock uses it as
 * the "items it sees" so failure modes (hallucinated id, omission) can be
 * driven from test configuration.
 */
function extractIdsFromPrompt(prompt: string): string[] {
  const ids: string[] = [];
  const re = /<untrusted_item id="([^"]+)"/g;
  for (const match of prompt.matchAll(re)) {
    // Decode the attribute escapes the prompt builder applied (only `"` and
    // `<` / `>` / `&` matter for the mock — keep symmetric with the builder).
    const decoded = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    ids.push(decoded);
  }
  return ids;
}

/**
 * Build a `TriageRunner` configured per `TriageMockOptions`. The returned
 * runner is plain async, so tests can pass it directly to
 * `triageItems(items, { runner: mock.runner, … })`.
 */
export function createTriageMock(options: TriageMockOptions = {}): {
  runner: TriageRunner;
  callLog: Array<{ agent: string; prompt: string; cwd: string }>;
  reset: () => void;
} {
  const callLog = options.callLog ?? [];
  let rateLimitCallCount = 0;

  const runner: TriageRunner = async ({ agent, prompt, cwd }) => {
    const callIndex = callLog.length;
    callLog.push({ agent, prompt, cwd });
    options.beforeRun?.({ agent, prompt, cwd }, callIndex);

    const mode = options.failureMode ?? "none";

    if (mode === "cli-down") {
      return {
        status: "error",
        stdout: "",
        stderr: "ENOENT: spawn claude ENOENT",
        exitCode: -1,
      } satisfies TriageRunResult;
    }

    if (mode === "rate-limit-persistent") {
      return {
        status: "rate-limited",
        stdout: "",
        stderr: "HTTP 429 Too Many Requests",
        exitCode: 1,
      } satisfies TriageRunResult;
    }

    if (mode === "rate-limit-once") {
      rateLimitCallCount += 1;
      if (rateLimitCallCount === 1) {
        return {
          status: "rate-limited",
          stdout: "",
          stderr: "HTTP 429 Too Many Requests",
          exitCode: 1,
        } satisfies TriageRunResult;
      }
      // Fall through to normal success after the first 429.
    }

    if (mode === "garbage-json") {
      return {
        status: "ok",
        stdout: "this is not valid JSON at all",
        stderr: "",
        exitCode: 0,
      } satisfies TriageRunResult;
    }

    if (mode === "empty-output") {
      return { status: "ok", stdout: "", stderr: "", exitCode: 0 } satisfies TriageRunResult;
    }

    if (mode === "non-array-json") {
      return {
        status: "ok",
        stdout: JSON.stringify({ decision: "research", id: "foo" }),
        stderr: "",
        exitCode: 0,
      } satisfies TriageRunResult;
    }

    // Successful path: produce one entry per <untrusted_item> id, applying
    // the per-id overrides where present.
    const ids = extractIdsFromPrompt(prompt);
    const defaultDecision = options.defaultDecision ?? {
      decision: "research" as TriageDecisionValue,
      confidence: 0.9,
      reason: "default mock decision",
    };

    const entries = ids.map((id) => {
      const override = options.decisions?.get(id);
      const merged = override ?? defaultDecision;
      const entry: Record<string, unknown> = {
        id,
        decision: merged.decision,
        confidence: merged.confidence ?? 0.9,
        reason: merged.reason ?? "default mock decision",
      };
      if (merged.group !== undefined) {
        entry.group = merged.group;
      }
      return entry;
    });

    if (options.duplicateIds) {
      for (const id of options.duplicateIds) {
        const original = entries.find((e) => e.id === id);
        if (original) {
          entries.push({ ...original, reason: `${original.reason}_dup` });
        }
      }
    }

    if (mode === "hallucinate-id") {
      entries.push({
        id: "fake-hallucinated-id-not-in-input",
        decision: "research",
        confidence: 0.95,
        reason: "hallucinated entry",
      });
    }

    if (options.extraEntries) {
      entries.push(...options.extraEntries);
    }

    return {
      status: "ok",
      stdout: JSON.stringify(entries),
      stderr: "",
      exitCode: 0,
    } satisfies TriageRunResult;
  };

  const reset = () => {
    callLog.length = 0;
    rateLimitCallCount = 0;
  };

  return { runner, callLog, reset };
}

/**
 * Construct a valid `Item` for tests. Centralises the boilerplate (every
 * field schema-validated) so individual test files stay focused on the
 * triage-specific assertions.
 */
export function makeItem(overrides: Partial<Item> = {}): Item {
  const base: Item = {
    id: overrides.id ?? "test-source-2026-05-23-default",
    sourceId: overrides.sourceId ?? "test-source",
    title: overrides.title ?? "Test item title",
    url: overrides.url ?? "https://example.com/post/1",
    fetchedAt: overrides.fetchedAt ?? "2026-05-23T00:00:00.000Z",
    matchedKeywords: overrides.matchedKeywords ?? ["test"],
    status: overrides.status ?? "detected",
    injectionFlags: overrides.injectionFlags ?? [],
    summary: overrides.summary,
    raw: overrides.raw,
    publishedAt: overrides.publishedAt,
    triage: overrides.triage,
    dismissedBy: overrides.dismissedBy,
  };
  return base;
}
