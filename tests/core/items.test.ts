import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadItems, saveItems } from "../../src/core/items.js";
import type { Item } from "../../src/schemas/index.js";

const FIXED_FETCHED_AT = "2026-05-12T00:00:00.000Z";

function makeItem(overrides: Partial<Item>): Item {
  return {
    id: "placeholder",
    sourceId: "src",
    title: "t",
    url: "https://example.com/post",
    fetchedAt: FIXED_FETCHED_AT,
    matchedKeywords: [],
    status: "detected",
    ...overrides,
  };
}

describe("items round-trip with sanitized filenames", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-items-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves and loads an item whose id is a URL", async () => {
    const item = makeItem({
      id: "https://github.blog/?p=95797",
      sourceId: "github-blog",
      title: "GitHub Blog Post",
    });

    await saveItems(dir, [item]);

    const files = await readdir(join(dir, "github-blog"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^https___github\.blog__p_95797-[0-9a-f]{8}\.yaml$/);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain(":");
    expect(files[0]).not.toContain("?");

    const loaded = await loadItems(dir, "github-blog");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("https://github.blog/?p=95797");
  });

  it("does not collide when two distinct ids sanitize to the same string", async () => {
    const a = makeItem({ id: "a/b", sourceId: "s", title: "A" });
    const b = makeItem({ id: "a:b", sourceId: "s", title: "B" });

    await saveItems(dir, [a, b]);

    const files = await readdir(join(dir, "s"));
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);

    const loaded = await loadItems(dir, "s");
    expect(loaded.map((i) => i.id).sort()).toEqual(["a/b", "a:b"]);
  });

  it("truncates very long ids while still round-tripping", async () => {
    const longId = `x${"y".repeat(500)}`;
    const item = makeItem({ id: longId, sourceId: "s" });

    await saveItems(dir, [item]);

    const files = await readdir(join(dir, "s"));
    expect(files).toHaveLength(1);
    expect((files[0] ?? "").length).toBeLessThan(110);

    const loaded = await loadItems(dir, "s");
    expect(loaded[0]?.id).toBe(longId);
  });

  it("leaves already-safe short ids unchanged", async () => {
    const item = makeItem({ id: "post-123", sourceId: "s" });
    await saveItems(dir, [item]);
    const files = await readdir(join(dir, "s"));
    expect(files).toEqual(["post-123.yaml"]);
  });
});
