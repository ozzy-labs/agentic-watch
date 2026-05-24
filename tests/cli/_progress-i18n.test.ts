import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import type { AgentAdapter, ResearchRequest, ReviewRequest } from "../../src/agents/index.js";
import { registerAgentAdapter } from "../../src/agents/index.js";
import { runResearch } from "../../src/cli/research.js";
import { runReview } from "../../src/cli/review.js";
import { runUpdate } from "../../src/cli/update.js";
import { createProgressReporter } from "../../src/core/progress.js";
import { ja } from "../../src/i18n/messages/ja.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Locale-aware phase-marker tests for #313 (ProgressReporter i18n, ADR-0021).
 *
 * The labels passed to `progress.phase()` / `start()` / `succeed()` / `fail()`
 * by `research` / `review` / `update` are sourced from `src/i18n/messages/*`
 * and rendered through the resolved-locale translator. These tests pin that:
 *
 * 1. With `--lang ja` the markers come out in Japanese (the catalog values).
 * 2. `RADAR_NO_PROGRESS=1` still forces a no-op reporter even with `--lang ja`
 *    (regression: the env escape hatch is locale-independent).
 *
 * They reuse the same in-memory-stream + mock-adapter harness as
 * `_progress.test.ts` but inject a reporter built directly (no translator
 * bundled) so we also prove the CLI derives its own translator from the
 * resolved locale rather than depending on the reporter carrying one.
 */

function memoryStream(): NodeJS.WritableStream & { chunks: string[]; output: () => string } {
  const chunks: string[] = [];
  const stream = {
    chunks,
    output: () => chunks.join(""),
    write(data: string | Uint8Array, ...rest: unknown[]): boolean {
      chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
      const last = rest[rest.length - 1];
      if (typeof last === "function") (last as () => void)();
      return true;
    },
  } as unknown as NodeJS.WritableStream & { chunks: string[]; output: () => string };
  return stream;
}

function captureIo(): {
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  captured: { log: string[]; warn: string[]; error: string[] };
} {
  const captured = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    io: {
      log: (m) => captured.log.push(m),
      warn: (m) => captured.warn.push(m),
      error: (m) => captured.error.push(m),
    },
    captured,
  };
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

const RESEARCH_ID = "20260510_anthropic-news-claude-code-shiny-new-feature_v1";

const PRE_FRONTMATTER: ResearchFrontmatter = {
  id: RESEARCH_ID,
  itemIds: [SAMPLE_ITEM.id],
  agent: "claude-code",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  supersedes: null,
};

const RESEARCH_BODY_MARKDOWN =
  "# Claude Code: shiny new feature\n\n## 要約\n\nbody.\n\n## 出典\n\n- https://anthropic.com/news/claude-code-shiny\n";

function validResearchFrontmatter(req: ResearchRequest): Record<string, unknown> {
  return {
    id: RESEARCH_ID,
    itemIds: req.items.map((i) => i.id),
    agent: req.agent,
    templateId: req.templateId,
    createdAt: "2026-05-10T03:00:00.000Z",
    updatedAt: null,
    reviewedAt: null,
    reviewedBy: null,
  };
}

function reviewedFrontmatter(req: ReviewRequest): ResearchFrontmatter {
  return {
    ...req.researchFrontmatter,
    reviewedAt: "2026-05-11T00:00:00.000Z",
    reviewedBy: req.agent,
    updatedAt: "2026-05-11T00:00:00.000Z",
  };
}

