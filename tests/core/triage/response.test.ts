import { describe, expect, it } from "vitest";
import { parseTriageResponse, TriageResponseParseError } from "../../../src/core/triage/index.js";
import type { SourceTriagePolicy } from "../../../src/schemas/source.js";
import { makeItem } from "../../helpers/triage-mock.js";

const POLICY: SourceTriagePolicy = {
  agent: "gemini-cli",
  confidenceThreshold: 0.7,
  rules: "test",
};

const ITEM_A = makeItem({ id: "src-1-2026-05-23-a" });
const ITEM_B = makeItem({ id: "src-1-2026-05-23-b" });

describe("core/triage/parseTriageResponse — happy path", () => {
  it("accepts a clean JSON array with one entry per input id", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.9, reason: "important GA" },
      { id: ITEM_B.id, decision: "dismiss", confidence: 0.85, reason: "minor region expansion" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A, ITEM_B], POLICY);
    expect(result.entries.size).toBe(2);
    expect(result.entries.get(ITEM_A.id)?.decision).toBe("research");
    expect(result.entries.get(ITEM_B.id)?.decision).toBe("dismiss");
    expect(result.warnings).toEqual([]);
  });

  it("strips a leading markdown code fence and still parses", () => {
    const raw = `\`\`\`json\n${JSON.stringify([{ id: ITEM_A.id, decision: "research", confidence: 0.9, reason: "ok" }])}\n\`\`\``;
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.decision).toBe("research");
  });

  it("recovers a JSON array when the agent prepends prose before the array", () => {
    const raw = `Here is the result:\n${JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.95, reason: "ok" },
    ])}\n(end)`;
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.decision).toBe("research");
  });
});

describe("core/triage/parseTriageResponse — Zod validate", () => {
  it("throws TriageResponseParseError on totally invalid JSON", () => {
    expect(() => parseTriageResponse("not json at all", [ITEM_A], POLICY)).toThrow(
      TriageResponseParseError,
    );
  });

  it("throws TriageResponseParseError when the top-level value is not an array", () => {
    const raw = JSON.stringify({ id: ITEM_A.id, decision: "research" });
    expect(() => parseTriageResponse(raw, [ITEM_A], POLICY)).toThrow(TriageResponseParseError);
  });

  it("drops individual entries that fail Zod (missing decision) but keeps the rest", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.9, reason: "ok" },
      { id: ITEM_B.id, confidence: 0.8, reason: "missing decision field" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A, ITEM_B], POLICY);
    expect(result.entries.has(ITEM_A.id)).toBe(true);
    expect(result.entries.has(ITEM_B.id)).toBe(false);
    expect(result.warnings.some((w) => w.includes("entry[1]"))).toBe(true);
  });

  it("rejects entries with confidence outside [0, 1]", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 1.5, reason: "out of range" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.has(ITEM_A.id)).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects entries with an unknown decision value", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "investigate", confidence: 0.9, reason: "made-up decision" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.has(ITEM_A.id)).toBe(false);
  });
});

describe("core/triage/parseTriageResponse — hallucinated id reject", () => {
  it("drops entries whose id is not in the input set", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.9, reason: "real" },
      { id: "totally-made-up-id", decision: "research", confidence: 0.95, reason: "fake" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.size).toBe(1);
    expect(result.entries.has(ITEM_A.id)).toBe(true);
    expect(result.warnings.some((w) => w.includes("hallucinated"))).toBe(true);
  });

  it("keeps the first duplicate of the same id and warns on the second", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.95, reason: "first" },
      { id: ITEM_A.id, decision: "dismiss", confidence: 0.5, reason: "second" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.reason).toBe("first");
    expect(result.warnings.some((w) => w.includes("duplicates"))).toBe(true);
  });
});

describe("core/triage/parseTriageResponse — confidence threshold", () => {
  it("demotes a research entry below the threshold to unsure", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.5, reason: "shaky" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    const entry = result.entries.get(ITEM_A.id);
    expect(entry?.decision).toBe("unsure");
    expect(entry?.demoted).toBe(true);
    expect(entry?.reason).toContain("0.50");
    expect(entry?.reason).toContain("0.70");
  });

  it("does not demote a research entry at or above the threshold", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "research", confidence: 0.7, reason: "exactly threshold" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.decision).toBe("research");
    expect(result.entries.get(ITEM_A.id)?.demoted).toBe(false);
  });

  it("preserves an already-unsure entry below the threshold without flagging demoted", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "unsure", confidence: 0.4, reason: "shrug" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.decision).toBe("unsure");
    expect(result.entries.get(ITEM_A.id)?.demoted).toBe(false);
  });
});

describe("core/triage/parseTriageResponse — digest without group", () => {
  it("demotes a digest entry missing the group key to unsure", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "digest", confidence: 0.95, reason: "group missing" },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    const entry = result.entries.get(ITEM_A.id);
    expect(entry?.decision).toBe("unsure");
    expect(entry?.demoted).toBe(true);
    expect(entry?.group).toBeUndefined();
  });

  it("demotes a digest entry whose group is an empty / whitespace string", () => {
    const raw = JSON.stringify([
      { id: ITEM_A.id, decision: "digest", confidence: 0.9, reason: "blank", group: "" },
    ]);
    // Empty string is rejected by the inner z.string().min(1) on group, so it
    // never reaches the digest-without-group rule — the entry is dropped
    // with a Zod warning instead. Either path is acceptable: the contract is
    // that a malformed digest entry does not end up on disk as a digest.
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.decision).not.toBe("digest");
  });

  it("keeps a digest entry that supplies a non-empty group", () => {
    const raw = JSON.stringify([
      {
        id: ITEM_A.id,
        decision: "digest",
        confidence: 0.9,
        reason: "good group",
        group: "region-expansion-2026q2",
      },
    ]);
    const result = parseTriageResponse(raw, [ITEM_A], POLICY);
    expect(result.entries.get(ITEM_A.id)?.decision).toBe("digest");
    expect(result.entries.get(ITEM_A.id)?.group).toBe("region-expansion-2026q2");
  });
});
