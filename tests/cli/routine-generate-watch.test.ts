import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildBootstrapPrompt,
  collectSourceHosts,
  generateWatchRoutine,
  isSafeRoutinePath,
  isSubHourlyCron,
  isValidCron,
  PROMPT_MODES,
  parseGenerateWatchRoutineArgs,
  printPromptModePaste,
  renderNetworkAccessBlock,
  renderWatchRoutineTemplate,
  SUPPORTED_MODELS,
  type SupportedModel,
} from "../../src/cli/routine/generate-watch.js";
import { runRoutine } from "../../src/cli/routine.js";
import { createTranslator } from "../../src/i18n/index.js";

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
        "name: {{name}}\nrepo: {{repository}}\ncron: {{cron}}\ntz: {{timezone}}\nmodel: {{model}}\n{{networkAccessBlock}}\nagain: {{name}}";
      const out = renderWatchRoutineTemplate(tpl, {
        name: "my-watch",
        repository: "acme/widgets",
        cron: "0 * * * *",
        timezone: "Asia/Tokyo",
        model: "claude-opus-4-7",
        networkAccessBlock: "  network_access: custom",
      });
      expect(out).toContain("name: my-watch");
      expect(out).toContain("repo: acme/widgets");
      expect(out).toContain("cron: 0 * * * *");
      expect(out).toContain("tz: Asia/Tokyo");
      expect(out).toContain("model: claude-opus-4-7");
      expect(out).toContain("network_access: custom");
      expect(out).toContain("again: my-watch");
      expect(out).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });
  });

  describe("renderNetworkAccessBlock (F2: network_access)", () => {
    it("emits `custom` mode and never the wrong mode names", () => {
      const block = renderNetworkAccessBlock([]);
      expect(block).toContain("network_access: custom");
      // The old comment claimed `trusted / none / open`; the real modes are
      // Trusted / Custom / Full.
      expect(block).toContain("Trusted / Custom / Full");
      expect(block).not.toMatch(/network_access:\s*trusted/);
      expect(block).not.toMatch(/network_access:\s*(none|open|full)/);
      // Records the 403 fact so the user understands why Trusted is wrong.
      expect(block).toContain("403");
    });

    it("lists enumerated hosts as Custom allowlist comments", () => {
      const block = renderNetworkAccessBlock(["aws.amazon.com", "blog.example.com"]);
      expect(block).toContain("#   - aws.amazon.com");
      expect(block).toContain("#   - blog.example.com");
      expect(block).toContain("network_access: custom");
    });

    it("falls back to an explicit Web UI instruction when no hosts enumerable", () => {
      const block = renderNetworkAccessBlock([]);
      expect(block).toContain("Custom network access allowlist");
      expect(block).toMatch(/sources\/\*\.yaml/);
    });
  });

  describe("collectSourceHosts (F2: sources/*.yaml host enumeration)", () => {
    let workdir: string;

    beforeEach(async () => {
      workdir = await mkdtemp(join(tmpdir(), "feedradar-routine-hosts-"));
    });

    it("returns [] when there is no sources/ directory", async () => {
      expect(await collectSourceHosts(workdir)).toEqual([]);
    });

    it("extracts and de-duplicates hostnames from sources/*.yaml", async () => {
      const sourcesDir = join(workdir, "sources");
      await mkdir(sourcesDir, { recursive: true });
      await writeFile(
        join(sourcesDir, "blog.yaml"),
        "id: blog\nkind: rss\nurl: https://blog.example.com/feed.xml\n",
        "utf8",
      );
      await writeFile(
        join(sourcesDir, "blog2.yaml"),
        "id: blog2\nkind: rss\nurl: https://blog.example.com/other.xml\n",
        "utf8",
      );
      await writeFile(
        join(sourcesDir, "news.yaml"),
        "id: news\nkind: rss\nurl: https://news.example.org/rss\n",
        "utf8",
      );
      const hosts = await collectSourceHosts(workdir);
      // De-duplicated (blog.example.com appears once) and sorted.
      expect(hosts).toEqual(["blog.example.com", "news.example.org"]);
    });

    it("maps npm-registry sources to registry.npmjs.org", async () => {
      const sourcesDir = join(workdir, "sources");
      await mkdir(sourcesDir, { recursive: true });
      await writeFile(
        join(sourcesDir, "pkg.yaml"),
        'id: pkg\nkind: npm-registry\nurl: "@scope/pkg"\n',
        "utf8",
      );
      expect(await collectSourceHosts(workdir)).toEqual(["registry.npmjs.org"]);
    });
  });

  describe("parseGenerateWatchRoutineArgs", () => {
    it("provides sensible defaults (hourly cron, output derived from name)", () => {
      const parsed = parseGenerateWatchRoutineArgs([]);
      expect(parsed.name).toBe("feedradar-watch");
      expect(parsed.cron).toBe("0 * * * *");
      expect(parsed.timezone).toBe("UTC");
      expect(parsed.model).toBe("claude-sonnet-4-6");
      expect(parsed.promptMode).toBe("inline");
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
        "claude-haiku-4-5",
        "--output",
        ".claude/routines/custom.yaml",
        "--force",
      ]);
      expect(parsed.repository).toBe("acme/widgets");
      expect(parsed.cron).toBe("0 0 * * *");
      expect(parsed.timezone).toBe("Asia/Tokyo");
      expect(parsed.model).toBe("claude-haiku-4-5");
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

    it("accepts --prompt-mode bootstrap and rejects an unknown mode (#327)", () => {
      expect(parseGenerateWatchRoutineArgs(["--prompt-mode", "bootstrap"]).promptMode).toBe(
        "bootstrap",
      );
      expect(parseGenerateWatchRoutineArgs(["--prompt-mode", "inline"]).promptMode).toBe("inline");
      expect(() => parseGenerateWatchRoutineArgs(["--prompt-mode", "external"])).toThrow(
        /--prompt-mode expects one of: inline \| bootstrap/,
      );
      expect(() => parseGenerateWatchRoutineArgs(["--prompt-mode"])).toThrow(/requires a value/);
    });

    it("every PROMPT_MODES value parses (#327)", () => {
      for (const m of PROMPT_MODES) {
        expect(parseGenerateWatchRoutineArgs(["--prompt-mode", m]).promptMode).toBe(m);
      }
    });

    it("--emit-bootstrap-prompt is a boolean flag, default false (#365)", () => {
      expect(parseGenerateWatchRoutineArgs([]).emitBootstrapPrompt).toBe(false);
      expect(parseGenerateWatchRoutineArgs(["--emit-bootstrap-prompt"]).emitBootstrapPrompt).toBe(
        true,
      );
    });
  });

  describe("buildBootstrapPrompt (single source of truth, #365)", () => {
    it("renders the 4 bootstrap lines with name / path interpolated (en)", () => {
      const t = createTranslator("en");
      const prompt = buildBootstrapPrompt(
        { name: "feedradar-watch", path: ".claude/routines/feedradar-watch.yaml" },
        t,
      );
      const lines = prompt.split("\n");
      expect(lines).toHaveLength(4);
      expect(prompt).toContain("You are the `feedradar-watch` routine.");
      expect(prompt).toContain("Read `.claude/routines/feedradar-watch.yaml`");
      expect(prompt).toContain("`instructions:` block");
      expect(prompt).toContain("AskUserQuestion is NOT available");
    });

    it("matches the bootstrap paste-mode block byte-for-byte (en + ja) (#365)", () => {
      for (const locale of ["en", "ja"] as const) {
        const t = createTranslator(locale);
        const values = { name: "feedradar-watch", path: ".claude/routines/feedradar-watch.yaml" };
        const emitted = buildBootstrapPrompt(values, t);

        // Reconstruct exactly the lines printPromptModePaste logs for the prompt
        // body (the 4 lines between the two blank separators).
        const pasteLines: string[] = [];
        printPromptModePaste("bootstrap", values, t, (m) => pasteLines.push(m));
        const blanks = pasteLines.map((l, i) => (l === "" ? i : -1)).filter((i) => i >= 0);
        const body = pasteLines.slice(blanks[0] + 1, blanks[1]).join("\n");

        expect(body).toBe(emitted);
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
      // F2: network access is Custom (Trusted Default would 403 on feed hosts),
      // never the old `trusted` value or the wrong `none`/`open` mode names.
      expect(written).toContain("network_access: custom");
      expect(written).not.toMatch(/network_access:\s*trusted/);
      expect(written).not.toMatch(/network_access:\s*(none|open|full)/);
    });

    it("emits the subscribed-feed hosts into the Custom allowlist comments", async () => {
      const sourcesDir = join(workdir, "sources");
      await mkdir(sourcesDir, { recursive: true });
      await writeFile(
        join(sourcesDir, "aws.yaml"),
        "id: aws\nkind: rss\nurl: https://aws.amazon.com/about-aws/whats-new/recent/feed/\n",
        "utf8",
      );
      await run();
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-watch.yaml"),
        "utf8",
      );
      expect(written).toContain("#   - aws.amazon.com");
      expect(written).toContain("network_access: custom");
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

    it("prints Web UI paste instructions (yq) and a corrected /schedule caveat", async () => {
      await run();
      const joined = logs.join("\n");
      expect(joined).toContain("yq -r '.instructions'");
      expect(joined).toContain("yq -r '.environment.setup_script'");
      expect(joined).toContain("/schedule");
      expect(joined).toContain("claude.ai/code/routines");
      // Issue #300: the old `/schedule create --name --cron --repo` example is a
      // fabricated syntax — it must not appear. Instead the output describes the
      // real conversational form and the Web-UI-only caveats.
      expect(joined).not.toContain("/schedule create");
      expect(joined).toContain("`/schedule <description>`");
      expect(joined).toContain("Allow unrestricted branch");
    });

    it("points Claude Code users at the /routine-setup skill (en, #367)", async () => {
      await run({ locale: "en" });
      const joined = logs.join("\n");
      // The completion guidance offers the skill as an automation alternative to
      // the manual Web UI registration flow above.
      expect(joined).toContain("/routine-setup");
      expect(joined).toContain("Claude Code");
      expect(joined).toContain("RemoteTrigger");
      expect(joined).toContain("Claude-only alternative");
    });

    it("points Claude Code users at the /routine-setup skill (ja, #367)", async () => {
      await run({ locale: "ja" });
      const joined = logs.join("\n");
      // The slash-command name stays verbatim; the prose is localized.
      expect(joined).toContain("/routine-setup");
      expect(joined).toContain("Claude 専用");
    });

    it("inline prompt-mode (default) tells the user to yq the full instructions (#327)", async () => {
      await run({ promptMode: "inline" });
      const joined = logs.join("\n");
      // Inline: extract the whole instructions block into the Web UI Prompt.
      expect(joined).toContain("yq -r '.instructions'");
      expect(joined).toContain("yq -r '.environment.setup_script'");
      // No bootstrap prompt body.
      expect(joined).not.toContain("You are the `feedradar-watch` routine.");
      expect(joined).not.toMatch(/no Web UI re-paste/);
    });

    it("bootstrap prompt-mode prints a SHORT prompt, not the full instructions (#327)", async () => {
      await run({ promptMode: "bootstrap" });
      const joined = logs.join("\n");
      // Bootstrap: a short prompt to paste; routine reads the committed YAML.
      expect(joined).toContain("You are the `feedradar-watch` routine.");
      expect(joined).toContain("Read `.claude/routines/feedradar-watch.yaml`");
      expect(joined).toContain("`instructions:` block");
      expect(joined).toContain("AskUserQuestion is NOT available");
      expect(joined).toContain("no Web UI re-paste");
      // The Setup script field still needs its own yq extraction.
      expect(joined).toContain("yq -r '.environment.setup_script'");
      // But the Instructions field is NOT the full-instructions yq line.
      expect(joined).not.toContain("yq -r '.instructions'");
    });

    it("bootstrap mode leaves the generated YAML instructions block intact (#327)", async () => {
      // The runtime source of truth must stay in the file in BOTH modes — only
      // the Web UI paste guidance differs.
      await run({ promptMode: "bootstrap" });
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-watch.yaml"),
        "utf8",
      );
      expect(written).toContain("instructions:");
      expect(written).toContain("radar watch run");
      expect(written).toContain("claude/watch/");
      // The bootstrap prose is a stdout-only artifact; it must NOT be injected
      // into the YAML file.
      expect(written).not.toContain("no Web UI re-paste");
    });

    it("rejects an invalid promptMode at the core level (#327)", async () => {
      await expect(run({ promptMode: "external" as unknown as "inline" })).rejects.toThrow(
        /invalid --prompt-mode/,
      );
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
      const joined = logs.join("\n");
      expect(joined).toContain("routine generate watch");
      // #327: the new --prompt-mode option is documented in help.
      expect(joined).toContain("--prompt-mode <mode>");
      expect(joined).toContain("inline | bootstrap");
    });

    it("dispatches `generate watch --prompt-mode bootstrap` end-to-end (#327)", async () => {
      const code = await runRoutine(
        ["generate", "watch", "--repo", "acme/widgets", "--prompt-mode", "bootstrap"],
        { cwd: workdir, io: io() },
      );
      expect(code, `stderr: ${errors.join("\n")}`).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toContain("You are the `feedradar-watch` routine.");
      // The YAML still carries the full instructions block.
      const written = await readFile(
        join(workdir, ".claude", "routines", "feedradar-watch.yaml"),
        "utf8",
      );
      expect(written).toContain("radar watch run");
    });

    it("surfaces an unknown --prompt-mode through the dispatcher (exit 2) (#327)", async () => {
      const code = await runRoutine(["generate", "watch", "--prompt-mode", "external"], {
        cwd: workdir,
        io: io(),
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--prompt-mode expects one of: inline | bootstrap");
    });

    it("--emit-bootstrap-prompt prints ONLY the prompt body, writes no YAML (#365)", async () => {
      const code = await runRoutine(["generate", "watch", "--emit-bootstrap-prompt"], {
        cwd: workdir,
        io: io(),
      });
      expect(code, `stderr: ${errors.join("\n")}`).toBe(0);
      const joined = logs.join("\n");
      // Just the bootstrap body — no paste guidance / schedule notes / YAML path.
      expect(joined).toContain("You are the `feedradar-watch` routine.");
      expect(joined).not.toContain("yq -r");
      expect(joined).not.toContain("/schedule");
      expect(joined).not.toMatch(/Wrote|generated|claude\.ai/);
      // Read-only: no file is created.
      await expect(
        readFile(join(workdir, ".claude", "routines", "feedradar-watch.yaml"), "utf8"),
      ).rejects.toThrow();
    });

    it("--emit-bootstrap-prompt output equals the generator's bootstrap paste body (en + ja) (#365)", async () => {
      for (const lang of ["en", "ja"] as const) {
        // 1. Capture the --emit-bootstrap-prompt output.
        const emitLogs: string[] = [];
        const emitCode = await runRoutine(
          ["generate", "watch", "--lang", lang, "--emit-bootstrap-prompt", "--name", "my-routine"],
          { cwd: workdir, io: { log: (m) => emitLogs.push(m), error: () => {} } },
        );
        expect(emitCode).toBe(0);
        const emitted = emitLogs.join("\n");

        // 2. Run the real generator in bootstrap paste mode and extract the body.
        const genLogs: string[] = [];
        const genWorkdir = await mkdtemp(join(tmpdir(), "feedradar-routine-emit-"));
        const genCode = await runRoutine(
          [
            "generate",
            "watch",
            "--lang",
            lang,
            "--prompt-mode",
            "bootstrap",
            "--name",
            "my-routine",
          ],
          { cwd: genWorkdir, io: { log: (m) => genLogs.push(m), warn: () => {}, error: () => {} } },
        );
        expect(genCode).toBe(0);
        // The bootstrap body is the 4 lines following the blank line right after
        // the "paste this SHORT bootstrap prompt" step header.
        const t = createTranslator(lang);
        const stepIdx = genLogs.indexOf(t("cli.routine.pasteStep3Bootstrap"));
        expect(stepIdx).toBeGreaterThanOrEqual(0);
        // genLogs[stepIdx + 1] is the blank separator; the body is the next 4.
        const pasteBody = genLogs.slice(stepIdx + 2, stepIdx + 6).join("\n");

        // 3. The emit output must equal the paste body byte-for-byte.
        expect(emitted).toBe(pasteBody);
      }
    });
  });
});
