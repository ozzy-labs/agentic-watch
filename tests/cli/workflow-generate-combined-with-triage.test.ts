import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEnvBlock,
  buildSlackWebhookExpr,
  isSafeWorkflowPath,
  isValidCron,
  isValidMaxItems,
  isValidSlackWebhookRef,
  parseGenerateCombinedWithTriageArgs,
  renderCombinedWithTriageTemplate,
  runGenerateCombinedWithTriage,
} from "../../src/cli/workflow/generate-combined-with-triage.js";
import { runWorkflow } from "../../src/cli/workflow.js";

/**
 * Coverage for `radar workflow generate combined-with-triage` (ADR-0018
 * §W5 / #241). Mirrors the layout of `workflow-generate-combined.test.ts`
 * — validators, arg parser, end-to-end rendering, dispatcher integration
 * — so a future maintainer reads one and recognizes the other.
 *
 * The end-to-end suite asserts the **structural** shape of the rendered
 * YAML (cron, env block contents, step names, triage / research / review
 * lines, Slack notify step, PR creation step) rather than a byte-identical
 * snapshot so cosmetic template tweaks do not force a churn cycle.
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

async function setupWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "feedradar-workflow-cwt-"));
}

describe("cli/workflow generate combined-with-triage (#241 / ADR-0018 §W5)", () => {
  describe("validators", () => {
    it("isValidCron mirrors the combined validator (5-field POSIX)", () => {
      expect(isValidCron("0 6 * * *")).toBe(true);
      expect(isValidCron("*/15 * * * *")).toBe(true);
      // Wrong shape: must surface as a validator-level reject.
      expect(isValidCron("0 6 * *")).toBe(false);
      expect(isValidCron("@daily")).toBe(false);
      expect(isValidCron("")).toBe(false);
    });

    it("isSafeWorkflowPath rejects traversal / absolute / non-yaml outputs", () => {
      const cwd = "/tmp/fakecwd";
      expect(isSafeWorkflowPath(".github/workflows/x.yaml", cwd)).toBe(true);
      expect(isSafeWorkflowPath(".github/workflows/x.yml", cwd)).toBe(true);
      expect(isSafeWorkflowPath(".github/workflows/../../etc/cron", cwd)).toBe(false);
      expect(isSafeWorkflowPath("/etc/cron.d/x.yaml", cwd)).toBe(false);
      expect(isSafeWorkflowPath("workflows/x.yaml", cwd)).toBe(false);
    });

    it("isValidMaxItems rejects 0 / negative / non-numeric input", () => {
      expect(isValidMaxItems("10")).toBe(true);
      expect(isValidMaxItems("0")).toBe(false);
      expect(isValidMaxItems("-1")).toBe(false);
      expect(isValidMaxItems("ten")).toBe(false);
    });

    it("isValidSlackWebhookRef accepts secrets.<NAME> and rejects everything else", () => {
      expect(isValidSlackWebhookRef("secrets.SLACK_WEBHOOK")).toBe(true);
      expect(isValidSlackWebhookRef("secrets.MY_HOOK_1")).toBe(true);
      // Anti-patterns: full Actions expression literal (we wrap it for the user).
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions secret expression literal
      expect(isValidSlackWebhookRef("${{ secrets.SLACK_WEBHOOK }}")).toBe(false);
      // Plain string (no secrets. prefix).
      expect(isValidSlackWebhookRef("SLACK_WEBHOOK")).toBe(false);
      // Empty string is rejected so callers fall through to "unset".
      expect(isValidSlackWebhookRef("")).toBe(false);
    });

    it("buildEnvBlock dedupes across agent roles and always includes GITHUB_TOKEN", () => {
      // Each env entry is a single line of the form `      KEY: ${{ secrets.KEY }}`,
      // so counting `^      KEY:` lines is the dedupe signal. The bare token
      // (e.g. "ANTHROPIC_API_KEY") appears twice per line because the key name
      // is mirrored in the `secrets.<name>` reference.
      const sameAgent = buildEnvBlock("claude-code", "claude-code", "claude-code");
      expect(sameAgent.match(/^ {6}ANTHROPIC_API_KEY:/gm)?.length).toBe(1);
      expect(sameAgent.match(/^ {6}GITHUB_TOKEN:/gm)?.length).toBe(1);

      // Three distinct agents: all three API keys appear plus the shared token.
      const mixed = buildEnvBlock("gemini-cli", "claude-code", "codex-cli");
      expect(mixed.match(/^ {6}GEMINI_API_KEY:/gm)?.length).toBe(1);
      expect(mixed.match(/^ {6}ANTHROPIC_API_KEY:/gm)?.length).toBe(1);
      expect(mixed.match(/^ {6}OPENAI_API_KEY:/gm)?.length).toBe(1);
      expect(mixed.match(/^ {6}GITHUB_TOKEN:/gm)?.length).toBe(1);

      // copilot contributes no agent-specific secret (rides GITHUB_TOKEN natively).
      const copilotOnly = buildEnvBlock("copilot", "copilot", "copilot");
      expect(copilotOnly).not.toContain("ANTHROPIC_API_KEY");
      expect(copilotOnly).not.toContain("OPENAI_API_KEY");
      expect(copilotOnly).not.toContain("GEMINI_API_KEY");
      expect(copilotOnly.match(/^ {6}GITHUB_TOKEN:/gm)?.length).toBe(1);
    });

    it("buildSlackWebhookExpr wraps secrets.X into a full Actions expression literal", () => {
      // Unset/undefined: empty literal so the shell guard `[ -n "$..." ]` collapses to no-op.
      expect(buildSlackWebhookExpr(undefined)).toBe('""');
      expect(buildSlackWebhookExpr("")).toBe('""');
      // Set: wrap into ${{ ... }} verbatim (no double-wrap, no escaping).
      expect(buildSlackWebhookExpr("secrets.SLACK_WEBHOOK")).toBe(
        "$" + "{{ secrets.SLACK_WEBHOOK }}",
      );
    });

    it("renderCombinedWithTriageTemplate substitutes every placeholder atomically", () => {
      const tpl = [
        "cron={{watchCron}}",
        "max={{maxItems}}",
        "triage={{triageAgent}}",
        "research={{researchAgent}}",
        "review={{reviewAgent}}",
        "env:",
        "{{envBlock}}",
        "slack={{slackWebhookExpr}}",
      ].join("\n");
      const out = renderCombinedWithTriageTemplate(tpl, {
        watchCron: "0 6 * * *",
        maxItems: 12,
        triageAgent: "gemini-cli",
        researchAgent: "claude-code",
        reviewAgent: "codex-cli",
        envBlock: "      KEY: VALUE",
        slackWebhookExpr: '""',
      });
      expect(out).toContain("cron=0 6 * * *");
      expect(out).toContain("max=12");
      expect(out).toContain("triage=gemini-cli");
      expect(out).toContain("research=claude-code");
      expect(out).toContain("review=codex-cli");
      expect(out).toContain("      KEY: VALUE");
      expect(out).toContain('slack=""');
      // Nothing should leak through.
      expect(out).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });
  });

  describe("parseGenerateCombinedWithTriageArgs", () => {
    it("returns defaults when no flags are passed", () => {
      const parsed = parseGenerateCombinedWithTriageArgs([]);
      expect(parsed.watchCron).toBe("0 6 * * *");
      expect(parsed.triageAgent).toBe("gemini-cli");
      expect(parsed.researchAgent).toBe("claude-code");
      expect(parsed.reviewAgent).toBe("codex-cli");
      expect(parsed.maxItems).toBe(10);
      expect(parsed.slackWebhook).toBeUndefined();
      expect(parsed.force).toBe(false);
    });

    it("rejects each agent flag with an invalid id", () => {
      expect(() => parseGenerateCombinedWithTriageArgs(["--triage-agent", "wat"])).toThrow(
        /--triage-agent expects/,
      );
      expect(() => parseGenerateCombinedWithTriageArgs(["--research-agent", "wat"])).toThrow(
        /--research-agent expects/,
      );
      expect(() => parseGenerateCombinedWithTriageArgs(["--review-agent", "wat"])).toThrow(
        /--review-agent expects/,
      );
    });

    it("rejects --max-items 0", () => {
      expect(() => parseGenerateCombinedWithTriageArgs(["--max-items", "0"])).toThrow(
        /positive integer/,
      );
    });

    it("rejects --slack-webhook that is not in secrets.<NAME> form", () => {
      expect(() =>
        parseGenerateCombinedWithTriageArgs(["--slack-webhook", "$" + "{{ secrets.X }}"]),
      ).toThrow(/--slack-webhook expects/);
      expect(() =>
        parseGenerateCombinedWithTriageArgs(["--slack-webhook", "https://hooks.slack.com/..."]),
      ).toThrow(/--slack-webhook expects/);
    });

    it("rejects unknown flags", () => {
      expect(() => parseGenerateCombinedWithTriageArgs(["--nope"])).toThrow(/unknown option/);
    });
  });

  describe("generateCombinedWithTriage (end-to-end)", () => {
    it("renders defaults: 5 pipeline steps + Slack notify + create-pull-request", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombinedWithTriage([], io, workdir);
      expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      // No placeholders should leak through.
      expect(yaml).not.toMatch(/\{\{[a-zA-Z]+\}\}/);

      // Cron + 5 step `run:` lines land in the rendered YAML.
      expect(yaml).toMatch(/cron:\s*"0 6 \* \* \*"/);
      expect(yaml).toContain("radar watch run");
      expect(yaml).toContain("radar triage --apply --triage-agent gemini-cli");
      expect(yaml).toContain(
        "radar research --batch --status triaged_research --max-items 10 --agent claude-code",
      );
      // Digest loop (per-group) walks `radar items list --triage-group ...`.
      expect(yaml).toContain("radar items list --status triaged_digest --field triage.group");
      // #255: the digest call passes `--triage-group "$GROUP"` so each
      // per-group report gets a unique slug (no same-day collision), and the
      // loop reads the group list via `mapfile` (SC2128/SC2178 clean).
      expect(yaml).toContain(
        'radar research --digest $IDS --triage-group "$GROUP" --agent claude-code',
      );
      // Array is named DIGEST_GROUPS, NOT the special bash `GROUPS` var
      // (mapfile into `GROUPS` fails under set -e).
      expect(yaml).toMatch(/mapfile -t DIGEST_GROUPS </);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash array expansion in generated YAML, not a JS template
      expect(yaml).toContain('for GROUP in "${DIGEST_GROUPS[@]}"; do');
      // The old scalar-array antipattern must be gone.
      expect(yaml).not.toContain("GROUPS=$(");
      // The reserved `GROUPS` name must not be assigned via mapfile.
      expect(yaml).not.toMatch(/mapfile -t GROUPS\b/);
      // Review step uses the cross-agent default.
      expect(yaml).toContain("radar review --batch --status researched --agent codex-cli");

      // Job-level env block surfaces all three agents' keys plus GITHUB_TOKEN.
      expect(yaml).toMatch(/^ {6}ANTHROPIC_API_KEY:/m);
      expect(yaml).toMatch(/^ {6}OPENAI_API_KEY:/m);
      expect(yaml).toMatch(/^ {6}GEMINI_API_KEY:/m);
      expect(yaml).toMatch(/^ {6}GITHUB_TOKEN:/m);

      // Notify step has `if: always()` and the queue depth printout.
      expect(yaml).toContain("if: always()");
      expect(yaml).toContain("triaged_unsure queue depth");
      // Slack webhook unset by default: rendered as empty literal so the
      // shell guard short-circuits without leaking the alert.
      expect(yaml).toContain('SLACK_WEBHOOK_URL: ""');

      // PR creation step uses peter-evans/create-pull-request@v6.
      expect(yaml).toContain("uses: peter-evans/create-pull-request@v6");

      // Stdout reports the secrets to register and the hard-cap double-defense warn.
      expect(captured.log.some((m) => m.includes("ANTHROPIC_API_KEY"))).toBe(true);
      expect(captured.log.some((m) => m.includes("OPENAI_API_KEY"))).toBe(true);
      expect(captured.log.some((m) => m.includes("GEMINI_API_KEY"))).toBe(true);
      expect(captured.warn.some((m) => m.includes("--max-items cap"))).toBe(true);
    });

    it("renders --watch-cron and --max-items overrides as YAML literals", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runGenerateCombinedWithTriage(
        ["--watch-cron", "0 */6 * * *", "--max-items", "25"],
        io,
        workdir,
      );
      expect(code).toBe(0);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      expect(yaml).toMatch(/cron:\s*"0 \*\/6 \* \* \*"/);
      expect(yaml).toContain("--max-items 25");
      // Audit signal in the step name so a PR diff surfaces a cap change.
      expect(yaml).toContain("capped at 25");
    });

    it("renders --slack-webhook into the notify step expression", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runGenerateCombinedWithTriage(
        ["--slack-webhook", "secrets.SLACK_WEBHOOK"],
        io,
        workdir,
      );
      expect(code).toBe(0);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      // Full GitHub Actions expression literal (the generator wraps the user's `secrets.X` ref).
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions secret expression literal
      expect(yaml).toContain("SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}");
    });

    it("renders a single-agent setup with no duplicate env entries", async () => {
      // All three roles on claude-code => ANTHROPIC_API_KEY appears once
      // in the env block (sourced from the same agent across roles).
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runGenerateCombinedWithTriage(
        [
          "--triage-agent",
          "claude-code",
          "--research-agent",
          "claude-code",
          "--review-agent",
          "claude-code",
        ],
        io,
        workdir,
      );
      expect(code).toBe(0);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      const envLine = yaml.match(/^ {6}ANTHROPIC_API_KEY:/gm);
      expect(envLine?.length, "ANTHROPIC_API_KEY env line dedupes across roles").toBe(1);
      expect(yaml).not.toContain("GEMINI_API_KEY");
      expect(yaml).not.toContain("OPENAI_API_KEY");
    });

    it("rejects --triage-agent with an invalid id (exit 2)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombinedWithTriage(["--triage-agent", "wat"], io, workdir);
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--triage-agent expects"))).toBe(true);
    });

    it("rejects an invalid cron (exit 1, validation happens post-parse)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombinedWithTriage(["--watch-cron", "0 * * *"], io, workdir);
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid --watch-cron"))).toBe(true);
    });

    it("rejects --output outside .github/workflows/ (path traversal)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runGenerateCombinedWithTriage(
        ["--output", ".github/workflows/../../etc/cron"],
        io,
        workdir,
      );
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid --output"))).toBe(true);
    });

    it("refuses to overwrite an existing file without --force", async () => {
      const workdir = await setupWorkspace();
      await mkdir(join(workdir, ".github/workflows"), { recursive: true });
      await writeFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "existing", "utf8");
      const { io, captured } = captureIo();
      const code = await runGenerateCombinedWithTriage([], io, workdir);
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("already exists"))).toBe(true);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      expect(yaml).toBe("existing");
    });

    it("overwrites with --force", async () => {
      const workdir = await setupWorkspace();
      await mkdir(join(workdir, ".github/workflows"), { recursive: true });
      await writeFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "existing", "utf8");
      const { io } = captureIo();
      const code = await runGenerateCombinedWithTriage(["--force"], io, workdir);
      expect(code).toBe(0);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      expect(yaml).not.toBe("existing");
      expect(yaml).toContain("radar triage --apply");
    });
  });

  describe("dispatcher (runWorkflow combined-with-triage integration)", () => {
    it("dispatches `workflow generate combined-with-triage` to runGenerateCombinedWithTriage", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      const code = await runWorkflow(["generate", "combined-with-triage", "--max-items", "7"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      const yaml = await readFile(join(workdir, ".github/workflows/feedradar-daily.yaml"), "utf8");
      expect(yaml).toContain("--max-items 7");
    });

    it("--help on the new type returns 0 and prints the help banner", async () => {
      const { io, captured } = captureIo();
      const code = await runWorkflow(["generate", "combined-with-triage", "--help"], { io });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("combined-with-triage"))).toBe(true);
    });

    it("the new type is enumerated by `workflow generate --help`", async () => {
      const { io, captured } = captureIo();
      const code = await runWorkflow(["generate"], { io });
      // No <type> argument => 2 (matching the existing semantics in workflow.ts).
      expect(code).toBe(2);
      // The generate banner emitted to the log sink lists the new type so
      // human discovery from the help text works.
      expect(captured.log.some((m) => m.includes("combined-with-triage"))).toBe(true);
    });
  });
});
