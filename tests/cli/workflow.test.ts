import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentEnvKey,
  generateWatch,
  isSafeWorkflowPath,
  isValidCron,
  parseGenerateWatchArgs,
  renderWatchTemplate,
  type SupportedAgent,
} from "../../src/cli/workflow/generate-watch.js";
import { runWorkflow } from "../../src/cli/workflow.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLED_TEMPLATES_ROOT = join(REPO_ROOT, "src", "templates");

describe("cli/workflow/generate-watch", () => {
  describe("isValidCron", () => {
    // GitHub Actions accepts standard 5-field cron, so we accept the most
    // common shapes a user is likely to type and reject the trap forms
    // (4-field, 6-field with seconds, `@daily` aliases, etc.).
    it("accepts standard 5-field cron expressions", () => {
      expect(isValidCron("0 0 * * *")).toBe(true);
      expect(isValidCron("0 */6 * * *")).toBe(true);
      expect(isValidCron("15 2 1 * *")).toBe(true);
      expect(isValidCron("*/5 * * * *")).toBe(true);
      expect(isValidCron("0 0 1,15 * *")).toBe(true);
      expect(isValidCron("0 9-17 * * 1-5")).toBe(true);
    });

    it("rejects non-5-field expressions", () => {
      expect(isValidCron("0 0 * *")).toBe(false); // 4 fields
      expect(isValidCron("0 0 0 * * *")).toBe(false); // 6 fields (with seconds)
      expect(isValidCron("")).toBe(false);
      expect(isValidCron("   ")).toBe(false);
    });

    it("rejects @daily / @hourly aliases (unsupported by GitHub Actions)", () => {
      expect(isValidCron("@daily")).toBe(false);
      expect(isValidCron("@hourly")).toBe(false);
      expect(isValidCron("@reboot")).toBe(false);
    });

    it("rejects garbage tokens and trailing commas", () => {
      expect(isValidCron("abc 0 * * *")).toBe(false);
      expect(isValidCron("0, 0 * * *")).toBe(false);
      expect(isValidCron("0 0 * * *,")).toBe(false);
    });
  });

  describe("isSafeWorkflowPath", () => {
    const cwd = "/tmp/workspace";

    it("accepts paths under .github/workflows/ with yaml/yml extension", () => {
      expect(isSafeWorkflowPath(".github/workflows/feedradar-watch.yaml", cwd)).toBe(true);
      expect(isSafeWorkflowPath(".github/workflows/watch.yml", cwd)).toBe(true);
      expect(isSafeWorkflowPath(".github/workflows/sub/watch.yaml", cwd)).toBe(true);
    });

    it("rejects path traversal escapes", () => {
      // Both classic `..` traversal and the embedded form must be rejected:
      // GitHub Actions will only load `.github/workflows/*.yaml`, so anything
      // that resolves outside that directory is either user error or attack.
      expect(isSafeWorkflowPath("../etc/passwd", cwd)).toBe(false);
      expect(isSafeWorkflowPath(".github/workflows/../../etc/passwd", cwd)).toBe(false);
      expect(isSafeWorkflowPath(".github/workflows/../../../foo.yaml", cwd)).toBe(false);
    });

    it("rejects absolute paths outside the workspace", () => {
      expect(isSafeWorkflowPath("/etc/foo.yaml", cwd)).toBe(false);
      expect(isSafeWorkflowPath("/tmp/elsewhere.yaml", cwd)).toBe(false);
    });

    it("accepts absolute paths inside the workspace .github/workflows/", () => {
      // Test seam: mkdtemp workdirs are absolute. The validator allows
      // absolute paths only when they resolve into <cwd>/.github/workflows/.
      expect(isSafeWorkflowPath(`${cwd}/.github/workflows/x.yaml`, cwd)).toBe(true);
    });

    it("rejects non-yaml extensions", () => {
      expect(isSafeWorkflowPath(".github/workflows/watch.txt", cwd)).toBe(false);
      expect(isSafeWorkflowPath(".github/workflows/watch", cwd)).toBe(false);
    });

    it("rejects paths outside .github/workflows/", () => {
      expect(isSafeWorkflowPath("watch.yaml", cwd)).toBe(false);
      expect(isSafeWorkflowPath(".github/actions/watch.yaml", cwd)).toBe(false);
      expect(isSafeWorkflowPath("workflows/watch.yaml", cwd)).toBe(false);
    });
  });

  describe("agentEnvKey", () => {
    // ADR-0014 D5 fixes the secret name per agent — these must not drift.
    // The completion-message stdout relies on this mapping so users know
    // exactly which secret to register in Settings.
    it("maps each supported agent to its required secret", () => {
      const cases: [SupportedAgent, string][] = [
        ["claude-code", "ANTHROPIC_API_KEY"],
        ["codex-cli", "OPENAI_API_KEY"],
        ["gemini-cli", "GEMINI_API_KEY"],
        ["copilot", "GITHUB_TOKEN"],
      ];
      for (const [agent, expected] of cases) {
        expect(agentEnvKey(agent)).toBe(expected);
      }
    });
  });

  describe("renderWatchTemplate", () => {
    it("substitutes {{cron}} and {{agentEnvKey}} placeholders", () => {
      const template = "cron: {{cron}}\nenv: {{agentEnvKey}}";
      const rendered = renderWatchTemplate(template, {
        cron: "0 */6 * * *",
        agentEnvKey: "ANTHROPIC_API_KEY",
      });
      expect(rendered).toBe("cron: 0 */6 * * *\nenv: ANTHROPIC_API_KEY");
    });

    it("replaces all occurrences of each placeholder", () => {
      // The bundled template uses {{agentEnvKey}} twice (once as the env
      // key, once as the secrets.<NAME> reference); a non-global replace
      // would leave the second one un-substituted and produce an invalid
      // YAML at runtime.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal YAML containing GitHub Actions ${{ }} expression
      const template = "{{agentEnvKey}}: ${{ secrets.{{agentEnvKey}} }}";
      const rendered = renderWatchTemplate(template, {
        cron: "0 0 * * *",
        agentEnvKey: "ANTHROPIC_API_KEY",
      });
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal YAML containing GitHub Actions ${{ }} expression
      expect(rendered).toBe("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    });

    it("leaves unrelated text untouched", () => {
      const template = "name: feedradar-watch\non:\n  workflow_dispatch: {}\n";
      const rendered = renderWatchTemplate(template, {
        cron: "0 0 * * *",
        agentEnvKey: "ANTHROPIC_API_KEY",
      });
      expect(rendered).toBe(template);
    });
  });

  describe("parseGenerateWatchArgs", () => {
    it("provides sensible defaults", () => {
      const parsed = parseGenerateWatchArgs([]);
      expect(parsed.cron).toBe("0 0 * * *");
      expect(parsed.output).toBe(join(".github", "workflows", "feedradar-watch.yaml"));
      expect(parsed.agent).toBe("claude-code");
      expect(parsed.force).toBe(false);
    });

    it("parses --cron, --output, --agent, --force", () => {
      const parsed = parseGenerateWatchArgs([
        "--cron",
        "0 */6 * * *",
        "--output",
        ".github/workflows/custom.yaml",
        "--agent",
        "gemini-cli",
        "--force",
      ]);
      expect(parsed.cron).toBe("0 */6 * * *");
      expect(parsed.output).toBe(".github/workflows/custom.yaml");
      expect(parsed.agent).toBe("gemini-cli");
      expect(parsed.force).toBe(true);
    });

    it("rejects unsupported --agent values", () => {
      expect(() => parseGenerateWatchArgs(["--agent", "bogus"])).toThrow(/agent/);
    });

    it("rejects unknown options", () => {
      expect(() => parseGenerateWatchArgs(["--bogus"])).toThrow(/unknown option/);
    });
  });

  describe("generateWatch (file emission)", () => {
    let workdir: string;
    let logs: string[];
    let warnings: string[];
    let errors: string[];

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-workflow-"));
      logs = [];
      warnings = [];
      errors = [];
    });

    function io() {
      return {
        log: (m: string) => logs.push(m),
        warn: (m: string) => warnings.push(m),
        error: (m: string) => errors.push(m),
      };
    }

    it("writes the rendered template to the default output path", async () => {
      const result = await generateWatch({
        cwd: workdir,
        cron: "0 0 * * *",
        output: ".github/workflows/feedradar-watch.yaml",
        agent: "claude-code",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
      });
      expect(result.outputPath).toBe(".github/workflows/feedradar-watch.yaml");
      expect(result.requiredSecret).toBe("ANTHROPIC_API_KEY");

      const written = await readFile(
        join(workdir, ".github", "workflows", "feedradar-watch.yaml"),
        "utf8",
      );
      // Placeholders must all be substituted; a stray `{{...}}` indicates a
      // placeholder-renaming bug or a missing entry in renderWatchTemplate.
      expect(written).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
      expect(written).toContain('cron: "0 0 * * *"');
      expect(written).toContain("ANTHROPIC_API_KEY");
      // The rebase retry loop is the headline ADR-0014 D4 feature — its
      // absence would silently regress workflow reliability.
      expect(written).toContain("git pull --rebase");
      expect(written).toContain("attempt");
    });

    it("substitutes --cron value into the schedule block", async () => {
      await generateWatch({
        cwd: workdir,
        cron: "0 */6 * * *",
        output: ".github/workflows/feedradar-watch.yaml",
        agent: "claude-code",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
      });
      const written = await readFile(
        join(workdir, ".github", "workflows", "feedradar-watch.yaml"),
        "utf8",
      );
      expect(written).toContain('cron: "0 */6 * * *"');
    });

    it("uses the agent-specific secret name", async () => {
      await generateWatch({
        cwd: workdir,
        cron: "0 0 * * *",
        output: ".github/workflows/feedradar-watch.yaml",
        agent: "gemini-cli",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
      });
      const written = await readFile(
        join(workdir, ".github", "workflows", "feedradar-watch.yaml"),
        "utf8",
      );
      // The secret name must land in both the env key and the
      // secrets.<NAME> reference; a non-global replace would leave one form
      // un-substituted.
      expect(written).toMatch(/GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
      expect(written).not.toContain("ANTHROPIC_API_KEY");
    });

    it("refuses to overwrite an existing file without --force", async () => {
      const dest = join(workdir, ".github", "workflows", "feedradar-watch.yaml");
      await mkdir(join(workdir, ".github", "workflows"), { recursive: true });
      await writeFile(dest, "existing content\n", "utf8");

      await expect(
        generateWatch({
          cwd: workdir,
          cron: "0 0 * * *",
          output: ".github/workflows/feedradar-watch.yaml",
          agent: "claude-code",
          force: false,
          templatesRoot: BUNDLED_TEMPLATES_ROOT,
          io: io(),
        }),
      ).rejects.toThrow(/already exists/);

      // The original content must remain — overwriting silently would lose
      // any user customization (especially on a workspace where the user
      // hand-edited the bundled `init --with-actions` output).
      const after = await readFile(dest, "utf8");
      expect(after).toBe("existing content\n");
    });

    it("overwrites an existing file when --force is passed", async () => {
      const dest = join(workdir, ".github", "workflows", "feedradar-watch.yaml");
      await mkdir(join(workdir, ".github", "workflows"), { recursive: true });
      await writeFile(dest, "stale\n", "utf8");

      const result = await generateWatch({
        cwd: workdir,
        cron: "0 0 * * *",
        output: ".github/workflows/feedradar-watch.yaml",
        agent: "claude-code",
        force: true,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
      });
      expect(result.outputPath).toBe(".github/workflows/feedradar-watch.yaml");

      const after = await readFile(dest, "utf8");
      expect(after).not.toBe("stale\n");
      expect(after).toContain("name: feedradar-watch");
      // A user-facing warning is the explicit signal that we clobbered an
      // existing file; absence here would suggest the user could lose work
      // without noticing.
      expect(warnings.some((w) => /overwriting/.test(w))).toBe(true);
    });

    it("rejects invalid cron expressions", async () => {
      await expect(
        generateWatch({
          cwd: workdir,
          cron: "@daily",
          output: ".github/workflows/feedradar-watch.yaml",
          agent: "claude-code",
          force: false,
          templatesRoot: BUNDLED_TEMPLATES_ROOT,
          io: io(),
        }),
      ).rejects.toThrow(/invalid --cron/);
    });

    it("rejects --output paths outside .github/workflows/", async () => {
      await expect(
        generateWatch({
          cwd: workdir,
          cron: "0 0 * * *",
          output: "../etc/foo.yaml",
          agent: "claude-code",
          force: false,
          templatesRoot: BUNDLED_TEMPLATES_ROOT,
          io: io(),
        }),
      ).rejects.toThrow(/invalid --output/);
    });

    it("rejects --output paths with traversal segments", async () => {
      await expect(
        generateWatch({
          cwd: workdir,
          cron: "0 0 * * *",
          output: ".github/workflows/../../etc/passwd.yaml",
          agent: "claude-code",
          force: false,
          templatesRoot: BUNDLED_TEMPLATES_ROOT,
          io: io(),
        }),
      ).rejects.toThrow(/invalid --output/);
    });

    it("emits a completion message listing the required secret", async () => {
      await generateWatch({
        cwd: workdir,
        cron: "0 0 * * *",
        output: ".github/workflows/feedradar-watch.yaml",
        agent: "claude-code",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
      });
      // ADR-0014 D5 user-experience requirement: the user must see exactly
      // which secret to register without having to read the ADR.
      expect(logs.some((l) => l.includes("ANTHROPIC_API_KEY"))).toBe(true);
      expect(logs.some((l) => l.includes("GITHUB_TOKEN"))).toBe(true);
    });

    it("for copilot agent surfaces only auto-provisioned GITHUB_TOKEN", async () => {
      await generateWatch({
        cwd: workdir,
        cron: "0 0 * * *",
        output: ".github/workflows/feedradar-watch.yaml",
        agent: "copilot",
        force: false,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        io: io(),
      });
      // The user must not be told to register an ANTHROPIC_API_KEY etc.
      // when running on the copilot agent — that would mislead them into
      // creating a secret with no purpose.
      const joined = logs.join("\n");
      expect(joined).toContain("GITHUB_TOKEN");
      expect(joined).toContain("auto-provisioned");
      expect(joined).not.toContain("ANTHROPIC_API_KEY");
      expect(joined).not.toContain("OPENAI_API_KEY");
      expect(joined).not.toContain("GEMINI_API_KEY");
    });
  });

  describe("runWorkflow (dispatcher)", () => {
    let workdir: string;
    let logs: string[];
    let errors: string[];

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-workflow-dispatch-"));
      logs = [];
      errors = [];
    });

    function io() {
      return {
        log: (m: string) => logs.push(m),
        error: (m: string) => errors.push(m),
      };
    }

    it("prints subcommand help on no args (exit 2)", async () => {
      const code = await runWorkflow([], { cwd: workdir, io: io() });
      expect(code).toBe(2);
      expect(logs.join("\n")).toContain("Usage: radar workflow");
    });

    it("rejects unknown subcommands", async () => {
      const code = await runWorkflow(["bogus"], { cwd: workdir, io: io() });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("unknown subcommand");
    });

    it("rejects unknown generate types", async () => {
      const code = await runWorkflow(["generate", "bogus"], { cwd: workdir, io: io() });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("unknown type");
    });

    it("dispatches to runGenerateWatch for `generate watch`", async () => {
      // End-to-end via the dispatcher to confirm the wiring matches the
      // CLI surface a user would type.
      const code = await runWorkflow(
        ["generate", "watch", "--cron", "0 */6 * * *", "--agent", "codex-cli"],
        { cwd: workdir, io: io() },
      );
      expect(code).toBe(0);
      const written = await readFile(
        join(workdir, ".github", "workflows", "feedradar-watch.yaml"),
        "utf8",
      );
      expect(written).toContain('cron: "0 */6 * * *"');
      expect(written).toContain("OPENAI_API_KEY");
    });
  });
});
