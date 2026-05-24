import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runDismiss } from "../../src/cli/dismiss.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { initWorkspace } from "../../src/cli/init.js";
import { runItemsList } from "../../src/cli/items.js";
import { runUndismiss } from "../../src/cli/undismiss.js";
import { loadRadarConfig, RadarConfigError } from "../../src/core/config.js";
import { createTranslator } from "../../src/i18n/index.js";
import type { Item } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Locale coverage for the user-facing error / result-notification strings
 * catalogued in #312. Each command is driven once in `en` and once in `ja`
 * (via the `--lang` flag, which every command strips before its own parser
 * runs) and we assert the emitted copy actually switches language — i.e. the
 * literal English text is gone and a representative Japanese token is present.
 */

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function captureIo(): {
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  captured: Captured;
} {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (m) => captured.log.push(m),
      warn: (m) => captured.warn.push(m),
      error: (m) => captured.error.push(m),
    },
    captured,
  };
}

async function writeItem(workdir: string, item: Item): Promise<void> {
  await mkdir(join(workdir, "items", item.sourceId), { recursive: true });
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
}

function makeDismissed(): Item {
  return ItemSchema.parse({
    id: "i18n-target",
    sourceId: "src",
    title: "Dismissed item",
    url: "https://example.com/x",
    fetchedAt: "2026-05-20T00:00:00.000Z",
    matchedKeywords: ["test"],
    status: "dismissed",
    dismissedBy: "human",
  });
}

