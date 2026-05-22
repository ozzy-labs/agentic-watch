import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import { createCodexCliAdapter } from "../../src/agents/codex-cli.js";
import { createCopilotAdapter } from "../../src/agents/copilot.js";
import { createGeminiCliAdapter } from "../../src/agents/gemini-cli.js";
import type {
  AgentAdapter,
  ResearchRequest,
  ReviewRequest,
  UpdateRequest,
} from "../../src/agents/index.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Cross-adapter regression suite for the `onProgress` callback added in
 * #196 (ADR-0015 D3). Each adapter's runner takes an optional `onProgress`
 * hook on its `SpawnOptions`; this suite verifies:
 *
 * 1. Adapters forward `req.onProgress` to the runner verbatim
 * 2. The runner contract is "unchanged when `onProgress` is undefined"
 *    (no regression for callers that haven't opted into progress)
 *
 * We do not assert the runtime piping of stdout / stderr chunks here —
 * that would require spawning a real child process. The default
 * `run{Claude,Codex,Gemini,Copilot}Cli` functions are exercised by the
 * existing CLI integration tests; this file only locks down the adapter
 * wiring (`adapter.method` → `runner({ ..., onProgress })`).
 */

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

const SAMPLE_RESEARCH_FM: ResearchFrontmatter = {
  id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
  itemIds: [SAMPLE_ITEM.id],
  agent: "claude-code",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

function buildResearchRequest(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    agent: "claude-code",
    templateId: "default",
    templateBody: "",
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/feedradar-test/research/sample_v1.md",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

function buildReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    agent: "claude-code",
    templateId: "default",
    templateBody: "",
    researchPath: "/tmp/feedradar-test/research/sample_v1.md",
    researchFrontmatter: SAMPLE_RESEARCH_FM,
    researchBody: "---\nid: sample\n---\n# v1 body\n",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

function buildUpdateRequest(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    agent: "claude-code",
    templateId: "default",
    templateBody: "",
    prevResearch: {
      frontmatter: SAMPLE_RESEARCH_FM,
      body: "---\nid: sample\n---\n# v1 body\n",
    },
    items: [SAMPLE_ITEM],
    outputPath:
      "/tmp/feedradar-test/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

/**
 * Each adapter is constructed with a slightly different factory shape (the
 * runner type differs per adapter — `ClaudeRunner` / `CodexRunner` etc.),
 * but at the call site all four collapse to `(prompt, options) => Promise<
 * SpawnResult>`. Each entry below wraps the factory so the table-driven
 * suite can hand a single `vi.fn()` mock to all four.
 *
 * Each entry returns both the constructed adapter and the mock so the test
 * can assert on `run.mock.calls[0][1].onProgress`. We avoid `any` here so
 * the test file stays clean of the biome `noExplicitAny` lint.
 */
type AdapterEntry = {
  name: "claude-code" | "codex-cli" | "gemini-cli" | "copilot";
  // The runner mock — typed as a plain Mock so we don't have to import
  // each adapter's per-runner type just to satisfy `as` casts.
  build: () => { adapter: AgentAdapter; run: Mock };
};

const adapters: AdapterEntry[] = [
  {
    name: "claude-code",
    build: () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      return { adapter: createClaudeCodeAdapter({ run }), run };
    },
  },
  {
    name: "codex-cli",
    build: () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      return { adapter: createCodexCliAdapter({ run }), run };
    },
  },
  {
    name: "gemini-cli",
    build: () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      return { adapter: createGeminiCliAdapter({ run }), run };
    },
  },
  {
    name: "copilot",
    build: () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      return { adapter: createCopilotAdapter({ run }), run };
    },
  },
];

describe.each(adapters)("agents/$name adapter — onProgress callback (ADR-0015 D3)", ({
  name,
  build,
}) => {
  describe("research", () => {
    it("forwards req.onProgress to the runner's SpawnOptions", async () => {
      const { adapter, run } = build();
      const onProgress = vi.fn();
      await adapter.research(buildResearchRequest({ agent: name, onProgress }));
      const [, options] = run.mock.calls[0];
      expect(options.onProgress).toBe(onProgress);
    });

    it("omits onProgress from SpawnOptions when the caller does not pass one", async () => {
      const { adapter, run } = build();
      await adapter.research(buildResearchRequest({ agent: name }));
      const [, options] = run.mock.calls[0];
      // `undefined` is acceptable; the runner uses optional chaining so the
      // missing field is byte-equivalent to pre-#196 behaviour.
      expect(options.onProgress).toBeUndefined();
    });
  });

  describe("review", () => {
    it("forwards req.onProgress to the runner's SpawnOptions", async () => {
      const { adapter, run } = build();
      const onProgress = vi.fn();
      await adapter.review(buildReviewRequest({ agent: name, onProgress }));
      const [, options] = run.mock.calls[0];
      expect(options.onProgress).toBe(onProgress);
    });
  });

  describe("update", () => {
    it("forwards req.onProgress to the runner's SpawnOptions", async () => {
      const { adapter, run } = build();
      const onProgress = vi.fn();
      await adapter.update(buildUpdateRequest({ agent: name, onProgress }));
      const [, options] = run.mock.calls[0];
      expect(options.onProgress).toBe(onProgress);
    });
  });
});
