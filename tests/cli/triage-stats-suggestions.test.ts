import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/cli/triage.js";
import type { Item, TriageDecision } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Direct unit coverage for the heuristic policy-tuning suggestions in
 * `radar triage stats` (#242).
 *
 * The suggestion section is the most opinionated part of the command — the
 * thresholds and keyword extraction are documented in the user guide, so we
 * pin the behaviour here so future tuning of the heuristic surfaces in the
 * diff (and CI) rather than silently shifting.
 */

const { buildSuggestions, extractTopKeywordHint, computeHumanOverrides } = __test__;

function triage(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    decision: overrides.decision ?? "research",
    confidence: overrides.confidence ?? 0.85,
    reason: overrides.reason ?? "test",
    agent: overrides.agent ?? "gemini-cli",
    triagedAt: overrides.triagedAt ?? "2026-05-20T10:00:00.000Z",
    group: overrides.group,
    feedback: overrides.feedback ?? [],
  };
}

function item(
  id: string,
  t: TriageDecision,
  status: Item["status"] = "triaged_research",
  matchedKeywords: string[] = ["test"],
  title = `Item ${id}`,
): Item {
  return ItemSchema.parse({
    id,
    sourceId: "src",
    title,
    url: `https://example.com/${id}`,
    fetchedAt: "2026-05-20T10:00:00.000Z",
    matchedKeywords,
    status,
    triage: t,
  });
}

describe("triage stats suggestions", () => {
  it("emits a false-negative hint with the most common matchedKeywords (3+ items)", () => {
    const items = [
      item(
        "1",
        triage({
          decision: "dismiss",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "detected",
        ["sso", "identity"],
      ),
      item(
        "2",
        triage({
          decision: "dismiss",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "detected",
        ["identity", "billing"],
      ),
      item(
        "3",
        triage({
          decision: "dismiss",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "detected",
        ["identity"],
      ),
    ];
    const overrides = computeHumanOverrides(items);
    const suggestions = buildSuggestions(items, overrides);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("3 false negatives");
    // `identity` should rank first (3 occurrences) and lead the keyword hint.
    expect(suggestions[0]).toContain("identity");
  });

  it("emits a false-positive hint when 3+ research/digest items have correct=false", () => {
    const items = [
      item(
        "1",
        triage({
          decision: "research",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "dismissed",
        ["marketing", "blog-post"],
      ),
      item(
        "2",
        triage({
          decision: "digest",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "dismissed",
        ["marketing"],
      ),
      item(
        "3",
        triage({
          decision: "research",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "dismissed",
        ["marketing", "preview"],
      ),
    ];
    const overrides = computeHumanOverrides(items);
    const suggestions = buildSuggestions(items, overrides);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("3 false positives");
    expect(suggestions[0]).toContain("marketing");
  });

  it("stays silent when the override count is below the 3-item threshold", () => {
    const items = [
      item(
        "1",
        triage({
          decision: "dismiss",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "detected",
        ["sso"],
      ),
      item(
        "2",
        triage({
          decision: "dismiss",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "detected",
        ["identity"],
      ),
    ];
    const overrides = computeHumanOverrides(items);
    expect(buildSuggestions(items, overrides)).toEqual([]);
  });

  it("recommends lowering confidenceThreshold when 5+ unsure decisions accumulate", () => {
    const items = [];
    // 3 unsure → researched, 2 unsure → still triaged_unsure (pending human),
    // total 5 unsure decisions.
    for (let i = 0; i < 3; i++) {
      items.push(item(`r${i}`, triage({ decision: "unsure", confidence: 0.5 }), "researched"));
    }
    for (let i = 0; i < 2; i++) {
      items.push(item(`p${i}`, triage({ decision: "unsure", confidence: 0.5 }), "triaged_unsure"));
    }
    const overrides = computeHumanOverrides(items);
    const suggestions = buildSuggestions(items, overrides);
    expect(suggestions.some((s) => s.includes("unsure decisions"))).toBe(true);
    expect(suggestions.some((s) => s.includes("confidenceThreshold"))).toBe(true);
  });

  it("emits both false-negative and false-positive hints when both thresholds fire", () => {
    const fnItems = Array.from({ length: 4 }).map((_, i) =>
      item(
        `fn${i}`,
        triage({
          decision: "dismiss",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "detected",
        ["region"],
      ),
    );
    const fpItems = Array.from({ length: 3 }).map((_, i) =>
      item(
        `fp${i}`,
        triage({
          decision: "research",
          feedback: [{ correct: false, feedbackAt: "2026-05-22T00:00:00.000Z" }],
        }),
        "dismissed",
        ["preview"],
      ),
    );
    const all = [...fnItems, ...fpItems];
    const overrides = computeHumanOverrides(all);
    const suggestions = buildSuggestions(all, overrides);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toContain("4 false negatives");
    expect(suggestions[1]).toContain("3 false positives");
  });

  it("extractTopKeywordHint falls back to title tokens when matchedKeywords is empty", () => {
    const items = [
      item("1", triage(), "triaged_research", [], "Amazon Bedrock GA release announcement"),
      item("2", triage(), "triaged_research", [], "Amazon Bedrock GA pricing update"),
      item("3", triage(), "triaged_research", [], "Amazon Bedrock GA region expansion"),
    ];
    const hint = extractTopKeywordHint(items);
    // 'Bedrock' / 'Amazon' / 'release' / etc. should all be candidates;
    // `Amazon` and `Bedrock` appear 3 times each. We assert at least one
    // shared token surfaces.
    expect(hint).toMatch(/Amazon|Bedrock/);
  });
});
