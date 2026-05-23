import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  isValidTransition,
  statusForTriageDecision,
  TRIAGE_INTERMEDIATE_STATUSES,
} from "../../src/core/transitions.js";
import type { ItemStatus, TriageDecisionValue } from "../../src/schemas/item.js";

/**
 * Centralized state-machine helper tests (ADR-0008 + ADR-0018).
 *
 * The helper is what every CLI command (research / dismiss / review /
 * future triage / undismiss) calls to validate status mutations. A
 * regression here that silently allows e.g. `reviewed → detected` would
 * let a downstream command roll back a terminal state and re-emit the
 * item for research, so we pin every legal and illegal edge explicitly.
 */

describe("core/transitions — isValidTransition (ADR-0008 + ADR-0018)", () => {
  it("allows the original ADR-0008 happy path (detected → researched → reviewed)", () => {
    expect(isValidTransition("detected", "researched")).toBe(true);
    expect(isValidTransition("researched", "reviewed")).toBe(true);
  });

  it("allows the original ADR-0008 dismiss path (detected → dismissed → detected)", () => {
    expect(isValidTransition("detected", "dismissed")).toBe(true);
    // ADR-0018 §W6: undismiss reinstates dismissed items.
    expect(isValidTransition("dismissed", "detected")).toBe(true);
  });

  it("allows triage to produce every documented intermediate status", () => {
    // ADR-0018 §W-B: detected can move to any of the 3 new intermediate
    // statuses (or directly to dismissed when triage chooses `dismiss`).
    expect(isValidTransition("detected", "triaged_research")).toBe(true);
    expect(isValidTransition("detected", "triaged_digest")).toBe(true);
    expect(isValidTransition("detected", "triaged_unsure")).toBe(true);
  });

  it("allows triage_* statuses to advance to researched / dismissed / re-triage", () => {
    // triaged_research → researched (radar research promotion)
    expect(isValidTransition("triaged_research", "researched")).toBe(true);
    // triaged_digest → researched (radar research --digest --triage-group)
    expect(isValidTransition("triaged_digest", "researched")).toBe(true);
    // triaged_unsure can go either way after human review
    expect(isValidTransition("triaged_unsure", "researched")).toBe(true);
    expect(isValidTransition("triaged_unsure", "dismissed")).toBe(true);
    // Re-triage rolls everything back to detected (ADR-0018 §W2 case 3)
    for (const s of TRIAGE_INTERMEDIATE_STATUSES) {
      expect(isValidTransition(s, "detected"), `${s} → detected should be allowed`).toBe(true);
    }
  });

  it("treats `reviewed` as terminal (no outbound transitions)", () => {
    const allTargets: ItemStatus[] = [
      "detected",
      "triaged_research",
      "triaged_digest",
      "triaged_unsure",
      "researched",
      "reviewed",
      "dismissed",
    ];
    for (const to of allTargets) {
      expect(isValidTransition("reviewed", to), `reviewed → ${to} should be rejected`).toBe(false);
    }
  });

  it("rejects self-transitions (callers must short-circuit before invoking)", () => {
    // Returning true for `from === to` would let idempotent CLI flows
    // double-write the same status / overwrite frontmatter timestamps;
    // the helper deliberately forces callers to be explicit about no-ops.
    const all: ItemStatus[] = [
      "detected",
      "triaged_research",
      "triaged_digest",
      "triaged_unsure",
      "researched",
      "reviewed",
      "dismissed",
    ];
    for (const s of all) {
      expect(isValidTransition(s, s), `${s} → ${s} should be rejected`).toBe(false);
    }
  });

  it("rejects illegal jumps (e.g. detected → reviewed, dismissed → researched)", () => {
    expect(isValidTransition("detected", "reviewed")).toBe(false);
    // dismissed must go through `detected` (undismiss) before re-research,
    // not jump straight to researched — that would skip the redo intent.
    expect(isValidTransition("dismissed", "researched")).toBe(false);
    expect(isValidTransition("researched", "detected")).toBe(false);
    expect(isValidTransition("researched", "dismissed")).toBe(false);
    // triage_* should NOT short-circuit straight to reviewed
    expect(isValidTransition("triaged_research", "reviewed")).toBe(false);
    expect(isValidTransition("triaged_digest", "reviewed")).toBe(false);
    expect(isValidTransition("triaged_unsure", "reviewed")).toBe(false);
  });
});

describe("core/transitions — allowedTransitions", () => {
  it("returns the full outbound set for `detected`", () => {
    // detected supports: triage producing 3 intermediate statuses,
    // human / triage dismissing (→ dismissed), and the legacy
    // `radar research` path (→ researched). That's 5 outbound edges.
    const out = allowedTransitions("detected").sort();
    expect(out).toEqual(
      ["dismissed", "researched", "triaged_digest", "triaged_research", "triaged_unsure"].sort(),
    );
  });

  it("returns an empty array for `reviewed`", () => {
    expect(allowedTransitions("reviewed")).toEqual([]);
  });

  it("returns only [detected] for `dismissed` (= undismiss path)", () => {
    expect(allowedTransitions("dismissed")).toEqual(["detected"]);
  });

  it("returns only [reviewed] for `researched`", () => {
    expect(allowedTransitions("researched")).toEqual(["reviewed"]);
  });
});

describe("core/transitions — statusForTriageDecision", () => {
  it("maps each TriageDecisionValue to the right post-triage status", () => {
    // `dismiss` is the deliberate odd one out: it collapses into the
    // existing `dismissed` status (origin recorded via `dismissedBy`)
    // rather than getting its own `triaged_dismiss` status per ADR-0018 §W2.
    const cases: ReadonlyArray<[TriageDecisionValue, ItemStatus]> = [
      ["research", "triaged_research"],
      ["digest", "triaged_digest"],
      ["unsure", "triaged_unsure"],
      ["dismiss", "dismissed"],
    ];
    for (const [decision, expected] of cases) {
      expect(statusForTriageDecision(decision)).toBe(expected);
    }
  });
});

describe("core/transitions — TRIAGE_INTERMEDIATE_STATUSES", () => {
  it("lists exactly the 3 statuses ADR-0018 §W-B names as intermediate", () => {
    // Sanity check on the constant: a regression that adds `dismissed` here
    // (or drops one of the three) would break CLI filters that branch on
    // "is this item still awaiting research?".
    expect([...TRIAGE_INTERMEDIATE_STATUSES].sort()).toEqual(
      ["triaged_digest", "triaged_research", "triaged_unsure"].sort(),
    );
  });

  it("does not include `dismissed` (origin distinguished via dismissedBy)", () => {
    expect(TRIAGE_INTERMEDIATE_STATUSES).not.toContain("dismissed");
  });
});
