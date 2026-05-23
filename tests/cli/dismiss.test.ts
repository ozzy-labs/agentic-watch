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

  it("dismisses a triaged_unsure item (state machine allows it; ADR-0018)", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "triaged_unsure" });
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(0);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.status).toBe("dismissed");
    expect(captured.error).toEqual([]);
  });

  it("rejects items already in 'researched' status with a user-friendly error", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "researched" });
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(
      captured.error.some(
        (m) => m.includes("status 'researched'") && m.includes("detected | triaged_unsure"),
      ),
    ).toBe(true);
    // Status must not change.
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.status).toBe("researched");
  });

  it("rejects items in 'triaged_research' status (not dismissible per state machine)", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "triaged_research" });
    const { io, captured } = captureIo();

    const code = await runDismiss([SAMPLE_ITEM.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("status 'triaged_research'"))).toBe(true);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.status).toBe("triaged_research");
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
    expect(captured.log.some((m) => m.includes("Usage:"))).toBe(true);
    expect(captured.log.some((m) => m.includes("radar dismiss"))).toBe(true);
    expect(captured.log.some((m) => m.includes("--batch"))).toBe(true);
    expect(captured.log.some((m) => m.includes("--status"))).toBe(true);
    expect(captured.log.some((m) => m.includes("--filter-tags"))).toBe(true);
    expect(captured.log.some((m) => m.includes("dismissed"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss(["--bogus"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
  });

  // --- multiple positional ids -------------------------------------------

  const ITEM_A: Item = ItemSchema.parse({
    id: "anthropic-news-2026-05-10-a",
    sourceId: "anthropic-news",
    title: "Item A",
    url: "https://anthropic.com/news/a",
    publishedAt: "2026-05-10T00:00:00.000Z",
    fetchedAt: "2026-05-10T01:00:00.000Z",
    summary: "A.",
    matchedKeywords: ["security"],
    status: "detected",
  });
  const ITEM_B: Item = ItemSchema.parse({
    id: "aws-2026-05-11-b",
    sourceId: "aws-whats-new",
    title: "Item B",
    url: "https://aws.amazon.com/new/b",
    publishedAt: "2026-05-11T00:00:00.000Z",
    fetchedAt: "2026-05-11T01:00:00.000Z",
    summary: "B.",
    matchedKeywords: ["breaking-change"],
    status: "detected",
  });

  it("dismisses multiple ids in one call (cross-source)", async () => {
    await writeItem(workdir, ITEM_A);
    await writeItem(workdir, ITEM_B);
    const { io, captured } = captureIo();

    const code = await runDismiss([ITEM_A.id, ITEM_B.id], { cwd: workdir, io });

    expect(code).toBe(0);
    expect((await readItem(workdir, ITEM_A)).status).toBe("dismissed");
    expect((await readItem(workdir, ITEM_B)).status).toBe("dismissed");
    expect(captured.error).toEqual([]);
  });

  it("rejects the whole multi-id call if any id is in a non-dismissible status", async () => {
    await writeItem(workdir, ITEM_A);
    await writeItem(workdir, { ...ITEM_B, status: "reviewed" });
    const { io, captured } = captureIo();

    const code = await runDismiss([ITEM_A.id, ITEM_B.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes(ITEM_B.id) && m.includes("reviewed"))).toBe(true);
    // No partial write: the valid item must stay untouched.
    expect((await readItem(workdir, ITEM_A)).status).toBe("detected");
    expect((await readItem(workdir, ITEM_B)).status).toBe("reviewed");
  });

  it("errors with the missing id if any multi-id is not found", async () => {
    await writeItem(workdir, ITEM_A);
    const { io, captured } = captureIo();

    const code = await runDismiss([ITEM_A.id, "ghost"], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not found") && m.includes("ghost"))).toBe(true);
    expect((await readItem(workdir, ITEM_A)).status).toBe("detected");
  });

  // --- --batch ------------------------------------------------------------

  it("--batch dismisses every detected item by default", async () => {
    await writeItem(workdir, ITEM_A);
    await writeItem(workdir, ITEM_B);
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "researched" });
    const { io, captured } = captureIo();

    const code = await runDismiss(["--batch"], { cwd: workdir, io });

    expect(code).toBe(0);
    expect((await readItem(workdir, ITEM_A)).status).toBe("dismissed");
    expect((await readItem(workdir, ITEM_B)).status).toBe("dismissed");
    // researched item is outside the default `detected` filter — untouched.
    expect((await readItem(workdir, SAMPLE_ITEM)).status).toBe("researched");
    expect(captured.log.some((m) => m.includes("--batch completed 2 item(s)"))).toBe(true);
  });

  it("--batch --status triaged_unsure targets only triaged_unsure items", async () => {
    await writeItem(workdir, ITEM_A); // detected
    await writeItem(workdir, { ...ITEM_B, status: "triaged_unsure" });
    const { io, captured } = captureIo();

    const code = await runDismiss(["--batch", "--status", "triaged_unsure"], { cwd: workdir, io });

    expect(code).toBe(0);
    expect((await readItem(workdir, ITEM_A)).status).toBe("detected");
    expect((await readItem(workdir, ITEM_B)).status).toBe("dismissed");
    expect(captured.error).toEqual([]);
  });

  it("--batch rejects an invalid --status with the allow-list", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss(["--batch", "--status", "triaged_research"], {
      cwd: workdir,
      io,
    });
    expect(code).toBe(2);
    expect(
      captured.error.some(
        (m) => m.includes("invalid --status") && m.includes("detected | triaged_unsure"),
      ),
    ).toBe(true);
  });

  it("--batch --filter-tags matches matchedKeywords case-insensitively", async () => {
    await writeItem(workdir, ITEM_A); // security
    await writeItem(workdir, ITEM_B); // breaking-change
    const { io, captured } = captureIo();

    const code = await runDismiss(["--batch", "--filter-tags", "SECURITY"], { cwd: workdir, io });

    expect(code).toBe(0);
    expect((await readItem(workdir, ITEM_A)).status).toBe("dismissed");
    expect((await readItem(workdir, ITEM_B)).status).toBe("detected");
    expect(captured.error).toEqual([]);
  });

  it("--batch --max-items caps and warns about dropped excess", async () => {
    await writeItem(workdir, ITEM_A);
    await writeItem(workdir, ITEM_B);
    const { io, captured } = captureIo();

    const code = await runDismiss(["--batch", "--max-items", "1"], { cwd: workdir, io });

    expect(code).toBe(0);
    // Oldest-first: ITEM_A (2026-05-10) is processed, ITEM_B (2026-05-11) dropped.
    expect((await readItem(workdir, ITEM_A)).status).toBe("dismissed");
    expect((await readItem(workdir, ITEM_B)).status).toBe("detected");
    expect(captured.warn.some((m) => m.includes("--max-items 1 cap reached"))).toBe(true);
  });

  it("--batch reports 0 matches without writing", async () => {
    await writeItem(workdir, { ...SAMPLE_ITEM, status: "researched" });
    const { io, captured } = captureIo();

    const code = await runDismiss(["--batch"], { cwd: workdir, io });

    expect(code).toBe(0);
    expect(captured.log.some((m) => m.includes("no items matched --batch filters"))).toBe(true);
  });

  it("--batch rejects positional ids", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss(["--batch", SAMPLE_ITEM.id], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("--batch is incompatible"))).toBe(true);
  });

  it("rejects --status without --batch", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss([SAMPLE_ITEM.id, "--status", "detected"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("--status requires --batch"))).toBe(true);
  });

  it("rejects --max-items without --batch", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss([SAMPLE_ITEM.id, "--max-items", "5"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("--max-items requires --batch"))).toBe(true);
  });

  it("rejects --filter-tags without --batch", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss([SAMPLE_ITEM.id, "--filter-tags", "x"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("--filter-tags requires --batch"))).toBe(true);
  });

  it("--batch rejects an invalid --max-items", async () => {
    const { io, captured } = captureIo();
    const code = await runDismiss(["--batch", "--max-items", "0"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("--max-items"))).toBe(true);
  });
});
