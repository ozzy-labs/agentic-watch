import { describe, expect, it } from "vitest";
import { deriveItemId, deriveStableKey } from "../../../src/core/feeds/derive-id.js";

describe("core/feeds/derive-id — deriveStableKey", () => {
  it("prefers publisherId over url and fallback inputs", () => {
    expect(
      deriveStableKey({
        publisherId: "post-1",
        url: "https://example.com/1",
        fallbackHashInputs: ["Title", "2026-05-12"],
      }),
    ).toBe("post-1");
  });

  it("falls back to url when publisherId is missing", () => {
    expect(
      deriveStableKey({
        url: "https://example.com/posts/1",
        fallbackHashInputs: ["Title", "2026-05-12"],
      }),
    ).toBe("https://example.com/posts/1");
  });

  it("treats empty / whitespace publisherId as absent", () => {
    expect(deriveStableKey({ publisherId: "   ", url: "https://example.com/2" })).toBe(
      "https://example.com/2",
    );
  });

  it("falls back to sha1 of joined inputs when neither id nor url is present", () => {
    const key = deriveStableKey({
      fallbackHashInputs: ["Hello", "2026-05-12T09:00:00Z"],
    });
    // The legacy format was `sha1:<hex>`; preserve it so existing Item.id
    // values remain byte-stable across the refactor.
    expect(key).toMatch(/^sha1:[0-9a-f]{40}$/);
  });

  it("produces deterministic output across calls", () => {
    const a = deriveStableKey({ fallbackHashInputs: ["t", "p"] });
    const b = deriveStableKey({ fallbackHashInputs: ["t", "p"] });
    expect(a).toBe(b);
  });

  it("matches the legacy inline implementation byte-for-byte", () => {
    // Pin against the exact string the legacy `deriveId` would have produced
    // for an input where guid/url are absent and only title/pubDate exist.
    // Regenerating this fixture requires a deliberate decision (it would
    // invalidate every persisted Item.id on disk).
    expect(
      deriveStableKey({
        fallbackHashInputs: ["Hello World", "Mon, 12 May 2026 09:00:00 +0000"],
      }),
    ).toBe("sha1:75f821be7613bf7121bf9f89da50f1d3f4d6ea74");
  });
});

describe("core/feeds/derive-id — deriveItemId", () => {
  it("returns <slug>-<8-hex> for slug-friendly titles", () => {
    const id = deriveItemId("Hello World", "post-1");
    expect(id).toMatch(/^hello-world-[0-9a-f]{8}$/);
  });

  it("returns just the 8-hex hash when the title has no slug-friendly chars", () => {
    expect(deriveItemId("???", "post-1")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("normalizes non-ASCII / punctuation to single dashes and trims trailing dashes", () => {
    const id = deriveItemId("Foo!! Bar??", "k");
    expect(id).toMatch(/^foo-bar-[0-9a-f]{8}$/);
  });

  it("truncates the slug at 40 chars before the hash suffix", () => {
    const longTitle = "a".repeat(80);
    const id = deriveItemId(longTitle, "k");
    const [slug] = id.split(/-(?=[0-9a-f]{8}$)/);
    expect(slug?.length).toBe(40);
  });

  it("produces stable output across calls (same key → same id)", () => {
    expect(deriveItemId("Hello", "k1")).toBe(deriveItemId("Hello", "k1"));
  });

  it("changes the hash suffix when the stableKey changes", () => {
    expect(deriveItemId("Hello", "k1")).not.toBe(deriveItemId("Hello", "k2"));
  });

  it("handles undefined / empty titles as hash-only ids", () => {
    expect(deriveItemId(undefined, "k")).toMatch(/^[0-9a-f]{8}$/);
    expect(deriveItemId("", "k")).toMatch(/^[0-9a-f]{8}$/);
  });
});
