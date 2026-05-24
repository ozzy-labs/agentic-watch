import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-research-"));
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

  it("accepts gemini-cli as a valid agent (adapter is now implemented)", async () => {
    // Phase 2 sub-issue D wires the gemini-cli adapter. The CLI gating used to
    // reject this with a "not supported" message; now the request reaches the
    // adapter, which (with the mock writer) succeeds end-to-end.
    const workdir = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    // The mock is registered under "claude-code"; rewrite the id so the same
    // factory serves gemini-cli for this test.
    const geminiAdapter: AgentAdapter = { ...adapter, id: "gemini-cli" };
    previousAdapter = registerAgentAdapter(geminiAdapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "--agent", "gemini-cli"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("gemini-cli");
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
    // The config sets a non-default agent (gemini-cli). Register a mock
    // adapter for gemini-cli and verify it (not claude-code) was invoked,
    // proving the config value was picked up vs. falling back to the hardcoded
    // claude-code default.
    const workdir = await setupWorkspace();
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultResearchAgent: gemini-cli\n",
      "utf8",
    );
    const { adapter, calls } = buildMockAdapter(async (req) => {
      await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
    });
    const geminiAdapter: AgentAdapter = { ...adapter, id: "gemini-cli" };
    previousAdapter = registerAgentAdapter(geminiAdapter);

    const { io } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("gemini-cli");
  });

  // #316 / ADR-0021: the CLI resolves the report-output locale and hands it to
  // the adapter (`--lang` flag > RADAR_LANG env > config.locale > en).
  describe("report output locale resolution (#316)", () => {
    it("defaults the adapter locale to 'en' when no source supplies one", async () => {
      const workdir = await setupWorkspace();
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls[0].locale).toBe("en");
    });

    it("passes locale='ja' to the adapter when --lang ja is given", async () => {
      const workdir = await setupWorkspace();
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id, "--lang", "ja"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls[0].locale).toBe("ja");
    });

    it("falls back to config.locale when --lang / RADAR_LANG are absent", async () => {
      const workdir = await setupWorkspace();
      await writeFile(join(workdir, "radar.config.yaml"), "locale: ja\n", "utf8");
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls[0].locale).toBe("ja");
    });

    it("lets --lang override config.locale (flag wins)", async () => {
      const workdir = await setupWorkspace();
      await writeFile(join(workdir, "radar.config.yaml"), "locale: ja\n", "utf8");
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(req.outputPath, matter.stringify("body", validFrontmatter(req)), "utf8");
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id, "--lang", "en"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls[0].locale).toBe("en");
    });
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

  it("rejects multiple <item-id> arguments without --digest", async () => {
    // Without --digest, the CLI accepts exactly one positional id. Two ids
    // without the flag is an arg-shape mistake (exit 2) rather than a
    // workspace error (exit 1) — distinguishes "you typed the wrong thing"
    // from "the item doesn't exist".
    const workdir = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runResearch([SAMPLE_ITEM.id, "another-item-id"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("require --digest"))).toBe(true);
  });

  describe("digest mode (--digest)", () => {
    const SECOND_ITEM: Item = ItemSchema.parse({
      id: "anthropic-news-2026-05-12-claude-code-skills",
      sourceId: "anthropic-news",
      title: "Claude Code skills: ship and iterate",
      url: "https://anthropic.com/news/claude-code-skills",
      publishedAt: "2026-05-12T00:00:00.000Z",
      fetchedAt: "2026-05-12T01:00:00.000Z",
      summary: "Claude Code skills, anthropic deep dive.",
      matchedKeywords: ["Claude Code", "Anthropic"],
      status: "detected",
    });

    async function setupDigestWorkspace(): Promise<string> {
      // setupWorkspace seeds SAMPLE_ITEM under anthropic-news/. Add a second
      // item with overlapping `matchedKeywords` so digest slug derivation has
      // something deterministic to rank.
      const workdir = await setupWorkspace();
      await writeFile(
        join(workdir, "items", SECOND_ITEM.sourceId, `${SECOND_ITEM.id}.yaml`),
        stringifyYaml(SECOND_ITEM),
        "utf8",
      );
      return workdir;
    }

    function validDigestFrontmatter(req: ResearchRequest): Record<string, unknown> {
      // Mirror the validDigestFrontmatter shape but compute a digest-style id
      // so a misconfigured filename in the CLI surfaces as a frontmatter
      // mismatch, not a silent pass.
      return {
        id: "20260518_digest_claude-code-anthropic_v1",
        itemIds: req.items.map((i) => i.id),
        agent: req.agent,
        templateId: req.templateId,
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      };
    }

    it("generates a single digest file from multiple item ids", async () => {
      const workdir = await setupDigestWorkspace();
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("# digest body\n", validDigestFrontmatter(req)),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--digest", SAMPLE_ITEM.id, SECOND_ITEM.id], {
        cwd: workdir,
        io,
      });

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      // Adapter received both items in one call.
      expect(calls[0].items.map((i) => i.id)).toEqual([SAMPLE_ITEM.id, SECOND_ITEM.id]);
      // Filename follows the ADR-0011 pattern:
      // <YYYYMMDD>_digest_<slug>_v1.md
      expect(calls[0].outputPath).toMatch(/research\/\d{8}_digest_[a-z0-9-]+_v1\.md$/);
      // Top matchedKeyword across both items is "claude code" → "claude-code"
      // (SAMPLE contributes 1 hit, SECOND contributes 1 hit = 2 total; "anthropic"
      // contributes 1 hit). Top-2 → "claude-code-anthropic" per ADR-0011 §2.
      expect(calls[0].outputPath).toContain("_digest_claude-code");
      // Template default for digest mode is "digest" (ADR-0011 §6).
      expect(calls[0].templateId).toBe("digest");
      // The generated file exists and lists both ids in itemIds frontmatter.
      const body = await readFile(calls[0].outputPath, "utf8");
      const fm = matter(body).data;
      expect(fm.itemIds).toEqual([SAMPLE_ITEM.id, SECOND_ITEM.id]);
      expect(fm.templateId).toBe("digest");

      // Both items transition to `researched`.
      for (const item of [SAMPLE_ITEM, SECOND_ITEM]) {
        const itemRaw = await readFile(
          join(workdir, "items", item.sourceId, `${item.id}.yaml`),
          "utf8",
        );
        expect(parseYaml(itemRaw).status).toBe("researched");
      }

      // The log line cites both items (helps users grep `research:` lines).
      expect(captured.log.some((m) => m.includes("status -> researched"))).toBe(true);
    });

    it("exits 2 when --digest receives only one item id", async () => {
      const workdir = await setupDigestWorkspace();
      const { adapter, calls } = buildMockAdapter(async () => undefined);
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--digest", SAMPLE_ITEM.id], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--digest requires 2 or more"))).toBe(true);
      // Adapter must not be invoked when validation fails up-front.
      expect(calls).toHaveLength(0);
    });

    it("honors an explicit --template override in digest mode", async () => {
      const workdir = await setupDigestWorkspace();
      // Provision a custom template under the workspace.
      await writeFile(
        join(workdir, "templates", "digest-detailed.md"),
        "# Detailed digest body\n",
        "utf8",
      );
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", validDigestFrontmatter(req)),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch(
        ["--digest", "--template", "digest-detailed", SAMPLE_ITEM.id, SECOND_ITEM.id],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      expect(calls[0].templateId).toBe("digest-detailed");
      expect(calls[0].templateBody).toBe("# Detailed digest body\n");
    });

    it("falls back to 'digest' slug when no matchedKeywords are present", async () => {
      // Both items have empty matchedKeywords → slug should be literal
      // "digest" per ADR-0011 §2 fallback.
      const workdir = await mkdtemp(join(tmpdir(), "feedradar-research-digest-"));
      await mkdir(join(workdir, "items", "src-a"), { recursive: true });
      await mkdir(join(workdir, "research"), { recursive: true });
      await mkdir(join(workdir, "templates"), { recursive: true });
      const itemA = ItemSchema.parse({
        id: "src-a-item-1",
        sourceId: "src-a",
        title: "Item A",
        url: "https://example.com/a",
        fetchedAt: "2026-05-18T00:00:00.000Z",
        matchedKeywords: [],
        status: "detected",
      });
      const itemB = ItemSchema.parse({
        id: "src-a-item-2",
        sourceId: "src-a",
        title: "Item B",
        url: "https://example.com/b",
        fetchedAt: "2026-05-18T00:00:00.000Z",
        matchedKeywords: [],
        status: "detected",
      });
      for (const item of [itemA, itemB]) {
        await writeFile(
          join(workdir, "items", item.sourceId, `${item.id}.yaml`),
          stringifyYaml(item),
          "utf8",
        );
      }
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: "20260518_digest_digest_v1",
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch(["--digest", itemA.id, itemB.id], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls[0].outputPath).toMatch(/research\/\d{8}_digest_digest_v1\.md$/);
    });

    it("rejects digest including a dismissed item", async () => {
      const workdir = await setupDigestWorkspace();
      // Flip SECOND_ITEM to dismissed.
      await writeFile(
        join(workdir, "items", SECOND_ITEM.sourceId, `${SECOND_ITEM.id}.yaml`),
        stringifyYaml({ ...SECOND_ITEM, status: "dismissed" }),
        "utf8",
      );
      const { adapter, calls } = buildMockAdapter(async () => undefined);
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--digest", SAMPLE_ITEM.id, SECOND_ITEM.id], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("dismissed"))).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it("does not regress an already-researched item's status when included in a digest", async () => {
      // ADR-0011 §5: terminal states (researched / reviewed) are protected
      // from being re-set by a digest run.
      const workdir = await setupDigestWorkspace();
      await writeFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        stringifyYaml({ ...SAMPLE_ITEM, status: "reviewed" }),
        "utf8",
      );
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", validDigestFrontmatter(req)),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch(["--digest", SAMPLE_ITEM.id, SECOND_ITEM.id], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);

      // SAMPLE_ITEM stays `reviewed` (terminal protected); SECOND_ITEM moves
      // from detected → researched.
      const sampleRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(sampleRaw).status).toBe("reviewed");
      const secondRaw = await readFile(
        join(workdir, "items", SECOND_ITEM.sourceId, `${SECOND_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(secondRaw).status).toBe("researched");
    });

    it("errors when one of the digest item ids does not exist", async () => {
      const workdir = await setupDigestWorkspace();
      const { adapter, calls } = buildMockAdapter(async () => undefined);
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--digest", SAMPLE_ITEM.id, "ghost-item"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("ghost-item"))).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  describe("digest slug from triage.group (#255 / ADR-0018 §W-H)", () => {
    /**
     * Reproduce the #255 bug surface: a single-keyword source whose items all
     * carry the same `matchedKeywords`, split across 2 triage groups on the
     * same day. The pre-fix `deriveDigestSlug` ranked only `matchedKeywords`,
     * so both groups resolved to the same `<date>_digest_amazon-quick_v1.md`
     * and the second `radar research --digest` call exited 1 on the
     * already-exists guard.
     */
    function singleKeywordItem(id: string, group: string): Item {
      return ItemSchema.parse({
        id,
        sourceId: "amazon-quick",
        title: `Amazon Quick item ${id}`,
        url: `https://example.com/${id}`,
        publishedAt: "2026-05-23T00:00:00.000Z",
        fetchedAt: "2026-05-23T01:00:00.000Z",
        summary: "Amazon Quick update.",
        matchedKeywords: ["Amazon Quick"],
        status: "triaged_digest",
        triage: {
          decision: "digest",
          confidence: 0.9,
          reason: "grouped",
          group,
          agent: "gemini-2.5-flash-lite",
          triagedAt: "2026-05-23T00:30:00.000Z",
        },
      });
    }

    async function setupSingleKeywordWorkspace(): Promise<{ workdir: string; items: Item[] }> {
      const workdir = await mkdtemp(join(tmpdir(), "feedradar-research-group-"));
      await mkdir(join(workdir, "items", "amazon-quick"), { recursive: true });
      await mkdir(join(workdir, "research"), { recursive: true });
      await mkdir(join(workdir, "templates"), { recursive: true });
      const items = [
        singleKeywordItem("amazon-quick-a", "billing-changes"),
        singleKeywordItem("amazon-quick-b", "billing-changes"),
        singleKeywordItem("amazon-quick-c", "ui-refresh"),
        singleKeywordItem("amazon-quick-d", "ui-refresh"),
      ];
      for (const item of items) {
        await writeFile(
          join(workdir, "items", item.sourceId, `${item.id}.yaml`),
          stringifyYaml(item),
          "utf8",
        );
      }
      return { workdir, items };
    }

    function digestFrontmatter(req: ResearchRequest): Record<string, unknown> {
      return {
        id: "20260523_digest_group_v1",
        itemIds: req.items.map((i) => i.id),
        agent: req.agent,
        templateId: req.templateId,
        createdAt: "2026-05-23T02:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      };
    }

    it("does not collide when a single-keyword source emits 2 same-day groups (core #255)", async () => {
      const { workdir } = await setupSingleKeywordWorkspace();
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("# digest\n", digestFrontmatter(req)),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      // Group 1 (billing-changes).
      const { io: io1, captured: cap1 } = captureIo();
      const code1 = await runResearch(
        ["--digest", "amazon-quick-a", "amazon-quick-b", "--triage-group", "billing-changes"],
        { cwd: workdir, io: io1 },
      );
      expect(code1, `stderr: ${cap1.error.join("\n")}`).toBe(0);

      // Group 2 (ui-refresh) on the SAME day. Pre-fix this exited 1 on the
      // already-exists guard because both groups derived the same slug.
      const { io: io2, captured: cap2 } = captureIo();
      const code2 = await runResearch(
        ["--digest", "amazon-quick-c", "amazon-quick-d", "--triage-group", "ui-refresh"],
        { cwd: workdir, io: io2 },
      );
      expect(code2, `stderr: ${cap2.error.join("\n")}`).toBe(0);

      // Two distinct digest files landed — no collision.
      const filenames = calls.map((c) => c.outputPath);
      expect(filenames).toHaveLength(2);
      expect(filenames[0]).toContain("_digest_billing-changes_v1.md");
      expect(filenames[1]).toContain("_digest_ui-refresh_v1.md");
      expect(new Set(filenames).size).toBe(2);
    });

    it("derives the slug from triage.group when --triage-group is omitted (uniform group)", async () => {
      const { workdir } = await setupSingleKeywordWorkspace();
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("# digest\n", digestFrontmatter(req)),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      // Both items share triage.group "billing-changes"; no explicit flag.
      const code = await runResearch(["--digest", "amazon-quick-a", "amazon-quick-b"], {
        cwd: workdir,
        io,
      });
      expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
      expect(calls[0].outputPath).toContain("_digest_billing-changes_v1.md");
    });

    it("explicit --triage-group wins over a divergent matchedKeywords slug", async () => {
      const { workdir } = await setupSingleKeywordWorkspace();
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("# digest\n", digestFrontmatter(req)),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(
        ["--digest", "amazon-quick-a", "amazon-quick-b", "--triage-group", "Q3 Roadmap!"],
        { cwd: workdir, io },
      );
      expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
      // Free-form group is kebab-cased into the slug.
      expect(calls[0].outputPath).toContain("_digest_q3-roadmap_v1.md");
    });

    it("rejects --triage-group without --digest (exit 2)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id, "--triage-group", "foo"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--triage-group requires --digest"))).toBe(true);
    });

    it("rejects --triage-group with --batch (exit 2)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--triage-group", "foo"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(
        captured.error.some((m) => m.includes("--batch is incompatible with --triage-group")),
      ).toBe(true);
    });
  });

  describe("batch mode (--batch, #189 / ADR-0014)", () => {
    /**
     * Seed a workspace with `n` `detected` items so batch mode has something to
     * walk. Item ids embed an ordinal so the test can assert sort order
     * deterministically. `matchedKeywords` carries one shared tag plus an
     * ordinal tag so we can exercise `--filter-tags` allow-list behavior.
     */
    async function setupBatchWorkspace(n: number): Promise<{ workdir: string; items: Item[] }> {
      const workdir = await mkdtemp(join(tmpdir(), "feedradar-research-batch-"));
      await mkdir(join(workdir, "items", "src-a"), { recursive: true });
      await mkdir(join(workdir, "research"), { recursive: true });
      await mkdir(join(workdir, "templates"), { recursive: true });
      const items: Item[] = [];
      for (let i = 0; i < n; i++) {
        // publishedAt strictly ascending so the deterministic batch order
        // is "lowest publishedAt first".
        const published = new Date(Date.UTC(2026, 4, 10 + i)).toISOString();
        const item = ItemSchema.parse({
          id: `src-a-item-${String(i).padStart(2, "0")}`,
          sourceId: "src-a",
          title: `Item ${i}`,
          url: `https://example.com/${i}`,
          publishedAt: published,
          fetchedAt: published,
          matchedKeywords: ["claude-code", `tag-${i}`],
          status: "detected",
        });
        await writeFile(
          join(workdir, "items", item.sourceId, `${item.id}.yaml`),
          stringifyYaml(item),
          "utf8",
        );
        items.push(item);
      }
      return { workdir, items };
    }

    it("walks detected items, respects --max-items cap, and emits a per-item report", async () => {
      const { workdir, items } = await setupBatchWorkspace(5);
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("# batch body\n", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--max-items", "3"], { cwd: workdir, io });

      expect(code).toBe(0);
      // Hard cap: only 3 invocations even though 5 items match.
      expect(calls).toHaveLength(3);
      // Each invocation receives a single item (batch is not a digest).
      for (const c of calls) {
        expect(c.items).toHaveLength(1);
      }
      // Deterministic order: ascending by publishedAt → items[0..2].
      expect(calls.map((c) => c.items[0].id)).toEqual([items[0].id, items[1].id, items[2].id]);
      // CLI-layer cap warning surfaces the dropped item count.
      expect(
        captured.warn.some(
          (m) => m.includes("--max-items 3 cap reached") && m.includes("dropping 2"),
        ),
      ).toBe(true);
      // Processed items transitioned to researched; excess items remain detected.
      for (let i = 0; i < 3; i++) {
        const raw = await readFile(
          join(workdir, "items", items[i].sourceId, `${items[i].id}.yaml`),
          "utf8",
        );
        expect(parseYaml(raw).status).toBe("researched");
      }
      for (let i = 3; i < 5; i++) {
        const raw = await readFile(
          join(workdir, "items", items[i].sourceId, `${items[i].id}.yaml`),
          "utf8",
        );
        expect(parseYaml(raw).status).toBe("detected");
      }
    });

    it("defaults --max-items to RESEARCH_BATCH_DEFAULT_MAX_ITEMS when omitted", async () => {
      const { workdir } = await setupBatchWorkspace(15);
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--batch"], { cwd: workdir, io });

      expect(code).toBe(0);
      // Default cap = 10 (ADR-0014 D3a).
      expect(calls).toHaveLength(10);
      expect(captured.warn.some((m) => m.includes("--max-items 10 cap reached"))).toBe(true);
    });

    it("applies --filter-tags as a lower-cased allow-list against matchedKeywords", async () => {
      const { workdir, items } = await setupBatchWorkspace(4);
      // Override item 2 so it lacks the shared 'claude-code' tag — only
      // items[0] / items[1] / items[3] should match `--filter-tags claude-code`.
      const isolated = { ...items[2], matchedKeywords: ["other-topic"] };
      await writeFile(
        join(workdir, "items", isolated.sourceId, `${isolated.id}.yaml`),
        stringifyYaml(isolated),
        "utf8",
      );
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      // Uppercase intentionally so the test asserts the case-insensitive
      // comparison (parseFilterTags lower-cases the literal).
      const code = await runResearch(["--batch", "--filter-tags", "Claude-Code"], {
        cwd: workdir,
        io,
      });

      expect(code).toBe(0);
      expect(calls.map((c) => c.items[0].id)).toEqual([items[0].id, items[1].id, items[3].id]);
    });

    it("emits a no-match log when zero detected items satisfy the filter", async () => {
      const { workdir } = await setupBatchWorkspace(3);
      const { adapter, calls } = buildMockAdapter(async () => undefined);
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--filter-tags", "nonexistent-tag"], {
        cwd: workdir,
        io,
      });

      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(
        captured.log.some(
          (m) => m.includes("no items matched --batch filters") && m.includes("nonexistent-tag"),
        ),
      ).toBe(true);
    });

    it("rejects --batch combined with positional ids", async () => {
      const { workdir } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "src-a-item-00"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("incompatible with positional"))).toBe(true);
    });

    it("rejects --batch combined with --digest", async () => {
      const { workdir } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--digest"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("incompatible with --digest"))).toBe(true);
    });

    it("rejects an invalid --status value", async () => {
      const { workdir } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--status", "detcted"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("invalid --status"))).toBe(true);
    });

    it("rejects non-positive --max-items", async () => {
      const { workdir } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--max-items", "0"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("invalid --max-items"))).toBe(true);
    });

    it("rejects --status outside of --batch (no silent ignore)", async () => {
      const { workdir, items } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runResearch([items[0].id, "--status", "detected"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--status requires --batch"))).toBe(true);
    });

    it("rejects --max-items outside of --batch", async () => {
      const { workdir, items } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runResearch([items[0].id, "--max-items", "5"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--max-items requires --batch"))).toBe(true);
    });

    it("walks triaged_research items (#250) and transitions them to researched", async () => {
      // PR #249 generates workflow YAML that runs:
      //   radar research --batch --status triaged_research --max-items N
      // against items that the triage adapter promoted (ADR-0018 §W-B).
      // Issue #250 closed the gap where this surface was schema-rejected
      // (or silently filtered to zero) before. This test pins the contract:
      // input `triaged_research` → output `researched`.
      const { workdir, items } = await setupBatchWorkspace(3);
      // Promote each seeded item from detected → triaged_research before
      // the CLI runs so we exercise the same on-disk state the triage step
      // would leave behind.
      for (const item of items) {
        const promoted = { ...item, status: "triaged_research" as const };
        await writeFile(
          join(workdir, "items", promoted.sourceId, `${promoted.id}.yaml`),
          stringifyYaml(promoted),
          "utf8",
        );
      }
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--batch", "--status", "triaged_research"], {
        cwd: workdir,
        io,
      });

      expect(code).toBe(0);
      expect(calls).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const raw = await readFile(
          join(workdir, "items", items[i].sourceId, `${items[i].id}.yaml`),
          "utf8",
        );
        // ADR-0008 / ADR-0018: triaged_research → researched.
        expect(parseYaml(raw).status).toBe("researched");
      }
      // The progress phase marker reflects the actual source status so the
      // user sees "triaged_research → researched" (not the legacy
      // "detected → researched"). The log path mirrors the marker.
      expect(captured.log.some((m) => m.includes("status -> researched"))).toBe(true);
    });

    it("backward-compat: --status detected still transitions detected → researched", async () => {
      // Guard rail for #250: the existing `detected` path must keep working
      // unchanged after we expanded the allow-list to also accept
      // `triaged_research`. Mirrors the first batch test but explicitly
      // sets `--status detected` to assert it is not just a fluke of the
      // default.
      const { workdir, items } = await setupBatchWorkspace(2);
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch(["--batch", "--status", "detected"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls).toHaveLength(2);
      for (let i = 0; i < 2; i++) {
        const raw = await readFile(
          join(workdir, "items", items[i].sourceId, `${items[i].id}.yaml`),
          "utf8",
        );
        expect(parseYaml(raw).status).toBe("researched");
      }
    });

    it("--batch --status triaged_research only matches triaged_research items (no cross-status bleed)", async () => {
      // Seed a mix: items 0..1 stay `detected`, items 2..3 become
      // `triaged_research`. `--status triaged_research` must only pick up
      // the latter so the workflow's per-status dispatch (triaged_research
      // step vs. triaged_digest step) does not double-process anything.
      const { workdir, items } = await setupBatchWorkspace(4);
      for (let i = 2; i < 4; i++) {
        const promoted = { ...items[i], status: "triaged_research" as const };
        await writeFile(
          join(workdir, "items", promoted.sourceId, `${promoted.id}.yaml`),
          stringifyYaml(promoted),
          "utf8",
        );
      }
      const { adapter, calls } = buildMockAdapter(async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runResearch(["--batch", "--status", "triaged_research"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      // Only items[2] and items[3] were eligible.
      expect(calls.map((c) => c.items[0].id)).toEqual([items[2].id, items[3].id]);
      // items[0..1] still detected (untouched).
      for (let i = 0; i < 2; i++) {
        const raw = await readFile(
          join(workdir, "items", items[i].sourceId, `${items[i].id}.yaml`),
          "utf8",
        );
        expect(parseYaml(raw).status).toBe("detected");
      }
    });

    it("rejects --status values outside the documented allow-list (#250)", async () => {
      // `researched` / `reviewed` / `dismissed` / `triaged_digest` /
      // `triaged_unsure` are valid `ItemStatus` enum values but not valid
      // *input* states for research. Per ADR-0018 only `detected` and
      // `triaged_research` produce a `researched` transition; the rest must
      // be rejected with an explicit error so a typo in scheduled YAML
      // fails loud instead of silently no-op-ing.
      const { workdir } = await setupBatchWorkspace(1);
      for (const bogus of [
        "researched",
        "reviewed",
        "dismissed",
        "triaged_digest",
        "triaged_unsure",
      ]) {
        const { io, captured } = captureIo();
        const code = await runResearch(["--batch", "--status", bogus], { cwd: workdir, io });
        expect(code, `--status ${bogus} should be rejected`).toBe(2);
        expect(
          captured.error.some((m) => m.includes("invalid --status") && m.includes(bogus)),
          `error should name '${bogus}'`,
        ).toBe(true);
      }
    });

    it("halts the batch when an inner item invocation fails", async () => {
      const { workdir, items } = await setupBatchWorkspace(3);
      const { adapter, calls } = buildMockAdapter(async (req) => {
        if (req.items[0].id === items[1].id) {
          throw new Error("simulated adapter crash on item 2");
        }
        await writeFile(
          req.outputPath,
          matter.stringify("body", {
            id: `20260510_${req.items[0].id}_v1`,
            itemIds: req.items.map((i) => i.id),
            agent: req.agent,
            templateId: req.templateId,
            createdAt: "2026-05-10T03:00:00.000Z",
            updatedAt: null,
            reviewedAt: null,
            reviewedBy: null,
          }),
          "utf8",
        );
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch(["--batch"], { cwd: workdir, io });

      expect(code).toBe(1);
      // First item succeeded; second crashed → third is never invoked.
      expect(calls.map((c) => c.items[0].id)).toEqual([items[0].id, items[1].id]);
      expect(captured.error.some((m) => m.includes("--batch halted on item"))).toBe(true);
    });
  });

  // Host-agent (in-session) mode — #254 / ADR-0019. The CLI keeps payload
  // construction, schema validation, the status transition, and the untrusted
  // boundary; only the model-call step moves to the interactive host session.
  describe("emit-payload mode (--emit-payload, #254)", () => {
    function expectedOutputPath(workdir: string): string {
      return join(
        workdir,
        "research",
        "20260510_anthropic-news-claude-code-shiny-new-feature_v1.md",
      );
    }

    it("emits a payload to stdout and does NOT spawn the adapter", async () => {
      const workdir = await setupWorkspace();
      const { adapter, calls } = buildMockAdapter(async () => undefined);
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id, "--emit-payload"], { cwd: workdir, io });

      expect(code).toBe(0);
      // The model-call step never runs in host mode.
      expect(calls).toHaveLength(0);
      const payload = captured.log.join("\n");
      expect(payload).toContain("FEEDRADAR RESEARCH PAYLOAD");
      // The deterministic output path and the commit hint are both present so
      // the host knows where to write and how to finalize.
      expect(payload).toContain(expectedOutputPath(workdir));
      expect(payload).toContain(`radar research --commit ${expectedOutputPath(workdir)}`);
      expect(payload).toContain(`Items to research: ${SAMPLE_ITEM.id}`);
    });

    it("wraps untrusted item content in <untrusted_item> markers (ADR-0009 M1c)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id, "--emit-payload"], { cwd: workdir, io });

      expect(code).toBe(0);
      const payload = captured.log.join("\n");
      expect(payload).toContain("<untrusted_item>");
      expect(payload).toContain("</untrusted_item>");
      // The feed title (untrusted) is inside the boundary; the id (trusted
      // routing metadata) is rendered outside it by renderItemForPrompt.
      expect(payload).toContain(SAMPLE_ITEM.title);
    });

    it("includes a schema-compatible JSON fence in the payload", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      await runResearch([SAMPLE_ITEM.id, "--emit-payload"], { cwd: workdir, io });

      const payload = captured.log.join("\n");
      const match = payload.match(/```json\n([\s\S]*?)\n```/);
      expect(match).not.toBeNull();
      const parsed = JSON.parse((match as RegExpMatchArray)[1]);
      expect(parsed.agent).toBe("claude-code");
      expect(parsed.outputPath).toBe(expectedOutputPath(workdir));
      expect(parsed.items.map((i: { id: string }) => i.id)).toEqual([SAMPLE_ITEM.id]);
    });

    it("does NOT transition item status and does NOT write the report", async () => {
      const workdir = await setupWorkspace();
      const { io } = captureIo();
      await runResearch([SAMPLE_ITEM.id, "--emit-payload"], { cwd: workdir, io });

      // The item stays detected — only `--commit` (after the host writes the
      // report) advances it.
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("detected");
      // No report file is written by the emit step.
      expect(await pathExists(expectedOutputPath(workdir))).toBe(false);
    });

    it("refuses to emit when the output file already exists", async () => {
      const workdir = await setupWorkspace();
      await writeFile(expectedOutputPath(workdir), "# pre-existing\n", "utf8");

      const { io, captured } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id, "--emit-payload"], { cwd: workdir, io });

      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("already exists"))).toBe(true);
    });

    it("emits a digest payload for multiple ids with --digest", async () => {
      const workdir = await setupWorkspace();
      const SECOND_ITEM = ItemSchema.parse({
        id: "anthropic-news-2026-05-12-claude-code-skills",
        sourceId: "anthropic-news",
        title: "Claude Code skills: ship and iterate",
        url: "https://anthropic.com/news/claude-code-skills",
        publishedAt: "2026-05-12T00:00:00.000Z",
        fetchedAt: "2026-05-12T01:00:00.000Z",
        summary: "Claude Code skills, anthropic deep dive.",
        matchedKeywords: ["Claude Code", "Anthropic"],
        status: "detected",
      });
      await writeFile(
        join(workdir, "items", SECOND_ITEM.sourceId, `${SECOND_ITEM.id}.yaml`),
        stringifyYaml(SECOND_ITEM),
        "utf8",
      );

      const { io, captured } = captureIo();
      const code = await runResearch(
        ["--digest", SAMPLE_ITEM.id, SECOND_ITEM.id, "--emit-payload"],
        { cwd: workdir, io },
      );

      expect(code).toBe(0);
      const payload = captured.log.join("\n");
      expect(payload).toContain("_digest_");
      expect(payload).toContain(SAMPLE_ITEM.id);
      expect(payload).toContain(SECOND_ITEM.id);
    });

    it("rejects --emit-payload combined with --batch", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--emit-payload", "--batch"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("incompatible with --batch"))).toBe(true);
    });
  });

  describe("commit mode (--commit, #254)", () => {
    const REPORT_NAME = "20260510_anthropic-news-claude-code-shiny-new-feature_v1.md";

    function commitFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
        itemIds: [SAMPLE_ITEM.id],
        agent: "claude-code",
        templateId: "default",
        createdAt: "2026-05-10T03:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
        ...overrides,
      };
    }

    async function writeReport(
      workdir: string,
      name: string,
      fm: Record<string, unknown>,
      body = "# host-written report\n\n本文。\n",
    ): Promise<string> {
      const reportPath = join(workdir, "research", name);
      await writeFile(reportPath, matter.stringify(body, fm), "utf8");
      return reportPath;
    }

    it("validates an externally written report and transitions detected → researched", async () => {
      const workdir = await setupWorkspace();
      const reportPath = await writeReport(workdir, REPORT_NAME, commitFrontmatter());

      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", reportPath], { cwd: workdir, io });

      expect(code).toBe(0);
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("researched");
      expect(captured.log.some((m) => m.includes("wrote"))).toBe(true);
      expect(captured.log.some((m) => m.includes("status -> researched"))).toBe(true);
    });

    it("reverse-looks-up items from frontmatter itemIds (digest with multiple ids)", async () => {
      const workdir = await setupWorkspace();
      const SECOND_ITEM = ItemSchema.parse({
        id: "anthropic-news-2026-05-12-claude-code-skills",
        sourceId: "anthropic-news",
        title: "Claude Code skills",
        url: "https://anthropic.com/news/claude-code-skills",
        publishedAt: "2026-05-12T00:00:00.000Z",
        fetchedAt: "2026-05-12T01:00:00.000Z",
        matchedKeywords: ["Claude Code"],
        status: "detected",
      });
      await writeFile(
        join(workdir, "items", SECOND_ITEM.sourceId, `${SECOND_ITEM.id}.yaml`),
        stringifyYaml(SECOND_ITEM),
        "utf8",
      );
      const reportPath = await writeReport(
        workdir,
        "20260512_digest_claude-code_v1.md",
        commitFrontmatter({
          id: "20260512_digest_claude-code_v1",
          itemIds: [SAMPLE_ITEM.id, SECOND_ITEM.id],
          templateId: "digest",
        }),
      );

      const { io } = captureIo();
      const code = await runResearch(["--commit", reportPath], { cwd: workdir, io });

      expect(code).toBe(0);
      for (const item of [SAMPLE_ITEM, SECOND_ITEM]) {
        const itemRaw = await readFile(
          join(workdir, "items", item.sourceId, `${item.id}.yaml`),
          "utf8",
        );
        expect(parseYaml(itemRaw).status).toBe("researched");
      }
    });

    it("rejects a --commit path outside <cwd>/research/ (path traversal, M3b)", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", "../escape.md"], { cwd: workdir, io });

      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("must be a file under"))).toBe(true);
      // The item is untouched.
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("detected");
    });

    it("rejects a --commit path in a sibling directory (research-evil/)", async () => {
      const workdir = await setupWorkspace();
      await mkdir(join(workdir, "research-evil"), { recursive: true });
      const { io, captured } = captureIo();
      // `research-evil/x.md` shares the `research` prefix as a string but is a
      // different directory; the `+ sep` guard must reject it.
      const code = await runResearch(["--commit", "research-evil/x.md"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("must be a file under"))).toBe(true);
    });

    it("rejects an absolute --commit path outside the workspace", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", "/etc/passwd"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("must be a file under"))).toBe(true);
    });

    it("rejects a --commit path that escapes research/ via a symlink (realpath, M3b)", async () => {
      const workdir = await setupWorkspace();
      // A valid report living OUTSIDE research/, reachable through a symlink
      // inside research/. The literal prefix check passes (the link is under
      // research/); the realpath guard must still reject the escape.
      const outside = join(workdir, "outside.md");
      await writeFile(outside, matter.stringify("# x\n", commitFrontmatter()), "utf8");
      await symlink(outside, join(workdir, "research", "link.md"));

      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", "research/link.md"], { cwd: workdir, io });

      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("via a symlink"))).toBe(true);
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("detected");
    });

    it("rejects a report that violates ResearchFrontmatterSchema (no transition)", async () => {
      const workdir = await setupWorkspace();
      // Legacy/invalid frontmatter: missing required fields, stray `status`.
      const reportPath = await writeReport(workdir, REPORT_NAME, {
        id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
        status: "researched",
      });

      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", reportPath], { cwd: workdir, io });

      expect(code).toBe(1);
      expect(
        captured.error.some((m) => m.includes("does not match ResearchFrontmatterSchema")),
      ).toBe(true);
      // Rollback: items.yaml is untouched.
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("detected");
    });

    it("errors when frontmatter itemIds reference an unknown item", async () => {
      const workdir = await setupWorkspace();
      const reportPath = await writeReport(
        workdir,
        REPORT_NAME,
        commitFrontmatter({ itemIds: ["does-not-exist"] }),
      );

      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", reportPath], { cwd: workdir, io });

      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("unknown item id 'does-not-exist'"))).toBe(true);
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("detected");
    });

    it("resets reviewedAt/reviewedBy/supersedes drift on commit (shares finalizeResearch)", async () => {
      const workdir = await setupWorkspace();
      const reportPath = await writeReport(
        workdir,
        REPORT_NAME,
        commitFrontmatter({ reviewedAt: "2026-05-10T05:00:00.000Z", reviewedBy: "codex-cli" }),
      );

      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", reportPath], { cwd: workdir, io });

      expect(code).toBe(0);
      const body = await readFile(reportPath, "utf8");
      expect(matter(body).data.reviewedAt).toBeNull();
      expect(matter(body).data.reviewedBy).toBeNull();
      expect(captured.warn.some((m) => m.includes("resetting to null"))).toBe(true);
    });

    it("errors when the committed report file does not exist", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", join(workdir, "research", "missing.md")], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("was not written"))).toBe(true);
    });

    it("does not re-transition an already-researched item (idempotent guard)", async () => {
      const workdir = await setupWorkspace();
      await writeFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        stringifyYaml({ ...SAMPLE_ITEM, status: "researched" }),
        "utf8",
      );
      const reportPath = await writeReport(workdir, REPORT_NAME, commitFrontmatter());

      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", reportPath], { cwd: workdir, io });

      expect(code).toBe(0);
      // No transition happened (researched → researched is not a legal edge).
      expect(captured.log.some((m) => m.includes("status -> researched"))).toBe(false);
      const itemRaw = await readFile(
        join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
        "utf8",
      );
      expect(parseYaml(itemRaw).status).toBe("researched");
    });

    it("rejects --commit combined with --digest", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", "research/x.md", "--digest"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("incompatible with --digest"))).toBe(true);
    });

    it("rejects --commit combined with positional item ids", async () => {
      const workdir = await setupWorkspace();
      const { io, captured } = captureIo();
      const code = await runResearch(["--commit", "research/x.md", SAMPLE_ITEM.id], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("takes a <path>"))).toBe(true);
    });
  });
});
