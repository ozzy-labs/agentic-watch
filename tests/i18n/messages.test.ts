import { describe, expect, it } from "vitest";
import { createTranslator } from "../../src/i18n/index.js";
import { en } from "../../src/i18n/messages/en.js";
import { ja } from "../../src/i18n/messages/ja.js";

/**
 * Tests for the i18n message catalog + translator (ADR-0021, epic #307 P2).
 *
 * Covers: en/ja key-set parity (belt-and-suspenders alongside the compile-time
 * `Messages` type), `createTranslator` locale routing + interpolation, and the
 * defensive en fallback for a missing key.
 */
describe("i18n catalog parity", () => {
  it("en and ja expose the exact same key set", () => {
    const enKeys = Object.keys(en).sort();
    const jaKeys = Object.keys(ja).sort();
    expect(jaKeys).toEqual(enKeys);
  });

  it("matching keys carry the same value kind (string vs function)", () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(typeof ja[key]).toBe(typeof en[key]);
    }
  });
});

describe("createTranslator", () => {
  it("returns ja strings for a ja translator", () => {
    const t = createTranslator("ja");
    expect(t("cli.help.tagline")).toBe(ja["cli.help.tagline"]);
    expect(t("cli.help.usage")).toBe("使い方: radar <コマンド> [オプション]");
  });

  it("returns en strings for an en translator", () => {
    const t = createTranslator("en");
    expect(t("cli.help.tagline")).toBe(
      "FeedRadar — Multi-agent CLI for blog/release feed research",
    );
  });

  it("interpolates params via the function entry form", () => {
    const tEn = createTranslator("en");
    const tJa = createTranslator("ja");
    expect(tEn("cli.error.unknownCommand", { command: "frobnicate" })).toBe(
      "radar: unknown command 'frobnicate'",
    );
    expect(tJa("cli.error.unknownCommand", { command: "frobnicate" })).toBe(
      "radar: 不明なコマンド 'frobnicate' です",
    );
  });

  it("never yields undefined for any catalog key (en fallback floor)", () => {
    // `Messages` guarantees parity statically; this asserts the *runtime*
    // contract that backs the documented en fallback — a translator resolves
    // every key to a string, never `undefined`, for both locales.
    for (const locale of ["en", "ja"] as const) {
      const t = createTranslator(locale);
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        const entry = en[key];
        const value =
          typeof entry === "function"
            ? // function entries need params; exercise with a representative arg
              t(key, { command: "x" } as never)
            : t(key as never);
        expect(value).toBeTypeOf("string");
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
