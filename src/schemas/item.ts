import { z } from "zod";

/**
 * Item status state machine (ADR-0008 + ADR-0018).
 *
 * Original 4-state machine:
 *
 *   detected ──► (dismissed | researched) ──► reviewed
 *
 * Triage extension (ADR-0018) adds 3 intermediate states. `triaged_dismiss`
 * is intentionally **not** a separate status — it is collapsed into existing
 * `dismissed` with the `dismissedBy: "human" | "triage_<agent>"` sub-field
 * recording the origin. Total status count: 4 → 7.
 *
 *   detected
 *     ├── triage ──► triaged_research ──► researched ──► reviewed
 *     ├── triage ──► triaged_digest   ──► researched (digest 合流)
 *     ├── triage ──► triaged_unsure   ──► (human loop) ──► research / dismiss
 *     └── triage ──► dismissed (dismissedBy: triage_<agent>)
 *
 *   dismissed ──► detected (via `radar undismiss`)
 *
 * Status semantics (per ADR-0018 §W-B):
 *
 * - `detected`: watch run emitted the item after filter, triage not yet run
 * - `triaged_research`: triage classified as research-worthy
 * - `triaged_digest`: triage classified as digest candidate (group key in `triage.group`)
 * - `triaged_unsure`: triage confidence below threshold; human judgment needed
 * - `researched`: research report written
 * - `reviewed`: research report reviewed (terminal happy path)
 * - `dismissed`: human or triage agent decided not to research (terminal,
 *   reversible via `radar undismiss`; origin in `dismissedBy`)
 */
