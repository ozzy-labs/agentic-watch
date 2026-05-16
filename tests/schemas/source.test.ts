import { describe, expect, it } from "vitest";
import { SourceSchema } from "../../src/schemas/source.js";

describe("schemas/source - trustLevel (ADR-0009 M4)", () => {
  it("defaults trustLevel to 'untrusted' when the field is omitted", () => {
    // Mirrors the shape of existing source YAMLs (#17) written before ADR-0009
    // M4 landed. The default must preserve the current defense-in-depth posture
    // so no migration is required.
    const result = SourceSchema.parse({
      id: "anthropic-news",
      kind: "rss",
      url: "https://anthropic.com/news/rss.xml",
    });
    expect(result.trustLevel).toBe("untrusted");
  });

  it("accepts an explicit trustLevel: 'trusted' opt-in", () => {
    const result = SourceSchema.parse({
      id: "internal-feed",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: "trusted",
    });
    expect(result.trustLevel).toBe("trusted");
  });

  it("accepts an explicit trustLevel: 'untrusted'", () => {
    const result = SourceSchema.parse({
      id: "third-party",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: "untrusted",
    });
    expect(result.trustLevel).toBe("untrusted");
  });

  it("rejects an unknown trustLevel value", () => {
    const result = SourceSchema.safeParse({
      id: "bad",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: "foo",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "trustLevel");
      expect(issue).toBeDefined();
    }
  });

  it("rejects a non-string trustLevel value", () => {
    const result = SourceSchema.safeParse({
      id: "bad",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: 1,
    });
    expect(result.success).toBe(false);
  });
});
