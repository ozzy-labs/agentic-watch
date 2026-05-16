import { describe, expect, it } from "vitest";
import { ResearchFrontmatterSchema } from "../../src/schemas/research.js";

/**
 * Phase 5 Sub-issue A (#40): the `supersedes` field links a v(N+1) research
 * file to its predecessor by id. v1 files write `null`; v2+ files write the
 * previous version's id.
 *
 * These tests pin the parse-time contract:
 *
 *   1. Existing v1 frontmatter (generated before Phase 5, no `supersedes`
 *      field at all) must still parse and end up with `supersedes: null`.
 *   2. Explicit `supersedes: null` must parse unchanged.
 *   3. A string id (e.g. the v1 id when this is v2) must parse unchanged.
 *   4. An empty string must be rejected — predecessor ids are non-empty by
 *      construction, and the empty-string case usually signals a serialization
 *      bug we want to surface early.
 */
const V1_FRONTMATTER_WITHOUT_SUPERSEDES = {
  id: "20260511_anthropic-claude-code-update_v1",
  itemIds: ["anthropic-news-2026-05-10-claude-code"],
  agent: "claude-code",
  templateId: "default",
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

describe("ResearchFrontmatterSchema — supersedes field", () => {
  it("parses pre-Phase-5 v1 frontmatter that omits `supersedes` and defaults it to null", () => {
    const result = ResearchFrontmatterSchema.parse(V1_FRONTMATTER_WITHOUT_SUPERSEDES);
    expect(result.supersedes).toBeNull();
    // Existing fields are preserved.
    expect(result.id).toBe(V1_FRONTMATTER_WITHOUT_SUPERSEDES.id);
    expect(result.itemIds).toEqual(V1_FRONTMATTER_WITHOUT_SUPERSEDES.itemIds);
    expect(result.reviewedAt).toBeNull();
    expect(result.reviewedBy).toBeNull();
  });

  it("accepts explicit `supersedes: null` for v1 files", () => {
    const result = ResearchFrontmatterSchema.parse({
      ...V1_FRONTMATTER_WITHOUT_SUPERSEDES,
      supersedes: null,
    });
    expect(result.supersedes).toBeNull();
  });

  it("accepts a previous-version id string for v2+ files", () => {
    const result = ResearchFrontmatterSchema.parse({
      ...V1_FRONTMATTER_WITHOUT_SUPERSEDES,
      id: "20260612_anthropic-claude-code-update_v2",
      supersedes: "20260511_anthropic-claude-code-update_v1",
    });
    expect(result.supersedes).toBe("20260511_anthropic-claude-code-update_v1");
  });

  it("rejects an empty `supersedes` string", () => {
    const result = ResearchFrontmatterSchema.safeParse({
      ...V1_FRONTMATTER_WITHOUT_SUPERSEDES,
      supersedes: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string, non-null `supersedes` value", () => {
    const result = ResearchFrontmatterSchema.safeParse({
      ...V1_FRONTMATTER_WITHOUT_SUPERSEDES,
      supersedes: 42,
    });
    expect(result.success).toBe(false);
  });
});
