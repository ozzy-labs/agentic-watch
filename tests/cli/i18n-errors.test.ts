import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runDismiss } from "../../src/cli/dismiss.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { initWorkspace } from "../../src/cli/init.js";
import { runItemsList } from "../../src/cli/items.js";
import { runResearch } from "../../src/cli/research.js";
import { runReview } from "../../src/cli/review.js";
import { runRoutine } from "../../src/cli/routine.js";
import { runSource } from "../../src/cli/source.js";
import { runTriage } from "../../src/cli/triage.js";
import { runUndismiss } from "../../src/cli/undismiss.js";
import { runUpdate } from "../../src/cli/update.js";
import { runWatch } from "../../src/cli/watch.js";
import { runWorkflow } from "../../src/cli/workflow.js";
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

  describe("research — validation errors localize (#336)", () => {
    it("localizes the missing <item-id> error", async () => {
      const en = captureIo();
      const codeEn = await runResearch([], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("research: missing <item-id>"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runResearch(["--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("missing <item-id>"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("が指定されていません"))).toBe(true);
    });

    it("localizes the --status requires --batch error + keeps the `research:` prefix", async () => {
      const ja = captureIo();
      const codeJa = await runResearch(["x", "--status", "detected", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(
        ja.captured.error.some((m) => m.startsWith("research:") && m.includes("--batch が必要")),
      ).toBe(true);
    });
  });

  describe("review — validation errors localize (#336)", () => {
    it("localizes the missing <research-id> error", async () => {
      const en = captureIo();
      const codeEn = await runReview([], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("review: missing <research-id>"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runReview(["--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("missing <research-id>"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("が指定されていません"))).toBe(true);
    });
  });

  describe("update — validation errors localize (#336)", () => {
    it("localizes the missing <research-id> error", async () => {
      const en = captureIo();
      const codeEn = await runUpdate([], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("update: missing <research-id>"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runUpdate(["--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("missing <research-id>"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("が指定されていません"))).toBe(true);
    });
  });

  describe("source — validation error + result notification (#336)", () => {
    it("localizes the missing <id> error for `source add`", async () => {
      const en = captureIo();
      const codeEn = await runSource(["add"], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("source add: missing <id>"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runSource(["add", "--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("missing <id>"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("が指定されていません"))).toBe(true);
    });

    it("localizes the unknown-subcommand error", async () => {
      const ja = captureIo();
      const codeJa = await runSource(["frobnicate", "--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("不明なサブコマンド"))).toBe(true);
    });
  });

  describe("triage — validation error + notification (#336)", () => {
    it("localizes the mutually-exclusive modes error", async () => {
      const en = captureIo();
      const codeEn = await runTriage(["--dry-run", "--apply"], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("mutually exclusive"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runTriage(["--dry-run", "--apply", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("mutually exclusive"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("併用できません"))).toBe(true);
    });

    it("localizes the no-detected-match notification", async () => {
      // No sources/ + no items/ short-circuits before classification; the
      // `no sources/ directory` notice is the locale-aware path here.
      const ja = captureIo();
      const codeJa = await runTriage(["--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa, ja.captured.error.join("\n")).toBe(1);
      expect(ja.captured.error.some((m) => m.includes("sources/ ディレクトリがありません"))).toBe(
        true,
      );
    });
  });

  describe("watch — sync parser validation error localizes (#336)", () => {
    it("localizes the --bootstrap / --backfill mutual-exclusion error", async () => {
      // `runWatch` IS the `run` subcommand handler, so the argv is the run-mode
      // flag set (no leading `run` token — that is consumed by the dispatcher).
      const en = captureIo();
      const codeEn = await runWatch(["--bootstrap", "--backfill"], {
        cwd: workdir,
        io: en.io,
      });
      expect(codeEn).toBe(2);
      expect(
        en.captured.error.some((m) =>
          m.includes("--bootstrap and --backfill are mutually exclusive"),
        ),
      ).toBe(true);

      const ja = captureIo();
      const codeJa = await runWatch(["--bootstrap", "--backfill", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(
        ja.captured.error.some((m) =>
          m.includes("--bootstrap and --backfill are mutually exclusive"),
        ),
      ).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("併用できません"))).toBe(true);
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

    // #342 A3: operational warnings (bundled-asset-not-found / skipped-existing /
    // config-locale skips) are now localized too. Force a "skipped existing" warn
    // by pre-creating a target and running without --force.
    it("localizes the skipped-existing-file warning (A3)", async () => {
      // Pre-create AGENTS.md so the AGENTS.md scaffold step warns + skips it.
      await writeFile(join(workdir, "AGENTS.md"), "pre-existing\n", "utf8");
      const en = captureIo();
      await initWorkspace({
        cwd: workdir,
        force: false,
        locale: "en",
        noClaudeSkills: true,
        noGeminiCommands: true,
        noClaudeMd: true,
        noTemplates: true,
        noFeedradarMd: true,
        info: (m) => en.captured.log.push(m),
        warn: (m) => en.captured.warn.push(m),
      });
      expect(en.captured.warn.some((m) => m.includes("skipped existing file"))).toBe(true);

      const ja = captureIo();
      await initWorkspace({
        cwd: workdir,
        force: false,
        locale: "ja",
        noClaudeSkills: true,
        noGeminiCommands: true,
        noClaudeMd: true,
        noTemplates: true,
        noFeedradarMd: true,
        info: (m) => ja.captured.log.push(m),
        warn: (m) => ja.captured.warn.push(m),
      });
      expect(ja.captured.warn.some((m) => m.includes("skipped existing file"))).toBe(false);
      expect(ja.captured.warn.some((m) => m.includes("既存ファイルをスキップ"))).toBe(true);
    });
  });

  // #342 B3 / A1: the workflow / routine dispatcher errors (unknown subcommand /
  // unknown type) route through the translator now that the dispatcher resolves
  // a locale for its help text.
  describe("workflow / routine dispatcher errors localize (#342 A1/B3)", () => {
    it("localizes `workflow: unknown subcommand`", async () => {
      const en = captureIo();
      const codeEn = await runWorkflow(["frobnicate"], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("unknown subcommand"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runWorkflow(["frobnicate", "--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("unknown subcommand"))).toBe(false);
      expect(ja.captured.error.some((m) => m.includes("不明なサブコマンド"))).toBe(true);
    });

    it("localizes `workflow generate: unknown type`", async () => {
      const ja = captureIo();
      const codeJa = await runWorkflow(["generate", "bogus", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("不明なタイプ"))).toBe(true);
    });

    it("localizes `routine: unknown subcommand`", async () => {
      const en = captureIo();
      const codeEn = await runRoutine(["frobnicate"], { cwd: workdir, io: en.io });
      expect(codeEn).toBe(2);
      expect(en.captured.error.some((m) => m.includes("unknown subcommand"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runRoutine(["frobnicate", "--lang", "ja"], { cwd: workdir, io: ja.io });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("不明なサブコマンド"))).toBe(true);
    });

    it("localizes `routine generate: unknown type`", async () => {
      const ja = captureIo();
      const codeJa = await runRoutine(["generate", "bogus", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa).toBe(2);
      expect(ja.captured.error.some((m) => m.includes("不明なタイプ"))).toBe(true);
    });
  });

  // #342 A2: the workflow generate completion summary (wrote / detail rows /
  // required-secrets heading) is localized now.
  describe("workflow generate summaries localize (#342 A2)", () => {
    it("localizes `workflow generate watch` completion output", async () => {
      const en = captureIo();
      const codeEn = await runWorkflow(["generate", "watch"], { cwd: workdir, io: en.io });
      expect(codeEn, en.captured.error.join("\n")).toBe(0);
      expect(en.captured.log.some((m) => m.includes("wrote "))).toBe(true);
      expect(en.captured.log.some((m) => m.includes("Required GitHub Actions secrets"))).toBe(true);

      const ja = captureIo();
      const codeJa = await runWorkflow(
        ["generate", "watch", "--output", ".github/workflows/x.yaml", "--lang", "ja"],
        { cwd: workdir, io: ja.io },
      );
      expect(codeJa, ja.captured.error.join("\n")).toBe(0);
      expect(ja.captured.log.some((m) => m.includes("Required GitHub Actions secrets"))).toBe(
        false,
      );
      expect(ja.captured.log.some((m) => m.includes("を書き込みました"))).toBe(true);
      expect(ja.captured.log.some((m) => m.includes("必要な GitHub Actions シークレット"))).toBe(
        true,
      );
    });
  });

  // #342 A2: the routine generate completion block (wrote / paste flow /
  // /schedule note / output gate) is localized now.
  describe("routine generate summaries localize (#342 A2)", () => {
    it("localizes `routine generate watch` completion output", async () => {
      const ja = captureIo();
      const codeJa = await runRoutine(["generate", "watch", "--repo", "acme/x", "--lang", "ja"], {
        cwd: workdir,
        io: ja.io,
      });
      expect(codeJa, ja.captured.error.join("\n")).toBe(0);
      expect(ja.captured.log.some((m) => m.includes("を書き込みました"))).toBe(true);
      // Web UI paste flow + output-gate line localized.
      expect(ja.captured.log.some((m) => m.includes("Web UI に手で貼り付け"))).toBe(true);
      expect(ja.captured.log.some((m) => m.includes("出力ゲート"))).toBe(true);
      // English literal of the paste heading must be gone.
      expect(ja.captured.log.some((m) => m.includes("paste this routine into the Web UI"))).toBe(
        false,
      );
    });
  });
});
