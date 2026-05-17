import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runDismiss } from "../../src/cli/dismiss.js";
import type { Item } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

interface Captured {
  log: string[];
  error: string[];
}

function captureIo(): {
  io: { log: (m: string) => void; error: (m: string) => void };
  captured: Captured;
} {
  const captured: Captured = { log: [], error: [] };
  return {
    io: {
      log: (m) => captured.log.push(m),
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

async function writeItem(workdir: string, item: Item): Promise<void> {
  await mkdir(join(workdir, "items", item.sourceId), { recursive: true });
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
}

async function readItem(workdir: string, item: Item): Promise<Item> {
  const raw = await readFile(join(workdir, "items", item.sourceId, `${item.id}.yaml`), "utf8");
  return ItemSchema.parse(parseYaml(raw));
}

describe("cli/dismiss", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-dismiss-"));
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  it("transitions a detected item's status to dismissed", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(0);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.status).toBe("dismissed");
    // All other fields are preserved verbatim.
    expect(after.title).toBe(SAMPLE_ITEM.title);
    expect(after.url).toBe(SAMPLE_ITEM.url);
    expect(after.matchedKeywords).toEqual(SAMPLE_ITEM.matchedKeywords);

    expect(captured.log.some((m) => m.includes("status -> dismissed"))).toBe(true);
    expect(captured.error).toEqual([]);
  });

  it("rejects items already in 'researched' status with a user-friendly error", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "researched" });
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(
      captured.error.some(
        (m) => m.includes("status 'researched'") && m.includes("expected 'detected'"),
      ),
    ).toBe(true);
    // Status must not change.
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.status).toBe("researched");
  });

  it("rejects items already in 'reviewed' status", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "reviewed" });
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("status 'reviewed'"))).toBe(true);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.status).toBe("reviewed");
  });

  it("rejects items already in 'dismissed' status (no double-dismiss)", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "dismissed" });
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("status 'dismissed'"))).toBe(true);
  });

  it("errors when the item id does not exist", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();

    const code = await runDismiss(["ghost"], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not found") && m.includes("ghost"))).toBe(true);
  });

  it("errors when the items/ directory does not exist at all", async () => {
    // Fresh workspace with no items/ dir.
    const empty = await mkdtemp(join(tmpdir(), "feedradar-dismiss-empty-"));
    const { io, captured } = captureIo();

    const code = await runDismiss(["anything"], { cwd: empty, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not found"))).toBe(true);
  });

  it("errors when <item-id> is missing", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss([], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("missing <item-id>"))).toBe(true);
  });

  it("prints help with --help", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss(["--help"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.includes("Usage: radar dismiss"))).toBe(true);
    expect(captured.log.some((m) => m.includes("detected"))).toBe(true);
    expect(captured.log.some((m) => m.includes("dismissed"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss(["--bogus"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
  });

  it("rejects extra positional arguments", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss([SAMPLE_ITEM.id, "extra"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unexpected positional"))).toBe(true);
  });
});
