import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSafeWorkflowPath,
  isValidCron,
  isValidMaxItems,
  parseGenerateCombinedArgs,
  renderCombinedTemplate,
  renderFilterTagsLiteral,
  runGenerateCombined,
} from "../../src/cli/workflow/generate-combined.js";
import { runWorkflow } from "../../src/cli/workflow.js";

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

async function setupWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "feedradar-workflow-combined-"));
}

describe("cli/workflow generate combined (#189 / ADR-0014)", () => {
  describe("validators", () => {
    it("accepts standard 5-field cron and rejects malformed expressions", () => {
      expect(isValidCron("0 0 * * *")).toBe(true);
      expect(isValidCron("*/15 * * * *")).toBe(true);
      expect(isValidCron("0 0 1-7 * 1")).toBe(true);
      // Wrong shape: must surface as a validator-level reject, not "GitHub Actions silently never fires".
      expect(isValidCron("0 0 * *")).toBe(false);
      expect(isValidCron("@daily")).toBe(false);
      expect(isValidCron("")).toBe(false);
      expect(isValidCron("0 0 0 0 0 0")).toBe(false);
    });

    it("isSafeWorkflowPath rejects traversal / absolute / non-yaml outputs", () => {
      const cwd = "/tmp/fakecwd";
      expect(isSafeWorkflowPath(".github/workflows/x.yaml", cwd)).toBe(true);
      expect(isSafeWorkflowPath(".github/workflows/x.yml", cwd)).toBe(true);
      expect(isSafeWorkflowPath(".github/workflows/../../etc/cron", cwd)).toBe(false);
      expect(isSafeWorkflowPath("/etc/cron.d/x.yaml", cwd)).toBe(false);
      expect(isSafeWorkflowPath(".github/workflows/x.json", cwd)).toBe(false);
      expect(isSafeWorkflowPath("workflows/x.yaml", cwd)).toBe(false);
    });

    it("isValidMaxItems rejects 0 / negative / non-numeric input", () => {
      expect(isValidMaxItems("10")).toBe(true);
      expect(isValidMaxItems("1")).toBe(true);
      expect(isValidMaxItems("0")).toBe(false);
      expect(isValidMaxItems("-1")).toBe(false);
      expect(isValidMaxItems("ten")).toBe(false);
      expect(isValidMaxItems("3.5")).toBe(false);
      expect(isValidMaxItems("")).toBe(false);
    });

    it("renderFilterTagsLiteral lowercases, dedupes, and prefixes a leading space", () => {
      expect(renderFilterTagsLiteral(undefined)).toBe("");
      expect(renderFilterTagsLiteral("")).toBe("");
      expect(renderFilterTagsLiteral("security,breaking-change")).toBe(
        " --filter-tags security,breaking-change",
      );
      // Case-insensitive dedupe matches the CLI parser semantics in research.ts.
      expect(renderFilterTagsLiteral("Security, security ,Breaking-Change,security")).toBe(
        " --filter-tags security,breaking-change",
      );
    });

    it("renderCombinedTemplate substitutes every placeholder atomically", () => {
      const tpl =
        "cron={{cron}}\nmax={{maxItems}}\ntags={{filterTags}}\nagent={{agent}}\nsecrets:\n{{secretsBlock}}\nsecrets again:\n{{secretsBlock}}\n";
      const out = renderCombinedTemplate(tpl, {
        cron: "0 0 * * *",
        maxItems: 7,
        filterTagsLiteral: " --filter-tags x",
        agent: "claude-code",
        secretsBlock: "          K: $" + "{{ secrets.X }}",
      });
      expect(out).toContain("cron=0 0 * * *");
      expect(out).toContain("max=7");
      expect(out).toContain("tags= --filter-tags x");
      expect(out).toContain("agent=claude-code");
      // Both occurrences of {{secretsBlock}} must be replaced.
      const secretOccurrences = out.match(/K: \$\{\{ secrets\.X \}\}/g);
      expect(secretOccurrences?.length).toBe(2);
      // No placeholders should leak through.
      expect(out).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });
  });

  describe("parseGenerateCombinedArgs", () => {
    it("returns defaults when no flags are passed", () => {
      const parsed = parseGenerateCombinedArgs([]);
      expect(parsed.watchCron).toBe("0 0 * * *");
      expect(parsed.agent).toBe("claude-code");
      expect(parsed.maxItems).toBe(10);
      expect(parsed.filterTags).toEqual([]);
      expect(parsed.force).toBe(false);
    });

    it("rejects --agent values outside the supported set", () => {
      expect(() => parseGenerateCombinedArgs(["--agent", "wat"])).toThrow(/--agent expects/);
    });

    it("rejects --max-items 0", () => {
      expect(() => parseGenerateCombinedArgs(["--max-items", "0"])).toThrow(/positive integer/);
    });

    it("normalizes --filter-tags case + dedupe", () => {
      const parsed = parseGenerateCombinedArgs([
        "--filter-tags",
        "Security, security ,Breaking-Change",
      ]);
      expect(parsed.filterTags).toEqual(["security", "breaking-change"]);
    });

    it("rejects unknown flags", () => {
      expect(() => parseGenerateCombinedArgs(["--nope"])).toThrow(/unknown option/);
    });
  });

  describe("generateCombined (end-to-end)", () => {
    it("renders defaults: cron=0 0 * * *, max-items=10, agent=claude-code", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombined([], io, workdir);
      expect(code).toBe(0);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "utf8",
      );
      // No placeholders should leak through.
      expect(yaml).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
      // Cron + hard-cap + agent literal land in the YAML.
      expect(yaml).toMatch(/cron:\s*"0 0 \* \* \*"/);
      expect(yaml).toContain("--max-items 10");
      expect(yaml).toContain("--agent claude-code");
      // Filter-tags must be absent.
      // Look only at the `run:` line for the research step (the surrounding
      // comment block legitimately mentions --filter-tags for documentation).
      const researchRunLine = yaml.split("\n").find((l) => l.includes("radar research --batch"));
      expect(researchRunLine).toBeDefined();
      expect(researchRunLine).not.toMatch(/--filter-tags/);
      // claude-code default surfaces ANTHROPIC_API_KEY in BOTH env: blocks (watch + research).
      // Count only env-block occurrences (10 leading spaces). The template
      // header comment also mentions ANTHROPIC_API_KEY in passing.
      const occurrences = yaml.match(
        /^ {10}ANTHROPIC_API_KEY:\s+\$\{\{\s*secrets\.ANTHROPIC_API_KEY/gm,
      );
      expect(occurrences?.length).toBe(2);
      // No OAuth tokens (ADR-0014 D5).
      expect(yaml).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      // Skip-when-empty guard is present.
      expect(yaml).toContain('"$(git status --porcelain items/)"');
      expect(yaml).toContain("has_changes=false");
      expect(yaml).toContain("has_changes=true");
      // Push retry is present.
      expect(yaml).toContain("for attempt in 1 2 3");
      expect(yaml).toContain("git pull --rebase --autostash");
      // Stdout reports the secrets to register.
      expect(captured.log.some((m) => m.includes("ANTHROPIC_API_KEY"))).toBe(true);
      expect(captured.warn.some((m) => m.includes("--max-items cap"))).toBe(true);
    });

    it("renders --watch-cron + --max-items + --filter-tags literals", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runGenerateCombined(
        [
          "--watch-cron",
          "0 */6 * * *",
          "--max-items",
          "20",
          "--filter-tags",
          "security,breaking-change",
        ],
        io,
        workdir,
      );
      expect(code).toBe(0);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "utf8",
      );
      expect(yaml).toMatch(/cron:\s*"0 \*\/6 \* \* \*"/);
      expect(yaml).toContain("--max-items 20");
      expect(yaml).toContain("--filter-tags security,breaking-change");
      // Hard-cap mention also appears in the step name (audit signal).
      expect(yaml).toContain("(capped at 20, agent=claude-code)");
    });

    it("renders agent-specific secrets blocks for each agent without OAuth", async () => {
      const cases: Array<{ agent: string; expects: string[]; absents: string[] }> = [
        {
          agent: "claude-code",
          expects: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
          absents: ["OPENAI_API_KEY", "GEMINI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        },
        {
          agent: "codex-cli",
          expects: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
          absents: ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
        },
        {
          agent: "gemini-cli",
          expects: ["GEMINI_API_KEY", "GITHUB_TOKEN"],
          absents: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        },
        {
          agent: "copilot",
          expects: ["GITHUB_TOKEN"],
          absents: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
        },
      ];
      for (const c of cases) {
        const workdir = await setupWorkspace();
        const { io } = captureIo();
        const code = await runGenerateCombined(["--agent", c.agent], io, workdir);
        expect(code, `agent=${c.agent} should exit 0`).toBe(0);
        const yaml = await readFile(
          join(workdir, ".github/workflows/feedradar-combined.yaml"),
          "utf8",
        );
        for (const present of c.expects) {
          expect(yaml, `${c.agent} must include ${present}`).toContain(present);
        }
        for (const absent of c.absents) {
          expect(yaml, `${c.agent} must omit ${absent}`).not.toContain(absent);
        }
        expect(yaml).toContain(`--agent ${c.agent}`);
      }
    });

    it("rejects --agent with an invalid id (exit 2)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombined(["--agent", "wat"], io, workdir);
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--agent expects"))).toBe(true);
    });

    it("rejects an invalid cron expression (exit 1, validation happens after parsing)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombined(["--watch-cron", "0 * * *"], io, workdir);
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid --watch-cron"))).toBe(true);
    });

    it("rejects --max-items 0 at parse time (exit 2)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombined(["--max-items", "0"], io, workdir);
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("positive integer"))).toBe(true);
    });

    it("rejects --output outside .github/workflows/ (path traversal)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombined(
        ["--output", ".github/workflows/../../etc/cron"],
        io,
        workdir,
      );
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid --output"))).toBe(true);
    });

    it("rejects --output with a non-yaml extension", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombined(
        ["--output", ".github/workflows/feedradar.json"],
        io,
        workdir,
      );
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid --output"))).toBe(true);
    });

    it("refuses to overwrite an existing file without --force", async () => {
      const workdir = await setupWorkspace();
      await mkdir(join(workdir, ".github/workflows"), { recursive: true });
      await writeFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "existing",
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await runGenerateCombined([], io, workdir);
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("already exists"))).toBe(true);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "utf8",
      );
      expect(yaml).toBe("existing");
    });

    it("overwrites with --force", async () => {
      const workdir = await setupWorkspace();
      await mkdir(join(workdir, ".github/workflows"), { recursive: true });
      await writeFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "existing",
        "utf8",
      );
      const { io } = captureIo();
      const code = await runGenerateCombined(["--force"], io, workdir);
      expect(code).toBe(0);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "utf8",
      );
      expect(yaml).not.toBe("existing");
      expect(yaml).toContain("--max-items 10");
    });

    it("supports --output overriding the default path inside .github/workflows/", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runGenerateCombined(
        ["--output", ".github/workflows/feedradar-combined-weekly.yaml"],
        io,
        workdir,
      );
      expect(code).toBe(0);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined-weekly.yaml"),
        "utf8",
      );
      expect(yaml).toContain("name: feedradar-combined");
    });

    it("renders shell guard so research is skipped when no items change", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runGenerateCombined([], io, workdir);
      expect(code).toBe(0);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "utf8",
      );
      // The `if:` guard on the research step ensures no LLM call on an empty queue.
      const ifLines = yaml
        .split("\n")
        .filter((l) => l.includes("if: steps.detect_changes.outputs.has_changes"));
      expect(ifLines.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("dispatcher (runWorkflow combined integration)", () => {
    it("dispatches `workflow generate combined` to runGenerateCombined", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runWorkflow(["generate", "combined", "--max-items", "5"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      const yaml = await readFile(
        join(workdir, ".github/workflows/feedradar-combined.yaml"),
        "utf8",
      );
      expect(yaml).toContain("--max-items 5");
    });

    it("returns 2 on unknown type", async () => {
      const { io } = captureIo();
      const code = await runWorkflow(["generate", "nonsense"], { io });
      expect(code).toBe(2);
    });
  });
});
