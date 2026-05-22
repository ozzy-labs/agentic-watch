import { describe, expect, it } from "vitest";
import { JsonPathError, selectAll, selectOne } from "../../../src/core/feeds/_jsonpath.js";

describe("core/feeds/_jsonpath — supported expressions", () => {
  const sample = {
    items: [
      { id: 1, title: "alpha", meta: { tag: "release" } },
      { id: 2, title: "beta", meta: { tag: "beta" } },
      { id: 3, title: "gamma", meta: { tag: "release" } },
    ],
    nextCursor: "abc",
    total: 3,
    nested: { deep: { value: 42 } },
  };

  it("returns root for '$'", () => {
    expect(selectOne("$", sample)).toEqual(sample);
  });

  it("walks dotted property access", () => {
    expect(selectOne("$.nested.deep.value", sample)).toBe(42);
    expect(selectOne("$.nextCursor", sample)).toBe("abc");
  });

  it("walks bracket-form single-key property access", () => {
    expect(selectOne("$['nextCursor']", sample)).toBe("abc");
    expect(selectOne("$['nested']['deep']['value']", sample)).toBe(42);
    expect(selectOne('$["nextCursor"]', sample)).toBe("abc");
  });

  it("indexes into arrays with [N]", () => {
    expect(selectOne("$.items[0].id", sample)).toBe(1);
    expect(selectOne("$.items[2].title", sample)).toBe("gamma");
  });

  it("returns undefined for out-of-range indices", () => {
    expect(selectOne("$.items[99]", sample)).toBeUndefined();
  });

  it("expands [*] into all array elements", () => {
    expect(selectAll("$.items[*]", sample)).toHaveLength(3);
    expect(selectAll("$.items[*].title", sample)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("expands .* into all object values", () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(selectAll("$.*", obj).sort()).toEqual([1, 2, 3]);
  });

  it("returns undefined for missing properties", () => {
    expect(selectOne("$.does.not.exist", sample)).toBeUndefined();
    expect(selectOne("$.items[0].missing", sample)).toBeUndefined();
  });

  it("returns [] for missing arrays in selectAll", () => {
    expect(selectAll("$.does.not.exist[*]", sample)).toEqual([]);
  });

  it("ignores prototype-chain pollution", () => {
    const obj = Object.create({ inherited: "no" });
    obj.own = "yes";
    expect(selectOne("$.own", obj)).toBe("yes");
    expect(selectOne("$.inherited", obj)).toBeUndefined();
  });

  it("does not match array string properties via .field", () => {
    // Arrays are objects in JS but JSONPath should not pick `length` etc.
    expect(selectOne("$.items.length", sample)).toBeUndefined();
  });
});

describe("core/feeds/_jsonpath — out-of-scope expressions throw at parse time", () => {
  it("rejects recursive descent ('..')", () => {
    expect(() => selectAll("$..tag", {})).toThrow(JsonPathError);
    expect(() => selectAll("$..tag", {})).toThrow(/recursive descent/);
  });

  it("rejects filter expressions ('[?(...)]')", () => {
    expect(() => selectAll("$.items[?(@.id > 1)]", {})).toThrow(JsonPathError);
    expect(() => selectAll("$.items[?(@.id > 1)]", {})).toThrow(/filter expression/);
  });

  it("rejects slice expressions ('[N:M]')", () => {
    expect(() => selectAll("$.items[0:2]", {})).toThrow(JsonPathError);
    expect(() => selectAll("$.items[0:2]", {})).toThrow(/slice/);
  });

  it("rejects multi-key bracket expressions", () => {
    expect(() => selectAll("$.items['a','b']", {})).toThrow(JsonPathError);
    expect(() => selectAll("$.items['a','b']", {})).toThrow(/multi-key/);
  });

  it("rejects an empty path", () => {
    expect(() => selectOne("", {})).toThrow(JsonPathError);
  });

  it("rejects paths that do not start with '$'", () => {
    expect(() => selectOne("items[0]", {})).toThrow(JsonPathError);
    expect(() => selectOne("@", {})).toThrow(JsonPathError);
  });

  it("rejects unclosed bracket expressions", () => {
    expect(() => selectOne("$.items[0", {})).toThrow(JsonPathError);
    expect(() => selectOne("$.items[0", {})).toThrow(/unclosed/);
  });

  it("rejects empty bracket keys", () => {
    expect(() => selectOne("$['']", {})).toThrow(JsonPathError);
  });

  it("rejects negative array indices", () => {
    expect(() => selectOne("$.items[-1]", {})).toThrow(JsonPathError);
  });

  it("rejects unsupported bracket expressions", () => {
    expect(() => selectOne("$.items[abc]", {})).toThrow(JsonPathError);
  });

  it("rejects empty property name after '.'", () => {
    expect(() => selectOne("$.", {})).toThrow(JsonPathError);
  });
});

describe("core/feeds/_jsonpath — handles edge values", () => {
  it("returns undefined for null/undefined roots", () => {
    expect(selectOne("$.field", null)).toBeUndefined();
    expect(selectOne("$.field", undefined)).toBeUndefined();
  });

  it("returns [] for null/undefined roots with wildcard", () => {
    expect(selectAll("$.items[*]", null)).toEqual([]);
  });

  it("handles arrays at the root", () => {
    const root = [{ id: 1 }, { id: 2 }];
    expect(selectAll("$[*]", root)).toHaveLength(2);
    expect(selectOne("$[0].id", root)).toBe(1);
  });
});
