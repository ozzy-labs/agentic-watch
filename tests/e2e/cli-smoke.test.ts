import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * L4 CLI binary smoke tests.
 *
 * These exercise the *built* `dist/index.js` as a real subprocess against a
 * temp workspace, which catches a layer that the in-process `tests/cli/*`
 * suite cannot: packaging miss, shebang/permissions, Node ESM resolution at
 * runtime, CLI arg parser quoting, and exit-code propagation. The LLM step
 * is stubbed via a fake `claude` binary on PATH so we never hit the network
 * or burn tokens.
 *
 * Layer rationale (see #73): tests/cli/* covers "hexagonal e2e" (adapter
 * mocked in-process); tests/e2e/* covers "binary smoke" (whole CLI spawned
 * as a subprocess, only the agent CLI itself is faked).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO_ROOT, "dist", "index.js");

/**
 * Spawn the built CLI and capture stdout/stderr/exit-code.
 *
 * Tests are responsible for asserting on the returned shape; we never throw
 * on non-zero exit so the assertion message can include the captured output.
 */
async function runCli(
  args: string[],
  options: { cwd: string; extraPath?: string; extraEnv?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveProm, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.extraPath) {
      env.PATH = `${options.extraPath}:${env.PATH ?? ""}`;
    }
    if (options.extraEnv) {
      // Extra env is layered on top of the inherited process.env so a test
      // can flip RADAR_FETCH_HOST_ALLOWLIST=127.0.0.1 just for one CLI call
      // (the SSRF blocklist in src/core/feeds/_fetch.ts is opt-in here).
      Object.assign(env, options.extraEnv);
    }
    const child = spawn("node", [CLI, ...args], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveProm({ code: code ?? 0, stdout, stderr });
    });
    child.stdin.end();
  });
}

/**
 * Write a fake `claude` binary that reads the adapter's JSON payload from
 * stdin and produces a minimal-but-valid v(N+1) Markdown report at the
 * requested outputPath. Used for research (no prevResearch) and update (with
 * prevResearch); we discriminate on payload shape.
 *
 * Mirrors the structure pin'd by tests/agents/claude-code.test.ts: stdin is
 * a single JSON document with agent / templateId / templateBody / items /
 * outputPath, plus prevResearch for update.
 */
