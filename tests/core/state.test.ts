import { describe, expect, it } from "vitest";
import { capSeenIds } from "../../src/core/state.js";

/**
 * Unit coverage for the FIFO `lastSeenIds` cap (#333).
 *
 * `capSeenIds(ids, max)` keeps the newest `max` ids (the tail of the array,
 * since new ids append at the end) and drops the oldest from the front. It is
 * the shared primitive behind both the automatic per-source `maxSeenIds` cap
 * (applied in the watcher) and the manual `radar state prune --keep N` command.
 */
describe("capSeenIds (FIFO lastSeenIds cap)", () => {
  it("keeps the newest N ids and drops the oldest from the front", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(capSeenIds(ids, 3)).toEqual(["c", "d", "e"]);
  });

  it("returns the list unchanged when length <= max", () => {
    const ids = ["a", "b", "c"];
    expect(capSeenIds(ids, 3)).toEqual(["a", "b", "c"]);
    expect(capSeenIds(ids, 10)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when max is undefined (cap disabled)", () => {
    const ids = ["a", "b", "c", "d"];
    expect(capSeenIds(ids, undefined)).toBe(ids);
  });

  it("treats max <= 0 and non-integer max as disabled (no-op)", () => {
    const ids = ["a", "b", "c"];
    expect(capSeenIds(ids, 0)).toBe(ids);
    expect(capSeenIds(ids, -1)).toBe(ids);
    expect(capSeenIds(ids, 1.5)).toBe(ids);
  });

  it("keeps exactly N when the list is far larger (firehose case)", () => {
    const ids = Array.from({ length: 20_958 }, (_, i) => `id-${i}`);
    const capped = capSeenIds(ids, 500);
    expect(capped).toHaveLength(500);
    // Newest tail retained; oldest dropped.
    expect(capped[0]).toBe("id-20458");
    expect(capped[capped.length - 1]).toBe("id-20957");
  });

  it("handles an empty list", () => {
    expect(capSeenIds([], 5)).toEqual([]);
  });
});
