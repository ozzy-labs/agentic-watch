import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runTriage } from "../../src/cli/triage.js";
import type { Item } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";
import type { Source } from "../../src/schemas/source.js";
import { createTriageMock, makeItem } from "../helpers/triage-mock.js";

/**
 * Coverage for the host-agent (in-session) triage entry points
 * (#279 / ADR-0019): `radar triage --emit-payload` and `radar triage --commit`.
 *
 * The contract differs from research / review because triage writes a per-item
 * `TriageDecision` (no Markdown report). `--emit-payload` prints the agent-
 * neutral payload (the `buildTriagePrompt` request wrapped in host framing);
 * the host classifies the items and writes a decisions JSON; `--commit`
 * re-validates that JSON against the source's policy + on-disk detected items
 * (the SAME `parseTriageResponse` rules the spawn path runs) and applies the
 * status transitions. These tests assert the emit/commit pair behaves
 * identically to the spawn path's `--apply` finalize.
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

async function writeItem(workdir: string, item: Item): Promise<void> {
  await mkdir(join(workdir, "items", item.sourceId), { recursive: true });
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
}

async function readItem(workdir: string, sourceId: string, itemId: string): Promise<Item> {
  const raw = await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8");
  return ItemSchema.parse(parseYaml(raw));
}

async function writeSource(workdir: string, source: Source): Promise<void> {
  await mkdir(join(workdir, "sources"), { recursive: true });
  await writeFile(join(workdir, "sources", `${source.id}.yaml`), stringifyYaml(source), "utf8");
}

interface DecisionEntry {
  id: string;
  decision: "research" | "digest" | "dismiss" | "unsure";
  confidence: number;
  reason: string;
  group?: string;
}

async function writeDecisions(
  workdir: string,
  fileName: string,
  body: { agent: string; sourceId: string; decisions: DecisionEntry[] },
): Promise<string> {
  const dir = join(workdir, "triage");
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, JSON.stringify(body), "utf8");
  return path;
}

const TRIAGE_POLICY = {
  agent: "claude-code" as const,
  confidenceThreshold: 0.7,
  rules: "Test rules: GA => research, region => dismiss, UI => digest (group: ui)",
};

const SAMPLE_SOURCE: Source = {
  id: "test-source",
  kind: "rss" as const,
  url: "https://example.com/feed.xml",
  tags: [],
  filters: {
    keywords: ["test"],
    excludeKeywords: [],
    matchMode: "word" as const,
    matchFields: ["title", "summary"] as const,
    caseSensitive: false,
  },
  trustLevel: "untrusted" as const,
  triagePolicy: TRIAGE_POLICY,
};

const NOW = "2026-05-24T10:00:00.000Z";

describe("cli/triage --emit-payload", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-triage-host-"));
    await mkdir(join(workdir, "items"), { recursive: true });
    await writeSource(workdir, SAMPLE_SOURCE);
  });

  it("prints the payload without spawning an agent or touching items", async () => {
    await writeItem(workdir, makeItem({ id: "item-1", sourceId: "test-source" }));
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--emit-payload"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    // No agent spawn in host mode.
    expect(mock.callLog).toHaveLength(0);
    const out = captured.log.join("\n");
    expect(out).toContain("FEEDRADAR TRIAGE PAYLOAD (host-agent mode)");
    expect(out).toContain("radar triage --commit");
    // The embedded triage request carries the M1c boundary marker.
    expect(out).toContain('<untrusted_item id="item-1"');
    expect(out).toContain("<policy>");
    // The decisions path is under triage/.
    expect(out).toContain(join("triage", "test-source_decisions.json"));
    // Item unchanged.
    const after = await readItem(workdir, "test-source", "item-1");
    expect(after.status).toBe("detected");
    expect(after.triage).toBeUndefined();
  });

  it("rejects --emit-payload when more than one source has detected items", async () => {
    await writeSource(workdir, { ...SAMPLE_SOURCE, id: "second-source" });
    await writeItem(workdir, makeItem({ id: "a", sourceId: "test-source" }));
    await writeItem(workdir, makeItem({ id: "b", sourceId: "second-source" }));
    const { io, captured } = captureIo();

    const code = await runTriage(["--emit-payload"], { cwd: workdir, io, now: () => NOW });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("single source group"))).toBe(true);
  });

  it("narrows to one source via --source for a multi-source workspace", async () => {
    await writeSource(workdir, { ...SAMPLE_SOURCE, id: "second-source" });
    await writeItem(workdir, makeItem({ id: "a", sourceId: "test-source" }));
    await writeItem(workdir, makeItem({ id: "b", sourceId: "second-source" }));
    const { io, captured } = captureIo();

    const code = await runTriage(["--emit-payload", "--source", "test-source"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const out = captured.log.join("\n");
    expect(out).toContain('<untrusted_item id="a"');
    expect(out).not.toContain('<untrusted_item id="b"');
  });

  it("is incompatible with --apply", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["--emit-payload", "--apply"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("incompatible"))).toBe(true);
  });
});

describe("cli/triage --commit", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-triage-host-"));
    await mkdir(join(workdir, "items"), { recursive: true });
    await writeSource(workdir, SAMPLE_SOURCE);
  });

  it("applies host-written decisions and transitions status (parity with --apply)", async () => {
    await writeItem(workdir, makeItem({ id: "ga-item", sourceId: "test-source" }));
    await writeItem(workdir, makeItem({ id: "region-item", sourceId: "test-source" }));
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "claude-code",
      sourceId: "test-source",
      decisions: [
        { id: "ga-item", decision: "research", confidence: 0.9, reason: "GA" },
        { id: "region-item", decision: "dismiss", confidence: 0.85, reason: "region" },
      ],
    });
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const ga = await readItem(workdir, "test-source", "ga-item");
    expect(ga.status).toBe("triaged_research");
    expect(ga.triage?.decision).toBe("research");
    expect(ga.triage?.agent).toBe("claude-code");
    expect(ga.triage?.triagedAt).toBe(NOW);

    const region = await readItem(workdir, "test-source", "region-item");
    expect(region.status).toBe("dismissed");
    expect(region.dismissedBy).toBe("triage_claude-code");
    expect(region.triage?.decision).toBe("dismiss");
  });

  it("stamps dismissedBy / triage.agent from the decisions file agent field", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "gemini-cli",
      sourceId: "test-source",
      decisions: [{ id: "x", decision: "dismiss", confidence: 0.9, reason: "x" }],
    });
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, "test-source", "x");
    expect(after.dismissedBy).toBe("triage_gemini-cli");
    expect(after.triage?.agent).toBe("gemini-cli");
  });

  it("re-applies the confidence-threshold demotion the spawn path uses", async () => {
    await writeItem(workdir, makeItem({ id: "low-conf", sourceId: "test-source" }));
    // confidence 0.5 < threshold 0.7 → demoted to unsure by parseTriageResponse.
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "claude-code",
      sourceId: "test-source",
      decisions: [{ id: "low-conf", decision: "research", confidence: 0.5, reason: "maybe" }],
    });
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, "test-source", "low-conf");
    expect(after.status).toBe("triaged_unsure");
    expect(after.triage?.decision).toBe("unsure");
  });

  it("rejects a hallucinated id and records the omitted real item as unsure", async () => {
    await writeItem(workdir, makeItem({ id: "real", sourceId: "test-source" }));
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "claude-code",
      sourceId: "test-source",
      decisions: [{ id: "ghost", decision: "research", confidence: 0.95, reason: "hallucinated" }],
    });
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    // The real item was omitted by the host → recorded as unsure (coverage).
    const after = await readItem(workdir, "test-source", "real");
    expect(after.status).toBe("triaged_unsure");
    expect(after.triage?.reason).toBe("host-omitted");
    // Hallucinated id never persisted.
    expect(captured.warn.some((m) => m.includes("hallucinated"))).toBe(true);
  });

  it("rejects a decisions path outside triage/", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const outside = join(workdir, "evil.json");
    await writeFile(
      outside,
      JSON.stringify({ agent: "claude-code", sourceId: "test-source", decisions: [] }),
      "utf8",
    );
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", outside], { cwd: workdir, io, now: () => NOW });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("must be a file under"))).toBe(true);
  });

  it("rejects an invalid agent id in the decisions file", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "bogus-agent",
      sourceId: "test-source",
      decisions: [{ id: "x", decision: "research", confidence: 0.9, reason: "x" }],
    });
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("not a valid agent id"))).toBe(true);
  });

  it("rejects a malformed decisions file (schema mismatch)", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const dir = join(workdir, "triage");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "test-source_decisions.json");
    await writeFile(path, JSON.stringify({ not: "the right shape" }), "utf8");
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("does not match the expected shape"))).toBe(true);
  });

  it("rejects an unknown source referenced by the decisions file", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const path = await writeDecisions(workdir, "ghost_decisions.json", {
      agent: "claude-code",
      sourceId: "ghost-source",
      decisions: [{ id: "x", decision: "research", confidence: 0.9, reason: "x" }],
    });
    const { io, captured } = captureIo();

    const code = await runTriage(["--commit", path], { cwd: workdir, io, now: () => NOW });

    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("unknown source"))).toBe(true);
  });

  it("is incompatible with run-mode flags", async () => {
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "claude-code",
      sourceId: "test-source",
      decisions: [],
    });
    const { io, captured } = captureIo();
    const code = await runTriage(["--commit", path, "--apply"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("incompatible"))).toBe(true);
  });

  it("emit → host writes decisions → commit round-trips to the same status as --apply", async () => {
    await writeItem(workdir, makeItem({ id: "round", sourceId: "test-source" }));
    // 1. emit-payload (host mode); capture the decisions path from the payload.
    const emitIo = captureIo();
    const emitCode = await runTriage(["--emit-payload"], {
      cwd: workdir,
      io: emitIo.io,
      now: () => NOW,
    });
    expect(emitCode, `stderr: ${emitIo.captured.error.join("\n")}`).toBe(0);

    // 2. Host writes the decisions JSON to the advertised path.
    const path = await writeDecisions(workdir, "test-source_decisions.json", {
      agent: "claude-code",
      sourceId: "test-source",
      decisions: [{ id: "round", decision: "research", confidence: 0.9, reason: "ok" }],
    });

    // 3. commit finalizes.
    const commitIo = captureIo();
    const commitCode = await runTriage(["--commit", path], {
      cwd: workdir,
      io: commitIo.io,
      now: () => NOW,
    });
    expect(commitCode, `stderr: ${commitIo.captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, "test-source", "round");
    expect(after.status).toBe("triaged_research");
    expect(after.triage?.decision).toBe("research");
  });
});