async function installFakeClaude(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  let req;
  try {
    // Payload block (#272): structured fields live in the trailing json fence.
    // FENCE built via charCode to avoid backtick escaping in this template.
    const FENCE = String.fromCharCode(96, 96, 96);
    const marker = FENCE + "json";
    const start = stdin.indexOf(marker);
    let jsonText = stdin;
    if (start >= 0) {
      const after = stdin.slice(start + marker.length);
      jsonText = after.slice(0, after.lastIndexOf(FENCE));
    }
    req = JSON.parse(jsonText);
  } catch (e) {
    console.error("fake-claude: bad stdin:", e.message);
    process.exit(2);
  }
  const { outputPath, prevResearch, agent, items } = req;
  if (!outputPath) { console.error("fake-claude: no outputPath"); process.exit(2); }
  const newId = path.basename(outputPath, ".md");
  const isUpdate = prevResearch !== undefined;
  const fm = isUpdate ? prevResearch.frontmatter : null;
  const itemIds = (fm ? fm.itemIds : items.map((i) => i.id))
    .map((id) => "  - " + id)
    .join("\\n");
  const createdAt = isUpdate ? fm.createdAt : new Date().toISOString();
  const templateId = isUpdate ? fm.templateId : (req.templateId || "default");
  const supersedes = isUpdate ? fm.id : null;
  const yaml = [
    "---",
    "id: " + newId,
    "itemIds:",
    itemIds,
    "agent: " + agent,
    "templateId: " + templateId,
    "createdAt: " + createdAt,
    "updatedAt: " + new Date().toISOString(),
    "reviewedAt: null",
    "reviewedBy: null",
    "supersedes: " + (supersedes === null ? "null" : supersedes),
    "---",
    "",
    "# " + (isUpdate ? "v+1 update" : "v1 research") + " (smoke)",
    "",
    "Generated by fake claude binary for L4 smoke. agent=" + agent,
    ""
  ].join("\\n");
  fs.writeFileSync(outputPath, yaml, "utf8");
  console.log("fake-claude: wrote " + outputPath);
});
`;
  const scriptPath = join(binDir, "claude");
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

interface Frontmatter {
  id: string;
  itemIds: string[];
  agent: string;
  templateId: string;
  createdAt: string;
  updatedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  supersedes: string | null;
}

/** Lightweight frontmatter parser sufficient for what the fake binary writes. */
function parseFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("no frontmatter");
  return { fm: parseYaml(match[1]) as Frontmatter, body: match[2] };
}

describe("e2e/cli (binary smoke)", () => {
  beforeAll(() => {
    // CI builds dist/ before tests (typecheck → build → test). Locally, the
    // developer must run `pnpm build` first; we fail loudly here rather than
    // silently skip so the gap is obvious.
    if (!existsSync(CLI)) {
      throw new Error(
        `dist/index.js not found at ${CLI}. Run \`pnpm build\` before \`pnpm run test\`, or use \`pnpm run prepublishOnly\` which chains build → typecheck → test.`,
      );
    }
  });

  describe("scenario A: init", () => {
    it("creates the canonical workspace layout and copies bundled skills (engine + claude discovery)", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-init-"));
      const result = await runCli(["init"], { cwd: workdir });

      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      // Sanity: status message + skill copy log lines on stdout.
      expect(result.stdout).toContain("init: workspace ready");
      expect(result.stdout).toContain("init: skills copied");

      for (const dir of ["sources", "state", "items", "research", "templates"]) {
        expect(existsSync(join(workdir, dir))).toBe(true);
      }
      // Engine SKILLs (SSoT) under .agents/skills/.
      for (const skill of ["research", "review", "update"]) {
        expect(existsSync(join(workdir, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // Claude Code slash-command wrappers under .claude/skills/ (ADR-0007
      // revision via #75). dismiss is here but NOT in engine skills since the
      // dismiss command does not invoke an agent.
      for (const skill of ["research", "review", "update", "dismiss"]) {
        expect(existsSync(join(workdir, ".claude", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // Gemini CLI slash commands under .gemini/commands/ (ADR-0007 revision
      // via #78): native TOML format Gemini CLI surfaces as /research etc.
      // dismiss appears here too (same asymmetry as .claude/skills/).
      for (const command of ["research", "review", "update", "dismiss"]) {
        expect(existsSync(join(workdir, ".gemini", "commands", `${command}.toml`))).toBe(true);
      }
      // Workspace-root AGENTS.md (ADR-0007 revision via #77): agent-agnostic
      // instructions auto-read by Codex / Gemini / Copilot when opened in
      // the workspace.
      expect(existsSync(join(workdir, "AGENTS.md"))).toBe(true);
    });

    it("--no-claude-skills skips .claude/skills/ but still writes engine SKILLs", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-init-nocs-"));
      const result = await runCli(["init", "--no-claude-skills"], { cwd: workdir });

      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      // Engine SKILLs still written.
      for (const skill of ["research", "review", "update"]) {
        expect(existsSync(join(workdir, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // .claude/skills/ should not exist at all.
      expect(existsSync(join(workdir, ".claude", "skills"))).toBe(false);
    });

    it("--no-gemini-commands skips .gemini/commands/ but still writes engine SKILLs", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-init-nogc-"));
      const result = await runCli(["init", "--no-gemini-commands"], { cwd: workdir });

      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      // Engine SKILLs still written (SSoT layer, always on).
      for (const skill of ["research", "review", "update"]) {
        expect(existsSync(join(workdir, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // Claude discovery skills still written (independent of gemini opt-out).
      for (const skill of ["research", "review", "update", "dismiss"]) {
        expect(existsSync(join(workdir, ".claude", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // .gemini/commands/ should not exist at all.
      expect(existsSync(join(workdir, ".gemini", "commands"))).toBe(false);
    });
  });

  describe("scenario B: source add / list / remove", () => {
    it("round-trips a source through add → list → remove", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-source-"));
      await runCli(["init"], { cwd: workdir });

      const add = await runCli(
        ["source", "add", "smoke-blog", "--kind", "rss", "--url", "https://example.com/feed.xml"],
        { cwd: workdir },
      );
      expect(add.code, `stderr: ${add.stderr}`).toBe(0);
      expect(existsSync(join(workdir, "sources", "smoke-blog.yaml"))).toBe(true);

      const list = await runCli(["source", "list"], { cwd: workdir });
      expect(list.code, `stderr: ${list.stderr}`).toBe(0);
      expect(list.stdout).toContain("smoke-blog");
      expect(list.stdout).toContain("rss");

      const remove = await runCli(["source", "remove", "smoke-blog"], { cwd: workdir });
      expect(remove.code, `stderr: ${remove.stderr}`).toBe(0);
      expect(existsSync(join(workdir, "sources", "smoke-blog.yaml"))).toBe(false);
    });
  });

  describe("scenario C: dismiss (LLM-free)", () => {
    it("transitions a detected item to dismissed", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-dismiss-"));
      await runCli(["init"], { cwd: workdir });

      const itemId = "smoke-item-abcdef12";
      const sourceId = "smoke-source";
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      await writeFile(
        join(workdir, "items", sourceId, `${itemId}.yaml`),
        stringifyYaml({
          id: itemId,
          sourceId,
          title: "Smoke item",
          url: "https://example.com/smoke",
          fetchedAt: "2026-05-15T00:00:00.000Z",
          matchedKeywords: ["smoke"],
          status: "detected",
        }),
        "utf8",
      );

      const result = await runCli(["dismiss", itemId], { cwd: workdir });
      expect(result.code, `stderr: ${result.stderr}`).toBe(0);

      const after = parseYaml(
        await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8"),
      );
      expect(after.status).toBe("dismissed");
    });
  });

  describe("scenario D: research --agent claude-code (fake binary)", () => {
    it("generates a valid v1 research file and transitions item to researched", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-research-"));
      const binDir = join(workdir, "_bin");
      await installFakeClaude(binDir);
      await runCli(["init"], { cwd: workdir });

      const itemId = "smoke-item-12345678";
      const sourceId = "smoke-source";
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      await writeFile(
        join(workdir, "items", sourceId, `${itemId}.yaml`),
        stringifyYaml({
          id: itemId,
          sourceId,
          title: "Smoke item for research",
          url: "https://example.com/smoke",
          fetchedAt: "2026-05-15T00:00:00.000Z",
          matchedKeywords: ["smoke"],
          status: "detected",
        }),
        "utf8",
      );

      const result = await runCli(["research", itemId, "--agent", "claude-code"], {
        cwd: workdir,
        extraPath: binDir,
      });
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

      // Item status transitioned.
      const item = parseYaml(
        await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8"),
      );
      expect(item.status).toBe("researched");

      // Research file was written with valid frontmatter (id contains
      // YYYYMMDD prefix + sourceId-slug-of-title + _v1).
      const researchMatch = result.stdout.match(/research\/([^.\s]+\.md)/);
      expect(researchMatch).not.toBeNull();
      const researchPath = join(workdir, "research", researchMatch?.[1] ?? "MISSING");
      expect(existsSync(researchPath)).toBe(true);
      const { fm } = parseFrontmatter(await readFile(researchPath, "utf8"));
      expect(fm.agent).toBe("claude-code");
      expect(fm.itemIds).toEqual([itemId]);
      expect(fm.supersedes).toBeNull();
      expect(fm.reviewedAt).toBeNull();
      expect(fm.reviewedBy).toBeNull();
      // v1 invariant: id ends in _v1.
      expect(fm.id).toMatch(/_v1$/);
    });
  });

  describe("scenario E: update --agent claude-code (fake binary, supersedes + status-invariance)", () => {
    it("generates v2 with supersedes pointing to v1; items.yaml status is unchanged", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-update-"));
      const binDir = join(workdir, "_bin");
      await installFakeClaude(binDir);
      await runCli(["init"], { cwd: workdir });

      const itemId = "smoke-item-aabbccdd";
      const sourceId = "smoke-source";
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      await writeFile(
        join(workdir, "items", sourceId, `${itemId}.yaml`),
        stringifyYaml({
          id: itemId,
          sourceId,
          title: "Smoke item for update",
          url: "https://example.com/smoke",
          fetchedAt: "2026-05-15T00:00:00.000Z",
          matchedKeywords: ["smoke"],
          status: "reviewed",
        }),
        "utf8",
      );

      // Hand-craft a v1 research file. (We skip running the research
      // subcommand first to keep scenario E isolated and fast.)
      const v1Id = `20260510_smoke-source-smoke-item-for-update_v1`;
      const v1Path = join(workdir, "research", `${v1Id}.md`);
      const v1Yaml = stringifyYaml({
        id: v1Id,
        itemIds: [itemId],
        agent: "claude-code",
        templateId: "default",
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: null,
        reviewedAt: "2026-05-12T00:00:00.000Z",
        reviewedBy: "codex-cli",
        supersedes: null,
      });
      await writeFile(v1Path, `---\n${v1Yaml}---\n\n# v1 body\n`, "utf8");

      const result = await runCli(["update", v1Id, "--agent", "claude-code"], {
        cwd: workdir,
        extraPath: binDir,
      });
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

      // v2 file exists with supersedes pointing at v1.
      const v2Path = join(workdir, "research", `${v1Id.replace(/_v1$/, "_v2")}.md`);
      expect(existsSync(v2Path)).toBe(true);
      const { fm: v2Fm } = parseFrontmatter(await readFile(v2Path, "utf8"));
      expect(v2Fm.supersedes).toBe(v1Id);
      // v+1 invariant: review state reset (ADR-0003).
      expect(v2Fm.reviewedAt).toBeNull();
      expect(v2Fm.reviewedBy).toBeNull();
      // createdAt preserved from predecessor.
      expect(v2Fm.createdAt).toBe("2026-05-10T00:00:00.000Z");

      // ADR-0008 invariance: items.yaml status is unchanged (still reviewed).
      const item = parseYaml(
        await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8"),
      );
      expect(item.status).toBe("reviewed");

      // Immutable history: v1 file unchanged.
      const { fm: v1Fm } = parseFrontmatter(await readFile(v1Path, "utf8"));
      expect(v1Fm.reviewedBy).toBe("codex-cli");
      expect(v1Fm.supersedes).toBeNull();
    });
  });

  describe("scenario F: watch run --source <id> (RSS fixture via local HTTP server)", () => {
    // Phase 1 fetch path (#18) covered through the binary boundary. tests/core/feeds/rss
    // exercises the adapter with vi.spyOn(fetch); that mock cannot survive a child
    // subprocess so we serve the same fixture over a local HTTP server bound to port
    // 0 (kernel-assigned, no collision risk under parallel vitest workers).
    it("fetches an RSS source through the built binary and writes items/<sourceId>/<itemId>.yaml", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-watch-"));
      await runCli(["init"], { cwd: workdir });

      // Minimal RSS 2.0 envelope with one item that matches the keyword we
      // configure below. Two items would exercise dedup but mask the
      // "did any item land?" failure mode we actually care about here.
      const rssXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        "  <channel>",
        "    <title>Smoke Blog</title>",
        "    <link>https://example.com/</link>",
        "    <description>e2e fixture</description>",
        "    <item>",
        "      <title>claude code update v0.1</title>",
        "      <link>https://example.com/posts/claude-code-v0-1</link>",
        '      <guid isPermaLink="false">smoke-e2e-1</guid>',
        "      <pubDate>Sun, 10 May 2026 00:00:00 GMT</pubDate>",
        "      <description>release notes for claude code</description>",
        "    </item>",
        "  </channel>",
        "</rss>",
      ].join("\n");

      // Set up the local HTTP server. The first listen happens before we
      // know the port, so url is captured inside the handler via
      // `server.address()` after listen() resolves.
      let server: Server | null = null;
      try {
        server = createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
          res.end(rssXml);
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          server?.once("error", rejectListen);
          server?.listen(0, "127.0.0.1", () => resolveListen());
        });
        const port = (server.address() as AddressInfo).port;
        const feedUrl = `http://127.0.0.1:${port}/feed.xml`;

        // ADR-0006 / src/core/filter.ts: empty keywords means "match nothing"
        // (firehose guard). We must pass --keywords for items to survive the
        // filter and reach disk.
        const add = await runCli(
          ["source", "add", "smoke-rss", "--kind", "rss", "--url", feedUrl, "--keywords", "claude"],
          { cwd: workdir },
        );
        expect(add.code, `stderr: ${add.stderr}`).toBe(0);

        // The shared fetch wrapper enforces an SSRF host blocklist
        // (ADR-0009 §D5b); the fixture serves on 127.0.0.1 so we have to
        // opt that loopback host into the allowlist for this test only.
        const watch = await runCli(["watch", "run", "--source", "smoke-rss"], {
          cwd: workdir,
          extraEnv: { RADAR_FETCH_HOST_ALLOWLIST: "127.0.0.1" },
        });
        expect(watch.code, `stderr: ${watch.stderr}\nstdout: ${watch.stdout}`).toBe(0);
        expect(watch.stdout).toMatch(/1 new item\(s\)/);

        // An item file landed under items/smoke-rss/. The filename is the
        // sanitized id; we discover it rather than reconstruct the derivation.
        const itemsDir = join(workdir, "items", "smoke-rss");
        expect(existsSync(itemsDir)).toBe(true);
        const files = readdirSync(itemsDir).filter((f) => f.endsWith(".yaml"));
        expect(files).toHaveLength(1);

        const itemYaml = await readFile(join(itemsDir, files[0]), "utf8");
        const item = parseYaml(itemYaml);
        expect(item.sourceId).toBe("smoke-rss");
        expect(item.title).toBe("claude code update v0.1");
        expect(item.url).toBe("https://example.com/posts/claude-code-v0-1");
        expect(item.status).toBe("detected");
        // Filter matched on "claude" — recorded for downstream commands.
        expect(item.matchedKeywords).toContain("claude");

        // State file was persisted with the seen id so a second `watch run`
        // would not re-emit it.
        const statePath = join(workdir, "state", "smoke-rss.yaml");
        expect(existsSync(statePath)).toBe(true);
        const state = parseYaml(await readFile(statePath, "utf8"));
        expect(state.sourceId).toBe("smoke-rss");
        expect(state.lastSeenIds.length).toBeGreaterThan(0);
      } finally {
        if (server) {
          await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
        }
      }
    });
  });

  describe("scenario G: review --agent claude-code (fake binary, reviewedAt stamp + status invariance)", () => {
    // Mirror of scenario E (update) but for review: stamps reviewedAt /
    // reviewedBy in the research frontmatter and transitions linked items
    // from researched → reviewed via the workspace-level atomic snapshot
    // (src/cli/review.ts).
    it("stamps reviewedAt/reviewedBy and transitions linked item to reviewed", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-review-"));
      const binDir = join(workdir, "_bin");
      await installFakeClaudeReviewer(binDir);
      await runCli(["init"], { cwd: workdir });

      const itemId = "smoke-item-deadbeef";
      const sourceId = "smoke-source";
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      await writeFile(
        join(workdir, "items", sourceId, `${itemId}.yaml`),
        stringifyYaml({
          id: itemId,
          sourceId,
          title: "Smoke item for review",
          url: "https://example.com/smoke",
          fetchedAt: "2026-05-15T00:00:00.000Z",
          matchedKeywords: ["smoke"],
          status: "researched",
        }),
        "utf8",
      );

      // Hand-craft a v1 research file (pre-review state: reviewedAt/By null).
      const v1Id = `20260512_smoke-source-smoke-item-for-review_v1`;
      const v1Path = join(workdir, "research", `${v1Id}.md`);
      const v1Yaml = stringifyYaml({
        id: v1Id,
        itemIds: [itemId],
        agent: "claude-code",
        templateId: "default",
        createdAt: "2026-05-12T00:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
        supersedes: null,
      });
      await writeFile(v1Path, `---\n${v1Yaml}---\n\n# v1 body\n`, "utf8");

      // Use codex-cli as the reviewer to make the cross-agent pattern obvious
      // (the underlying fake binary is still `claude` on PATH; the adapter
      // dispatched is the one in registry for codex-cli, so we keep the
      // simpler case here and use claude-code as the reviewer agent too).
      const result = await runCli(["review", v1Id, "--agent", "claude-code"], {
        cwd: workdir,
        extraPath: binDir,
      });
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

      // Research file has the review stamp.
      const { fm } = parseFrontmatter(await readFile(v1Path, "utf8"));
      expect(fm.reviewedAt).not.toBeNull();
      expect(fm.reviewedBy).toBe("claude-code");
      // Immutable fields preserved.
      expect(fm.id).toBe(v1Id);
      expect(fm.createdAt).toBe("2026-05-12T00:00:00.000Z");
      expect(fm.supersedes).toBeNull();

      // Linked item transitioned to reviewed.
      const item = parseYaml(
        await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8"),
      );
      expect(item.status).toBe("reviewed");
    });
  });

  describe("scenario H: workflow generate watch", () => {
    // Validates that the built binary can render the bundled
    // `dist/templates/workflows/watch.template.yaml.tmpl` (the `.tmpl`
    // extension is what keeps yamlfmt from rewriting placeholders into
    // syntactically-valid-but-broken YAML — see `generate-watch.ts`). A
    // packaging regression that dropped the templates directory would fail
    // here with "bundled template not found".
    it("renders the watch template with placeholders replaced and rebase retry intact", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-wf-watch-"));
      const outputPath = join(".github", "workflows", "test-watch.yaml");

      const result = await runCli(
        ["workflow", "generate", "watch", "--cron", "0 */6 * * *", "--output", outputPath],
        { cwd: workdir },
      );
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      expect(result.stdout).toContain(`workflow generate watch: wrote ${outputPath}`);
      // Required-secrets section names the default agent's API key (ADR-0014 D5).
      expect(result.stdout).toContain("ANTHROPIC_API_KEY");

      const written = await readFile(join(workdir, outputPath), "utf8");
      // The `{{cron}}` / `{{agentEnvKey}}` placeholders must all be
      // substituted. We can't grep for a bare `{{` because GitHub Actions
      // expressions (`${{ secrets.X }}`) legitimately contain it; check the
      // exact placeholder tokens by name instead.
      expect(written).not.toContain("{{cron}}");
      expect(written).not.toContain("{{agentEnvKey}}");
      expect(written).toContain('cron: "0 */6 * * *"');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions secret expression literal
      expect(written).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
      // Rebase retry block (ADR-0014 D4) is the differentiator from the
      // bootstrap `watch.yaml` — assert it survived the template render.
      expect(written).toContain("git pull --rebase --autostash");
      // YAML parses cleanly so downstream GitHub Actions schema validation
      // is at least structurally possible (we don't pull an Actions JSON
      // schema lib for this smoke; structural parse is the floor).
      const yaml = parseYaml(written);
      expect(yaml).toBeDefined();
      expect(yaml.name).toBe("feedradar-watch");
      expect(yaml.on?.schedule?.[0]?.cron).toBe("0 */6 * * *");
    });
  });

  describe("scenario I: workflow generate combined", () => {
    // Combined workflow embeds agent-specific secret blocks twice (watch +
    // research steps), a shell guard (`git diff --quiet items/` style detect),
    // and the `--max-items` hard cap as a YAML literal. The CLI re-enforces
    // the cap at runtime so a hand-edited YAML cannot blow it inside one
    // invocation (ADR-0014 D3a 二重防御) — this scenario covers the template
    // rendering side of that double defense.
    it("renders combined template with agent secrets, shell guard, and max-items cap", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-wf-combined-"));
      const outputPath = join(".github", "workflows", "test-combined.yaml");

      const result = await runCli(
        [
          "workflow",
          "generate",
          "combined",
          "--watch-cron",
          "0 0 * * *",
          "--output",
          outputPath,
          "--agent",
          "codex-cli",
          "--max-items",
          "5",
        ],
        { cwd: workdir },
      );
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      expect(result.stdout).toContain(`workflow generate combined: wrote ${outputPath}`);
      // OpenAI key surfaces in the "Required secrets" stdout block when
      // --agent codex-cli is selected (ADR-0014 D5).
      expect(result.stdout).toContain("OPENAI_API_KEY");

      const written = await readFile(join(workdir, outputPath), "utf8");
      // Same caveat as scenario H: GitHub Actions expressions use `${{ ... }}`
      // legitimately, so we grep for the explicit placeholder tokens instead
      // of any `{{` to confirm substitution ran on every site.
      expect(written).not.toContain("{{cron}}");
      expect(written).not.toContain("{{maxItems}}");
      expect(written).not.toContain("{{filterTags}}");
      expect(written).not.toContain("{{agent}}");
      expect(written).not.toContain("{{secretsBlock}}");
      // Agent-specific env block landed in both the watch and research step.
      // `setSecretsBlock` injects two occurrences from the same fragment, so
      // we count rather than just assert presence.
      const openAiMatches = written.match(/OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/g);
      expect(openAiMatches).not.toBeNull();
      expect(openAiMatches?.length).toBeGreaterThanOrEqual(2);
      // Shell guard: combined.template.yaml.tmpl uses `git status --porcelain
      // items/` to gate the research step; assert the literal phrase is
      // preserved so the no-new-items short-circuit survives the render.
      expect(written).toContain("git status --porcelain items/");
      // Hard-cap literal embedded in the research command line.
      expect(written).toContain("--max-items 5");
      // Agent literal flows through to the research command line.
      expect(written).toContain("--agent codex-cli");
      // Hard-cap double-defense note prints to stderr on success.
      expect(result.stderr).toContain("the --max-items cap is also enforced");

      // The combined template injects a literal `${{ secrets.X }}` block
      // unindented (column 0) followed by content, which a strict YAML 1.2
      // parser may interpret as scalar-after-end. We don't structurally
      // parse it here — scenario H already covers structural parseability
      // for the simpler watch template, and this test focuses on the
      // placeholder / cap / secrets-block invariants.
      expect(written).toContain("name: feedradar-combined");
    });
  });

  describe("scenario R: routine generate watch (ADR-0020 D5 / #280)", () => {
    // Validates that the built binary renders the bundled
    // `dist/templates/routines/watch.yaml.tmpl` into a valid Claude Routine
    // YAML under `.claude/routines/`. Mirrors scenario H (workflow side): a
    // packaging regression that dropped the routines template directory would
    // fail here with "bundled template not found".
    it("renders the watch routine with placeholders replaced and a parseable shape", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-routine-watch-"));
      const result = await runCli(
        ["routine", "generate", "watch", "--repo", "acme/widgets", "--cron", "0 0 * * *"],
        { cwd: workdir },
      );
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      const outputPath = join(".claude", "routines", "feedradar-watch.yaml");
      expect(result.stdout).toContain(`routine generate watch: wrote ${outputPath}`);
      // Stdout surfaces the Web UI paste workflow (yq) and the /schedule example.
      expect(result.stdout).toContain("yq -r '.instructions'");
      expect(result.stdout).toContain("/schedule");

      const written = await readFile(join(workdir, outputPath), "utf8");
      // No placeholder leaks.
      expect(written).not.toContain("{{name}}");
      expect(written).not.toContain("{{repository}}");
      expect(written).not.toContain("{{cron}}");
      expect(written).not.toContain("{{model}}");

      // Parses cleanly and carries the watch-only routine shape (1:1 with the
      // org `_template.yaml`).
      const yaml = parseYaml(written);
      expect(yaml.name).toBe("feedradar-watch");
      expect(yaml.status).toBe("draft");
      expect(yaml.repositories).toEqual(["acme/widgets"]);
      expect(yaml.triggers?.[0]?.cron).toBe("0 0 * * *");
      // Watch-only: instructions run `radar watch run`, no triage/research.
      expect(yaml.instructions).toContain("radar watch run");
      expect(yaml.instructions).not.toContain("radar triage");
    });

    it("rejects a sub-hourly cron (Routines 1-hour minimum)", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-routine-subhourly-"));
      const result = await runCli(
        ["routine", "generate", "watch", "--repo", "acme/widgets", "--cron", "*/5 * * * *"],
        { cwd: workdir },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("minimum interval of 1 hour");
    });
  });

  describe("scenario S: routine generate pipeline (ADR-0020 D5 `pipeline` / #284)", () => {
    // Sibling of scenario R for the full-pipeline routine type. Validates that
    // the built binary renders the bundled `dist/templates/routines/
    // pipeline.yaml.tmpl` into a contract-clean Claude Routine YAML under
    // `.claude/routines/`. We assert the *stable* shape of the generated file
    // (file landed, parses, draft status, repositories, the >= 1-hour cron, the
    // `--max-items` cap threaded into the body) and deliberately avoid pinning
    // volatile prose like `network_access` (PR #293 may change it) so this
    // smoke survives template wording churn.
    it("renders the pipeline routine with placeholders replaced and a parseable shape", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-routine-pipeline-"));
      const result = await runCli(
        [
          "routine",
          "generate",
          "pipeline",
          "--repo",
          "acme/widgets",
          "--cron",
          "0 * * * *",
          "--max-items",
          "4",
        ],
        { cwd: workdir },
      );
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      const outputPath = join(".claude", "routines", "feedradar-pipeline.yaml");
      expect(result.stdout).toContain(`routine generate pipeline: wrote ${outputPath}`);
      // Stdout surfaces the Web UI paste workflow (yq) and the /schedule example
      // (same operator affordances as the watch generator).
      expect(result.stdout).toContain("yq -r '.instructions'");
      expect(result.stdout).toContain("/schedule");

      const written = await readFile(join(workdir, outputPath), "utf8");
      // No placeholder leaks (every {{token}} must be substituted).
      expect(written).not.toMatch(/\{\{[a-zA-Z]+\}\}/);

      // Stable contract shape — 1:1 with the routine field set the validator
      // requires. We pin structure, not prose.
      const yaml = parseYaml(written);
      expect(yaml.name).toBe("feedradar-pipeline");
      expect(yaml.status).toBe("draft");
      expect(yaml.routine_id).toBe("");
      expect(yaml.repositories).toEqual(["acme/widgets"]);
      expect(yaml.triggers?.[0]?.type).toBe("scheduled");
      expect(yaml.triggers?.[0]?.cron).toBe("0 * * * *");
      expect(yaml.connectors).toEqual([]);
      expect(typeof yaml.environment?.setup_script).toBe("string");
      // Full pipeline in one session: the instructions run the whole chain and
      // the CLI `--max-items` cap (ADR-0020 D3e) is threaded through.
      expect(yaml.instructions).toContain("radar watch run");
      expect(yaml.instructions).toContain("radar triage --apply --max-items 4");
      expect(yaml.instructions).toContain("--limit 4");
    });

    it("rejects a sub-hourly pipeline cron (Routines 1-hour minimum)", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-routine-pipeline-subhourly-"));
      const result = await runCli(
        ["routine", "generate", "pipeline", "--repo", "acme/widgets", "--cron", "*/10 * * * *"],
        { cwd: workdir },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("minimum interval of 1 hour");
    });
  });

  describe("scenario T: routine fire (ADR-0020 /fire connector / #282, network-free)", () => {
    // `radar routine fire <trig_id>` POSTs to api.anthropic.com. We must NEVER
    // hit the network from a smoke test, so we only exercise the paths that
    // exit BEFORE any fetch is attempted:
    //   - missing token env var      → exit 2 (no fetch)
    //   - missing <trig_id>          → exit 2 (no fetch)
    //   - a `--token` flag           → exit 2 (refused: leak prevention)
    //   - an invalid id WITH a token → exit 1 (id validated before fetch)
    // The fetch-mocked POST contract (URL / headers / token-never-logged) is
    // covered in-process by tests/cli/routine-fire.test.ts; here we only pin
    // the binary-boundary behaviour of the no-network guards.
    const FIRE_TOKEN_ENV = "FEEDRADAR_ROUTINE_FIRE_TOKEN";

    it("errors (exit 2) when the token env var is unset, never reaching the network", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-fire-notoken-"));
      // Explicitly clear the default token env var so an ambient export in the
      // CI shell cannot accidentally arm a real network call.
      const result = await runCli(["routine", "fire", "trig_abc123"], {
        cwd: workdir,
        extraEnv: { [FIRE_TOKEN_ENV]: "" },
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(FIRE_TOKEN_ENV);
    });

    it("errors (exit 2) when <trig_id> is omitted", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-fire-noid-"));
      const result = await runCli(["routine", "fire"], {
        cwd: workdir,
        extraEnv: { [FIRE_TOKEN_ENV]: "tok-should-not-be-used" },
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("missing <trig_id>");
      // Token present but never echoed (the missing-id path prints help only).
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("tok-should-not-be-used");
    });

    it("refuses a --token flag on the command line (leak prevention, exit 2)", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-fire-tokenflag-"));
      const result = await runCli(["routine", "fire", "trig_abc123", "--token", "secret-on-argv"], {
        cwd: workdir,
        extraEnv: { [FIRE_TOKEN_ENV]: "" },
      });
      expect(result.code).toBe(2);
      expect(result.stderr.toLowerCase()).toContain("refusing --token");
    });

    it("honours --token-env and --text but still exits before the network on a bad id", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-fire-badid-"));
      // A token IS present (under a custom env name) and `--text` is supplied,
      // so the parser accepts the flags and reaches fireRoutine; the invalid id
      // (no `trig_` prefix) is rejected there BEFORE fetch runs → exit 1. This
      // proves --token-env / --text are wired without ever opening a socket.
      const result = await runCli(
        ["routine", "fire", "not-a-trig-id", "--token-env", "ALT_FIRE_TOKEN", "--text", "go now"],
        {
          cwd: workdir,
          extraEnv: { ALT_FIRE_TOKEN: "alt-secret-value", [FIRE_TOKEN_ENV]: "" },
        },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("invalid routine id");
      // The token is never printed on any stream.
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("alt-secret-value");
    });

    it("prints help (exit 0)", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-fire-help-"));
      const result = await runCli(["routine", "fire", "--help"], { cwd: workdir });
      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("radar routine fire <trig_id>");
    });
  });

  describe("scenario J: source add --recipe + source recipes (bundled recipe discovery)", () => {
    // ADR-0012 §D3 / #178: recipes ship as `dist/recipes/*.yaml` and are
    // discovered via `source recipes`. `source add --recipe <name>` then
    // applies the recipe (kind / url / pagination / selectors) while
    // honouring `--keywords` / `--tags` / `--name` overrides. A packaging
    // regression that dropped `dist/recipes` would surface here as
    // "no recipes bundled" or a recipe-not-found error.
    it("lists bundled recipes and applies one via --recipe with --keywords override", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-recipe-"));
      await runCli(["init"], { cwd: workdir });

      // 1) `source recipes` enumerates ≥ 2 bundled recipes (aws-whats-new,
      //    dev-to as of #178). The table header is fixed-width so we look
      //    for the recipe name tokens rather than column alignment.
      const recipesList = await runCli(["source", "recipes"], { cwd: workdir });
      expect(recipesList.code, `stderr: ${recipesList.stderr}`).toBe(0);
      expect(recipesList.stdout).toContain("aws-whats-new");
      expect(recipesList.stdout).toContain("dev-to");
      expect(recipesList.stdout).toContain("json-api");

      // 2) Apply the AWS What's New recipe. `--keywords` overrides the
      //    recipe's empty default; `--kind` / `--url` are forbidden on the
      //    recipe path (the recipe owns them) so we deliberately omit them.
      const add = await runCli(
        ["source", "add", "aws", "--recipe", "aws-whats-new", "--keywords", "Bedrock,Claude"],
        { cwd: workdir },
      );
      expect(add.code, `stderr: ${add.stderr}\nstdout: ${add.stdout}`).toBe(0);
      expect(add.stdout).toContain("from recipe 'aws-whats-new'");

      // 3) The generated YAML inherits the recipe's kind / url and the
      //    user's --keywords override (ADR-0012 §D3 strategy A).
      const yamlPath = join(workdir, "sources", "aws.yaml");
      expect(existsSync(yamlPath)).toBe(true);
      const generated = parseYaml(await readFile(yamlPath, "utf8"));
      expect(generated.id).toBe("aws");
      expect(generated.kind).toBe("json-api");
      // Recipe URL hits aws.amazon.com (we don't fetch — this is a render
      // test). The exact URL is brittle to recipe edits, so just check the
      // host so an upstream tweak to the path doesn't break us.
      expect(generated.url).toContain("aws.amazon.com");
      expect(generated.filters?.keywords).toEqual(["Bedrock", "Claude"]);
      // Pagination block from the recipe (page-based, totalPath hint).
      expect(generated.pagination?.type).toBe("page");
    });
  });

  describe("scenario K: source add --kind json-api + watch run --backfill", () => {
    // Phase-3 / ADR-0012 json-api adapter end-to-end through the binary
    // boundary. Mocks the API over 127.0.0.1, configures `--max-pages 2`,
    // and verifies that --backfill walks both pages and writes items to
    // disk. If `dist/core/feeds/json-api.js` failed to bundle (or the
    // Source schema discriminated union dropped the `json-api` case), this
    // scenario surfaces it as a parse / "unknown kind" error.
    it("paginates a json-api source across two pages and writes detected items", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-jsonapi-"));
      await runCli(["init"], { cwd: workdir });

      // Mock a paginated JSON API: page 0 / page 1 each return one item,
      // page 2+ returns an empty `items: []` so the adapter's
      // end-of-pagination heuristic short-circuits before maxPages.
      let server: Server | null = null;
      try {
        server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const page = Number(url.searchParams.get("page") ?? "0");
          const pageItems =
            page === 0
              ? [
                  {
                    id: "json-api-1",
                    title: "json-api item one (Claude release)",
                    url: "https://example.com/api/items/1",
                    publishedAt: "2026-05-12T00:00:00Z",
                    summary: "Page-0 item summary",
                  },
                ]
              : page === 1
                ? [
                    {
                      id: "json-api-2",
                      title: "json-api item two (Claude update)",
                      url: "https://example.com/api/items/2",
                      publishedAt: "2026-05-13T00:00:00Z",
                      summary: "Page-1 item summary",
                    },
                  ]
                : [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ items: pageItems }));
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          server?.once("error", rejectListen);
          server?.listen(0, "127.0.0.1", () => resolveListen());
        });
        const port = (server.address() as AddressInfo).port;
        // The adapter rewrites `page=<N>` on every request, so we just need
        // the base URL to point at the mock. The `?page=0` placeholder gets
        // overwritten by `setQueryParam`.
        const apiUrl = `http://127.0.0.1:${port}/api?page=0`;

        const add = await runCli(
          [
            "source",
            "add",
            "smoke-json-api",
            "--kind",
            "json-api",
            "--url",
            apiUrl,
            "--keywords",
            "Claude",
            "--pagination-strategy",
            "page",
            "--pagination-param",
            "page",
            "--pagination-start",
            "0",
            "--page-size",
            "1",
            "--max-pages",
            "2",
          ],
          { cwd: workdir },
        );
        expect(add.code, `stderr: ${add.stderr}\nstdout: ${add.stdout}`).toBe(0);

        // --backfill walks every page up to maxPages (2 here). The host
        // allowlist gate (ADR-0009 §D5b) needs the loopback explicitly.
        const watch = await runCli(
          ["watch", "run", "--source", "smoke-json-api", "--backfill", "--max-pages", "2"],
          {
            cwd: workdir,
            extraEnv: { RADAR_FETCH_HOST_ALLOWLIST: "127.0.0.1" },
          },
        );
        expect(watch.code, `stderr: ${watch.stderr}\nstdout: ${watch.stdout}`).toBe(0);
        expect(watch.stdout).toMatch(/backfill complete/);

        const itemsDir = join(workdir, "items", "smoke-json-api");
        expect(existsSync(itemsDir)).toBe(true);
        const files = readdirSync(itemsDir).filter((f) => f.endsWith(".yaml"));
        // Two items across two pages; the keyword filter accepts both.
        expect(files.length).toBeGreaterThanOrEqual(2);

        // Spot-check one item to confirm the json-api default selector chain
        // picked up title/url/publishedAt without explicit jsonSelectors.
        const sample = parseYaml(await readFile(join(itemsDir, files[0]), "utf8"));
        expect(sample.sourceId).toBe("smoke-json-api");
        expect(sample.status).toBe("detected");
        expect(sample.matchedKeywords).toContain("Claude");
      } finally {
        if (server) {
          await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
        }
      }
    });
  });

  describe("scenario L: source add --kind json-feed + watch run", () => {
    // JSON Feed 1.1 is a real standard with a fixed schema; the adapter is
    // URL-only (no recipe, no pagination flags needed for the simple case).
    // This scenario serves a minimal 1.1 fixture over the same local-HTTP
    // pattern as scenario F (RSS) and asserts items land on disk.
    it("ingests JSON Feed 1.1 items through the built binary", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-jsonfeed-"));
      await runCli(["init"], { cwd: workdir });

      const feedBody = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Smoke JSON Feed",
        items: [
          {
            id: "jf-1",
            url: "https://example.com/posts/claude-update",
            title: "Claude Code update v1.0",
            content_text: "Release notes for Claude Code 1.0",
            date_published: "2026-05-14T00:00:00Z",
            tags: ["release"],
          },
        ],
      });

      let server: Server | null = null;
      try {
        server = createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "application/feed+json" });
          res.end(feedBody);
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          server?.once("error", rejectListen);
          server?.listen(0, "127.0.0.1", () => resolveListen());
        });
        const port = (server.address() as AddressInfo).port;
        const feedUrl = `http://127.0.0.1:${port}/feed.json`;

        const add = await runCli(
          [
            "source",
            "add",
            "smoke-jsonfeed",
            "--kind",
            "json-feed",
            "--url",
            feedUrl,
            "--keywords",
            "Claude",
          ],
          { cwd: workdir },
        );
        expect(add.code, `stderr: ${add.stderr}\nstdout: ${add.stdout}`).toBe(0);

        const watch = await runCli(["watch", "run", "--source", "smoke-jsonfeed"], {
          cwd: workdir,
          extraEnv: { RADAR_FETCH_HOST_ALLOWLIST: "127.0.0.1" },
        });
        expect(watch.code, `stderr: ${watch.stderr}\nstdout: ${watch.stdout}`).toBe(0);
        expect(watch.stdout).toMatch(/1 new item\(s\)/);

        const itemsDir = join(workdir, "items", "smoke-jsonfeed");
        expect(existsSync(itemsDir)).toBe(true);
        const files = readdirSync(itemsDir).filter((f) => f.endsWith(".yaml"));
        expect(files).toHaveLength(1);

        const item = parseYaml(await readFile(join(itemsDir, files[0]), "utf8"));
        expect(item.sourceId).toBe("smoke-jsonfeed");
        expect(item.title).toBe("Claude Code update v1.0");
        expect(item.url).toBe("https://example.com/posts/claude-update");
        expect(item.status).toBe("detected");
        expect(item.matchedKeywords).toContain("Claude");
      } finally {
        if (server) {
          await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
        }
      }
    });
  });

  describe("scenario M: research --batch (fake binary, --max-items cap)", () => {
    // Batch mode (#189 / ADR-0014 D3a) walks items/ for status=detected,
    // applies the cap, and processes each item via the agent adapter. Seeds
    // three detected items but caps at 2; the third must remain `detected`
    // so we can prove the cap is enforced at the CLI layer (not just the
    // generated YAML literal).
    it("processes detected items up to --max-items and leaves overflow as detected", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-batch-"));
      const binDir = join(workdir, "_bin");
      await installFakeClaude(binDir);
      await runCli(["init"], { cwd: workdir });

      const sourceId = "smoke-source";
      const itemIds = ["smoke-batch-aaaaaaaa", "smoke-batch-bbbbbbbb", "smoke-batch-cccccccc"];
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      // Use distinct publishedAt timestamps so batch's sort order is stable
      // (oldest first); the third in chronological order is what we expect
      // to be dropped by the --max-items 2 cap.
      const publishedAt = ["2026-05-10T00:00:00Z", "2026-05-11T00:00:00Z", "2026-05-12T00:00:00Z"];
      for (let i = 0; i < itemIds.length; i++) {
        await writeFile(
          join(workdir, "items", sourceId, `${itemIds[i]}.yaml`),
          stringifyYaml({
            id: itemIds[i],
            sourceId,
            title: `Smoke batch item ${i + 1}`,
            url: `https://example.com/smoke/${i + 1}`,
            fetchedAt: "2026-05-15T00:00:00.000Z",
            publishedAt: publishedAt[i],
            matchedKeywords: ["smoke"],
            status: "detected",
          }),
          "utf8",
        );
      }

      const result = await runCli(
        [
          "research",
          "--batch",
          "--status",
          "detected",
          "--max-items",
          "2",
          "--agent",
          "claude-code",
        ],
        { cwd: workdir, extraPath: binDir },
      );
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("--batch completed 2 item(s)");
      // The cap-reached warning surfaces on stderr (overflow count = 1).
      expect(result.stderr).toContain("--max-items 2 cap reached");

      // Items 1 and 2 (oldest first) transitioned to `researched`; item 3
      // is still `detected`. itemIds[0] and itemIds[1] are oldest by
      // publishedAt, so they go through; itemIds[2] stays.
      for (let i = 0; i < itemIds.length; i++) {
        const after = parseYaml(
          await readFile(join(workdir, "items", sourceId, `${itemIds[i]}.yaml`), "utf8"),
        );
        if (i < 2) {
          expect(after.status, `item ${i + 1} should be researched`).toBe("researched");
        } else {
          expect(after.status, `item ${i + 1} should still be detected`).toBe("detected");
        }
      }

      // Exactly two research reports were produced (one per processed item;
      // batch mode does not aggregate into a digest — ADR-0014 D3a).
      const researchDir = join(workdir, "research");
      const reports = readdirSync(researchDir).filter((f) => f.endsWith(".md"));
      expect(reports).toHaveLength(2);
    });
  });

  describe("scenario O: triage lifecycle (fake binary, ADR-0018 PR-3)", () => {
    // End-to-end triage flow: 6 mock items in `detected` → `radar triage
    // --apply` classifies them via a fake `claude` binary → `radar items
    // list` filters by status → `radar triage feedback` writes feedback →
    // `radar undismiss` exercises both triage-origin and human-origin paths.
    // The fake binary is a deterministic mapping from item id → decision so
    // every assertion is reproducible.
    it("classifies items, lists by status, records feedback, and reverses dismisses", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-triage-"));
      const binDir = join(workdir, "_bin");
      await installFakeClaudeTriage(binDir);
      await runCli(["init"], { cwd: workdir });

      // Seed a source with a triagePolicy block so `radar triage` does not
      // skip it. The policy text is opaque to the fake binary; only the
      // item ids matter.
      const sourceId = "smoke-triage";
      await mkdir(join(workdir, "sources"), { recursive: true });
      await writeFile(
        join(workdir, "sources", `${sourceId}.yaml`),
        stringifyYaml({
          id: sourceId,
          kind: "rss",
          url: "https://example.com/feed.xml",
          tags: [],
          filters: {
            keywords: ["test"],
            excludeKeywords: [],
            matchMode: "word",
            matchFields: ["title", "summary"],
            caseSensitive: false,
          },
          trustLevel: "untrusted",
          triagePolicy: {
            agent: "claude-code",
            confidenceThreshold: 0.7,
            rules: "Test rules: GA => research, UI => digest (group: ui), region/SDK => dismiss",
          },
        }),
        "utf8",
      );

      // Seed six items covering every triage decision plus the "unsure"
      // branch (ambiguous returns confidence below threshold).
      const seedItems = [
        { id: "new-service-ga", summary: "GA of new service Foo" }, // → research
        { id: "minor-ui-add", summary: "Add custom sort to Foo" }, // → digest (group: ui)
        { id: "another-ui-add", summary: "Add filter to Foo" }, // → digest (group: ui)
        { id: "region-expansion", summary: "Foo now available in Tokyo" }, // → dismiss
        { id: "sdk-bump", summary: "Foo SDK v2.1.0 released" }, // → dismiss
        { id: "ambiguous", summary: "Foo changes billing units" }, // → unsure (low conf)
      ];
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      for (const seed of seedItems) {
        await writeFile(
          join(workdir, "items", sourceId, `${seed.id}.yaml`),
          stringifyYaml({
            id: seed.id,
            sourceId,
            title: seed.summary,
            url: `https://example.com/${seed.id}`,
            fetchedAt: "2026-05-20T00:00:00.000Z",
            publishedAt: "2026-05-19T00:00:00.000Z",
            matchedKeywords: ["test"],
            status: "detected",
            summary: seed.summary,
          }),
          "utf8",
        );
      }

      // 1. radar triage --apply — fake binary returns the deterministic
      //    classification table. `--triage-agent claude-code` matches the
      //    fake `claude` we just installed.
      const triage = await runCli(["triage", "--apply", "--triage-agent", "claude-code"], {
        cwd: workdir,
        extraPath: binDir,
      });
      expect(triage.code, `stderr: ${triage.stderr}\nstdout: ${triage.stdout}`).toBe(0);

      // 2. Assert per-item status transitions match the fake binary's
      //    decision map. `triaged_research` for the GA, `triaged_digest` for
      //    the two UI items, `dismissed` for the two low-importance items,
      //    `triaged_unsure` for the confidence-below-threshold item.
      const newServiceGa = parseYaml(
        await readFile(join(workdir, "items", sourceId, "new-service-ga.yaml"), "utf8"),
      );
      expect(newServiceGa.status).toBe("triaged_research");

      const minorUiAdd = parseYaml(
        await readFile(join(workdir, "items", sourceId, "minor-ui-add.yaml"), "utf8"),
      );
      expect(minorUiAdd.status).toBe("triaged_digest");
      expect(minorUiAdd.triage?.group).toBe("ui");

      const anotherUiAdd = parseYaml(
        await readFile(join(workdir, "items", sourceId, "another-ui-add.yaml"), "utf8"),
      );
      expect(anotherUiAdd.status).toBe("triaged_digest");
      expect(anotherUiAdd.triage?.group).toBe("ui");

      const regionExpansion = parseYaml(
        await readFile(join(workdir, "items", sourceId, "region-expansion.yaml"), "utf8"),
      );
      expect(regionExpansion.status).toBe("dismissed");
      expect(regionExpansion.dismissedBy).toBe("triage_claude-code");

      const sdkBump = parseYaml(
        await readFile(join(workdir, "items", sourceId, "sdk-bump.yaml"), "utf8"),
      );
      expect(sdkBump.status).toBe("dismissed");
      expect(sdkBump.dismissedBy).toBe("triage_claude-code");

      const ambiguous = parseYaml(
        await readFile(join(workdir, "items", sourceId, "ambiguous.yaml"), "utf8"),
      );
      expect(ambiguous.status).toBe("triaged_unsure");

      // 3. radar items list --status triaged_* --json filters the JSON
      //    output by status and parses cleanly into an array.
      const researchList = await runCli(
        ["items", "list", "--status", "triaged_research", "--json"],
        { cwd: workdir },
      );
      expect(researchList.code, `stderr: ${researchList.stderr}`).toBe(0);
      expect(JSON.parse(researchList.stdout)).toHaveLength(1);

      const unsureList = await runCli(["items", "list", "--status", "triaged_unsure", "--json"], {
        cwd: workdir,
      });
      expect(unsureList.code, `stderr: ${unsureList.stderr}`).toBe(0);
      expect(JSON.parse(unsureList.stdout)).toHaveLength(1);

      const digestList = await runCli(["items", "list", "--triage-group", "ui", "--json"], {
        cwd: workdir,
      });
      expect(digestList.code, `stderr: ${digestList.stderr}`).toBe(0);
      expect(JSON.parse(digestList.stdout)).toHaveLength(2);

      // 4. radar triage feedback — record a --wrong verdict with reason.
      const feedback = await runCli(
        ["triage", "feedback", "region-expansion", "--wrong", "--reason", "actually important"],
        { cwd: workdir },
      );
      expect(feedback.code, `stderr: ${feedback.stderr}`).toBe(0);
      const regionAfterFeedback = parseYaml(
        await readFile(join(workdir, "items", sourceId, "region-expansion.yaml"), "utf8"),
      );
      expect(regionAfterFeedback.triage?.feedback?.[0]?.correct).toBe(false);
      expect(regionAfterFeedback.triage?.feedback?.[0]?.reason).toBe("actually important");

      // 5. radar undismiss <triage-origin> — silent revert.
      const undismissTriage = await runCli(["undismiss", "region-expansion"], {
        cwd: workdir,
      });
      expect(undismissTriage.code, `stderr: ${undismissTriage.stderr}`).toBe(0);
      const regionRestored = parseYaml(
        await readFile(join(workdir, "items", sourceId, "region-expansion.yaml"), "utf8"),
      );
      expect(regionRestored.status).toBe("detected");

      // 6. radar dismiss (human) then radar undismiss — warn + require
      //    --force. The status precondition for `radar dismiss` is
      //    `detected`, so we revert sdk-bump first (triage-origin, no
      //    --force needed), then human-dismiss it, then try to undismiss.
      const sdkUndismiss = await runCli(["undismiss", "sdk-bump"], { cwd: workdir });
      expect(sdkUndismiss.code).toBe(0);
      const sdkHumanDismiss = await runCli(["dismiss", "sdk-bump"], { cwd: workdir });
      expect(sdkHumanDismiss.code).toBe(0);
      const sdkInspect = parseYaml(
        await readFile(join(workdir, "items", sourceId, "sdk-bump.yaml"), "utf8"),
      );
      // `radar dismiss` does not stamp `dismissedBy`; undefined is treated
      // as "human" per the schema docstring.
      expect(sdkInspect.status).toBe("dismissed");

      const undismissNoForce = await runCli(["undismiss", "sdk-bump"], { cwd: workdir });
      expect(undismissNoForce.code).toBe(2);
      expect(undismissNoForce.stderr.toLowerCase()).toContain("dismissed by human");

      const undismissForce = await runCli(["undismiss", "sdk-bump", "--force"], {
        cwd: workdir,
      });
      expect(undismissForce.code, `stderr: ${undismissForce.stderr}`).toBe(0);
      const sdkAfter = parseYaml(
        await readFile(join(workdir, "items", sourceId, "sdk-bump.yaml"), "utf8"),
      );
      expect(sdkAfter.status).toBe("detected");
    });
  });

  describe("scenario P: triage --apply → items list (per-group walk) → research --digest lifecycle (fake binaries, ADR-0018 §W5 / #241)", () => {
    // Fixture-based 1-cycle smoke for the `combined-with-triage` workflow
    // (PR-4 / #241). We exercise the runtime contract the generated YAML
    // depends on:
    //
    //   1. `radar triage --apply` partitions `detected` items into
    //      `triaged_research` / `triaged_digest` / `triaged_unsure` /
    //      `dismissed` per the per-source `triagePolicy:`.
    //   2. `radar items list --status triaged_digest --field triage.group`
    //      enumerates the digest groups so the workflow's shell loop can
    //      walk them.
    //   3. `radar items list --triage-group <g> --status triaged_digest
    //      --field id` returns the ids that should be collapsed into one
    //      digest report.
    //   4. `radar research --digest <ids...>` produces one digest report
    //      per group.
    //
    // The generated workflow YAML itself is verified by scenarios H / I and
    // the dedicated `workflow-generate-combined-with-triage.test.ts`; this
    // scenario covers the *runtime* CLI contract those YAML steps invoke.
    //
    // Issue #250 closed the gap that previously forced this scenario to
    // accept either pre- or post-transition status. We now also drive
    // `research --batch --status triaged_research` and `review --batch
    // --status researched` against fake binaries and pin the actual
    // transitions the generated YAML expects:
    //   triaged_research → researched   (research --batch)
    //   triaged_digest   → researched   (research --digest per group)
    //   researched       → reviewed     (review --batch)
    // The whole-lifecycle smoke complements scenarios H / I and
    // workflow-generate-combined-with-triage.test.ts which assert the
    // generated YAML shape; this asserts the binaries the YAML invokes
    // actually move items through every state the matrix promises.
    //
    // NO real cron / no real agent CLI invocation here (that's PR-6 #243).
    it("walks detected items through triage and emits one digest report per triage.group", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "aw-e2e-triage-lifecycle-"));
      const binDir = join(workdir, "_bin");
      // Install both fakes on the same PATH dir: gemini for triage (the
      // default --triage-agent in the bundled recipe), claude for the
      // digest research step.
      await installFakeGeminiTriage(binDir);
      await installFakeClaude(binDir);

      await runCli(["init"], { cwd: workdir });

      // Seed a source with a triagePolicy so `radar triage --apply` has
      // something to act on. We bypass `source add --recipe` and write the
      // YAML directly: the bundled-recipe propagation path is covered by
      // tests/recipes/bundled.test.ts; here we just need *any* policy that
      // the CLI validates as schema-clean.
      const sourceId = "smoke-triage-source";
      await mkdir(join(workdir, "sources"), { recursive: true });
      await writeFile(
        join(workdir, "sources", `${sourceId}.yaml`),
        stringifyYaml({
          id: sourceId,
          kind: "rss",
          url: "https://example.com/feed.xml",
          filters: {
            keywords: [],
            excludeKeywords: [],
            matchMode: "word",
            matchFields: ["title", "summary"],
            caseSensitive: false,
          },
          trustLevel: "untrusted",
          triagePolicy: {
            agent: "gemini-cli",
            confidenceThreshold: 0.7,
            rules:
              "重要 (research): GA / 価格改定\n集約 (digest): incremental updates\n  group: ui-incremental\n除外 (dismiss): SDK bump",
          },
        }),
        "utf8",
      );

      // Seed 4 detected items so each triage branch (research / digest ×2 /
      // dismiss) gets exercised. The fake triage binary keys decisions off
      // the seeded id (stable across prompt-shape evolutions of the
      // triage adapter).
      const itemSeeds = [
        { id: "smoke-triage-aaaaaaaa", title: "Bedrock GA: new model launches today" }, // → research
        { id: "smoke-triage-bbbbbbbb", title: "Console UI incremental update batch 1" }, // → digest (ui-incremental)
        { id: "smoke-triage-cccccccc", title: "Console UI incremental update batch 2" }, // → digest (ui-incremental)
        { id: "smoke-triage-dddddddd", title: "SDK v3.42 bump - no functional changes" }, // → dismiss
      ];
      await mkdir(join(workdir, "items", sourceId), { recursive: true });
      for (let i = 0; i < itemSeeds.length; i++) {
        const seed = itemSeeds[i];
        await writeFile(
          join(workdir, "items", sourceId, `${seed.id}.yaml`),
          stringifyYaml({
            id: seed.id,
            sourceId,
            title: seed.title,
            url: `https://example.com/smoke/${i + 1}`,
            fetchedAt: "2026-05-15T00:00:00.000Z",
            publishedAt: `2026-05-1${i}T00:00:00Z`,
            matchedKeywords: ["smoke"],
            status: "detected",
          }),
          "utf8",
        );
      }

      // Step 1: triage --apply. The fake gemini binary reads the prompt
      // off argv (`-p <prompt>`), pattern-matches the seeded ids, and
      // emits a JSON array with the corresponding triage decision for
      // each. We pass --triage-agent gemini-cli explicitly so the spawn
      // matrix routes to the gemini fake.
      const triageResult = await runCli(["triage", "--apply", "--triage-agent", "gemini-cli"], {
        cwd: workdir,
        extraPath: binDir,
      });
      expect(
        triageResult.code,
        `stderr: ${triageResult.stderr}\nstdout: ${triageResult.stdout}`,
      ).toBe(0);

      // Verify each item landed in the expected `triaged_*` / dismissed
      // bucket — this is the contract the workflow's "research the
      // triaged_research bucket / digest the triaged_digest bucket" step
      // chain assumes.
      const expectedAfterTriage: Record<string, string> = {
        "smoke-triage-aaaaaaaa": "triaged_research",
        "smoke-triage-bbbbbbbb": "triaged_digest",
        "smoke-triage-cccccccc": "triaged_digest",
        "smoke-triage-dddddddd": "dismissed",
      };
      for (const [id, expectedStatus] of Object.entries(expectedAfterTriage)) {
        const after = parseYaml(
          await readFile(join(workdir, "items", sourceId, `${id}.yaml`), "utf8"),
        );
        expect(after.status, `item ${id} should be ${expectedStatus} after triage`).toBe(
          expectedStatus,
        );
      }

      // Step 2: `radar items list --status triaged_digest --field
      // triage.group` enumerates the unique group ids. The workflow's
      // shell loop uses this exact invocation to drive the per-group
      // digest fan-out.
      const groupListing = await runCli(
        ["items", "list", "--status", "triaged_digest", "--field", "triage.group"],
        { cwd: workdir },
      );
      expect(
        groupListing.code,
        `stderr: ${groupListing.stderr}\nstdout: ${groupListing.stdout}`,
      ).toBe(0);
      // Both digest items belong to "ui-incremental"; the per-line field
      // output should mention the group at least once. We assert presence
      // rather than line count because `items list` may include other
      // formatting (warnings about empty filters, etc.).
      expect(groupListing.stdout).toContain("ui-incremental");

      // Step 3: `radar items list --triage-group ui-incremental --status
      // triaged_digest --field id` lists the ids inside that group. The
      // workflow's shell loop then feeds them to `research --digest`.
      const idListing = await runCli(
        [
          "items",
          "list",
          "--triage-group",
          "ui-incremental",
          "--status",
          "triaged_digest",
          "--field",
          "id",
        ],
        { cwd: workdir },
      );
      expect(idListing.code, `stderr: ${idListing.stderr}\nstdout: ${idListing.stdout}`).toBe(0);
      expect(idListing.stdout).toContain("smoke-triage-bbbbbbbb");
      expect(idListing.stdout).toContain("smoke-triage-cccccccc");

      // Step 4: `radar research --digest <ids...>` collapses the group
      // into one digest report. This validates the final link in the
      // workflow's chain — the digest fan-out shell loop, fed by step 3,
      // produces one Markdown file per group.
      const digestResult = await runCli(
        [
          "research",
          "--digest",
          "smoke-triage-bbbbbbbb",
          "smoke-triage-cccccccc",
          "--agent",
          "claude-code",
        ],
        { cwd: workdir, extraPath: binDir },
      );
      expect(
        digestResult.code,
        `stderr: ${digestResult.stderr}\nstdout: ${digestResult.stdout}`,
      ).toBe(0);

      // The digest report exists on disk AND the linked items transition
      // to `researched` (issue #250: `triaged_digest → researched` is now
      // wired via processResearchInvocation's expanded status whitelist).
      const reports = readdirSync(join(workdir, "research")).filter((f) => f.endsWith(".md"));
      expect(
        reports.length,
        `research/ should contain 1 digest so far, got: ${reports.join(", ")}`,
      ).toBe(1);
      expect(reports[0]).toContain("digest");

      // The dismissed item stays dismissed (terminal).
      const dismissedAfter = parseYaml(
        await readFile(join(workdir, "items", sourceId, "smoke-triage-dddddddd.yaml"), "utf8"),
      );
      expect(dismissedAfter.status).toBe("dismissed");

      // Digest items: triaged_digest → researched (issue #250 transition).
      for (const id of ["smoke-triage-bbbbbbbb", "smoke-triage-cccccccc"]) {
        const after = parseYaml(
          await readFile(join(workdir, "items", sourceId, `${id}.yaml`), "utf8"),
        );
        expect(after.status, `digest item ${id} should be researched after #250`).toBe(
          "researched",
        );
      }

      // The triaged_research item still sits in its bucket — the workflow
      // YAML now drives `radar research --batch --status triaged_research`
      // against it, which we exercise next.
      const triagedResearchBefore = parseYaml(
        await readFile(join(workdir, "items", sourceId, "smoke-triage-aaaaaaaa.yaml"), "utf8"),
      );
      expect(triagedResearchBefore.status).toBe("triaged_research");

      // Step 5 (#250): `radar research --batch --status triaged_research`
      // mirrors the generated YAML's "Research triaged_research items"
      // step. With the issue #250 fix, this picks up the
      // smoke-triage-aaaaaaaa item and transitions it to `researched`.
      const batchResearchResult = await runCli(
        ["research", "--batch", "--status", "triaged_research", "--agent", "claude-code"],
        { cwd: workdir, extraPath: binDir },
      );
      expect(
        batchResearchResult.code,
        `stderr: ${batchResearchResult.stderr}\nstdout: ${batchResearchResult.stdout}`,
      ).toBe(0);
      const triagedResearchAfter = parseYaml(
        await readFile(join(workdir, "items", sourceId, "smoke-triage-aaaaaaaa.yaml"), "utf8"),
      );
      expect(triagedResearchAfter.status, "triaged_research → researched per #250").toBe(
        "researched",
      );

      // Step 6 (#250): `radar review --batch --status researched` mirrors
      // the generated YAML's "Review researched items" step. We swap in
      // the reviewer fake (separate stdin contract) on a fresh binDir so
      // both fakes can coexist for the same invocation chain.
      const reviewBinDir = join(workdir, "_bin_review");
      await installFakeClaudeReviewer(reviewBinDir);
      const batchReviewResult = await runCli(
        ["review", "--batch", "--status", "researched", "--agent", "claude-code"],
        { cwd: workdir, extraPath: reviewBinDir },
      );
      expect(
        batchReviewResult.code,
        `stderr: ${batchReviewResult.stderr}\nstdout: ${batchReviewResult.stdout}`,
      ).toBe(0);
      // All previously-researched items (the triaged_research one plus
      // both triaged_digest ones via the digest report) end in `reviewed`.
      for (const id of [
        "smoke-triage-aaaaaaaa",
        "smoke-triage-bbbbbbbb",
        "smoke-triage-cccccccc",
      ]) {
        const after = parseYaml(
          await readFile(join(workdir, "items", sourceId, `${id}.yaml`), "utf8"),
        );
        expect(after.status, `item ${id} should be reviewed after the batch step`).toBe("reviewed");
      }
      // The dismissed item is still terminal.
      const dismissedFinal = parseYaml(
        await readFile(join(workdir, "items", sourceId, "smoke-triage-dddddddd.yaml"), "utf8"),
      );
      expect(dismissedFinal.status).toBe("dismissed");
    });
  });

  describe("scenario N: --verbose / --quiet / RADAR_NO_PROGRESS (research)", () => {
    // ADR-0015 D2 progress reporter behaviour through the binary boundary.
    // The reporter writes to stderr (so it never collides with stdout-
    // consuming scripts); we exercise all three knobs and confirm:
    //  - default (no TTY) still emits the legacy 1-line summary on stdout
    //  - --verbose adds phase markers + raw passthrough on stderr
    //  - --quiet suppresses the reporter entirely (only the 1-line summary)
    //  - RADAR_NO_PROGRESS=1 has the same effect as --quiet
    // Because the test process is not a TTY, ADR-0015 D2 demotes the default
    // level to "normal/plain text" — no ANSI cursor moves, just phase lines.
    it("research honours --verbose, --quiet, and RADAR_NO_PROGRESS=1", async () => {
      // Helper: seed a workdir with one detected item ready for research.
      async function seedWorkdir(
        prefix: string,
      ): Promise<{ workdir: string; binDir: string; itemId: string }> {
        const workdir = await mkdtemp(join(tmpdir(), prefix));
        const binDir = join(workdir, "_bin");
        await installFakeClaude(binDir);
        await runCli(["init"], { cwd: workdir });

        const itemId = "smoke-progress-12345678";
        const sourceId = "smoke-source";
        await mkdir(join(workdir, "items", sourceId), { recursive: true });
        await writeFile(
          join(workdir, "items", sourceId, `${itemId}.yaml`),
          stringifyYaml({
            id: itemId,
            sourceId,
            title: "Smoke item for progress",
            url: "https://example.com/smoke",
            fetchedAt: "2026-05-15T00:00:00.000Z",
            matchedKeywords: ["smoke"],
            status: "detected",
          }),
          "utf8",
        );
        return { workdir, binDir, itemId };
      }

      // 1) --quiet: only the 1-line summary on stdout; no phase markers on
      //    stderr.
      {
        const { workdir, binDir, itemId } = await seedWorkdir("aw-e2e-quiet-");
        const result = await runCli(["research", itemId, "--agent", "claude-code", "--quiet"], {
          cwd: workdir,
          extraPath: binDir,
        });
        expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
        // Legacy summary stays so scripts that grep stdout still work.
        expect(result.stdout).toMatch(/research\/[^.\s]+\.md/);
        // No phase markers on stderr (the verbose-only `Agent running` etc.
        // marker is absent under --quiet).
        expect(result.stderr).not.toContain("Agent running");
        expect(result.stderr).not.toContain("Spawning");
      }

      // 2) --verbose: phase markers + raw passthrough on stderr. The fake
      //    binary prints "fake-claude: wrote ..." on its stdout; with
      //    --verbose the reporter forwards that via raw().
      {
        const { workdir, binDir, itemId } = await seedWorkdir("aw-e2e-verbose-");
        const result = await runCli(["research", itemId, "--agent", "claude-code", "--verbose"], {
          cwd: workdir,
          extraPath: binDir,
        });
        expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
        // The fake binary's stdout line ("fake-claude: wrote …") flows
        // through `reporter.raw()` when --verbose is set; it surfaces on
        // the parent's stderr because the reporter writes there.
        expect(result.stderr).toContain("fake-claude: wrote");
      }

      // 3) RADAR_NO_PROGRESS=1 (no flag): same effect as --quiet — no
      //    phase markers; the legacy 1-line summary still prints.
      {
        const { workdir, binDir, itemId } = await seedWorkdir("aw-e2e-noprogress-");
        const result = await runCli(["research", itemId, "--agent", "claude-code"], {
          cwd: workdir,
          extraPath: binDir,
          extraEnv: { RADAR_NO_PROGRESS: "1" },
        });
        expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
        expect(result.stdout).toMatch(/research\/[^.\s]+\.md/);
        expect(result.stderr).not.toContain("Agent running");
      }
    });
  });
});