export const ItemStatusSchema = z.enum([
  "detected",
  "triaged_research",
  "triaged_digest",
  "triaged_unsure",
  "researched",
  "reviewed",
  "dismissed",
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

/**
 * Decision values produced by a triage agent (ADR-0018).
 *
 * - `research`: item is research-worthy on its own
 * - `digest`: item belongs to a group worth summarizing as a single digest
 * - `dismiss`: item is not research-worthy; collapse into `dismissed`
 * - `unsure`: triage agent's confidence is below `confidenceThreshold`; defer
 *   to human judgment
 */
export const TriageDecisionValueSchema = z.enum(["research", "digest", "dismiss", "unsure"]);
export type TriageDecisionValue = z.infer<typeof TriageDecisionValueSchema>;

/**
 * One feedback datapoint on a prior triage decision (ADR-0018 §W5).
 *
 * `radar triage feedback <item-id> --correct | --wrong [--reason <text>]`
 * appends to the array. Stored as a list so multiple reviewers (or the same
 * reviewer revisiting later) can leave independent verdicts without
 * overwriting each other; downstream stats aggregations decide how to
 * combine them.
 */
export const TriageFeedbackSchema = z.object({
  /**
   * `true` when the human agrees with the triage decision; `false` when they
   * judge it wrong. Stored as a boolean rather than free-text verdict so the
   * `radar triage stats` aggregation (#242) has a deterministic field to
   * count on.
   */
  correct: z.boolean(),
  /** Optional rationale shown alongside `--wrong` (or `--correct` for nuance). */
  reason: z.string().optional(),
  feedbackAt: z.string().datetime(),
});
export type TriageFeedback = z.infer<typeof TriageFeedbackSchema>;

/**
 * Triage decision attached to an item by a triage agent (ADR-0018 §W2 / §W5).
 *
 * Schema rationale (post-review #238 W-I):
 *
 * - The outer field on `Item` is the **singular** `triage` (not `triages`).
 *   This preserves the option of moving to a multi-agent shape (`triage: {
 *   decisions: [...], consensus: ... }`) later via a Zod union without
 *   renaming the field. PR-1 ships the single-agent inner shape only;
 *   multi-agent extension is a future PR and explicitly NOT in scope.
 * - `decision` is a discriminated string, not a nested object, so the same
 *   union-extension pattern can reuse the field name on the inner decision
 *   list without ambiguity.
 * - `feedback` is an array, not a single object — multiple human reviewers
 *   can leave independent verdicts (see `TriageFeedbackSchema` docstring).
 */
export const TriageDecisionSchema = z.object({
  decision: TriageDecisionValueSchema,
  /**
   * Triage agent's self-reported confidence in the decision. Compared against
   * the source's `triagePolicy.confidenceThreshold` (default 0.7) to decide
   * whether to promote `dismiss` / `research` / `digest` outright or
   * downgrade to `unsure` for human review. Stored regardless of outcome so
   * later feedback analysis can correlate confidence with correctness.
   */
  confidence: z.number().min(0).max(1),
  /** Short natural-language rationale from the triage agent. */
  reason: z.string().min(1),
  /**
   * Grouping key used when `decision === "digest"`. Stored as a free-form
   * slug — `radar research --digest --triage-group <group>` collects every
   * `triaged_digest` item sharing this key (ADR-0018 §W-H). Optional because
   * non-digest decisions do not produce a group.
   */
  group: z.string().optional(),
  /**
   * Identifier of the agent that produced the decision. Free-form string
   * rather than `AgentIdSchema` because the triage channel may use a more
   * specific model identifier (e.g. `"gemini-2.5-flash-lite"`) than the
   * coarse adapter id used elsewhere.
   */
  agent: z.string().min(1),
  triagedAt: z.string().datetime(),
  /**
   * Append-only feedback log. Defaults to `[]` so items written before the
   * feedback CLI runs (the common case) deserialize cleanly. Existing items
   * predating ADR-0018 have no `triage` field at all and therefore never
   * need a default for this nested array — the default exists for the
   * `triage` exists, `feedback` not yet populated case.
   */
  feedback: z.array(TriageFeedbackSchema).default([]),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

/**
 * Origin of a `dismissed` decision (ADR-0018 §W2 / §W6).
 *
 * Distinguishes human dismiss from triage-agent dismiss so `radar undismiss`
 * can apply the right safety behavior: triage-origin dismisses are reversible
 * without a flag, human-origin dismisses require `--force` (= confirms the
 * user is overriding their own prior decision, not just an agent's).
 *
 * Defined as a string enum (not a union with `AgentIdSchema`) because the
 * `triage_` prefix lets schema validation reject malformed values like
 * `"claude-code"` (missing prefix) that would silently collide with the
 * `human` case.
 *
 * Maintenance note: this enum mirrors `AgentIdSchema` (`src/schemas/research.ts`)
 * with a `triage_` prefix. When a new agent adapter is added, both enums
 * must be updated in lockstep. A test (`tests/schemas/item.test.ts`)
 * iterates each `AgentIdSchema` value and asserts the corresponding
 * `triage_<agent>` variant parses; that test will fail loudly if the two
 * lists drift out of sync.
 */
export const DismissedBySchema = z.enum([
  "human",
  "triage_claude-code",
  "triage_codex-cli",
  "triage_gemini-cli",
  "triage_copilot",
]);
export type DismissedBy = z.infer<typeof DismissedBySchema>;

export const ItemSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  title: z.string(),
  url: z.string().url(),
  publishedAt: z.string().datetime().optional(),
  fetchedAt: z.string().datetime(),
  summary: z.string().optional(),
  raw: z.unknown().optional(),
  matchedKeywords: z.array(z.string()).default([]),
  /**
   * Which `matchFields` actually produced a keyword hit (#332). Recorded by
   * `src/core/filter.ts` so downstream consumers (triage payload, `radar
   * source test`) can distinguish a title hit from a summary-only mention —
   * the latter is a frequent false-positive source when `matchFields`
   * includes `summary` (a body that merely *mentions* another service's
   * keyword). Order follows the declaration order of `filters.matchFields`.
   *
   * Defaults to `[]` so items written before this field landed deserialize
   * cleanly (the same load-side compat pattern as `matchedKeywords` /
   * `injectionFlags`). Values are drawn from the `MatchField` enum but stored
   * as plain strings to mirror `matchedKeywords` and avoid a load-time
   * failure should the enum ever shrink.
   */
  matchedFields: z.array(z.string()).default([]),
  status: ItemStatusSchema.default("detected"),
  /**
   * Prompt-injection pattern labels that fired when the watcher scanned
   * `title` / `summary` / `raw` (ADR-0009 M1a — Adopt). Audit-only: a
   * non-empty value does NOT change `status`, sanitize content, or block
   * downstream commands. Existing items written before this field landed
   * default to `[]` thanks to the schema default, so load-side compat is
   * automatic.
   */
  injectionFlags: z.array(z.string()).default([]),
  /**
   * Triage decision attached by `radar triage` (ADR-0018). Optional so:
   *
   * 1. Items written before PR-1 (no `triage:` key in YAML) validate cleanly
   *    (W-F migration requirement).
   * 2. Items detected after PR-1 but before triage runs also validate.
   *
   * Field name is intentionally singular even though a future multi-agent
   * triage extension will hold an array of decisions — the migration plan
   * is to widen this field to `z.union([TriageDecisionSchema, MultiAgentTriageSchema])`
   * without renaming, preserving on-disk compat (W-I post-review).
   */
  triage: TriageDecisionSchema.optional(),
  /**
   * Origin of a `dismissed` decision (ADR-0018 §W6). Only meaningful when
   * `status === "dismissed"`; we intentionally do NOT enforce this with a
   * superRefine so legacy `dismissed` items (no `dismissedBy` field, written
   * before ADR-0018) keep validating. Consumers needing origin information
   * should treat `undefined` as "human" for those legacy items.
   */
  dismissedBy: DismissedBySchema.optional(),
});
export type Item = z.infer<typeof ItemSchema>;
