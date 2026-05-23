import { z } from "zod";
import type { Item } from "../../schemas/item.js";
import { TriageDecisionValueSchema } from "../../schemas/item.js";
import type { SourceTriagePolicy } from "../../schemas/source.js";

/**
 * Triage response parser + validator (ADR-0018 §W4).
 *
 * The agent returns a JSON array (one entry per input item) on stdout. This
 * module turns that raw string into a `Map<itemId, ValidatedTriageEntry>`,
 * applying the safety rules from ADR-0018:
 *
 * 1. **Strict JSON parse.** Total parse failure is reported to the caller as
 *    a `TriageResponseParseError`; the caller (adapter.ts) decides whether
 *    to retry the agent invocation or fall back to all-unsure.
 * 2. **Schema validate per entry.** Entries that fail Zod parse become
 *    `unsure` entries with a synthesized reason; only the malformed entry is
 *    downgraded, the rest of the array is kept.
 * 3. **Hallucinated id reject.** Entries whose `id` is not in the input set
 *    are dropped from the result entirely (the caller's full-coverage check
 *    will turn the missing items into `unsure` entries with reason
 *    `"agent-omitted"`). Storing a hallucinated id on disk would corrupt the
 *    items index.
 * 4. **Duplicate id reject.** When the agent emits two entries for the same
 *    id, the **first** is kept and the duplicate triggers a warning. This is
 *    safer than overwriting — agents that hallucinate duplicates often emit
 *    contradictory decisions, and the first is at least likely to reflect
 *    the policy more directly.
 * 5. **Confidence threshold demotion.** Entries below
 *    `policy.confidenceThreshold` are demoted to `decision: "unsure"`. The
 *    original confidence is preserved so downstream feedback analysis can
 *    correlate "low confidence + demoted" outcomes.
 * 6. **Digest without group → unsure.** A `decision: "digest"` entry without
 *    a non-empty `group` is structurally invalid (the digest CLI needs the
 *    key to collect siblings). We demote rather than reject so the operator
 *    still gets a record.
 *
 * The output is a `Map`, not an array, so the adapter can do O(1) coverage
 * checks against the input id set.
 */

/**
 * Raw schema for one element of the agent's JSON response. We accept any
 * shape that has the four required fields (id / decision / confidence /
 * reason) and an optional group; unknown fields are dropped silently so the
 * agent has room to add metadata without breaking parse.
 *
 * `decision` is parsed via `TriageDecisionValueSchema` so the same enum is
 * shared with `TriageDecisionSchema` on the item — any drift would be caught
 * at this boundary instead of corrupting the items index.
 */
const AgentEntrySchema = z.object({
  id: z.string().min(1),
  decision: TriageDecisionValueSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  group: z.string().min(1).optional(),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/**
 * The whole response body is just an array of entries. We extract this as a
 * named schema so the malformed-array error message stays consistent across
 * test cases.
 */
const AgentResponseSchema = z.array(AgentEntrySchema);

/**
 * Validated triage entry returned by `parseTriageResponse`. The shape mirrors
 * the agent entry but `decision` has been demoted to `unsure` where the
 * confidence-threshold / digest-without-group rules fired, and a `demoted`
 * flag records whether that happened so the audit log can show the original
 * decision.
 */
export interface ValidatedTriageEntry {
  id: string;
  decision: z.infer<typeof TriageDecisionValueSchema>;
  confidence: number;
  reason: string;
  group: string | undefined;
  /**
   * `true` when the entry was demoted from a non-unsure decision to `unsure`
   * by the parser (confidence below threshold or digest without group). The
   * caller can use this to surface a warning in the audit log without
   * re-deriving the rule application.
   */
  demoted: boolean;
}

export interface ParseTriageResponseResult {
  /** One entry per validated input item id present in the response. */
  entries: Map<string, ValidatedTriageEntry>;
  /** Free-form warnings (one per skipped / demoted entry) for the caller's `errors[]`. */
  warnings: string[];
}

/**
 * Thrown by `parseTriageResponse` when the agent's stdout could not be
 * parsed as JSON at all, or when the top-level value is not an array of
 * entries. The adapter catches this and treats it as a total-fallback
 * situation (every item becomes `triaged_unsure`, `fallback: true`).
 *
 * Per-entry validation failures (one entry malformed but the array parses)
 * do NOT throw — they are recorded in `warnings[]` and the malformed entry
 * is dropped so the rest of the array still applies.
 */
export class TriageResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageResponseParseError";
  }
}