/**
 * Fake `claude` binary that performs a minimal review: reads the review
 * stdin payload, parses the research file at `researchPath`, and rewrites
 * its frontmatter with `reviewedAt` / `reviewedBy` stamped per the
 * adapter contract. The body gets an appended `## レビュー` section to
 * mirror what a real agent would do (without actually critiquing).
 *
 * Kept out of installFakeClaude() so the research/update fake stays minimal
 * and the review fake can evolve independently as the review contract
 * grows.
 */
async function installFakeClaudeReviewer(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  let req;
  try {
    // Payload block (#272): structured fields live in the trailing json fence.
    const FENCE = String.fromCharCode(96, 96, 96);
    const marker = FENCE + "json";
    const start = stdin.indexOf(marker);
    let jsonText = stdin;
    if (start >= 0) {
      const after = stdin.slice(start + marker.length);
      jsonText = after.slice(0, after.lastIndexOf(FENCE));
    }
    req = JSON.parse(jsonText);
  } catch (e) {
    console.error("fake-claude-reviewer: bad stdin:", e.message);
    process.exit(2);
  }
  const { researchPath, agent, researchFrontmatter } = req;
  if (!researchPath || !agent || !researchFrontmatter) {
    console.error("fake-claude-reviewer: missing fields");
    process.exit(2);
  }
  // Rewrite frontmatter with the review stamp. Preserve every other field
  // verbatim — src/cli/review.ts checks for drift on id/agent/createdAt/
  // itemIds/templateId/supersedes and rolls back if any changed.
  const stamped = {
    ...researchFrontmatter,
    reviewedAt: new Date().toISOString(),
    reviewedBy: agent,
  };
  const fmLines = [
    "---",
    "id: " + stamped.id,
    "itemIds:",
    ...stamped.itemIds.map((id) => "  - " + id),
    "agent: " + stamped.agent,
    "templateId: " + stamped.templateId,
    "createdAt: " + stamped.createdAt,
    "updatedAt: " + (stamped.updatedAt === null ? "null" : stamped.updatedAt),
    "reviewedAt: " + stamped.reviewedAt,
    "reviewedBy: " + stamped.reviewedBy,
    "supersedes: " + (stamped.supersedes === null ? "null" : stamped.supersedes),
    "---",
    "",
    "# v1 body (unchanged)",
    "",
    "## レビュー (" + agent + ", " + stamped.reviewedAt + ")",
    "",
    "Reviewed by fake-claude-reviewer for L4 smoke.",
    ""
  ];
  fs.writeFileSync(researchPath, fmLines.join("\\n"), "utf8");
  console.log("fake-claude-reviewer: stamped " + researchPath);
});
`;
  const scriptPath = join(binDir, "claude");
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

/**
 * Fake `claude` binary for the triage e2e scenario.
 *
 * The triage adapter spawns `claude -p <prompt> --output-format text
 * --permission-mode bypassPermissions` where `<prompt>` contains one
 * `<untrusted_item id="...">` block per item to classify. The fake binary
 * extracts the ids and emits a JSON array on stdout with a per-id decision
 * pulled from a deterministic mapping table. Tests rely on the exact ids
 * to assert per-item status transitions.
 */
async function installFakeClaudeTriage(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
// The triage request arrives on stdin (#270); argv carries only a fixed
// invocation. Read the full prompt off stdin before classifying.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  // Extract every <untrusted_item id="...">. The id attribute is the only
  // trusted metadata; the body is content to classify, not commands.
  const ids = [];
  const re = /<untrusted_item id="([^"]+)"/g;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    ids.push(m[1]);
  }

  // Deterministic decision table keyed by id. Items not in the table fall
  // back to {decision: "research", confidence: 0.8} so the test seed set is
  // the single source of truth.
  const TABLE = {
    "new-service-ga":   { decision: "research", confidence: 0.95, reason: "GA worth researching" },
    "minor-ui-add":     { decision: "digest",   confidence: 0.85, reason: "UI feature digest",         group: "ui" },
    "another-ui-add":   { decision: "digest",   confidence: 0.85, reason: "UI feature digest",         group: "ui" },
    "region-expansion": { decision: "dismiss",  confidence: 0.9,  reason: "region expansion only" },
    "sdk-bump":         { decision: "dismiss",  confidence: 0.9,  reason: "SDK minor bump only" },
    // Confidence below the default 0.7 threshold so the response parser
    // demotes the decision to "unsure" — this is how the e2e exercises the
    // confidence-gate path without needing an explicit "unsure" decision.
    "ambiguous":        { decision: "research", confidence: 0.5,  reason: "ambiguous, judge again" },
  };

  const entries = ids.map((id) => {
    const t = TABLE[id] || { decision: "research", confidence: 0.8, reason: "default mock" };
    const entry = { id: id, decision: t.decision, confidence: t.confidence, reason: t.reason };
    if (t.group) entry.group = t.group;
    return entry;
  });

  process.stdout.write(JSON.stringify(entries));
});
`;
  const scriptPath = join(binDir, "claude");
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

