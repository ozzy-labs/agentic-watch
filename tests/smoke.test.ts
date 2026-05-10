import { describe, expect, it } from "vitest";
import { SourceSchema } from "../src/schemas/source.js";

describe("schemas/source", () => {
  it("parses a minimal RSS source", () => {
    const result = SourceSchema.parse({
      id: "example",
      kind: "rss",
      url: "https://example.com/feed.xml",
    });
    expect(result.id).toBe("example");
    expect(result.kind).toBe("rss");
    expect(result.tags).toEqual([]);
  });
});
