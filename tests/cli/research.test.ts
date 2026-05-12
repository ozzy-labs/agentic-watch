import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentAdapter, ResearchRequest } from "../../src/agents/index.js";
import { registerAgentAdapter } from "../../src/agents/index.js";
import { runResearch } from "../../src/cli/research.js";
import type { Item } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const SAMPLE_ITEM: Item = ItemSchema.parse({
  id: "anthropic-news-2026-05-10-claude-code",
  sourceId: "anthropic-news",
  title: "Claude Code: shiny new feature",
  url: "https://anthropic.com/news/claude-code-shiny",
  publishedAt: "2026-05-10T00:00:00.000Z",
  fetchedAt: "2026-05-10T01:00:00.000Z",
  summary: "New feature in Claude Code.",
  matchedKeywords: ["Claude Code"],
  status: "detected",
});

async function setupWorkspace(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "agentic-watch-research-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  await writeFile(
    join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
    stringifyYaml(SAMPLE_ITEM),
    "utf8",
  );
  return workdir;
}

/**
 * Build an adapter that writes a well-formed research file. Tests inject
 * custom variations (missing file, bad frontmatter, etc.) by overriding the
 * writer.
 */
function buildMockAdapter(writer: (req: ResearchRequest) => Promise<void>): {
  adapter: AgentAdapter;
  calls: ResearchRequest[];
} {
  const calls: ResearchRequest[] = [];
  const adapter: AgentAdapter = {
    id: "claude-code",
    research: async (req) => {
      calls.push(req);
      await writer(req);
    },
  };
  return { adapter, calls };
}

function validFrontmatter(req: ResearchRequest): Record<string, unknown> {
  return {
    id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
    itemIds: req.items.map((i) => i.id),
    agent: req.agent,
    templateId: req.templateId,
    createdAt: "2026-05-10T03:00:00.000Z",
    updatedAt: null,
    reviewedAt: null,
    reviewedBy: null,
  };
}