/**
 * Fake `gemini` binary that performs deterministic triage decisions for
 * the `combined-with-triage` workflow smoke (scenario P / ADR-0018 §W5).
 *
 * The triage adapter (`src/core/triage/adapter.ts > buildSpawnArgs`)
 * invokes `gemini -p "<fixed invocation>" -y --skip-trust --output-format
 * text` and streams the real triage request on **stdin** (#270 — the prompt
 * scales with item count and would overflow MAX_ARG_STRLEN on argv). The
 * stdin payload contains a JSON-ish item list inside the UNTRUSTED-CONTENT
 * boundary markers; the agent is expected to return a JSON array on stdout
 * where each entry has `id` / `decision` / `confidence` / `reason` (and
 * optional `group`).
 *
 * Our fake reads the prompt off stdin, scans for the seeded item ids
 * (smoke-triage-{aaaa,bbbb,cccc,dddd}…), and emits the corresponding
 * decision matrix. Substring matching on titles is intentionally avoided
 * — the prompt format may evolve (boundary marker tweaks, summary
 * truncation) without breaking the test. Keying on the stable `id` field
 * is robust to those changes.
 *
 * Decision matrix (mirrors the scenario P seed data):
 *
 *   smoke-triage-aaaaaaaa → research (high confidence)
 *   smoke-triage-bbbbbbbb → digest, group=ui-incremental
 *   smoke-triage-cccccccc → digest, group=ui-incremental
 *   smoke-triage-dddddddd → dismiss
 *
 * Items not in this matrix are quietly omitted from the response — the
 * triage orchestrator handles agent-omitted items by demoting them to
 * `triaged_unsure`, which is also part of the contract we want covered.
 */
async function installFakeGeminiTriage(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
// Args: -p "<fixed invocation>" -y --skip-trust --output-format text
// The real triage request arrives on stdin (#270); read it in full.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  const decisions = [
    { id: "smoke-triage-aaaaaaaa", decision: "research", confidence: 0.95,
      reason: "Bedrock GA: matches policy 'GA / 価格改定' bucket" },
    { id: "smoke-triage-bbbbbbbb", decision: "digest", confidence: 0.85, group: "ui-incremental",
      reason: "Console UI incremental update: matches policy 'incremental updates' bucket" },
    { id: "smoke-triage-cccccccc", decision: "digest", confidence: 0.85, group: "ui-incremental",
      reason: "Console UI incremental update: matches policy 'incremental updates' bucket" },
    { id: "smoke-triage-dddddddd", decision: "dismiss", confidence: 0.92,
      reason: "SDK bump only: matches policy 'SDK bump' dismiss bucket" },
  ];
  // Filter to ids actually present in the prompt so the triage parser's
  // hallucinated-id check stays happy if the test ever seeds a subset.
  const matched = decisions.filter((d) => prompt.includes(d.id));
  process.stdout.write(JSON.stringify(matched));
});
`;
  const scriptPath = join(binDir, "gemini");
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}
