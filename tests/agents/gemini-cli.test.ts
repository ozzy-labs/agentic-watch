import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiCliAdapter, type GeminiRunner } from "../../src/agents/gemini-cli.js";
import type { ResearchRequest, ReviewRequest, UpdateRequest } from "../../src/agents/types.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

// Spawn-args tests rely on a vi.mock of node:child_process. We hoist the mock
// so it is applied before `src/agents/gemini-cli.ts` imports `spawn`.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

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

const SAMPLE_FRONTMATTER: ResearchFrontmatter = {
  id: "20260510_anthropic-news-claude-code-shiny_v1",
  itemIds: [SAMPLE_ITEM.id],
  agent: "gemini-cli",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

function buildResearchRequest(): ResearchRequest {
  return {
    agent: "gemini-cli",
    templateId: "default",
    templateBody: "# Default template\n",
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/feedradar/research/20260510_demo_v1.md",
    cwd: "/tmp/feedradar",
  };
}

function buildReviewRequest(): ReviewRequest {
  return {
    agent: "gemini-cli",
    templateId: "default",
    templateBody: "",
    researchPath: "/tmp/feedradar/research/20260510_demo_v1.md",
    researchFrontmatter: SAMPLE_FRONTMATTER,
    researchBody: "---\nid: demo\n---\n\n# body\n",
    cwd: "/tmp/feedradar",
  };
}

function buildUpdateRequest(): UpdateRequest {
  return {
    agent: "gemini-cli",
    templateId: "default",
    templateBody: "# Default template\n",
    prevResearch: {
      frontmatter: SAMPLE_FRONTMATTER,
      body: "---\nid: demo\n---\n\n# v1 body\n",
    },
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/feedradar/research/20260510_anthropic-news-claude-code-shiny_v2.md",
    cwd: "/tmp/feedradar",
  };
}

interface CapturedCall {
  prompt: string;
  stdin: string;
  cwd: string;
}

interface MockRunnerOptions {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** If set, the runner rejects with this Error instead of resolving. */
  rejectWith?: Error;
}

function buildMockRunner(opts: MockRunnerOptions = {}): {
  runner: GeminiRunner;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const runner: GeminiRunner = async (prompt, options) => {
    calls.push({ prompt, stdin: options.stdin, cwd: options.cwd });
    if (opts.rejectWith) {
      throw opts.rejectWith;
    }
    return {
      code: opts.code ?? 0,
      stdout: opts.stdout ?? "",
      stderr: opts.stderr ?? "",
    };
  };
  return { runner, calls };
}

describe("agents/gemini-cli", () => {
  describe("research", () => {
    it("invokes the runner with a SKILL prompt and JSON stdin", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.research(buildResearchRequest());

      expect(calls).toHaveLength(1);
      const call = calls[0];
      // Prompt must point Gemini at the research SKILL and re-state the
      // outputPath / itemId. We don't pin exact wording — the SKILL contract
      // lives in `.agents/skills/research/SKILL.md`, not here.
      expect(call.prompt).toContain(".agents/skills/research/SKILL.md");
      expect(call.prompt).toContain(SAMPLE_ITEM.id);
      expect(call.prompt).toContain("/tmp/feedradar/research/20260510_demo_v1.md");

      // Item title / summary / raw must sit inside the boundary marker pair
      // (ADR-0009 M1c) so the LLM treats the upstream-sourced content as data.
      expect(call.prompt).toContain("<untrusted_item>");
      expect(call.prompt).toContain("</untrusted_item>");
      expect(call.prompt).toContain(SAMPLE_ITEM.title);

      // The cwd is forwarded so the spawned CLI sees workspace-relative paths.
      expect(call.cwd).toBe("/tmp/feedradar");
    });

    it("forwards the structured payload as JSON on stdin", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.research(buildResearchRequest());

      const payload = JSON.parse(calls[0].stdin);
      expect(payload).toEqual({
        agent: "gemini-cli",
        templateId: "default",
        templateBody: "# Default template\n",
        items: [SAMPLE_ITEM],
        outputPath: "/tmp/feedradar/research/20260510_demo_v1.md",
      });
    });

    it("resolves cleanly when the CLI exits 0", async () => {
      const { runner } = buildMockRunner({ code: 0 });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.research(buildResearchRequest())).resolves.toBeUndefined();
    });

    it("throws a descriptive error when the CLI exits non-zero", async () => {
      const { runner } = buildMockRunner({ code: 1, stderr: "boom" });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /gemini-cli adapter: gemini CLI exited with code 1.*boom/,
      );
    });

    it("surfaces a friendly message for auth-style errors", async () => {
      const { runner } = buildMockRunner({
        code: 1,
        stderr: "Error: not authenticated. Run `gemini` to log in.",
      });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /authentication failed/i,
      );
    });

    it("detects auth errors regardless of which stream printed them", async () => {
      const { runner } = buildMockRunner({
        code: 1,
        stdout: "401 Unauthorized: missing API key",
      });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /authentication failed/i,
      );
    });

    it("propagates runner-level errors (e.g. ENOENT for missing CLI)", async () => {
      const { runner } = buildMockRunner({
        rejectWith: new Error("gemini CLI not found in PATH — install Gemini CLI"),
      });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(/not found in PATH/);
    });
  });

  describe("review", () => {
    it("invokes the runner with a review SKILL prompt and stdin payload", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.review(buildReviewRequest());

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.prompt).toContain(".agents/skills/review/SKILL.md");
      expect(call.prompt).toContain("/tmp/feedradar/research/20260510_demo_v1.md");
      expect(call.prompt).toContain("gemini-cli");
      // The review prompt should NOT re-trigger the research SKILL.
      expect(call.prompt).not.toContain(".agents/skills/research/SKILL.md");

      // The predecessor research body (untrusted, upstream-derived) is wrapped
      // in the boundary marker pair (ADR-0009 M1c).
      expect(call.prompt).toContain("<untrusted_item>");
      expect(call.prompt).toContain("</untrusted_item>");
      expect(call.prompt).toContain("---\nid: demo\n---\n\n# body\n");
    });

    it("forwards the full review payload as JSON on stdin", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.review(buildReviewRequest());

      const payload = JSON.parse(calls[0].stdin);
      expect(payload).toEqual({
        agent: "gemini-cli",
        templateId: "default",
        templateBody: "",
        researchPath: "/tmp/feedradar/research/20260510_demo_v1.md",
        researchFrontmatter: SAMPLE_FRONTMATTER,
        researchBody: "---\nid: demo\n---\n\n# body\n",
      });
    });

    it("resolves cleanly when the CLI exits 0", async () => {
      const { runner } = buildMockRunner({ code: 0 });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.review(buildReviewRequest())).resolves.toBeUndefined();
    });

    it("throws a descriptive error when the CLI exits non-zero", async () => {
      const { runner } = buildMockRunner({ code: 2, stderr: "review skill crashed" });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(
        /gemini-cli adapter: gemini CLI exited with code 2.*review skill crashed/,
      );
    });

    it("surfaces a friendly message for auth-style errors during review", async () => {
      const { runner } = buildMockRunner({
        code: 1,
        stderr: "Please log in to Gemini CLI",
      });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(/authentication failed/i);
    });

    it("uses '(no output)' when both streams are empty", async () => {
      const { runner } = buildMockRunner({ code: 137 });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(
        /exited with code 137.*\(no output\)/,
      );
    });
  });

  describe("update", () => {
    it("invokes the runner with the update SKILL prompt and predecessor id", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.update(buildUpdateRequest());

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.prompt).toContain(".agents/skills/update/SKILL.md");
      expect(call.prompt).toContain(SAMPLE_FRONTMATTER.id);
      expect(call.prompt).toContain(`supersedes: ${SAMPLE_FRONTMATTER.id}`);
      expect(call.prompt).toContain(
        "/tmp/feedradar/research/20260510_anthropic-news-claude-code-shiny_v2.md",
      );
      expect(call.cwd).toBe("/tmp/feedradar");
      // update prompt must NOT re-trigger the research SKILL (would generate v1, not v2).
      expect(call.prompt).not.toContain(".agents/skills/research/SKILL.md");

      // Both the predecessor research body and per-item title/summary/raw
      // must sit inside the boundary marker pair (ADR-0009 M1c).
      expect(call.prompt).toContain("<untrusted_item>");
      expect(call.prompt).toContain("</untrusted_item>");
      expect(call.prompt).toContain("---\nid: demo\n---\n\n# v1 body\n");
      expect(call.prompt).toContain(SAMPLE_ITEM.title);
    });

    it("forwards prevResearch + items + outputPath as JSON on stdin", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.update(buildUpdateRequest());

      const payload = JSON.parse(calls[0].stdin);
      expect(payload).toEqual({
        agent: "gemini-cli",
        templateId: "default",
        templateBody: "# Default template\n",
        prevResearch: {
          frontmatter: SAMPLE_FRONTMATTER,
          body: "---\nid: demo\n---\n\n# v1 body\n",
        },
        items: [SAMPLE_ITEM],
        outputPath: "/tmp/feedradar/research/20260510_anthropic-news-claude-code-shiny_v2.md",
      });
    });

    it("resolves cleanly when the CLI exits 0", async () => {
      const { runner } = buildMockRunner({ code: 0 });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.update(buildUpdateRequest())).resolves.toBeUndefined();
    });

    it("throws a descriptive error when the CLI exits non-zero", async () => {
      const { runner } = buildMockRunner({ code: 5, stderr: "update prompt rejected" });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(
        /gemini-cli adapter: gemini CLI exited with code 5.*update prompt rejected/,
      );
    });

    it("surfaces a friendly message for auth-style errors during update", async () => {
      const { runner } = buildMockRunner({
        code: 1,
        stderr: "Please log in to Gemini CLI",
      });
      const adapter = createGeminiCliAdapter({ run: runner });
      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(/authentication failed/i);
    });
  });

  describe("research (multi-item digest, ADR-0011 §1)", () => {
    const SECOND_ITEM: Item = ItemSchema.parse({
      id: "hacker-news-39876543-claude-code",
      sourceId: "hacker-news",
      title: "Show HN: claude-code in production",
      url: "https://news.ycombinator.com/item?id=39876543",
      publishedAt: "2026-05-11T12:00:00.000Z",
      fetchedAt: "2026-05-11T12:30:00.000Z",
      summary: "We migrated our research pipeline to claude-code.",
      matchedKeywords: ["Claude Code"],
      status: "detected",
    });
    const THIRD_ITEM: Item = ItemSchema.parse({
      id: "anthropic-news-2026-05-12-anthropic-funding",
      sourceId: "anthropic-news",
      title: "Anthropic funding round",
      url: "https://anthropic.com/news/funding",
      publishedAt: "2026-05-12T00:00:00.000Z",
      fetchedAt: "2026-05-12T01:00:00.000Z",
      summary: "New round closed.",
      matchedKeywords: ["Anthropic"],
      status: "detected",
    });

    function buildMultiItemResearchRequest(items: Item[]): ResearchRequest {
      return { ...buildResearchRequest(), items };
    }

    it("includes every item's id, url, and untrusted content in the prompt", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      const items = [SAMPLE_ITEM, SECOND_ITEM, THIRD_ITEM];
      await adapter.research(buildMultiItemResearchRequest(items));

      const call = calls[0];
      for (const item of items) {
        expect(call.prompt).toContain(item.id);
        expect(call.prompt).toContain(item.url);
        expect(call.prompt).toContain(item.title);
        if (item.summary !== undefined) {
          expect(call.prompt).toContain(item.summary);
        }
      }
      expect(call.prompt).toContain(items.map((i) => i.id).join(", "));

      const stdinJson = JSON.parse(call.stdin);
      expect(stdinJson.items).toEqual(items);
    });

    it("labels each item with an `### Item k of N` heading and one boundary marker per item", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      const items = [SAMPLE_ITEM, SECOND_ITEM, THIRD_ITEM];
      await adapter.research(buildMultiItemResearchRequest(items));

      const prompt = calls[0].prompt;
      expect(prompt).toContain("### Item 1 of 3");
      expect(prompt).toContain("### Item 2 of 3");
      expect(prompt).toContain("### Item 3 of 3");
      const openCount = (prompt.match(/<untrusted_item>/g) ?? []).length;
      const closeCount = (prompt.match(/<\/untrusted_item>/g) ?? []).length;
      expect(openCount).toBe(3);
      expect(closeCount).toBe(3);
    });

    it("emits the same prompt for a single-item array as before #140 (regression guard)", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      await adapter.research(buildResearchRequest());

      const prompt = calls[0].prompt;
      expect(prompt).not.toContain("### Item 1 of 1");
      const openCount = (prompt.match(/<untrusted_item>/g) ?? []).length;
      expect(openCount).toBe(1);
    });
  });

  describe("update (multi-item digest, ADR-0011 §4)", () => {
    const SECOND_ITEM: Item = ItemSchema.parse({
      id: "hacker-news-39876543-claude-code",
      sourceId: "hacker-news",
      title: "Show HN: claude-code in production",
      url: "https://news.ycombinator.com/item?id=39876543",
      publishedAt: "2026-05-11T12:00:00.000Z",
      fetchedAt: "2026-05-11T12:30:00.000Z",
      summary: "Production migration writeup.",
      matchedKeywords: ["Claude Code"],
      status: "researched",
    });

    it("renders every digest item under its `### Item k of N` heading inside the update prompt", async () => {
      const { runner, calls } = buildMockRunner();
      const adapter = createGeminiCliAdapter({ run: runner });
      const items = [SAMPLE_ITEM, SECOND_ITEM];
      await adapter.update({ ...buildUpdateRequest(), items });

      const prompt = calls[0].prompt;
      expect(prompt).toContain("### Item 1 of 2");
      expect(prompt).toContain("### Item 2 of 2");
      expect(prompt).toContain(SAMPLE_ITEM.id);
      expect(prompt).toContain(SECOND_ITEM.id);
      // Predecessor body + 2 items = 3 boundary marker pairs total.
      const openCount = (prompt.match(/<untrusted_item>/g) ?? []).length;
      expect(openCount).toBe(3);

      const stdinJson = JSON.parse(calls[0].stdin);
      expect(stdinJson.items).toEqual(items);
    });
  });

  describe("adapter shape", () => {
    it("has id 'gemini-cli'", () => {
      const adapter = createGeminiCliAdapter({ run: buildMockRunner().runner });
      expect(adapter.id).toBe("gemini-cli");
    });
  });

  // The real `runGeminiCli` (used when the adapter is constructed without a
  // runner override) is responsible for shaping the spawn argv handed to the
  // `gemini` CLI. The folder-trust bypass lives at this boundary, so we
  // exercise it by intercepting `node:child_process.spawn` and asserting
  // the argv we hand to it. See JSDoc on `runGeminiCli` for the rationale
  // behind `--skip-trust` — without it, Gemini CLI silently downgrades `-y`
  // to default approval mode in untrusted folders, breaking headless usage.
  describe("spawn args (folder trust bypass)", () => {
    afterEach(() => {
      spawnMock.mockReset();
    });

    function buildFakeChild(): EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void };
    } {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {} };
      return child;
    }

    it("passes --skip-trust to the gemini CLI on research()", async () => {
      const child = buildFakeChild();
      spawnMock.mockReturnValue(child);
      // Default adapter (no `run` override) goes through runGeminiCli ->
      // node:child_process.spawn, which we've mocked above.
      const adapter = createGeminiCliAdapter();
      const promise = adapter.research(buildResearchRequest());
      // The real implementation listens for `close` to resolve; fire it
      // immediately with a clean exit code.
      child.emit("close", 0);
      await promise;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, argv] = spawnMock.mock.calls[0] as [string, string[], unknown];
      expect(bin).toBe("gemini");
      // The folder-trust bypass restores parity with the other 3 adapters
      // (claude-code / codex-cli / copilot), all of which launch in
      // equivalent full-permission modes. Without `--skip-trust`, recent
      // Gemini CLI versions override `-y` back to default approval in
      // untrusted folders.
      expect(argv).toContain("--skip-trust");
      // `-y` (YOLO) is retained alongside `--skip-trust`.
      expect(argv).toContain("-y");
    });

    it("passes --skip-trust to the gemini CLI on review()", async () => {
      const child = buildFakeChild();
      spawnMock.mockReturnValue(child);
      const adapter = createGeminiCliAdapter();
      const promise = adapter.review(buildReviewRequest());
      child.emit("close", 0);
      await promise;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = spawnMock.mock.calls[0] as [string, string[], unknown];
      expect(argv).toContain("--skip-trust");
      expect(argv).toContain("-y");
    });
  });
});
