import { describe, expect, it } from "vitest";
import { SourceStateSchema, StateFileSchema } from "../../src/schemas/state.js";

/**
 * State files (`state/<sourceId>.yaml`) drive dedup: `lastSeenIds` is the
 * memory the watcher uses to suppress already-emitted items. A schema
 * regression here re-floods the user with old items on next watch run,
 * so we pin defaults / required fields explicitly.
 */

describe("schemas/state — SourceStateSchema (per-source watch memory)", () => {
  it("parses a minimal source state and defaults lastSeenIds to []", () => {
    const result = SourceStateSchema.parse({ sourceId: "anthropic-news" });
    expect(result.sourceId).toBe("anthropic-news");
    expect(result.lastFetchedAt).toBeUndefined();
    expect(result.lastEtag).toBeUndefined();
    expect(result.lastModified).toBeUndefined();
    // Default [] is load-time invariant: a missing field must NOT be
    // re-emitted as "no memory" (which would re-flood the user).
    expect(result.lastSeenIds).toEqual([]);
  });

  it("accepts all optional fields populated (post-first-fetch shape)", () => {
    const result = SourceStateSchema.parse({
      sourceId: "anthropic-news",
      lastFetchedAt: "2026-05-10T00:00:00.000Z",
      lastEtag: 'W/"abc123"',
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
      lastSeenIds: ["id-1", "id-2"],
    });
    expect(result.lastFetchedAt).toBe("2026-05-10T00:00:00.000Z");
    expect(result.lastEtag).toBe('W/"abc123"');
    expect(result.lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(result.lastSeenIds).toEqual(["id-1", "id-2"]);
  });

  it("preserves lastModified as an opaque RFC 1123 string (not coerced to Date)", () => {
    // HTTP `Last-Modified` is RFC 1123 / RFC 7231, not ISO 8601, so we must
    // accept the server-supplied form verbatim — the adapter echoes it back
    // in `If-Modified-Since` without re-formatting.
    const result = SourceStateSchema.parse({
      sourceId: "x",
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
    expect(result.lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("rejects a non-string lastModified (would break If-Modified-Since echo)", () => {
    expect(SourceStateSchema.safeParse({ sourceId: "x", lastModified: 1729495680 }).success).toBe(
      false,
    );
  });

  it("rejects empty sourceId (unaddressable state file)", () => {
    expect(SourceStateSchema.safeParse({ sourceId: "" }).success).toBe(false);
  });

  it("rejects non-ISO 8601 lastFetchedAt (lexicographic comparison would break)", () => {
    expect(
      SourceStateSchema.safeParse({ sourceId: "x", lastFetchedAt: "2026-05-10" }).success,
    ).toBe(false);
  });

  it("rejects non-string entries in lastSeenIds (dedup compare relies on string equality)", () => {
    expect(SourceStateSchema.safeParse({ sourceId: "x", lastSeenIds: ["ok", 42] }).success).toBe(
      false,
    );
  });
});

describe("schemas/state — StateFileSchema (envelope)", () => {
  it("parses an empty state file (no sources yet)", () => {
    const result = StateFileSchema.parse({ version: 1 });
    expect(result.version).toBe(1);
    expect(result.sources).toEqual([]);
  });

  it("parses a state file with multiple per-source records", () => {
    const result = StateFileSchema.parse({
      version: 1,
      sources: [{ sourceId: "a" }, { sourceId: "b", lastSeenIds: ["x"] }],
    });
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].sourceId).toBe("a");
    expect(result.sources[1].lastSeenIds).toEqual(["x"]);
  });

  it("rejects version != 1 (forward-compat: explicit bump must be deliberate)", () => {
    expect(StateFileSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(StateFileSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(StateFileSchema.safeParse({ version: "1" }).success).toBe(false);
  });

  it("rejects a missing version (callers must declare schema version)", () => {
    expect(StateFileSchema.safeParse({ sources: [] }).success).toBe(false);
  });
});
