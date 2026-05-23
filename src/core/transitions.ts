import type { ItemStatus, TriageDecisionValue } from "../schemas/item.js";

/**
 * Item status state machine helpers (ADR-0008 + ADR-0018).
 *
 * Centralized so every command that mutates `Item.status` validates against
 * the same graph instead of open-coding `if (status !== "detected")` checks.
 * This file is the canonical reference for "which transitions are legal";
 * the CLI commands (`research`, `dismiss`, `review`, future `triage`,
 * `undismiss`) call into the helpers rather than reimplementing the rules.
 *
 *   detected
 *     ├── (radar dismiss)              ──► dismissed
 *     ├── (radar triage → research)    ──► triaged_research
 *     ├── (radar triage → digest)      ──► triaged_digest
 *     ├── (radar triage → dismiss)     ──► dismissed (dismissedBy: triage_<agent>)
 *     ├── (radar triage → unsure)      ──► triaged_unsure
 *     └── (radar research)             ──► researched (legacy path, pre-triage)
 *
 *   triaged_research ──► researched (radar research)
 *                   ──► detected   (radar triage --redo / agent re-classify)
 *
 *   triaged_digest   ──► researched (radar research --digest)
 *                   ──► detected   (radar triage --redo with new grouping)
 *
 *   triaged_unsure   ──► researched (human → radar research)
 *                   ──► dismissed  (human → radar dismiss)
 *                   ──► detected   (radar triage --redo)
 *
 *   researched ──► reviewed (radar review)
 *
 *   dismissed  ──► detected (radar undismiss)
 *
 * `reviewed` is terminal (an `update` produces a new v+1 file without
 * changing `Item.status`).
 */

const TRANSITIONS: Readonly<Record<ItemStatus, ReadonlySet<ItemStatus>>> = {
  detected: new Set<ItemStatus>([
    "triaged_research",
    "triaged_digest",
    "triaged_unsure",
    "dismissed",
    // Legacy path: `radar research` (pre-triage / interactive) can promote
    // a `detected` item straight to `researched` without going through
    // triage. Preserved so existing CLI flows keep working unchanged after
    // PR-1 lands.
    "researched",
  ]),
  triaged_research: new Set<ItemStatus>(["researched", "detected"]),
  triaged_digest: new Set<ItemStatus>(["researched", "detected"]),
  triaged_unsure: new Set<ItemStatus>(["researched", "dismissed", "detected"]),
  researched: new Set<ItemStatus>(["reviewed"]),
  reviewed: new Set<ItemStatus>(),
  dismissed: new Set<ItemStatus>(["detected"]),
};

/**
 * Return `true` when transitioning `from → to` is allowed by the state
 * machine. Same-state transitions return `false` — callers should short-
 * circuit before invoking the state machine in idempotent paths.
 */
export function isValidTransition(from: ItemStatus, to: ItemStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].has(to);
}

/**
 * Return the set of statuses an item in `from` is allowed to transition to.
 * Useful for CLI error messages ("Cannot dismiss a researched item; valid
 * next statuses are: reviewed").
 */
export function allowedTransitions(from: ItemStatus): ItemStatus[] {
  return [...TRANSITIONS[from]];
}

/**
 * Status set produced by the triage layer (ADR-0018 §W-B). Excludes
 * `dismissed` because that is shared with the human-dismiss path — the
 * origin is distinguished at the `dismissedBy` field on `Item`, not by
 * status.
 */
export const TRIAGE_INTERMEDIATE_STATUSES: readonly ItemStatus[] = [
  "triaged_research",
  "triaged_digest",
  "triaged_unsure",
];

/**
 * Map a triage decision to the resulting `Item.status` post-triage.
 *
 * - `research` / `digest` / `unsure` → corresponding intermediate status
 * - `dismiss` → `dismissed` (the triage origin is recorded separately in
 *   `Item.dismissedBy`; the status itself is shared with the human-dismiss
 *   path so existing `undismiss` / filter UX continues to work)
 */
export function statusForTriageDecision(decision: TriageDecisionValue): ItemStatus {
  switch (decision) {
    case "research":
      return "triaged_research";
    case "digest":
      return "triaged_digest";
    case "unsure":
      return "triaged_unsure";
    case "dismiss":
      return "dismissed";
  }
}
