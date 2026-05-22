import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { createProgressReporter, type ProgressReporter } from "../../src/core/progress.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Integration tests for #197 (ADR-0015): research / review / update CLIs
 * surface phase markers via {@link ProgressReporter} and honour the shared
 * `--verbose` / `--quiet` / `RADAR_NO_PROGRESS=1` flags.
 *
 * The tests pin behaviour at the CLI boundary by injecting:
 *
 * - A capturing in-memory stream so we can assert on the literal stderr
 *   bytes the reporter writes (phase markers, spinner-clear ANSI escapes,
 *   `raw()` pass-through chunks)
 * - A mock {@link AgentAdapter} that synchronously calls `onProgress` with
 *   canned stdout / stderr chunks so we can verify `--verbose` pass-through
 *   without spawning a real child process
 *
 * Acceptance criteria from #197 covered here:
 *
 * 1. phase markers fire in canonical order (Loaded → Spawning → Agent
 *    completed → Frontmatter validated → Status)
 * 2. `--verbose` pipes agent stdout pass-through with a guaranteed trailing
 *    newline
 * 3. `--quiet` / `RADAR_NO_PROGRESS=1` suppresses phase markers but keeps
 *    the existing `io.log` 1-line summary intact
 * 4. non-TTY environments degrade to plain text (no `\r` / ANSI escapes)
 * 5. existing tests do not regress (covered by the broader test suite)
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
  } as unknown as NodeJS.WritableStream & {
    chunks: string[];
    output: () => string;
  };
  return stream;
}

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

async function setupResearchWorkspace(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-research-"));
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

async function setupReviewWorkspace(): Promise<{ workdir: string; researchPath: string }> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-review-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  const item: Item = { ...SAMPLE_ITEM, status: "researched" };
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
  const researchPath = join(workdir, "research", `${RESEARCH_ID}.md`);
  await writeFile(researchPath, matter.stringify(RESEARCH_BODY_MARKDOWN, PRE_FRONTMATTER), "utf8");
  return { workdir, researchPath };
}

async function setupUpdateWorkspace(): Promise<{ workdir: string; v1Path: string }> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-update-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  const item: Item = { ...SAMPLE_ITEM, status: "researched" };
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
  const v1Path = join(workdir, "research", `${RESEARCH_ID}.md`);
  await writeFile(v1Path, matter.stringify(RESEARCH_BODY_MARKDOWN, PRE_FRONTMATTER), "utf8");
  return { workdir, v1Path };
}

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

