import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runUndismiss } from "../../src/cli/undismiss.js";
import type { Item } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Unit coverage for `radar undismiss` (ADR-0018 §W6).
 *
 * Two safety modes:
 *  - triage-origin (`dismissedBy: triage_<agent>`): silently revert
 *  - human-origin (`dismissedBy: "human"`): warn + require --force
 *  - legacy (no dismissedBy): treat as human (safer default)
 */

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

function makeDismissed(overrides: Partial<Item> = {}): Item {
  return ItemSchema.parse({
    id: "undismiss-target",
    sourceId: "test-source",
    title: "Dismissed item",
    url: "https://example.com/x",
    fetchedAt: "2026-05-20T00:00:00.000Z",
    matchedKeywords: ["test"],
    status: "dismissed",
    ...overrides,
  });
}

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

describe("cli/undismiss", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-undismiss-"));
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  it("silently reverts a triage-origin dismiss without --force", async () => {
    const item = makeDismissed({ dismissedBy: "triage_claude-code" });
    await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runUndismiss([item.id], { cwd: workdir, io });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, item);
    expect(after.status).toBe("detected");
    // No warn emission for triage-origin path.
    expect(captured.warn).toHaveLength(0);
    // dismissedBy cleared so subsequent re-dismiss starts fresh.
    expect(after.dismissedBy).toBeUndefined();
  });

  it("rejects a human-origin dismiss without --force", async () => {
    const item = makeDismissed({ dismissedBy: "human" });
    await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runUndismiss([item.id], { cwd: workdir, io });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.toLowerCase().includes("dismissed by human"))).toBe(true);
    // Status unchanged.
    expect((await readItem(workdir, item)).status).toBe("dismissed");
  });

  it("reverts a human-origin dismiss with --force (warn emitted)", async () => {
    const item = makeDismissed({ dismissedBy: "human" });
    await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runUndismiss([item.id, "--force"], { cwd: workdir, io });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect((await readItem(workdir, item)).status).toBe("detected");
    expect(captured.warn.some((m) => m.includes("human-origin"))).toBe(true);
  });

  it("treats legacy items (no dismissedBy) as human-origin", async () => {
    // Items written before ADR-0018 do not carry dismissedBy; the safer
    // default is to require --force, mirroring the human-origin path.
    const item = makeDismissed({ dismissedBy: undefined });
    await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runUndismiss([item.id], { cwd: workdir, io });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.toLowerCase().includes("dismissed by human"))).toBe(true);
  });

  it("rejects items not in 'dismissed' status", async () => {
    const item = ItemSchema.parse({
      id: "x",
      sourceId: "test-source",
      title: "Not dismissed",
      url: "https://example.com/x",
      fetchedAt: "2026-05-20T00:00:00.000Z",
      matchedKeywords: ["test"],
      status: "detected",
    });
    await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runUndismiss([item.id], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("status 'detected'"))).toBe(true);
  });

  it("errors when the item id does not exist", async () => {
    const { io, captured } = captureIo();
    const code = await runUndismiss(["ghost"], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not found"))).toBe(true);
  });

  it("errors when items/ directory does not exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "feedradar-undismiss-empty-"));
    const { io, captured } = captureIo();
    const code = await runUndismiss(["anything"], { cwd: empty, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("items/ not found"))).toBe(true);
  });

  it("errors when <item-id> is missing", async () => {
    const { io, captured } = captureIo();
    const code = await runUndismiss([], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("missing <item-id>"))).toBe(true);
  });

  it("prints help on --help", async () => {
    const { io, captured } = captureIo();
    const code = await runUndismiss(["--help"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.toLowerCase().includes("usage: radar undismiss"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { io, captured } = captureIo();
    const code = await runUndismiss(["--bogus"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
  });
});
