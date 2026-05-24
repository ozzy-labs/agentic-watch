import { describe, expect, it, vi } from "vitest";
import {
  applyZodLocale,
  DEFAULT_LOCALE,
  LocaleSchema,
  resolveLocale,
} from "../../src/core/locale.js";

/**
 * Unit tests for the i18n locale foundation (ADR-0021, epic #309).
 *
 * Covers the documented priority chain and lenient fallback behavior of
 * {@link resolveLocale}, plus the locale enum and zod-locale application
 * helper. Message translation is out of scope for this PR, so the zod-locale
 * test only asserts the helper runs without throwing for each branch.
 */
describe("core/locale resolveLocale", () => {
  it("defaults to en when no source supplies a locale", () => {
    expect(resolveLocale({})).toBe("en");
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("resolves config.locale when it is the only source", () => {
    expect(resolveLocale({ config: "ja" })).toBe("ja");
  });

  it("resolves RADAR_LANG when set (overrides config.locale)", () => {
    expect(resolveLocale({ env: "ja", config: "en" })).toBe("ja");
  });

  it("resolves --lang flag (overrides env and config)", () => {
    expect(resolveLocale({ flag: "ja", env: "en", config: "en" })).toBe("ja");
  });

  it("honors the full priority order flag > env > config > default", () => {
    // flag wins over everything
    expect(resolveLocale({ flag: "en", env: "ja", config: "ja" })).toBe("en");
    // env wins when flag absent
    expect(resolveLocale({ env: "ja", config: "en" })).toBe("ja");
    // config wins when flag + env absent
    expect(resolveLocale({ config: "ja" })).toBe("ja");
  });

  it("skips empty-string and undefined sources (does not treat them as invalid)", () => {
    expect(resolveLocale({ flag: "", env: "", config: "ja" })).toBe("ja");
    expect(resolveLocale({ flag: undefined, env: undefined, config: "ja" })).toBe("ja");
  });

  it("falls back to en and warns on an invalid value (does not fall through layers)", () => {
    const warn = vi.fn();
    expect(resolveLocale({ flag: "frnch", env: "ja" }, { warn })).toBe("en");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("frnch");
    expect(warn.mock.calls[0]?.[0]).toContain("--lang");
  });

  it("reports the offending source in the warning (RADAR_LANG)", () => {
    const warn = vi.fn();
    expect(resolveLocale({ env: "de" }, { warn })).toBe("en");
    expect(warn.mock.calls[0]?.[0]).toContain("RADAR_LANG");
  });

  it("reports the offending source in the warning (config.locale)", () => {
    const warn = vi.fn();
    expect(resolveLocale({ config: "es" }, { warn })).toBe("en");
    expect(warn.mock.calls[0]?.[0]).toContain("config.locale");
  });
});

describe("core/locale LocaleSchema", () => {
  it("accepts en and ja", () => {
    expect(LocaleSchema.parse("en")).toBe("en");
    expect(LocaleSchema.parse("ja")).toBe("ja");
  });

  it("rejects unsupported locales", () => {
    expect(LocaleSchema.safeParse("fr").success).toBe(false);
    expect(LocaleSchema.safeParse("").success).toBe(false);
  });
});

describe("core/locale applyZodLocale", () => {
  it("applies each supported locale without throwing", () => {
    expect(() => applyZodLocale("ja")).not.toThrow();
    expect(() => applyZodLocale("en")).not.toThrow();
    // Restore default so other suites are not affected by global zod state.
    applyZodLocale(DEFAULT_LOCALE);
  });
});
