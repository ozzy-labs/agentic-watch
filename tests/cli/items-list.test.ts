import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runItems } from "../../src/cli/items.js";
import type { Item } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Unit coverage for `radar items list` (ADR-0018 PR-3).
 */

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

function makeItem(overrides: Partial<Item> = {}): Item {
  return ItemSchema.parse({
    id: overrides.id ?? "default-id",
    sourceId: overrides.sourceId ?? "test-source",
    title: overrides.title ?? "Default title",
    url: overrides.url ?? "https://example.com/x",
    fetchedAt: overrides.fetchedAt ?? "2026-05-20T00:00:00.000Z",
    publishedAt: overrides.publishedAt,
    matchedKeywords: overrides.matchedKeywords ?? ["test"],
    status: overrides.status ?? "detected",
    triage: overrides.triage,
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

describe("cli/items list", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-items-list-"));
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  it("default tabular output lists all items", async () => {
    await writeItem(workdir, makeItem({ id: "alpha", status: "detected" }));
    await writeItem(workdir, makeItem({ id: "beta", status: "triaged_research" }));
    const { io, captured } = captureIo();

    const code = await runItems(["list"], { cwd: workdir, io });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const all = captured.log.join("\n");
    expect(all).toContain("alpha");
    expect(all).toContain("beta");
    expect(all).toContain("STATUS");
  });

  it("--status filters by exact match", async () => {
    await writeItem(workdir, makeItem({ id: "a", status: "detected" }));
    await writeItem(workdir, makeItem({ id: "b", status: "triaged_research" }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--status", "triaged_research"], {
      cwd: workdir,
      io,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const all = captured.log.join("\n");
    expect(all).toContain("b");
    expect(all).not.toContain("a ");
  });

  it("--status rejects an unknown enum value with a helpful list", async () => {
    const { io, captured } = captureIo();
    const code = await runItems(["list", "--status", "bogus"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid --status"))).toBe(true);
    expect(captured.error.some((m) => m.includes("triaged_research"))).toBe(true);
  });

  it("--source filters by sourceId", async () => {
    await writeItem(workdir, makeItem({ id: "a", sourceId: "src-a" }));
    await writeItem(workdir, makeItem({ id: "b", sourceId: "src-b" }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--source", "src-a"], { cwd: workdir, io });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const all = captured.log.join("\n");
    expect(all).toContain("src-a");
    expect(all).not.toContain("src-b");
  });

  it("--triage-group filters by triage.group", async () => {
    const groupTriage = {
      decision: "digest" as const,
      confidence: 0.9,
      reason: "ui",
      group: "ui-features",
      agent: "claude-code",
      triagedAt: "2026-05-20T00:00:00.000Z",
      feedback: [],
    };
    await writeItem(
      workdir,
      makeItem({ id: "ui-a", status: "triaged_digest", triage: groupTriage }),
    );
    await writeItem(
      workdir,
      makeItem({ id: "ui-b", status: "triaged_digest", triage: groupTriage }),
    );
    await writeItem(workdir, makeItem({ id: "other", status: "detected" }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--triage-group", "ui-features"], {
      cwd: workdir,
      io,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const all = captured.log.join("\n");
    expect(all).toContain("ui-a");
    expect(all).toContain("ui-b");
    expect(all).not.toContain("other");
  });

  it("--since drops items older than the cutoff", async () => {
    // Old item (publishedAt ~ 30 days ago) and fresh item (today).
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const freshDate = new Date(Date.now() - 1 * 3_600_000).toISOString();
    await writeItem(workdir, makeItem({ id: "old", publishedAt: oldDate }));
    await writeItem(workdir, makeItem({ id: "fresh", publishedAt: freshDate }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--since", "7d"], { cwd: workdir, io });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const all = captured.log.join("\n");
    expect(all).toContain("fresh");
    expect(all).not.toContain(" old ");
  });

  it("--since rejects unparsable cutoffs", async () => {
    await writeItem(workdir, makeItem({ id: "x" }));
    const { io, captured } = captureIo();
    const code = await runItems(["list", "--since", "yesterday"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid --since"))).toBe(true);
  });

  it("--limit caps the result count after filtering", async () => {
    for (let i = 0; i < 5; i++) {
      await writeItem(
        workdir,
        makeItem({
          id: `i-${i}`,
          // Sort key is publishedAt desc; vary so the order is deterministic.
          publishedAt: new Date(2026, 0, i + 1).toISOString(),
        }),
      );
    }
    const { io, captured } = captureIo();
    const code = await runItems(["list", "--limit", "2"], { cwd: workdir, io });
    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    // Header + 2 rows.
    const dataRows = captured.log.filter((l) => l.startsWith("i-"));
    expect(dataRows).toHaveLength(2);
  });

  it("--json emits a JSON array parseable into Item[]", async () => {
    await writeItem(workdir, makeItem({ id: "a", status: "triaged_unsure" }));
    await writeItem(workdir, makeItem({ id: "b", status: "triaged_unsure" }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--status", "triaged_unsure", "--json"], {
      cwd: workdir,
      io,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const json = JSON.parse(captured.log.join("\n"));
    expect(json).toHaveLength(2);
    const ids = (json as { id: string }[]).map((x) => x.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("--field emits one value per line for piping", async () => {
    const triage = {
      decision: "research" as const,
      confidence: 0.9,
      reason: "x",
      agent: "claude-code",
      triagedAt: "2026-05-20T00:00:00.000Z",
      feedback: [],
    };
    await writeItem(workdir, makeItem({ id: "a", status: "triaged_research", triage }));
    await writeItem(workdir, makeItem({ id: "b", status: "triaged_research", triage }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--status", "triaged_research", "--field", "id"], {
      cwd: workdir,
      io,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const ids = captured.log.filter((l) => l === "a" || l === "b").sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("--field supports nested dot paths (triage.decision)", async () => {
    const triage = {
      decision: "digest" as const,
      confidence: 0.9,
      reason: "ui",
      group: "ui",
      agent: "claude-code",
      triagedAt: "2026-05-20T00:00:00.000Z",
      feedback: [],
    };
    await writeItem(workdir, makeItem({ id: "a", status: "triaged_digest", triage }));
    const { io, captured } = captureIo();

    const code = await runItems(["list", "--field", "triage.decision"], {
      cwd: workdir,
      io,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect(captured.log).toContain("digest");
  });

  it("returns an empty list when items/ is empty", async () => {
    const { io, captured } = captureIo();
    const code = await runItems(["list"], { cwd: workdir, io });
    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect(captured.log.some((m) => m.includes("no items match"))).toBe(true);
  });

  it("returns [] when items/ does not exist (--json)", async () => {
    const empty = await mkdtemp(join(tmpdir(), "feedradar-items-empty-"));
    const { io, captured } = captureIo();
    const code = await runItems(["list", "--json"], { cwd: empty, io });
    expect(code).toBe(0);
    expect(captured.log.join("\n")).toBe("[]");
  });

  it("prints help on --help", async () => {
    const { io, captured } = captureIo();
    const code = await runItems(["list", "--help"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.toLowerCase().includes("usage:"))).toBe(true);
  });

  it("rejects unknown subcommand", async () => {
    const { io, captured } = captureIo();
    const code = await runItems(["bogus"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown subcommand"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { io, captured } = captureIo();
    const code = await runItems(["list", "--bogus"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
  });
});
