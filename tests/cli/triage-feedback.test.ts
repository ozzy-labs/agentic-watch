import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runTriage } from "../../src/cli/triage.js";
import type { Item, TriageDecision } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Unit coverage for `radar triage feedback` (ADR-0018 §W5).
 *
 * Feedback is overwrite-semantic per post-review: each invocation replaces
 * the existing `triage.feedback` array with a single entry. The array
 * shape is preserved so a future multi-reviewer CLI can extend without a
 * schema change.
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

const SAMPLE_TRIAGE: TriageDecision = {
  decision: "research",
  confidence: 0.85,
  reason: "Looks like a GA",
  agent: "claude-code",
  triagedAt: "2026-05-20T00:00:00.000Z",
  feedback: [],
};

const SAMPLE_ITEM: Item = ItemSchema.parse({
  id: "feedback-target",
  sourceId: "test-source",
  title: "Item to give feedback on",
  url: "https://example.com/x",
  fetchedAt: "2026-05-20T00:00:00.000Z",
  matchedKeywords: ["test"],
  status: "triaged_research",
  triage: SAMPLE_TRIAGE,
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

const NOW = "2026-05-23T10:00:00.000Z";

describe("cli/triage feedback", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-triage-feedback-"));
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  it("writes a --wrong feedback with reason to triage.feedback", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();

    const code = await runTriage(
      ["feedback", SAMPLE_ITEM.id, "--wrong", "--reason", "actually important"],
      { cwd: workdir, io, now: () => NOW },
    );

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.triage?.feedback).toHaveLength(1);
    expect(after.triage?.feedback[0]).toEqual({
      correct: false,
      reason: "actually important",
      feedbackAt: NOW,
    });
  });

  it("writes a --correct feedback (no reason required)", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();

    const code = await runTriage(["feedback", SAMPLE_ITEM.id, "--correct"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.triage?.feedback[0]?.correct).toBe(true);
    expect(after.triage?.feedback[0]?.reason).toBeUndefined();
  });

  it("overwrites existing feedback (current verdict only)", async () => {
    const seeded: Item = {
      ...SAMPLE_ITEM,
      triage: {
        ...SAMPLE_TRIAGE,
        feedback: [
          { correct: true, reason: "old verdict", feedbackAt: "2026-05-21T00:00:00.000Z" },
        ],
      },
    };
    await writeItem(workdir, seeded);
    const { io, captured } = captureIo();

    const code = await runTriage(
      ["feedback", SAMPLE_ITEM.id, "--wrong", "--reason", "second look"],
      { cwd: workdir, io, now: () => NOW },
    );

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, SAMPLE_ITEM);
    expect(after.triage?.feedback).toHaveLength(1);
    expect(after.triage?.feedback[0]?.correct).toBe(false);
    expect(after.triage?.feedback[0]?.reason).toBe("second look");
  });

  it("rejects when neither --correct nor --wrong is supplied", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();

    const code = await runTriage(["feedback", SAMPLE_ITEM.id], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("--correct | --wrong"))).toBe(true);
  });

  it("rejects when both --correct and --wrong are supplied", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();

    const code = await runTriage(["feedback", SAMPLE_ITEM.id, "--correct", "--wrong"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("mutually exclusive"))).toBe(true);
  });

  it("errors when the item has no prior triage decision", async () => {
    const noTriage: Item = { ...SAMPLE_ITEM, triage: undefined, status: "detected" };
    await writeItem(workdir, noTriage);
    const { io, captured } = captureIo();

    const code = await runTriage(["feedback", noTriage.id, "--correct"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("no prior triage decision"))).toBe(true);
  });

  it("errors when the item id does not exist", async () => {
    await writeItem(workdir, SAMPLE_ITEM);
    const { io, captured } = captureIo();
    const code = await runTriage(["feedback", "ghost", "--correct"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not found"))).toBe(true);
  });

  it("prints help on --help", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["feedback", "--help"], { cwd: workdir, io, now: () => NOW });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.toLowerCase().includes("triage feedback"))).toBe(true);
  });
});
