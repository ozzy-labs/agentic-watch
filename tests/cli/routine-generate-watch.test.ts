import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  generateWatchRoutine,
  isSafeRoutinePath,
  isSubHourlyCron,
  isValidCron,
  parseGenerateWatchRoutineArgs,
  renderWatchRoutineTemplate,
  SUPPORTED_MODELS,
  type SupportedModel,
} from "../../src/cli/routine/generate-watch.js";
import { runRoutine } from "../../src/cli/routine.js";

/**
 * Coverage for `radar routine generate watch` (ADR-0020 D5 `watch` / #280).
 * Mirrors `workflow.test.ts` so a maintainer recognizes the layout:
 * validators (cron + 1h-minimum + path), arg parser, end-to-end YAML
 * emission, and dispatcher integration.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLED_TEMPLATES_ROOT = join(REPO_ROOT, "src", "templates");

describe("cli/routine/generate-watch", () => {
  describe("isValidCron", () => {
    it("accepts standard 5-field cron expressions (structural)", () => {
      expect(isValidCron("0 * * * *")).toBe(true);
      expect(isValidCron("0 0 * * *")).toBe(true);
      expect(isValidCron("30 */6 * * *")).toBe(true);
      expect(isValidCron("0 9-17 * * 1-5")).toBe(true);
    });

    it("rejects non-5-field / alias / garbage expressions", () => {
      expect(isValidCron("0 0 * *")).toBe(false);
      expect(isValidCron("0 0 0 * * *")).toBe(false);
      expect(isValidCron("@hourly")).toBe(false);
      expect(isValidCron("")).toBe(false);
      expect(isValidCron("0 0 * * *,")).toBe(false);
    });
  });

  describe("isSubHourlyCron (1-hour minimum interval)", () => {
    it("flags expressions that fire more than once per hour", () => {
      expect(isSubHourlyCron("* * * * *")).toBe(true); // every minute
      expect(isSubHourlyCron("*/5 * * * *")).toBe(true); // step
      expect(isSubHourlyCron("0,30 * * * *")).toBe(true); // 2 minutes
      expect(isSubHourlyCron("0-30 * * * *")).toBe(true); // range
    });

    it("accepts hourly-or-coarser (single fixed minute)", () => {
      expect(isSubHourlyCron("0 * * * *")).toBe(false); // hourly
      expect(isSubHourlyCron("30 * * * *")).toBe(false); // hourly at :30
      expect(isSubHourlyCron("0 0 * * *")).toBe(false); // daily
      expect(isSubHourlyCron("15 2 1 * *")).toBe(false); // monthly
    });
  });

  describe("isSafeRoutinePath", () => {
    const cwd = "/tmp/workspace";

    it("accepts .yaml paths under .claude/routines/", () => {
      expect(isSafeRoutinePath(".claude/routines/feedradar-watch.yaml", cwd)).toBe(true);
      expect(isSafeRoutinePath(".claude/routines/my-watch.yaml", cwd)).toBe(true);
    });

    it("rejects traversal, absolute-outside, and wrong-dir paths", () => {
      expect(isSafeRoutinePath("../etc/passwd.yaml", cwd)).toBe(false);
      expect(isSafeRoutinePath(".claude/routines/../../etc/x.yaml", cwd)).toBe(false);
      expect(isSafeRoutinePath("/etc/x.yaml", cwd)).toBe(false);
      expect(isSafeRoutinePath("routines/x.yaml", cwd)).toBe(false);
      expect(isSafeRoutinePath(".github/workflows/x.yaml", cwd)).toBe(false);
    });

    it("rejects non-.yaml extensions (.yml is NOT accepted for routines)", () => {
      expect(isSafeRoutinePath(".claude/routines/x.yml", cwd)).toBe(false);
      expect(isSafeRoutinePath(".claude/routines/x.txt", cwd)).toBe(false);
      expect(isSafeRoutinePath(".claude/routines/x", cwd)).toBe(false);
    });

    it("accepts an absolute path inside the workspace .claude/routines/", () => {
      expect(isSafeRoutinePath(`${cwd}/.claude/routines/x.yaml`, cwd)).toBe(true);
    });
  });

  describe("renderWatchRoutineTemplate", () => {
    it("substitutes every placeholder globally", () => {
      const tpl =
        "name: {{name}}\nrepo: {{repository}}\ncron: {{cron}}\ntz: {{timezone}}\nmodel: {{model}}\nagain: {{name}}";
      const out = renderWatchRoutineTemplate(tpl, {
        name: "my-watch",
        repository: "acme/widgets",
        cron: "0 * * * *",
        timezone: "Asia/Tokyo",
        model: "claude-opus-4-7",
      });
      expect(out).toContain("name: my-watch");
      expect(out).toContain("repo: acme/widgets");
      expect(out).toContain("cron: 0 * * * *");
      expect(out).toContain("tz: Asia/Tokyo");
      expect(out).toContain("model: claude-opus-4-7");
      expect(out).toContain("again: my-watch");
      expect(out).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });
  });

  describe("parseGenerateWatchRoutineArgs", () => {
    it("provides sensible defaults (hourly cron, output derived from name)", () => {
      const parsed = parseGenerateWatchRoutineArgs([]);
      expect(parsed.name).toBe("feedradar-watch");
      expect(parsed.cron).toBe("0 * * * *");
      expect(parsed.timezone).toBe("UTC");
      expect(parsed.model).toBe("claude-sonnet-4-6");
      expect(parsed.output).toBe(join(".claude", "routines", "feedradar-watch.yaml"));
      expect(parsed.force).toBe(false);
    });

    it("derives the default output filename from --name", () => {
      const parsed = parseGenerateWatchRoutineArgs(["--name", "nightly-watch"]);
      expect(parsed.output).toBe(join(".claude", "routines", "nightly-watch.yaml"));
    });

    it("parses all flags including --repo/--tz aliases", () => {
      const parsed = parseGenerateWatchRoutineArgs([
        "--name",
        "w",
        "--repo",
        "acme/widgets",
        "--cron",
        "0 0 * * *",
        "--tz",
        "Asia/Tokyo",
        "--model",
        "claude-haiku-4-6",
        "--output",
        ".claude/routines/custom.yaml",
        "--force",
      ]);
      expect(parsed.repository).toBe("acme/widgets");
      expect(parsed.cron).toBe("0 0 * * *");
      expect(parsed.timezone).toBe("Asia/Tokyo");
      expect(parsed.model).toBe("claude-haiku-4-6");
      expect(parsed.output).toBe(".claude/routines/custom.yaml");
      expect(parsed.force).toBe(true);
    });

    it("rejects unsupported --model and unknown options", () => {
      expect(() => parseGenerateWatchRoutineArgs(["--model", "gpt-4"])).toThrow(/--model expects/);
      expect(() => parseGenerateWatchRoutineArgs(["--bogus"])).toThrow(/unknown option/);
    });

    it("every SUPPORTED_MODELS value parses", () => {
      for (const m of SUPPORTED_MODELS) {
        expect(parseGenerateWatchRoutineArgs(["--model", m]).model).toBe(m as SupportedModel);
      }
    });
  });

  describe("generateWatchRoutine (file emission)", () => {
    let workdir: string;
    let logs: string[];
    let warnings: string[];

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-routine-"));
      logs = [];
      warnings = [];
    });

    function io() {
      return {
        log: (m: string) => logs.push(m),
        warn: (m: string) => warnings.push(m),
        error: () => {},
      };
    }

    async function run(overrides: Partial<Parameters<typeof generateWatchRoutine>[0]> = {}) {
      return generateWatchRoutine({
        cwd: workdir,
        name: "feedradar-watch",
        repository: "acme/widgets",
        cron: "0 * * * *",
        timezone: "UTC",
        model: "claude-sonnet-4-6",
        output: ".claude/routines/feedradar-watch.yaml",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
        ...overrides,
      });
    }

    it("writes a fully-substituted routine YAML with the watch-only shape", async () => {
      const result = await run();
      expect(result.outputPath).toBe(".claude/routines/feedradar-watch.yaml");
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-watch.yaml"),
        "utf8",
      );
      // No placeholder leaks.
      expect(written).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
      // Field 1:1 shape with org _template.yaml.
      expect(written).toContain("name: feedradar-watch");
      expect(written).toContain("status: draft");
      expect(written).toContain('routine_id: ""');
      expect(written).toContain("model: claude-sonnet-4-6");
      expect(written).toContain("- acme/widgets");
      expect(written).toContain('cron: "0 * * * *"');
      expect(written).toContain("timezone: UTC");
      expect(written).toContain("connectors: []");
      expect(written).toContain("setup_script: |");
      // Watch-only: runs `radar watch run`, NOT triage / research / review.
      expect(written).toContain("radar watch run");
      expect(written).not.toContain("radar triage");
      expect(written).not.toContain("radar research");
      // Repo-dependent install lives in instructions step 1 (setup runs pre-clone).
      expect(written).toContain("npm install -g @ozzylabs/feedradar");
      // Output gate: claude/* branch, never main.
      expect(written).toContain("claude/watch/");
    });

    it("rejects sub-hourly cron with a 1-hour-minimum message", async () => {
      await expect(run({ cron: "*/5 * * * *" })).rejects.toThrow(/minimum interval of 1 hour/);
      await expect(run({ cron: "0,30 * * * *" })).rejects.toThrow(/minimum interval of 1 hour/);
    });

    it("rejects structurally invalid cron", async () => {
      await expect(run({ cron: "@hourly" })).rejects.toThrow(/invalid --cron/);
      await expect(run({ cron: "0 0 * *" })).rejects.toThrow(/invalid --cron/);
    });

    it("rejects an --output outside .claude/routines/", async () => {
      await expect(run({ output: "../etc/x.yaml" })).rejects.toThrow(/invalid --output/);
      await expect(run({ output: ".github/workflows/x.yaml" })).rejects.toThrow(/invalid --output/);
    });

    it("rejects a malformed --repo", async () => {
      await expect(run({ repository: "not-a-repo" })).rejects.toThrow(/invalid --repo/);
    });

    it("refuses to overwrite an existing file without --force", async () => {
      const dest = join(workdir, ".claude", "routines", "feedradar-watch.yaml");
      await mkdir(join(workdir, ".claude", "routines"), { recursive: true });
      await writeFile(dest, "existing\n", "utf8");
      await expect(run()).rejects.toThrow(/already exists/);
      expect(await readFile(dest, "utf8")).toBe("existing\n");
    });

    it("overwrites with --force and warns", async () => {
      const dest = join(workdir, ".claude", "routines", "feedradar-watch.yaml");
      await mkdir(join(workdir, ".claude", "routines"), { recursive: true });
      await writeFile(dest, "stale\n", "utf8");
      await run({ force: true });
      const after = await readFile(dest, "utf8");
      expect(after).not.toBe("stale\n");
      expect(after).toContain("name: feedradar-watch");
      expect(warnings.some((w) => /overwriting/.test(w))).toBe(true);
    });

    it("prints Web UI paste instructions (yq) and a /schedule example", async () => {
      await run();
      const joined = logs.join("\n");
      expect(joined).toContain("yq -r '.instructions'");
      expect(joined).toContain("yq -r '.environment.setup_script'");
      expect(joined).toContain("/schedule");
      expect(joined).toContain("claude.ai/code/routines");
    });
  });

  describe("runRoutine (dispatcher)", () => {
    let workdir: string;
    let logs: string[];
    let errors: string[];

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-routine-dispatch-"));
      logs = [];
      errors = [];
    });

    function io() {
      return { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
    }

    it("prints subcommand help on no args (exit 2)", async () => {
      const code = await runRoutine([], { cwd: workdir, io: io() });
      expect(code).toBe(2);
      expect(logs.join("\n")).toContain("Usage: radar routine");
    });

    it("rejects unknown subcommands and types", async () => {
      expect(await runRoutine(["bogus"], { cwd: workdir, io: io() })).toBe(2);
      expect(errors.join("\n")).toContain("unknown subcommand");
      errors.length = 0;
      expect(await runRoutine(["generate", "bogus"], { cwd: workdir, io: io() })).toBe(2);
      expect(errors.join("\n")).toContain("unknown type");
    });

    it("lists the watch type in `generate --help`", async () => {
      const code = await runRoutine(["generate"], { cwd: workdir, io: io() });
      expect(code).toBe(2);
      expect(logs.join("\n")).toContain("watch");
    });

    it("dispatches `generate watch` end-to-end", async () => {
      const code = await runRoutine(
        ["generate", "watch", "--repo", "acme/widgets", "--cron", "0 0 * * *"],
        { cwd: workdir, io: io() },
      );
      expect(code, `stderr: ${errors.join("\n")}`).toBe(0);
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-watch.yaml"),
        "utf8",
      );
      expect(written).toContain('cron: "0 0 * * *"');
      expect(written).toContain("- acme/widgets");
    });

    it("surfaces sub-hourly cron rejection through the dispatcher (exit 1)", async () => {
      const code = await runRoutine(["generate", "watch", "--cron", "*/10 * * * *"], {
        cwd: workdir,
        io: io(),
      });
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("minimum interval of 1 hour");
    });

    it("supports `generate watch --help` (exit 0)", async () => {
      const code = await runRoutine(["generate", "watch", "--help"], { cwd: workdir, io: io() });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("routine generate watch");
    });
  });
});