describe("cli/research", () => {
  let previousAdapter: AgentAdapter | undefined;

  afterEach(() => {
    // Restore whatever adapter existed before each test so tests stay isolated.
    if (previousAdapter) {
      registerAgentAdapter(previousAdapter);
    }
  });

  beforeEach(() => {
    previousAdapter = undefined;
  });

  it("runs end-to-end: invokes adapter, validates output, transitions status to researched", async () => {
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      const fm = validFrontmatter(req);
      const body = matter.stringify("# Claude Code: shiny new feature\n\n本文。\n", fm);
      await writeFile(req.outputPath, body, "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "--agent", "claude-code"], {
      cwd: workdir,
      io,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("claude-code");
    expect(calls[0].templateId).toBe("default");
    expect(calls[0].items[0].id).toBe(SAMPLE_ITEM.id);
    expect(calls[0].outputPath).toMatch(/research\/20260510_anthropic-news-.*_v1\.md$/);

    // The research file exists with the expected frontmatter.
    const researchPath = calls[0].outputPath;
    expect(await pathExists(researchPath)).toBe(true);
    const body = await readFile(researchPath, "utf8");
    const parsed = matter(body);
    expect(parsed.data.reviewedAt).toBeNull();
    expect(parsed.data.reviewedBy).toBeNull();
    expect(parsed.data.agent).toBe("claude-code");
    expect(parsed.data.itemIds).toEqual([SAMPLE_ITEM.id]);

    // Item status is transitioned to `researched`.
    const itemRaw = await readFile(
      join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
      "utf8",
    );
    const item = parseYaml(itemRaw);
    expect(item.status).toBe("researched");

    expect(captured.log.some((m) => m.includes("invoking claude-code adapter"))).toBe(true);
    expect(captured.log.some((m) => m.includes("status -> researched"))).toBe(true);
  });

  it("defaults --agent to claude-code", async () => {
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("claude-code");
  });

  it("loads templates/<id>.md and passes templateBody to the adapter", async () => {
    const workdir = await setupWorkspace();
    await writeFile(join(workdir, "templates", "default.md"), "# Default template\n", "utf8");
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].templateBody).toBe("# Default template\n");
  });

  it("falls back to empty template body when templates/default.md is missing", async () => {
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].templateBody).toBe("");
  });

  it("errors when a non-default template is missing", async () => {
    const workdir = await setupWorkspace();
    const { adapter } = buildMockAdapter(async () => undefined);
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "--template", "deep-dive"], {
      cwd: workdir,
      io,
    });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("template not found"))).toBe(true);
  });

  it("ensures reviewedAt and reviewedBy are null in the persisted frontmatter", async () => {
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(0);
    const body = await readFile(calls[0].outputPath, "utf8");
    // Frontmatter assertion plus a literal text check so we know `null` is
    // serialized (not omitted or stringified as "null" later by a stringifier).
    const fm = matter(body).data;
    expect(fm.reviewedAt).toBeNull();
    expect(fm.reviewedBy).toBeNull();
    expect(body).toMatch(/reviewedAt:\s*null/);
    expect(body).toMatch(/reviewedBy:\s*null/);
  });

  it("resets reviewedAt/reviewedBy when an agent populates them ahead of time", async () => {
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      // Simulate a misbehaving agent that stamps the review fields itself.
      const fm = {
        ...validFrontmatter(req),
        reviewedAt: "2026-05-11T00:00:00.000Z",
        reviewedBy: "codex-cli",
      };
      await writeFile(req.outputPath, matter.stringify("body", fm), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(0);
    const body = await readFile(calls[0].outputPath, "utf8");
    const fm = matter(body).data;
    expect(fm.reviewedAt).toBeNull();
    expect(fm.reviewedBy).toBeNull();
    expect(captured.warn.some((m) => m.includes("Phase 1 contract"))).toBe(true);
  });

  it("rejects frontmatter that violates ResearchFrontmatterSchema", async () => {
    const workdir = await setupWorkspace();
    const { adapter } = buildMockAdapter(async (req) => {
      // Missing `itemIds`, wrong `agent` value.
      const bad = {
        id: "x",
        agent: "not-an-agent",
        templateId: "default",
        createdAt: "2026-05-10T03:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      };
      await writeFile(req.outputPath, matter.stringify("body", bad), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(
      captured.error.some((m) =>
        m.includes("frontmatter does not match ResearchFrontmatterSchema"),
      ),
    ).toBe(true);
  });

  it("errors when the adapter does not write the output file", async () => {
    const workdir = await setupWorkspace();
    const { adapter } = buildMockAdapter(async () => undefined);
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("did not write"))).toBe(true);
  });

  it("refuses to overwrite an existing research file", async () => {
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    // First run: success.
    expect(await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io: captureIo().io })).toBe(0);
    // The item is now `researched`; we need to also reset the status before re-running.
    const itemPath = join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`);
    await writeFile(itemPath, stringifyYaml({ ...SAMPLE_ITEM, status: "detected" }), "utf8");

    // Second run on the same item -> output exists -> refuse.
    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("already exists"))).toBe(true);
    // Adapter must NOT be invoked for the second run.
    expect(calls).toHaveLength(1);
  });

  it("errors when the item id does not exist", async () => {
    const workdir = await setupWorkspace();
    const { adapter } = buildMockAdapter(async () => undefined);
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch(["ghost"], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not found"))).toBe(true);
  });

  it("rejects unsupported agents (gemini-cli is still a stub)", async () => {
    const workdir = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "--agent", "gemini-cli"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("not supported yet"))).toBe(true);
  });

  it("rejects an invalid --agent value", async () => {
    const workdir = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "--agent", "wat"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid --agent"))).toBe(true);
  });

  it("errors when <item-id> is missing", async () => {
    const workdir = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runResearch([], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("missing <item-id>"))).toBe(true);
  });

  it("surfaces adapter errors with a non-zero exit code", async () => {
    const workdir = await setupWorkspace();
    const { adapter } = buildMockAdapter(async () => {
      throw new Error("simulated agent crash");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("simulated agent crash"))).toBe(true);
  });

  it("uses radar.config.yaml defaultResearchAgent when --agent is omitted", async () => {
    // The config sets a still-stubbed agent (gemini-cli). The CLI should refuse
    // with the not-supported message — proving the config value WAS picked up
    // (vs. falling back to the hardcoded claude-code default).
    const workdir = await setupWorkspace();
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultResearchAgent: gemini-cli\n",
      "utf8",
    );
    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(
      captured.error.some((m) => m.includes("gemini-cli") && m.includes("not supported yet")),
    ).toBe(true);
  });

  it("prefers explicit --agent over radar.config.yaml default", async () => {
    const workdir = await setupWorkspace();
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultResearchAgent: gemini-cli\n",
      "utf8",
    );
    const { adapter, calls } = buildMockAdapter(async (req) => {
      const fm = {
        id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
        itemIds: req.items.map((i) => i.id),
        agent: req.agent,
        templateId: req.templateId,
        createdAt: "2026-05-10T03:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      };
      await writeFile(req.outputPath, matter.stringify("body", fm), "utf8");
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "--agent", "claude-code"], {
      cwd: workdir,
      io,
    });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("claude-code");
  });

  it("exits with code 2 when radar.config.yaml is malformed", async () => {
    const workdir = await setupWorkspace();
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultResearchAgent: not-an-agent\n",
      "utf8",
    );
    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("radar.config.yaml"))).toBe(true);
  });
});
