import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LangFlagError,
  parseLangFlag,
  readLangEnv,
  resolveWorkspaceLocale,
} from "../../src/cli/_locale.js";
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

// #342 B6: resolveWorkspaceLocale must tolerate a malformed radar.config.yaml —
// the config layer is dropped (treated as absent) and resolution falls through
// to flag / env / default rather than hard-failing the command.
describe("cli/_locale resolveWorkspaceLocale (malformed config tolerance)", () => {
  async function makeWorkspace(configBody: string | undefined): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "feedradar-loc-"));
    if (configBody !== undefined) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "radar.config.yaml"), configBody, "utf8");
    }
    return dir;
  }

  it("falls back to default (en) when config is unparseable YAML and no flag/env", async () => {
    const cwd = await makeWorkspace("locale: : : broken\n  - nope\n");
    const locale = await resolveWorkspaceLocale({ flag: undefined, cwd, env: {} });
    expect(locale).toBe("en");
  });

  it("honors --lang even when config is unparseable", async () => {
    const cwd = await makeWorkspace("}{ this is not yaml\n");
    const locale = await resolveWorkspaceLocale({ flag: "ja", cwd, env: {} });
    expect(locale).toBe("ja");
  });

  it("honors RADAR_LANG when config is malformed and no flag", async () => {
    const cwd = await makeWorkspace(":\n:\n:\n");
    const locale = await resolveWorkspaceLocale({
      flag: undefined,
      cwd,
      env: { RADAR_LANG: "ja" },
    });
    expect(locale).toBe("ja");
  });

  it("does not warn-crash on a malformed config (warn is best-effort)", async () => {
    const cwd = await makeWorkspace("locale: { unterminated\n");
    const warnings: string[] = [];
    const locale = await resolveWorkspaceLocale({
      flag: undefined,
      cwd,
      env: {},
      warn: (m) => warnings.push(m),
    });
    // config layer dropped -> default en; the schema error surfaces (if at all)
    // only through the command's own config consumer, not here.
    expect(locale).toBe("en");
  });

  it("uses a valid config.locale as the lowest-priority layer", async () => {
    const cwd = await makeWorkspace("locale: ja\n");
    const locale = await resolveWorkspaceLocale({ flag: undefined, cwd, env: {} });
    expect(locale).toBe("ja");
  });
});