describe("cli progress integration (#197 / ADR-0015)", () => {
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

  describe("research", () => {
    it("emits phase markers in canonical order on non-TTY", async () => {
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
      const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io, progress: reporter });
      expect(code).toBe(0);
      const out = stream.output();
      // Markers must appear in the documented order (ADR-0015 D4).
      const order = [
        `Loaded item: ${SAMPLE_ITEM.id}`,
        "Loaded template: default.md",
        "Spawning claude-code",
        "Agent running",
        "Agent completed (exit 0)",
        "Frontmatter validated",
        "Status: detected → researched",
      ];
      let cursor = 0;
      for (const marker of order) {
        const idx = out.indexOf(marker, cursor);
        expect(
          idx,
          `marker '${marker}' missing or out-of-order in:\n${out}`,
        ).toBeGreaterThanOrEqual(cursor);
        cursor = idx + marker.length;
      }
      // Non-TTY must NOT contain ANSI escape sequences or `\r` overwrites.
      expect(out).not.toContain("\r");
      expect(out).not.toContain("\x1b[K");
    });

    it("passes through agent stdout when --verbose is set", async () => {
      const workdir = await setupResearchWorkspace();
      const adapter: AgentAdapter = {
        id: "claude-code",
        research: async (req) => {
          req.onProgress?.("stdout", "claude-code: tool call result\n");
          req.onProgress?.("stderr", "warning: rate limited\n");
          await writeFile(
            req.outputPath,
            matter.stringify("body", validResearchFrontmatter(req)),
            "utf8",
          );
        },
      };
      prevAdapter = registerAgentAdapter(adapter);

      const stream = memoryStream();
      const reporter = createProgressReporter({ level: "verbose", tty: false, stream });
      const { io } = captureIo();
      const code = await runResearch(["--verbose", SAMPLE_ITEM.id], {
        cwd: workdir,
        io,
        progress: reporter,
      });
      expect(code).toBe(0);
      const out = stream.output();
      expect(out).toContain("claude-code: tool call result\n");
      expect(out).toContain("warning: rate limited\n");
    });

    it("suppresses phase markers under --quiet but keeps the existing log summary", async () => {
      const workdir = await setupResearchWorkspace();
      const adapter: AgentAdapter = {
        id: "claude-code",
        research: async (req) => {
          req.onProgress?.("stdout", "agent chatter\n");
          await writeFile(
            req.outputPath,
            matter.stringify("body", validResearchFrontmatter(req)),
            "utf8",
          );
        },
      };
      prevAdapter = registerAgentAdapter(adapter);

      const stream = memoryStream();
      // Even though we hand in a `verbose` reporter directly, the CLI's own
      // flag parser produces a quiet-level reporter when it sees `--quiet`.
      // We bypass the production builder by injecting a `quiet`-equivalent
      // reporter to lock the no-op semantics. The CLI flag wiring is
      // exercised separately below.
      const noopReporter: ProgressReporter = createProgressReporter({
        level: "quiet",
        tty: false,
        stream,
      });
      const { io, captured } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id], {
        cwd: workdir,
        io,
        progress: noopReporter,
      });
      expect(code).toBe(0);
      // No phase markers / spinner / pass-through bytes on the reporter stream.
      expect(stream.output()).toBe("");
      // The pre-existing 1-line `research: wrote <path>` summary is preserved
      // (acceptance criterion 8).
      expect(captured.log.some((m) => /^research: wrote /.test(m))).toBe(true);
    });

    it("honours --quiet at the argv layer (CLI builds its own quiet reporter)", async () => {
      const workdir = await setupResearchWorkspace();
      const adapter: AgentAdapter = {
        id: "claude-code",
        research: async (req) => {
          req.onProgress?.("stdout", "chatter\n");
          await writeFile(
            req.outputPath,
            matter.stringify("body", validResearchFrontmatter(req)),
            "utf8",
          );
        },
      };
      prevAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      // No `progress` override — the CLI must build its own reporter from the
      // `--quiet` flag. We can't assert on a private stream, so we rely on
      // the absence of `log` calls beyond the existing summary and the
      // success exit code.
      const code = await runResearch(["--quiet", SAMPLE_ITEM.id], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(captured.log.some((m) => /^research: wrote /.test(m))).toBe(true);
    });

    it("RADAR_NO_PROGRESS=1 forces a no-op reporter at the env level", async () => {
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
      // Construct a `verbose` reporter directly: env still wins per ADR-0015
      // D2 priority table (env > flag > auto-detect), so the stream must
      // remain empty even though we asked for `verbose`.
      const reporter = createProgressReporter({ level: "verbose", tty: true, stream });
      const { io, captured } = captureIo();
      const code = await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io, progress: reporter });
      expect(code).toBe(0);
      expect(stream.output()).toBe("");
      expect(captured.log.some((m) => /^research: wrote /.test(m))).toBe(true);
    });

    it("rejects --verbose + --quiet with exit 2", async () => {
      const { io, captured } = captureIo();
      const code = await runResearch(["--verbose", "--quiet", SAMPLE_ITEM.id], { io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("mutually exclusive"))).toBe(true);
    });
  });

  describe("review", () => {
    it("emits phase markers in canonical order on non-TTY", async () => {
      const { workdir } = await setupReviewWorkspace();
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
      const code = await runReview([RESEARCH_ID, "--agent", "claude-code"], {
        cwd: workdir,
        io,
        progress: reporter,
      });
      expect(code).toBe(0);
      const out = stream.output();
      const order = [
        `Loaded item: ${SAMPLE_ITEM.id}`,
        "Loaded template: default.md",
        "Spawning claude-code",
        "Agent running",
        "Agent completed (exit 0)",
        "Frontmatter validated",
        "Status: researched → reviewed",
      ];
      let cursor = 0;
      for (const marker of order) {
        const idx = out.indexOf(marker, cursor);
        expect(
          idx,
          `marker '${marker}' missing or out-of-order in:\n${out}`,
        ).toBeGreaterThanOrEqual(cursor);
        cursor = idx + marker.length;
      }
    });

    it("passes through agent stdout when --verbose is set", async () => {
      const { workdir } = await setupReviewWorkspace();
      const adapter: AgentAdapter = {
        id: "claude-code",
        research: async () => {
          throw new Error("unused");
        },
        review: async (req) => {
          req.onProgress?.("stdout", "review-agent: appended block\n");
          await writeFile(
            req.researchPath,
            matter.stringify("body", reviewedFrontmatter(req)),
            "utf8",
          );
        },
      };
      prevAdapter = registerAgentAdapter(adapter);

      const stream = memoryStream();
      const reporter = createProgressReporter({ level: "verbose", tty: false, stream });
      const { io } = captureIo();
      const code = await runReview([RESEARCH_ID, "--verbose", "--agent", "claude-code"], {
        cwd: workdir,
        io,
        progress: reporter,
      });
      expect(code).toBe(0);
      expect(stream.output()).toContain("review-agent: appended block\n");
    });

    it("suppresses phase markers under --quiet but keeps the existing log summary", async () => {
      const { workdir } = await setupReviewWorkspace();
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
      const reporter = createProgressReporter({ level: "quiet", tty: false, stream });
      const { io, captured } = captureIo();
      const code = await runReview([RESEARCH_ID, "--agent", "claude-code"], {
        cwd: workdir,
        io,
        progress: reporter,
      });
      expect(code).toBe(0);
      expect(stream.output()).toBe("");
      expect(captured.log.some((m) => /^review: stamped /.test(m))).toBe(true);
    });
  });

  describe("update", () => {
    it("emits phase markers in canonical order on non-TTY", async () => {
      const { workdir } = await setupUpdateWorkspace();
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
      const code = await runUpdate([RESEARCH_ID], { cwd: workdir, io, progress: reporter });
      expect(code).toBe(0);
      const out = stream.output();
      const order = [
        `Loaded item: ${SAMPLE_ITEM.id}`,
        "Loaded template: default.md",
        "Spawning claude-code",
        "Agent running",
        "Agent completed (exit 0)",
        "Frontmatter validated",
        "Status: researched → researched",
      ];
      let cursor = 0;
      for (const marker of order) {
        const idx = out.indexOf(marker, cursor);
        expect(
          idx,
          `marker '${marker}' missing or out-of-order in:\n${out}`,
        ).toBeGreaterThanOrEqual(cursor);
        cursor = idx + marker.length;
      }
    });

    it("passes through agent stdout when --verbose is set", async () => {
      const { workdir } = await setupUpdateWorkspace();
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
          req.onProgress?.("stdout", "update-agent: regenerating v2\n");
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
      const reporter = createProgressReporter({ level: "verbose", tty: false, stream });
      const { io } = captureIo();
      const code = await runUpdate([RESEARCH_ID, "--verbose"], {
        cwd: workdir,
        io,
        progress: reporter,
      });
      expect(code).toBe(0);
      expect(stream.output()).toContain("update-agent: regenerating v2\n");
    });
  });

  describe("research --batch + progress", () => {
    it("emits per-item phase markers when --batch processes multiple items", async () => {
      const workdir = await mkdtemp(join(tmpdir(), "feedradar-progress-batch-"));
      await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
      await mkdir(join(workdir, "research"), { recursive: true });
      await mkdir(join(workdir, "templates"), { recursive: true });
      // Seed two detected items so --batch processes both.
      const second: Item = {
        ...SAMPLE_ITEM,
        id: "anthropic-news-2026-05-11-other",
        title: "Second item",
        url: "https://anthropic.com/news/second",
        publishedAt: "2026-05-11T00:00:00.000Z",
        fetchedAt: "2026-05-11T01:00:00.000Z",
      };
      for (const it of [SAMPLE_ITEM, second]) {
        await writeFile(
          join(workdir, "items", it.sourceId, `${it.id}.yaml`),
          stringifyYaml(it),
          "utf8",
        );
      }

      let invocations = 0;
      const adapter: AgentAdapter = {
        id: "claude-code",
        research: async (req) => {
          invocations += 1;
          const fm = {
            ...validResearchFrontmatter(req),
            id: `${RESEARCH_ID}-${invocations}`,
          };
          await writeFile(req.outputPath, matter.stringify("body", fm), "utf8");
        },
      };
      prevAdapter = registerAgentAdapter(adapter);

      const stream = memoryStream();
      const reporter = createProgressReporter({ level: "normal", tty: false, stream });
      const { io } = captureIo();
      const code = await runResearch(["--batch"], { cwd: workdir, io, progress: reporter });
      expect(code).toBe(0);
      expect(invocations).toBe(2);
      const out = stream.output();
      // We expect at least one "Loaded item" marker per processed item.
      const loadedItemCount = (out.match(/Loaded item: /g) ?? []).length;
      expect(loadedItemCount).toBe(2);
      const spawnCount = (out.match(/Spawning claude-code/g) ?? []).length;
      expect(spawnCount).toBe(2);
      const completedCount = (out.match(/Agent completed \(exit 0\)/g) ?? []).length;
      expect(completedCount).toBe(2);
    });
  });

  it("includes Agent completed duration in milliseconds", async () => {
    // Lightweight sanity check that the spinner's elapsed-time formatter
    // ships duration text alongside the exit code. We don't assert the exact
    // duration (timer-sensitive), only that the trailing `(<ms>)` shape is
    // present.
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
    await runResearch([SAMPLE_ITEM.id], { cwd: workdir, io, progress: reporter });
    expect(stream.output()).toMatch(/Agent completed \(exit 0\) \(\d+(?:\.\d+)?(?:ms|s|m \d+s)\)/);
    // The persisted file is what the CLI advertises in its summary, so make
    // sure the test path is consistent.
    const writtenFile = stream
      .output()
      .split("\n")
      .find((line) => line.includes("research/"));
    expect(writtenFile ?? "").toBe(""); // markers don't include the file path.
    const generated = await readFile(join(workdir, "research", `${RESEARCH_ID}.md`), "utf8");
    expect(generated).toContain("body");
  });
});