describe("cli/i18n user-facing errors & notifications (#312)", () => {
  let workdir: string;
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "radar-i18n-"));
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  describe("undismiss — representative error path", () => {
    it("emits English by default", async () => {
      const item = makeDismissed();
      await writeItem(workdir, item);
      const { io, captured } = captureIo();
      const code = await runUndismiss([item.id], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("was dismissed by human"))).toBe(true);
      expect(captured.error.some((m) => m.includes("pass --force to revert"))).toBe(true);
    });

    it("emits Japanese with --lang ja", async () => {
      const item = makeDismissed();
      await writeItem(workdir, item);
      const { io, captured } = captureIo();
      const code = await runUndismiss([item.id, "--lang", "ja"], { cwd: workdir, io });
      expect(code).toBe(2);
      // English literal must be gone; Japanese token present.
      expect(captured.error.some((m) => m.includes("was dismissed by human"))).toBe(false);
      expect(captured.error.some((m) => m.includes("人間によって dismiss"))).toBe(true);
      expect(captured.error.some((m) => m.includes("--force"))).toBe(true);
    });

    it("localizes the success notification (transition line)", async () => {
      const item = ItemSchema.parse({ ...makeDismissed(), dismissedBy: "triage_claude-code" });
      await writeItem(workdir, item);
      const { io, captured } = captureIo();
      const code = await runUndismiss([item.id, "--lang", "ja"], { cwd: workdir, io });
      expect(code, captured.error.join("\n")).toBe(0);
      expect(captured.log.some((m) => m.includes("detected に変更しました"))).toBe(true);
    });
  });

  describe("dismiss — validation error + result notification", () => {
    it("localizes the --batch incompatibility error", async () => {
      const { io, captured } = captureIo();
      const codeEn = await runDismiss(["abc", "--batch"], { cwd: workdir, io });
      expect(codeEn).toBe(2);
      expect(captured.error.some((m) => m.includes("--batch is incompatible"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runDismiss(["abc", "--batch", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("--batch is incompatible"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("併用できません"))).toBe(true);
    });

    it("localizes the no-items-matched batch notification", async () => {
      const { io, captured } = captureIo();
      const code = await runDismiss(["--batch", "--lang", "ja"], { cwd: workdir, io });
      expect(code, captured.error.join("\n")).toBe(0);
      expect(captured.log.some((m) => m.includes("一致するアイテムがありません"))).toBe(true);
    });
  });

  describe("doctor — diagnostics are locale-aware", () => {
    it("emits English diagnostics + summary by default", async () => {
      const { io, captured } = captureIo();
      const code = await runDoctor(["--no-proxy-check"], {
        cwd: workdir,
        io,
        whichImpl: async () => undefined,
      });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("missing — run `radar init`"))).toBe(true);
      expect(captured.log.some((m) => /doctor: \d+ ok, \d+ warn, \d+ error/.test(m))).toBe(true);
    });

    it("emits Japanese diagnostics + summary with --lang ja", async () => {
      const { io, captured } = captureIo();
      const code = await runDoctor(["--no-proxy-check", "--lang", "ja"], {
        cwd: workdir,
        io,
        whichImpl: async () => undefined,
      });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("missing — run `radar init`"))).toBe(false);
      expect(captured.log.some((m) => m.includes("がありません"))).toBe(true);
      // The summary keyword line stays English-keyword based by design.
      expect(captured.log.some((m) => /doctor: \d+ ok, \d+ warn, \d+ error/.test(m))).toBe(true);
    });
  });

  describe("zod schema-violation preamble", () => {
    it("renders the English preamble when no translator is passed", async () => {
      await writeFile(
        join(workdir, "radar.config.yaml"),
        stringifyYaml({ locale: "klingon" }),
        "utf8",
      );
      await expect(loadRadarConfig(workdir)).rejects.toBeInstanceOf(RadarConfigError);
      await expect(loadRadarConfig(workdir)).rejects.toThrow(
        /radar\.config\.yaml schema violation:/,
      );
    });

    it("renders the Japanese preamble when a ja translator is passed", async () => {
      await writeFile(
        join(workdir, "radar.config.yaml"),
        stringifyYaml({ locale: "klingon" }),
        "utf8",
      );
      const t = createTranslator("ja");
      const err = await loadRadarConfig(workdir, t).then(
        () => null,
        (e: unknown) => e as RadarConfigError,
      );
      expect(err).toBeInstanceOf(RadarConfigError);
      expect(err?.message).toContain("radar.config.yaml のスキーマ違反:");
      expect(err?.message).not.toContain("schema violation:");
    });

    it("doctor surfaces the ja preamble for a malformed config", async () => {
      await writeFile(
        join(workdir, "radar.config.yaml"),
        stringifyYaml({ defaultResearchAgent: "not-an-agent" }),
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await runDoctor(["--no-proxy-check", "--lang", "ja"], {
        cwd: workdir,
        io,
        whichImpl: async () => undefined,
      });
      expect(code).toBe(1);
      expect(captured.log.some((m) => m.includes("radar.config.yaml が不正です"))).toBe(true);
    });
  });

  describe("items list — validation error + empty notification", () => {
    it("localizes the invalid --status error", async () => {
      const en = captureIo();
      const codeEn = await runItemsList(["--status", "bogus"], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("invalid --status"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runItemsList(["--status", "bogus", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("invalid --status"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("不正な --status"))).toBe(true);
    });

    it("localizes the no-match notification", async () => {
      const { io, captured } = captureIo();
      const code = await runItemsList(["--lang", "ja"], { cwd: workdir, io });
      expect(code, captured.error.join("\n")).toBe(0);
      expect(captured.log.some((m) => m.includes("一致するアイテムがありません"))).toBe(true);
    });
  });

  describe("init — result summary / next-steps", () => {
    it("localizes the post-run summary with locale=ja", async () => {
      const { captured } = captureIo();
      await initWorkspace({
        cwd: workdir,
        force: false,
        locale: "ja",
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noClaudeMd: true,
        noTemplates: true,
        noFeedradarMd: true,
        info: (m) => captured.log.push(m),
        warn: (m) => captured.warn.push(m),
      });
      expect(captured.log.some((m) => m.includes("ワークスペースを"))).toBe(true);
      expect(captured.log.some((m) => m.includes("workspace ready at"))).toBe(false);
    });
  });
});