async function setupResearchWorkspace(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-i18n-research-"));
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

async function setupReviewWorkspace(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-i18n-review-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  const item: Item = { ...SAMPLE_ITEM, status: "researched" };
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
  await writeFile(
    join(workdir, "research", `${RESEARCH_ID}.md`),
    matter.stringify(RESEARCH_BODY_MARKDOWN, PRE_FRONTMATTER),
    "utf8",
  );
  return workdir;
}

async function setupUpdateWorkspace(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-i18n-update-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  const item: Item = { ...SAMPLE_ITEM, status: "researched" };
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
  await writeFile(
    join(workdir, "research", `${RESEARCH_ID}.md`),
    matter.stringify(RESEARCH_BODY_MARKDOWN, PRE_FRONTMATTER),
    "utf8",
  );
  return workdir;
}

describe("cli progress i18n (#313 / ADR-0021)", () => {
  let prevAdapter: AgentAdapter | undefined;
  const originalNoProgress = process.env.RADAR_NO_PROGRESS;

  beforeEach(() => {
    prevAdapter = undefined;
  });

  afterEach(() => {
    if (prevAdapter) registerAgentAdapter(prevAdapter);
    if (originalNoProgress === undefined) delete process.env.RADAR_NO_PROGRESS;
    else process.env.RADAR_NO_PROGRESS = originalNoProgress;
  });

  it("research --lang ja renders phase markers in Japanese", async () => {
    const workdir = await setupResearchWorkspace();
    const adapter: AgentAdapter = {
      id: "claude-code",
      research: async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", validResearchFrontmatter(req)),
          "utf8",
        );
      },
    };
    prevAdapter = registerAgentAdapter(adapter);

    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "normal", tty: false, stream });
    const { io } = captureIo();
    const code = await runResearch(["--lang", "ja", SAMPLE_ITEM.id], {
      cwd: workdir,
      io,
      progress: reporter,
    });
    expect(code).toBe(0);
    const out = stream.output();
    // Catalog-sourced Japanese markers, in canonical order.
    const order = [
      ja["cli.progress.loadedItem"]({ id: SAMPLE_ITEM.id }),
      ja["cli.progress.loadedTemplate"]({ templateId: "default" }),
      ja["cli.progress.spawning"]({ agent: "claude-code" }),
      ja["cli.progress.agentRunning"],
      ja["cli.progress.agentCompleted"]({ exitCode: 0 }),
      ja["cli.progress.frontmatterValidated"],
      ja["cli.progress.statusTransition"]({ from: "detected", to: "researched" }),
    ];
    let cursor = 0;
    for (const marker of order) {
      const idx = out.indexOf(marker, cursor);
      expect(idx, `marker '${marker}' missing or out-of-order in:\n${out}`).toBeGreaterThanOrEqual(
        cursor,
      );
      cursor = idx + marker.length;
    }
    // The English source strings must NOT leak when ja is selected.
    expect(out).not.toContain("Frontmatter validated");
    expect(out).not.toContain("Agent completed (exit 0)");
  });

  it("review --lang ja renders phase markers in Japanese", async () => {
    const workdir = await setupReviewWorkspace();
    const adapter: AgentAdapter = {
      id: "claude-code",
      research: async () => {
        throw new Error("unused");
      },
      review: async (req) => {
        await writeFile(
          req.researchPath,
          matter.stringify("body", reviewedFrontmatter(req)),
          "utf8",
        );
      },
    };
    prevAdapter = registerAgentAdapter(adapter);

    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "normal", tty: false, stream });
    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID, "--lang", "ja", "--agent", "claude-code"], {
      cwd: workdir,
      io,
      progress: reporter,
    });
    expect(code).toBe(0);
    const out = stream.output();
    expect(out).toContain(ja["cli.progress.loadedItem"]({ id: SAMPLE_ITEM.id }));
    expect(out).toContain(ja["cli.progress.spawning"]({ agent: "claude-code" }));
    expect(out).toContain(ja["cli.progress.frontmatterValidated"]);
    expect(out).toContain(
      ja["cli.progress.statusTransition"]({ from: "researched", to: "reviewed" }),
    );
    expect(out).not.toContain("Frontmatter validated");
  });

  it("update --lang ja renders phase markers in Japanese", async () => {
    const workdir = await setupUpdateWorkspace();
    const v2Id = `${RESEARCH_ID.replace(/_v1$/, "")}_v2`;
    const adapter: AgentAdapter = {
      id: "claude-code",
      research: async () => {
        throw new Error("unused");
      },
      review: async () => {
        throw new Error("unused");
      },
      update: async (req) => {
        const v2Frontmatter: ResearchFrontmatter = {
          ...req.prevResearch.frontmatter,
          id: v2Id,
          agent: req.agent,
          updatedAt: "2026-05-12T00:00:00.000Z",
          supersedes: req.prevResearch.frontmatter.id,
        };
        await writeFile(req.outputPath, matter.stringify("v2 body", v2Frontmatter), "utf8");
      },
    };
    prevAdapter = registerAgentAdapter(adapter);

    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "normal", tty: false, stream });
    const { io } = captureIo();
    const code = await runUpdate([RESEARCH_ID, "--lang", "ja"], {
      cwd: workdir,
      io,
      progress: reporter,
    });
    expect(code).toBe(0);
    const out = stream.output();
    expect(out).toContain(ja["cli.progress.loadedItem"]({ id: SAMPLE_ITEM.id }));
    expect(out).toContain(ja["cli.progress.spawning"]({ agent: "claude-code" }));
    expect(out).toContain(ja["cli.progress.agentCompleted"]({ exitCode: 0 }));
    expect(out).toContain(ja["cli.progress.frontmatterValidated"]);
    // update preserves item status (ADR-0008): the marker records a no-op
    // transition, still localized.
    expect(out).toContain(
      ja["cli.progress.statusTransition"]({ from: "researched", to: "researched" }),
    );
    expect(out).not.toContain("Frontmatter validated");
  });

  it("RADAR_NO_PROGRESS=1 still suppresses markers even with --lang ja", async () => {
    process.env.RADAR_NO_PROGRESS = "1";
    const workdir = await setupResearchWorkspace();
    const adapter: AgentAdapter = {
      id: "claude-code",
      research: async (req) => {
        await writeFile(
          req.outputPath,
          matter.stringify("body", validResearchFrontmatter(req)),
          "utf8",
        );
      },
    };
    prevAdapter = registerAgentAdapter(adapter);

    const stream = memoryStream();
    // Even a verbose reporter must stay silent: env > flag per ADR-0015 D2,
    // and that priority is independent of locale.
    const reporter = createProgressReporter({ level: "verbose", tty: true, stream });
    const { io, captured } = captureIo();
    const code = await runResearch(["--lang", "ja", SAMPLE_ITEM.id], {
      cwd: workdir,
      io,
      progress: reporter,
    });
    expect(code).toBe(0);
    expect(stream.output()).toBe("");
    // The pre-existing 1-line completion summary is still emitted (RADAR_NO_PROGRESS
    // only suppresses the spinner / phase markers). As of #336 the summary itself is
    // localized, so under `--lang ja` it carries the Japanese wording while keeping
    // the stable `research:` command prefix.
    expect(
      captured.log.some((m) => m.startsWith("research:") && m.includes("書き込みました")),
    ).toBe(true);
  });
});
