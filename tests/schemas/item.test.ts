import { describe, expect, it } from "vitest";
import {
  DismissedBySchema,
  ItemSchema,
  ItemStatusSchema,
  TriageDecisionSchema,
  TriageDecisionValueSchema,
  TriageFeedbackSchema,
} from "../../src/schemas/item.js";
import { AgentIdSchema } from "../../src/schemas/research.js";

/**
 * Item is the on-disk payload for items/<sourceId>/<itemId>.yaml. The
 * file format is part of the user-visible contract: a breaking change to
 * defaults / required fields silently corrupts every existing workspace,
 * so we pin the shape here.
 */

const MIN_VALID = {
  id: "anthropic-news-2026-05-10-claude-code-update",
  sourceId: "anthropic-news",
  title: "Claude Code update",
  url: "https://example.com/post",
  fetchedAt: "2026-05-10T00:00:00.000Z",
};

describe("schemas/item", () => {
  it("parses a minimal item and applies expected defaults", () => {
    const result = ItemSchema.parse(MIN_VALID);
    // Defaults are part of the contract: changing these silently
    // re-classifies every existing item on disk.
    expect(result.matchedKeywords).toEqual([]);
    expect(result.status).toBe("detected");
    expect(result.injectionFlags).toEqual([]);
    // ADR-0018 fields default to undefined (= not yet triaged / not yet
    // dismissed) so legacy items (pre-PR-1) validate without modification.
    expect(result.triage).toBeUndefined();
    expect(result.dismissedBy).toBeUndefined();
  });

  it("accepts the full set of optional fields", () => {
    const result = ItemSchema.parse({
      ...MIN_VALID,
      publishedAt: "2026-05-09T12:00:00.000Z",
      summary: "ヘッドライン要約",
      raw: { rss: "<entry>...</entry>" },
      matchedKeywords: ["claude", "code"],
      status: "researched",
      injectionFlags: ["ignore_previous"],
    });
    expect(result.publishedAt).toBe("2026-05-09T12:00:00.000Z");
    expect(result.summary).toBe("ヘッドライン要約");
    expect(result.matchedKeywords).toEqual(["claude", "code"]);
    expect(result.status).toBe("researched");
    expect(result.injectionFlags).toEqual(["ignore_previous"]);
  });

  it("rejects empty id / sourceId (load would create unaddressable file)", () => {
    expect(ItemSchema.safeParse({ ...MIN_VALID, id: "" }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...MIN_VALID, sourceId: "" }).success).toBe(false);
  });

  it("rejects a non-URL `url` (downstream commands open it in a browser)", () => {
    const result = ItemSchema.safeParse({ ...MIN_VALID, url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO 8601 fetchedAt (state machine compares timestamps lexicographically)", () => {
    const result = ItemSchema.safeParse({ ...MIN_VALID, fetchedAt: "2026-05-10" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status value", () => {
    // ADR-0008 + ADR-0018 pin the state machine to 7 named statuses.
    // Adding a new state requires a deliberate schema + ADR update.
    const result = ItemSchema.safeParse({ ...MIN_VALID, status: "in_progress" });
    expect(result.success).toBe(false);
  });
});

describe("schemas/item — ItemStatusSchema (ADR-0008 + ADR-0018 state machine)", () => {
  it("accepts every status in the post-ADR-0018 set (4 original + 3 triage)", () => {
    const allStatuses = [
      "detected",
      "triaged_research",
      "triaged_digest",
      "triaged_unsure",
      "researched",
      "reviewed",
      "dismissed",
    ] as const;
    // Sanity check: ADR-0018 pinned the total at 7 (4 + 3 new); a regression
    // here would silently break CLI filters expecting the documented count.
    expect(allStatuses.length).toBe(7);
    for (const status of allStatuses) {
      expect(ItemStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects `triaged_dismiss` (collapsed into `dismissed` per ADR-0018 §W2)", () => {
    // The hybrid state-machine decision intentionally omits `triaged_dismiss`
    // — triage-origin dismisses use `status: dismissed` with `dismissedBy:
    // triage_<agent>`. A future regression that adds `triaged_dismiss` back
    // would fork the `dismissed` semantic and break `undismiss`.
    const result = ItemStatusSchema.safeParse("triaged_dismiss");
    expect(result.success).toBe(false);
  });

  it("rejects values outside the canonical set", () => {
    expect(ItemStatusSchema.safeParse("pending").success).toBe(false);
    expect(ItemStatusSchema.safeParse("").success).toBe(false);
    expect(ItemStatusSchema.safeParse(null).success).toBe(false);
  });
});

describe("schemas/item — TriageDecisionSchema (ADR-0018 §W2/W5)", () => {
  const MIN_TRIAGE = {
    decision: "research" as const,
    confidence: 0.85,
    reason: "AWS service GA — high relevance",
    agent: "gemini-2.5-flash-lite",
    triagedAt: "2026-05-23T10:00:00.000Z",
  };

  it("parses a minimal triage decision and defaults feedback to []", () => {
    const result = TriageDecisionSchema.parse(MIN_TRIAGE);
    expect(result.decision).toBe("research");
    expect(result.confidence).toBe(0.85);
    expect(result.agent).toBe("gemini-2.5-flash-lite");
    expect(result.feedback).toEqual([]);
    expect(result.group).toBeUndefined();
  });

  it("accepts the full decision set", () => {
    for (const decision of ["research", "digest", "dismiss", "unsure"] as const) {
      const result = TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, decision });
      expect(result.success, `decision=${decision} should parse`).toBe(true);
    }
  });

  it("accepts a `group` slug for digest decisions", () => {
    const result = TriageDecisionSchema.parse({
      ...MIN_TRIAGE,
      decision: "digest",
      group: "region-expansion-2026q2",
    });
    expect(result.group).toBe("region-expansion-2026q2");
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, confidence: -0.1 }).success).toBe(false);
    expect(TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, confidence: 1.5 }).success).toBe(false);
  });

  it("rejects empty reason / agent (the YAML would be undebuggable)", () => {
    expect(TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, reason: "" }).success).toBe(false);
    expect(TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, agent: "" }).success).toBe(false);
  });

  it("rejects a non-ISO 8601 triagedAt", () => {
    const result = TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, triagedAt: "2026-05-23" });
    expect(result.success).toBe(false);
  });

  it("accepts a feedback array with append-only entries", () => {
    const result = TriageDecisionSchema.parse({
      ...MIN_TRIAGE,
      feedback: [
        { correct: true, feedbackAt: "2026-05-23T11:00:00.000Z" },
        {
          correct: false,
          reason: "actually was high-priority",
          feedbackAt: "2026-05-23T12:00:00.000Z",
        },
      ],
    });
    expect(result.feedback).toHaveLength(2);
    expect(result.feedback[0]?.correct).toBe(true);
    expect(result.feedback[1]?.correct).toBe(false);
    expect(result.feedback[1]?.reason).toBe("actually was high-priority");
  });

  it("rejects unknown decision values", () => {
    const result = TriageDecisionSchema.safeParse({ ...MIN_TRIAGE, decision: "maybe" });
    expect(result.success).toBe(false);
  });

  it("rejects feedback entries with non-boolean `correct`", () => {
    const result = TriageDecisionSchema.safeParse({
      ...MIN_TRIAGE,
      feedback: [{ correct: "yes", feedbackAt: "2026-05-23T11:00:00.000Z" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("schemas/item — TriageDecisionValueSchema / TriageFeedbackSchema", () => {
  it("TriageDecisionValueSchema accepts exactly the 4 ADR-0018 values", () => {
    for (const v of ["research", "digest", "dismiss", "unsure"] as const) {
      expect(TriageDecisionValueSchema.parse(v)).toBe(v);
    }
    expect(TriageDecisionValueSchema.safeParse("triage").success).toBe(false);
  });

  it("TriageFeedbackSchema requires `correct` + `feedbackAt`, reason is optional", () => {
    expect(
      TriageFeedbackSchema.parse({ correct: true, feedbackAt: "2026-05-23T11:00:00.000Z" }).reason,
    ).toBeUndefined();
    expect(TriageFeedbackSchema.safeParse({ feedbackAt: "2026-05-23T11:00:00.000Z" }).success).toBe(
      false,
    );
    expect(TriageFeedbackSchema.safeParse({ correct: true }).success).toBe(false);
  });
});

describe("schemas/item — DismissedBySchema (ADR-0018 §W6)", () => {
  it("accepts `human` and one `triage_<agent>` variant per supported agent", () => {
    for (const v of [
      "human",
      "triage_claude-code",
      "triage_codex-cli",
      "triage_gemini-cli",
      "triage_copilot",
    ] as const) {
      expect(DismissedBySchema.parse(v)).toBe(v);
    }
  });

  it("rejects bare agent ids (must carry `triage_` prefix to avoid collision with `human`)", () => {
    // Without the prefix `claude-code` would look like a status / origin but
    // not encode the triage source — ADR-0018 §W6 wants explicit origin
    // tagging so `undismiss --force` can do the right thing.
    expect(DismissedBySchema.safeParse("claude-code").success).toBe(false);
    expect(DismissedBySchema.safeParse("triage_unknown").success).toBe(false);
  });

  it("stays in lockstep with AgentIdSchema (every agent has a triage_<agent> variant)", () => {
    // DismissedBySchema is a hand-maintained mirror of AgentIdSchema with a
    // `triage_` prefix. When a new adapter is added to AgentIdSchema, both
    // lists must be updated. This test fails loudly if the two drift.
    for (const agent of AgentIdSchema.options) {
      const tagged = `triage_${agent}`;
      const result = DismissedBySchema.safeParse(tagged);
      expect(
        result.success,
        `AgentIdSchema has '${agent}' but DismissedBySchema is missing '${tagged}' — keep these in sync`,
      ).toBe(true);
    }
  });
});

describe("schemas/item — backward compatibility (post-review #238 W-F)", () => {
  it("loads a pre-ADR-0018 item without `triage` / `dismissedBy` fields", () => {
    // Simulates an items/<id>.yaml file written before PR-1 (the common
    // case when an existing workspace runs `radar triage` for the first
    // time). Both new fields must be `.optional()` so validation passes
    // without migration.
    const legacy = {
      id: "anthropic-news-old",
      sourceId: "anthropic-news",
      title: "Old item",
      url: "https://example.com/old",
      fetchedAt: "2026-04-01T00:00:00.000Z",
      // Note: no `triage`, no `dismissedBy`, no `injectionFlags`.
      // matchedKeywords defaults to [], status defaults to detected,
      // injectionFlags defaults to []. The shape mirrors what was on disk
      // before ADR-0009 M1a and before ADR-0018.
    };
    const result = ItemSchema.safeParse(legacy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triage).toBeUndefined();
      expect(result.data.dismissedBy).toBeUndefined();
      expect(result.data.status).toBe("detected");
    }
  });

  it("loads a pre-ADR-0018 `dismissed` item without `dismissedBy`", () => {
    // Legacy dismissed items have no origin tagging. Per ADR-0018 §W6
    // consumers should treat undefined as `"human"`, but the schema itself
    // must not reject them — that would brick every existing workspace
    // with prior dismisses.
    const legacyDismissed = {
      id: "old-dismissed",
      sourceId: "anthropic-news",
      title: "Old dismissed item",
      url: "https://example.com/old-dismissed",
      fetchedAt: "2026-04-01T00:00:00.000Z",
      status: "dismissed",
    };
    const result = ItemSchema.safeParse(legacyDismissed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("dismissed");
      expect(result.data.dismissedBy).toBeUndefined();
    }
  });

  it("accepts an item carrying a full triage block + dismissedBy (post-triage shape)", () => {
    const triaged = {
      ...MIN_VALID,
      status: "dismissed" as const,
      dismissedBy: "triage_gemini-cli" as const,
      triage: {
        decision: "dismiss" as const,
        confidence: 0.92,
        reason: "Minor SDK bump — out of scope",
        agent: "gemini-2.5-flash-lite",
        triagedAt: "2026-05-23T10:00:00.000Z",
      },
    };
    const result = ItemSchema.safeParse(triaged);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dismissedBy).toBe("triage_gemini-cli");
      expect(result.data.triage?.decision).toBe("dismiss");
    }
  });
});
