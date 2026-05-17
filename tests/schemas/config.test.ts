import { describe, expect, it } from "vitest";
import { RadarConfigSchema } from "../../src/schemas/config.js";

/**
 * `radar.config.yaml` is workspace-level config. It is allowed to be
 * absent (the resolver falls back to the hard-coded `claude-code`
 * default), so the schema must accept an empty object and reject only
 * values it actively cannot honor — namely an unknown agent id, which
 * would fail later during dispatch with a worse error.
 */
describe("schemas/config (radar.config.yaml)", () => {
  it("accepts an empty config (no overrides — resolver falls back to claude-code)", () => {
    const result = RadarConfigSchema.parse({});
    expect(result.defaultResearchAgent).toBeUndefined();
    expect(result.defaultReviewAgent).toBeUndefined();
  });

  it("accepts only defaultResearchAgent set", () => {
    const result = RadarConfigSchema.parse({ defaultResearchAgent: "codex-cli" });
    expect(result.defaultResearchAgent).toBe("codex-cli");
    expect(result.defaultReviewAgent).toBeUndefined();
  });

  it("accepts only defaultReviewAgent set", () => {
    const result = RadarConfigSchema.parse({ defaultReviewAgent: "gemini-cli" });
    expect(result.defaultResearchAgent).toBeUndefined();
    expect(result.defaultReviewAgent).toBe("gemini-cli");
  });

  it("accepts both defaults set to different agents (research/review cross-check pattern)", () => {
    const result = RadarConfigSchema.parse({
      defaultResearchAgent: "claude-code",
      defaultReviewAgent: "codex-cli",
    });
    expect(result.defaultResearchAgent).toBe("claude-code");
    expect(result.defaultReviewAgent).toBe("codex-cli");
  });

  it("accepts every supported agent id (must stay in sync with AgentIdSchema)", () => {
    for (const agent of ["claude-code", "codex-cli", "gemini-cli", "copilot"] as const) {
      expect(RadarConfigSchema.parse({ defaultResearchAgent: agent }).defaultResearchAgent).toBe(
        agent,
      );
      expect(RadarConfigSchema.parse({ defaultReviewAgent: agent }).defaultReviewAgent).toBe(agent);
    }
  });

  it("rejects an unknown agent id (catches typos at config-load time, not at dispatch)", () => {
    const result = RadarConfigSchema.safeParse({ defaultResearchAgent: "claude" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "defaultResearchAgent");
      expect(issue).toBeDefined();
    }
  });

  it("rejects non-string agent values", () => {
    expect(RadarConfigSchema.safeParse({ defaultResearchAgent: 1 }).success).toBe(false);
    expect(RadarConfigSchema.safeParse({ defaultReviewAgent: null }).success).toBe(false);
  });
});
