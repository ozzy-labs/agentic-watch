import { describe, expect, it } from "vitest";
import { LangFlagError, parseLangFlag, readLangEnv } from "../../src/cli/_locale.js";
import { resolveLocale } from "../../src/core/locale.js";

/**
 * Unit tests for the `--lang` / `RADAR_LANG` extraction helper (ADR-0021,
 * epic #309). Mirrors the `_progress.test.ts` style: assert the helper strips
 * the flag from argv and surfaces the raw value, leaving validation to
 * `resolveLocale`.
 */
describe("cli/_locale parseLangFlag", () => {
  it("returns undefined flag when --lang is absent", () => {
    const { rest, flag } = parseLangFlag(["research", "--agent", "claude-code"]);
    expect(flag).toBeUndefined();
    expect(rest).toEqual(["research", "--agent", "claude-code"]);
  });

  it("extracts the space-separated form (--lang ja)", () => {
    const { rest, flag } = parseLangFlag(["--lang", "ja", "research"]);
    expect(flag).toBe("ja");
    expect(rest).toEqual(["research"]);
  });

  it("extracts the =-joined form (--lang=ja)", () => {
    const { rest, flag } = parseLangFlag(["research", "--lang=ja"]);
    expect(flag).toBe("ja");
    expect(rest).toEqual(["research"]);
  });

  it("returns the raw value unvalidated (resolveLocale owns validation)", () => {
    expect(parseLangFlag(["--lang", "frnch"]).flag).toBe("frnch");
  });

  it("throws LangFlagError when --lang has no following value", () => {
    expect(() => parseLangFlag(["research", "--lang"])).toThrow(LangFlagError);
  });

  it("does not consume the following token for the =-joined form", () => {
    const { rest, flag } = parseLangFlag(["--lang=en", "items"]);
    expect(flag).toBe("en");
    expect(rest).toEqual(["items"]);
  });
});

describe("cli/_locale readLangEnv", () => {
  it("returns the value when RADAR_LANG is set", () => {
    expect(readLangEnv({ RADAR_LANG: "ja" })).toBe("ja");
  });

  it("returns undefined when RADAR_LANG is unset or empty", () => {
    expect(readLangEnv({})).toBeUndefined();
    expect(readLangEnv({ RADAR_LANG: "" })).toBeUndefined();
  });
});

describe("cli/_locale + resolveLocale wiring", () => {
  it("resolves ja from --lang ja", () => {
    const { flag } = parseLangFlag(["--lang", "ja"]);
    const env = readLangEnv({});
    expect(resolveLocale({ flag, env })).toBe("ja");
  });

  it("resolves ja from RADAR_LANG=ja", () => {
    const { flag } = parseLangFlag(["research"]);
    const env = readLangEnv({ RADAR_LANG: "ja" });
    expect(resolveLocale({ flag, env })).toBe("ja");
  });
});
