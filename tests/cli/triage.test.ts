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
 * Unit coverage for `radar triage` (ADR-0018 PR-3).
 *
 * Each test stubs out the agent runner via the shared mock helper so the
 * suite never spawns a real CLI. The mock pins decisions per item id, so
 * the assertions can focus on CLI surface concerns (option parsing, status
 * transitions, dry-run vs apply, multi-source aggregation) instead of
 * `triageItems` internals (covered in `tests/core/triage/`).
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

const NOW = "2026-05-23T10:00:00.000Z";

describe("cli/triage run", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-triage-"));
    await mkdir(join(workdir, "items"), { recursive: true });
    await writeSource(workdir, SAMPLE_SOURCE);
  });

  it("dry-run prints decisions without writing to disk", async () => {
    await writeItem(workdir, makeItem({ id: "item-1", sourceId: "test-source" }));
    await writeItem(workdir, makeItem({ id: "item-2", sourceId: "test-source" }));
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--dry-run"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect(captured.log.some((m) => m.includes("dry-run"))).toBe(true);
    expect(captured.log.some((m) => m.includes("item-1"))).toBe(true);
    // Item file unchanged.
    const after = await readItem(workdir, "test-source", "item-1");
    expect(after.status).toBe("detected");
    expect(after.triage).toBeUndefined();
  });

  it("--apply writes decisions and transitions status", async () => {
    await writeItem(workdir, makeItem({ id: "ga-item", sourceId: "test-source" }));
    await writeItem(workdir, makeItem({ id: "region-item", sourceId: "test-source" }));
    const decisions = new Map([
      ["ga-item", { decision: "research" as const, confidence: 0.9, reason: "GA" }],
      ["region-item", { decision: "dismiss" as const, confidence: 0.85, reason: "region" }],
    ]);
    const mock = createTriageMock({ decisions });
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const ga = await readItem(workdir, "test-source", "ga-item");
    expect(ga.status).toBe("triaged_research");
    expect(ga.triage?.decision).toBe("research");

    const region = await readItem(workdir, "test-source", "region-item");
    expect(region.status).toBe("dismissed");
    expect(region.dismissedBy).toBe("triage_claude-code");
    expect(region.triage?.decision).toBe("dismiss");
  });

  it("--triage-agent overrides the policy agent and stamps dismissedBy accordingly", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const decisions = new Map([
      ["x", { decision: "dismiss" as const, confidence: 0.9, reason: "x" }],
    ]);
    const mock = createTriageMock({ decisions });
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--triage-agent", "gemini-cli"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, "test-source", "x");
    expect(after.dismissedBy).toBe("triage_gemini-cli");
    expect(after.triage?.agent).toBe("gemini-cli");
  });

  it("--source narrows triage to a single source", async () => {
    // Add a second source without a policy; the items from it should be
    // ignored when --source pins us to test-source.
    await writeSource(workdir, { ...SAMPLE_SOURCE, id: "other-source", triagePolicy: undefined });
    await writeItem(workdir, makeItem({ id: "a", sourceId: "test-source" }));
    await writeItem(workdir, makeItem({ id: "b", sourceId: "other-source" }));
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--source", "test-source"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect((await readItem(workdir, "test-source", "a")).status).toBe("triaged_research");
    expect((await readItem(workdir, "other-source", "b")).status).toBe("detected");
    expect(mock.callLog).toHaveLength(1);
  });

  it("--filter-tags drops items whose matchedKeywords miss the allow-list", async () => {
    await writeItem(
      workdir,
      makeItem({ id: "keep", sourceId: "test-source", matchedKeywords: ["claude"] }),
    );
    await writeItem(
      workdir,
      makeItem({ id: "drop", sourceId: "test-source", matchedKeywords: ["other"] }),
    );
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--filter-tags", "claude"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect((await readItem(workdir, "test-source", "keep")).status).toBe("triaged_research");
    expect((await readItem(workdir, "test-source", "drop")).status).toBe("detected");
  });

  it("--max-items caps the processed item count and warns on overflow", async () => {
    for (let i = 0; i < 3; i++) {
      await writeItem(workdir, makeItem({ id: `i${i}`, sourceId: "test-source" }));
    }
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--max-items", "2"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    // Exactly 2 items transitioned; the third stayed detected.
    let transitioned = 0;
    for (let i = 0; i < 3; i++) {
      const item = await readItem(workdir, "test-source", `i${i}`);
      if (item.status !== "detected") transitioned += 1;
    }
    expect(transitioned).toBe(2);
    expect(captured.warn.some((m) => m.includes("--max-items 2"))).toBe(true);
  });

  it("skips sources without a triagePolicy (warns, does not error)", async () => {
    await writeSource(workdir, { ...SAMPLE_SOURCE, id: "no-policy", triagePolicy: undefined });
    await writeItem(workdir, makeItem({ id: "orphan", sourceId: "no-policy" }));
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code).toBe(0);
    expect(captured.warn.some((m) => m.includes("no triagePolicy"))).toBe(true);
    expect((await readItem(workdir, "no-policy", "orphan")).status).toBe("detected");
  });

  it("--policy loads an override YAML that supersedes per-source policy", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const policyPath = join(workdir, "_policy.yaml");
    await writeFile(
      policyPath,
      stringifyYaml({
        agent: "codex-cli",
        confidenceThreshold: 0.5,
        rules: "override rules: everything is research",
      }),
      "utf8",
    );
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--policy", policyPath], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const after = await readItem(workdir, "test-source", "x");
    expect(after.triage?.agent).toBe("codex-cli");
  });

  it("rejects an unknown --triage-agent value", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--triage-agent", "bogus"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("not a valid agent id"))).toBe(true);
  });

  it("rejects mutually-exclusive mode flags", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["--dry-run", "--apply"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("mutually exclusive"))).toBe(true);
  });

  it("--interactive opens the editor seam then applies on confirmation", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const mock = createTriageMock();
    let editorCalledWith: string | null = null;
    const { io, captured } = captureIo();

    const code = await runTriage(["--interactive"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
      editor: async (path) => {
        editorCalledWith = path;
      },
      confirm: async () => true,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect(editorCalledWith).not.toBeNull();
    expect((await readItem(workdir, "test-source", "x")).status).toBe("triaged_research");
  });

  it("--interactive aborts when user does not confirm", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--interactive"], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
      editor: async () => {},
      confirm: async () => false,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    expect(captured.log.some((m) => m.includes("aborted"))).toBe(true);
    expect((await readItem(workdir, "test-source", "x")).status).toBe("detected");
  });

  it("prints help on --help", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["--help"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.toLowerCase().includes("usage: radar triage"))).toBe(true);
  });

  it("--audit-log path forwards to the underlying triageItems orchestrator", async () => {
    await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
    const auditPath = join(workdir, "_audit.jsonl");
    const mock = createTriageMock();
    const { io, captured } = captureIo();

    const code = await runTriage(["--apply", "--audit-log", auditPath], {
      cwd: workdir,
      io,
      runner: mock.runner,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const audit = await readFile(auditPath, "utf8");
    expect(audit.trim().length).toBeGreaterThan(0);
    // Each line is a valid JSON record from the orchestrator.
    const lines = audit.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.status).toBe("ok");
    }
  });

  // #342 B1 / A6: the per-source "Triaging …" progress marker and the
  // interactive apply-confirm prompt now route through the translator.
  describe("progress + confirm prompt locale (#342 B1/A6)", () => {
    it("localizes the per-source 'Triaging …' progress marker (--verbose)", async () => {
      await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
      const mock = createTriageMock();
      // The progress reporter writes to process.stderr (not the io sinks), so
      // spy on it to capture the phase marker. --verbose keeps the reporter on.
      const writes: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      const spy = (chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      };
      // biome-ignore lint/suspicious/noExplicitAny: test-only stderr spy
      process.stderr.write = spy as any;
      try {
        const code = await runTriage(["--dry-run", "--verbose", "--lang", "ja"], {
          cwd: workdir,
          runner: mock.runner,
          now: () => NOW,
        });
        expect(code).toBe(0);
      } finally {
        process.stderr.write = original;
      }
      const out = writes.join("");
      // English literal "Triaging" gone; Japanese marker present.
      expect(out.includes("Triaging ")).toBe(false);
      expect(out.includes("で triage 中")).toBe(true);
    });

    it("localizes the interactive apply-confirm prompt", async () => {
      await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
      const mock = createTriageMock();
      let promptMessage: string | null = null;
      const { io } = captureIo();
      await runTriage(["--interactive", "--lang", "ja"], {
        cwd: workdir,
        io,
        runner: mock.runner,
        now: () => NOW,
        editor: async () => {},
        confirm: async (message) => {
          promptMessage = message;
          return false;
        },
      });
      expect(promptMessage).not.toBeNull();
      expect(promptMessage).not.toContain("Apply these decisions?");
      expect(promptMessage).toContain("適用しますか");
    });

    it("defaults the confirm prompt to English without --lang", async () => {
      await writeItem(workdir, makeItem({ id: "x", sourceId: "test-source" }));
      const mock = createTriageMock();
      let promptMessage: string | null = null;
      const { io } = captureIo();
      await runTriage(["--interactive"], {
        cwd: workdir,
        io,
        runner: mock.runner,
        now: () => NOW,
        editor: async () => {},
        confirm: async (message) => {
          promptMessage = message;
          return false;
        },
      });
      expect(promptMessage).toContain("Apply these decisions? [y/N]");
    });
  });
});