/**
 * Best-effort JSON extraction from agent stdout.
 *
 * Cheap models occasionally wrap their JSON in Markdown code fences
 * (```json ... ```) or prepend / append a sentence even when instructed not
 * to. We strip a leading / trailing code fence and locate the outermost
 * `[ ... ]` slice so the JSON.parse call has a fighting chance. If neither
 * heuristic helps, we let `JSON.parse` fail and propagate the error.
 */
function extractJsonArrayPayload(raw: string): string {
  const trimmed = raw.trim();
  // Strip a single ```json / ``` ... ``` fence if present.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  const fenced = fenceMatch ? fenceMatch[1].trim() : trimmed;
  // If the agent already emitted a clean array, return it directly.
  if (fenced.startsWith("[")) {
    return fenced;
  }
  // Otherwise locate the first `[` ... last `]` slice. This is intentionally
  // greedy: cheap-model preamble usually sits before `[`, so trimming to the
  // outermost brackets recovers the array.
  const first = fenced.indexOf("[");
  const last = fenced.lastIndexOf("]");
  if (first === -1 || last === -1 || last <= first) {
    return fenced;
  }
  return fenced.slice(first, last + 1);
}

/**
 * Parse and validate the agent's triage response against the input item set
 * and per-source policy.
 *
 * `inputItems` is consulted for two reasons: (a) hallucinated-id reject — we
 * only accept ids that appear in the input set, and (b) the caller (adapter)
 * uses the returned `entries` Map to figure out which items the agent
 * omitted entirely (those become `unsure` with reason `"agent-omitted"`).
 */
export function parseTriageResponse(
  raw: string,
  inputItems: Item[],
  policy: SourceTriagePolicy,
): ParseTriageResponseResult {
  const payload = extractJsonArrayPayload(raw);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TriageResponseParseError(`triage response is not valid JSON: ${message}`);
  }

  const arrayResult = AgentResponseSchema.safeParse(parsedJson);
  if (!arrayResult.success) {
    // If the top-level shape failed (e.g. agent returned an object instead of
    // an array), bail to the total-fallback path. Per-entry shape errors are
    // handled below (we still get a partial array there).
    if (!Array.isArray(parsedJson)) {
      throw new TriageResponseParseError(
        `triage response top-level value is not an array: ${arrayResult.error.message}`,
      );
    }
  }

  const inputIds = new Set(inputItems.map((i) => i.id));
  const entries = new Map<string, ValidatedTriageEntry>();
  const warnings: string[] = [];

  // Iterate the raw parsed JSON (which we know is an array at this point) so
  // we can per-entry validate and gather warnings without aborting on the
  // first malformed entry. We re-run AgentEntrySchema per element to get
  // precise error messages.
  const rawArray = Array.isArray(parsedJson) ? parsedJson : [];
  for (let idx = 0; idx < rawArray.length; idx++) {
    const entryResult = AgentEntrySchema.safeParse(rawArray[idx]);
    if (!entryResult.success) {
      warnings.push(
        `entry[${idx}] failed schema validation: ${entryResult.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
      continue;
    }
    const entry = entryResult.data;

    if (!inputIds.has(entry.id)) {
      warnings.push(`entry[${idx}] references unknown id "${entry.id}" (hallucinated, rejected)`);
      continue;
    }

    if (entries.has(entry.id)) {
      warnings.push(`entry[${idx}] duplicates id "${entry.id}" (kept first, ignored)`);
      continue;
    }

    // Apply demotion rules. We track the original decision in the warning so
    // the operator (or feedback CLI) can see why a low-confidence research
    // decision became unsure.
    let decision = entry.decision;
    let reason = entry.reason;
    let demoted = false;

    if (decision === "digest" && (entry.group === undefined || entry.group.trim() === "")) {
      decision = "unsure";
      reason = `digest decision without group key (demoted from "digest"): ${entry.reason}`;
      demoted = true;
      warnings.push(`entry[${idx}] "${entry.id}" demoted: digest without group key`);
    }

    if (decision !== "unsure" && entry.confidence < policy.confidenceThreshold) {
      const original = decision;
      decision = "unsure";
      reason = `confidence ${entry.confidence.toFixed(2)} below threshold ${policy.confidenceThreshold.toFixed(2)} (demoted from "${original}"): ${entry.reason}`;
      demoted = true;
      warnings.push(
        `entry[${idx}] "${entry.id}" demoted: confidence ${entry.confidence.toFixed(2)} < threshold ${policy.confidenceThreshold.toFixed(2)}`,
      );
    }

    entries.set(entry.id, {
      id: entry.id,
      decision,
      confidence: entry.confidence,
      reason,
      group: decision === "digest" ? entry.group : undefined,
      demoted,
    });
  }

  return { entries, warnings };
}
