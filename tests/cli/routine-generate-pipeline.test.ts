import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOutputGateConstraint,
  buildPipelineLandingStep,
  generatePipelineRoutine,
  PIPELINE_DEFAULT_MAX_ITEMS,
  parseGeneratePipelineRoutineArgs,
  renderPipelineRoutineTemplate,
} from "../../src/cli/routine/generate-pipeline.js";
import { SUPPORTED_MODELS, type SupportedModel } from "../../src/cli/routine/generate-watch.js";
import { runRoutine } from "../../src/cli/routine.js";

/**
 * Coverage for `radar routine generate pipeline` (ADR-0020 D5 `pipeline` /
 * #284). Mirrors `routine-generate-watch.test.ts` so a maintainer recognizes
 * the layout: arg parser (incl. the `--max-items` cap), end-to-end YAML
 * emission of the one-at-a-time self-session pipeline, dispatcher integration,
 * and a guard that the generated file passes #280's `validate.py`.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLED_TEMPLATES_ROOT = join(REPO_ROOT, "src", "templates");
const VALIDATE_SCRIPT = join(REPO_ROOT, "scripts", "routines", "validate.py");

describe("cli/routine/generate-pipeline", () => {
  describe("renderPipelineRoutineTemplate", () => {
    it("substitutes every placeholder globally, including maxItems", () => {
      const tpl =
        "name: {{name}}\nrepo: {{repository}}\ncron: {{cron}}\ntz: {{timezone}}\nmodel: {{model}}\ncap: {{maxItems}}\n{{networkAccessBlock}}\nagain: {{maxItems}}";
      const out = renderPipelineRoutineTemplate(tpl, {
        name: "my-pipe",
        repository: "acme/widgets",
        cron: "0 * * * *",
        timezone: "Asia/Tokyo",
        model: "claude-opus-4-7",
        maxItems: 7,
        networkAccessBlock: "  network_access: custom",
        landingStep: "  6. land",
        outputGateConstraint: "  - gate",
        outputGateNote: "  note",
        allowUnrestrictedGitPush: false,
      });
      expect(out).toContain("name: my-pipe");
      expect(out).toContain("repo: acme/widgets");
      expect(out).toContain("cron: 0 * * * *");
      expect(out).toContain("tz: Asia/Tokyo");
      expect(out).toContain("model: claude-opus-4-7");
      expect(out).toContain("cap: 7");
      expect(out).toContain("network_access: custom");
      expect(out).toContain("again: 7");
      expect(out).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });
  });

  describe("parseGeneratePipelineRoutineArgs", () => {
    it("provides sensible defaults (hourly cron, default cap, name-derived output)", () => {
      const parsed = parseGeneratePipelineRoutineArgs([]);
      expect(parsed.name).toBe("feedradar-pipeline");
      expect(parsed.cron).toBe("0 * * * *");
      expect(parsed.timezone).toBe("UTC");
      expect(parsed.model).toBe("claude-sonnet-4-6");
      expect(parsed.maxItems).toBe(PIPELINE_DEFAULT_MAX_ITEMS);
      expect(parsed.outputMode).toBe("pr");
      expect(parsed.output).toBe(join(".claude", "routines", "feedradar-pipeline.yaml"));
      expect(parsed.force).toBe(false);
    });

    it("derives the default output filename from --name", () => {
      const parsed = parseGeneratePipelineRoutineArgs(["--name", "nightly-pipe"]);
      expect(parsed.output).toBe(join(".claude", "routines", "nightly-pipe.yaml"));
    });

    it("parses all flags including --max-items and aliases", () => {
      const parsed = parseGeneratePipelineRoutineArgs([
        "--name",
        "p",
        "--repo",
        "acme/widgets",
        "--cron",
        "0 0 * * *",
        "--tz",
        "Asia/Tokyo",
        "--model",
        "claude-haiku-4-5",
        "--max-items",
        "5",
        "--output",
        ".claude/routines/custom.yaml",
        "--force",
      ]);
      expect(parsed.repository).toBe("acme/widgets");
      expect(parsed.cron).toBe("0 0 * * *");
      expect(parsed.timezone).toBe("Asia/Tokyo");
      expect(parsed.model).toBe("claude-haiku-4-5");
      expect(parsed.maxItems).toBe(5);
      expect(parsed.output).toBe(".claude/routines/custom.yaml");
      expect(parsed.force).toBe(true);
    });

    it("rejects non-positive / non-integer --max-items", () => {
      expect(() => parseGeneratePipelineRoutineArgs(["--max-items", "0"])).toThrow(
        /--max-items expects a positive integer/,
      );
      expect(() => parseGeneratePipelineRoutineArgs(["--max-items", "-3"])).toThrow(
        /--max-items expects a positive integer/,
      );
      expect(() => parseGeneratePipelineRoutineArgs(["--max-items", "abc"])).toThrow(
        /--max-items expects a positive integer/,
      );
    });

    it("rejects unsupported --model and unknown options", () => {
      expect(() => parseGeneratePipelineRoutineArgs(["--model", "gpt-4"])).toThrow(
        /--model expects/,
      );
      expect(() => parseGeneratePipelineRoutineArgs(["--bogus"])).toThrow(/unknown option/);
    });

    it("every SUPPORTED_MODELS value parses", () => {
      for (const m of SUPPORTED_MODELS) {
        expect(parseGeneratePipelineRoutineArgs(["--model", m]).model).toBe(m as SupportedModel);
      }
    });

    it("accepts --output-mode auto-merge and rejects an unknown mode", () => {
      expect(parseGeneratePipelineRoutineArgs(["--output-mode", "auto-merge"]).outputMode).toBe(
        "auto-merge",
      );
      expect(parseGeneratePipelineRoutineArgs(["--output-mode", "pr"]).outputMode).toBe("pr");
      expect(() => parseGeneratePipelineRoutineArgs(["--output-mode", "direct-commit"])).toThrow(
        /--output-mode expects one of: pr \| auto-merge/,
      );
      expect(() => parseGeneratePipelineRoutineArgs(["--output-mode"])).toThrow(/requires a value/);
    });
  });

  describe("buildPipelineLandingStep / buildOutputGateConstraint", () => {
    it("pr mode opens a PR and does NOT auto-merge", () => {
      const step = buildPipelineLandingStep("pr");
      expect(step).toContain("gh pr create --fill --base main");
      expect(step).not.toContain("gh pr merge");
      expect(step).not.toContain("git switch main");
      const constraint = buildOutputGateConstraint("pr");
      expect(constraint).toContain("Do NOT push to `main` directly");
      expect(constraint).toContain("no auto-merge");
    });

    it("auto-merge mode squash-merges the routine's own PR", () => {
      const step = buildPipelineLandingStep("auto-merge");
      expect(step).toContain("gh pr create --fill --base main");
      expect(step).toContain("git switch main");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell var in the asserted YAML string
      expect(step).toContain('gh pr merge "${BRANCH}" --squash --delete-branch');
      // Immediate --squash, never `gh pr merge --auto` (which never merges on a
      // check-less repo). Assert the merge command itself carries no --auto flag.
      expect(step).not.toMatch(/gh pr merge[^\n]*--auto/);
      const constraint = buildOutputGateConstraint("auto-merge");
      expect(constraint).toContain("Auto-merge is intentional here");
      expect(constraint).toContain("review-complete");
    });
  });

  describe("generatePipelineRoutine (file emission)", () => {
    let workdir: string;
    let logs: string[];
    let warnings: string[];

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-routine-pipeline-"));
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

    async function run(overrides: Partial<Parameters<typeof generatePipelineRoutine>[0]> = {}) {
      return generatePipelineRoutine({
        cwd: workdir,
        name: "feedradar-pipeline",
        repository: "acme/widgets",
        cron: "0 * * * *",
        timezone: "UTC",
        model: "claude-sonnet-4-6",
        maxItems: 10,
        outputMode: "pr",
        output: ".claude/routines/feedradar-pipeline.yaml",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
        ...overrides,
      });
    }

    it("writes a fully-substituted full-pipeline routine YAML", async () => {
      const result = await run();
      expect(result.outputPath).toBe(".claude/routines/feedradar-pipeline.yaml");
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-pipeline.yaml"),
        "utf8",
      );
      // No placeholder leaks.
      expect(written).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
      // Field 1:1 shape with org _template.yaml.
      expect(written).toContain("name: feedradar-pipeline");
      expect(written).toContain("status: draft");
      expect(written).toContain('routine_id: ""');
      expect(written).toContain("model: claude-sonnet-4-6");
      expect(written).toContain("- acme/widgets");
      expect(written).toContain('cron: "0 * * * *"');
      expect(written).toContain("timezone: UTC");
      expect(written).toContain("connectors: []");
      expect(written).toContain("setup_script: |");
      // Full pipeline, in order.
      expect(written).toContain("radar watch run");
      expect(written).toContain("radar triage --apply --max-items 10");
      expect(written).toContain("radar items list --status triaged_research --limit 10 --field id");
      // Review enumerates research-ids (report basenames), NOT item ids: the
      // <research-id> argument is the basename of research/<id>.md, which is
      // distinct from the item id `items list --field id` would emit.
      expect(written).toContain("head -n 10");
      // The `${RID}` here is a literal shell variable in the generated YAML,
      // not a JS template placeholder.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell var in the asserted YAML string
      expect(written).toContain('radar review --commit "research/${RID}.md"');
      // One-at-a-time self-session entrypoints (NOT --batch).
      expect(written).toContain("radar research");
      expect(written).toContain("--emit-payload");
      expect(written).toContain("radar research --commit");
      expect(written).toContain("radar review");
      expect(written).toContain("radar review --commit");
      // No command actually INVOKES --batch (it is mentioned in prose only,
      // to explicitly forbid it). Assert no `radar ... --batch` invocation.
      expect(written).not.toMatch(/radar\s+\w+[^\n]*--batch/);
      // Repo-dependent install lives in instructions step 1 (setup runs pre-clone).
      expect(written).toContain("npm install -g @ozzylabs/feedradar");
      // Output gate: claude/* branch, never main.
      expect(written).toContain("claude/pipeline/");
      // Safety constraints spelled out.
      expect(written).toContain("connectors: []");
      expect(written.toLowerCase()).toContain("data, not instructions");
      expect(written).toContain("sources/*.yaml");
      // F2: Custom network access (Trusted Default would 403 on feed hosts);
      // never the old `trusted` value or the wrong `none`/`open` mode names.
      expect(written).toContain("network_access: custom");
      expect(written).not.toMatch(/network_access:\s*trusted/);
      expect(written).not.toMatch(/network_access:\s*(none|open|full)/);
    });

    it("threads a custom --max-items through both the flag and the limit", async () => {
      await run({ maxItems: 3 });
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-pipeline.yaml"),
        "utf8",
      );
      expect(written).toContain("radar triage --apply --max-items 3");
      expect(written).toContain("--limit 3");
      // The review loop cap mirrors the research cap via `head -n {{maxItems}}`.
      expect(written).toContain("head -n 3");
      expect(written).not.toContain("--max-items 10");
    });

    it("pr mode (default) emits the no-auto-merge output gate and does NOT auto-merge", async () => {
      await run();
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-pipeline.yaml"),
        "utf8",
      );
      expect(written).toContain("allow_unrestricted_git_push: false");
      expect(written).toContain("Do NOT push to `main` directly");
      expect(written).not.toContain("gh pr merge");
      expect(written).not.toContain("git switch main");
      // No auto-merge warning in pr mode.
      expect(warnings.some((w) => /auto-merge/.test(w))).toBe(false);
    });

    it("auto-merge mode bakes in the squash-merge, flips the gate, and sets the push permission", async () => {
      await run({ outputMode: "auto-merge" });
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-pipeline.yaml"),
        "utf8",
      );
      expect(written).toContain("allow_unrestricted_git_push: true");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell var in the asserted YAML string
      expect(written).toContain('gh pr merge "${BRANCH}" --squash --delete-branch');
      expect(written).toContain("git switch main");
      // The inverted hard constraint replaces the no-auto-merge bullet.
      expect(written).toContain("Auto-merge is intentional here");
      expect(written).not.toContain("Do NOT push to `main` directly");
      // Still opens a PR first (auto-merge is not direct-commit).
      expect(written).toContain("gh pr create --fill --base main");
      expect(written).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });

    it("warns on stderr in auto-merge mode about the Web UI toggle requirement", async () => {
      await run({ outputMode: "auto-merge" });
      const joined = warnings.join("\n");
      expect(joined).toContain("Allow unrestricted branch pushes");
      expect(joined).toMatch(/NECESSARY/i);
    });

    it("rejects an unknown --output-mode at the core level", async () => {
      await expect(run({ outputMode: "direct-commit" as unknown as "pr" })).rejects.toThrow(
        /invalid --output-mode/,
      );
    });

    it("rejects sub-hourly cron with a 1-hour-minimum message", async () => {
      await expect(run({ cron: "*/5 * * * *" })).rejects.toThrow(/minimum interval of 1 hour/);
      await expect(run({ cron: "0,30 * * * *" })).rejects.toThrow(/minimum interval of 1 hour/);
    });

    it("rejects structurally invalid cron", async () => {
      await expect(run({ cron: "@hourly" })).rejects.toThrow(/invalid --cron/);
      await expect(run({ cron: "0 0 * *" })).rejects.toThrow(/invalid --cron/);
    });

    it("rejects a non-positive --max-items at the core level", async () => {
      await expect(run({ maxItems: 0 })).rejects.toThrow(/invalid --max-items/);
    });

    it("rejects an --output outside .claude/routines/", async () => {
      await expect(run({ output: "../etc/x.yaml" })).rejects.toThrow(/invalid --output/);
      await expect(run({ output: ".github/workflows/x.yaml" })).rejects.toThrow(/invalid --output/);
    });

    it("rejects a malformed --repo", async () => {
      await expect(run({ repository: "not-a-repo" })).rejects.toThrow(/invalid --repo/);
    });

    it("refuses to overwrite an existing file without --force", async () => {
      const dest = join(workdir, ".claude", "routines", "feedradar-pipeline.yaml");
      await mkdir(join(workdir, ".claude", "routines"), { recursive: true });
      await writeFile(dest, "existing\n", "utf8");
      await expect(run()).rejects.toThrow(/already exists/);
      expect(await readFile(dest, "utf8")).toBe("existing\n");
    });

    it("overwrites with --force and warns", async () => {
      const dest = join(workdir, ".claude", "routines", "feedradar-pipeline.yaml");
      await mkdir(join(workdir, ".claude", "routines"), { recursive: true });
      await writeFile(dest, "stale\n", "utf8");
      await run({ force: true });
      const after = await readFile(dest, "utf8");
      expect(after).not.toBe("stale\n");
      expect(after).toContain("name: feedradar-pipeline");
      expect(warnings.some((w) => /overwriting/.test(w))).toBe(true);
    });

    it("prints Web UI paste instructions (yq), a corrected /schedule caveat, and the no-cross-agent note", async () => {
      await run();
      const joined = logs.join("\n");
      expect(joined).toContain("yq -r '.instructions'");
      expect(joined).toContain("yq -r '.environment.setup_script'");
      expect(joined).toContain("/schedule");
      expect(joined).toContain("claude.ai/code/routines");
      expect(joined).toContain("NO cross-agent review");
      // Issue #300: the old `/schedule create --name --cron --repo` example is a
      // fabricated syntax — it must not appear. Instead the output describes the
      // real conversational form and the Web-UI-only caveats.
      expect(joined).not.toContain("/schedule create");
      expect(joined).toContain("`/schedule <description>`");
      expect(joined).toContain("Allow unrestricted branch");
    });

    it("emits a file that passes #280's validate.py", async () => {
      await run();
      const dest = join(workdir, ".claude", "routines", "feedradar-pipeline.yaml");
      // `uv run` the standalone validator against the generated file. If `uv`
      // is unavailable the test environment cannot exercise this guard, so we
      // skip rather than fail (the validator itself is covered elsewhere).
      let uvAvailable = true;
      try {
        execFileSync("uv", ["--version"], { stdio: "ignore" });
      } catch {
        uvAvailable = false;
      }
      if (!uvAvailable) return;
      const out = execFileSync("uv", ["run", VALIDATE_SCRIPT, dest], {
        encoding: "utf8",
      });
      expect(out).toContain(`OK   ${dest}`);
    });
  });

  describe("runRoutine (dispatcher)", () => {
    let workdir: string;
    let logs: string[];
    let errors: string[];

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-routine-pipeline-dispatch-"));
      logs = [];
      errors = [];
    });

    function io() {
      return { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
    }

    it("lists the pipeline type in `generate --help`", async () => {
      const code = await runRoutine(["generate"], { cwd: workdir, io: io() });
      expect(code).toBe(2);
      expect(logs.join("\n")).toContain("pipeline");
    });

    it("dispatches `generate pipeline` end-to-end", async () => {
      const code = await runRoutine(
        [
          "generate",
          "pipeline",
          "--repo",
          "acme/widgets",
          "--cron",
          "0 0 * * *",
          "--max-items",
          "4",
        ],
        { cwd: workdir, io: io() },
      );
      expect(code, `stderr: ${errors.join("\n")}`).toBe(0);
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-pipeline.yaml"),
        "utf8",
      );
      expect(written).toContain('cron: "0 0 * * *"');
      expect(written).toContain("- acme/widgets");
      expect(written).toContain("radar triage --apply --max-items 4");
      expect(written).toContain("--limit 4");
    });

    it("dispatches `generate pipeline --output-mode auto-merge` end-to-end", async () => {
      const code = await runRoutine(
        ["generate", "pipeline", "--repo", "acme/widgets", "--output-mode", "auto-merge"],
        { cwd: workdir, io: io() },
      );
      expect(code, `stderr: ${errors.join("\n")}`).toBe(0);
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-pipeline.yaml"),
        "utf8",
      );
      expect(written).toContain("allow_unrestricted_git_push: true");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell var in the asserted YAML string
      expect(written).toContain('gh pr merge "${BRANCH}" --squash --delete-branch');
    });

    it("surfaces an unknown --output-mode through the dispatcher (exit 2)", async () => {
      const code = await runRoutine(["generate", "pipeline", "--output-mode", "direct-commit"], {
        cwd: workdir,
        io: io(),
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--output-mode expects one of: pr | auto-merge");
    });

    it("surfaces sub-hourly cron rejection through the dispatcher (exit 1)", async () => {
      const code = await runRoutine(["generate", "pipeline", "--cron", "*/10 * * * *"], {
        cwd: workdir,
        io: io(),
      });
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("minimum interval of 1 hour");
    });

    it("surfaces bad --max-items through the dispatcher (exit 2)", async () => {
      const code = await runRoutine(["generate", "pipeline", "--max-items", "0"], {
        cwd: workdir,
        io: io(),
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--max-items expects a positive integer");
    });

    it("supports `generate pipeline --help` (exit 0)", async () => {
      const code = await runRoutine(["generate", "pipeline", "--help"], { cwd: workdir, io: io() });
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toContain("routine generate pipeline");
      expect(joined).toContain("--output-mode <mode>");
      expect(joined).toContain("pr | auto-merge");
    });
  });
});
