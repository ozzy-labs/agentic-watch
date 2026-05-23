import { describe, expect, it } from "vitest";
import { triageItems } from "../../../src/core/triage/index.js";
import type { SourceTriagePolicy } from "../../../src/schemas/source.js";
import { createTriageMock, makeItem } from "../../helpers/triage-mock.js";

/**
 * End-to-end coverage for `triageItems(items, options)` via a mock runner.
 *
 * The mock simulates a faithful agent (boundary-marker aware, returns
 * well-formed JSON keyed by id), and the tests assert the orchestrator wires
 * the prompt → runner → parser pipeline correctly.
 */

const POLICY: SourceTriagePolicy = {
  agent: "gemini-cli",
  confidenceThreshold: 0.7,
  rules: "重要 (research): GA / 価格改定\n軽微 (dismiss): リージョン拡張",
};

describe("core/triage/triageItems — happy path", () => {
  it("returns one TriageDecision per input item with the agent id stamped", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-a" }), makeItem({ id: "src-1-2026-05-23-b" })];
    const mock = createTriageMock();
    const result = await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      now: () => "2026-05-23T00:00:00.000Z",
    });

    expect(result.fallback).toBe(false);
    expect(result.decisions.size).toBe(2);
    for (const item of items) {
      const decision = result.decisions.get(item.id);
      expect(decision).toBeDefined();
      expect(decision?.agent).toBe("gemini-cli");
      expect(decision?.triagedAt).toBe("2026-05-23T00:00:00.000Z");
      expect(decision?.feedback).toEqual([]);
    }
  });

  it("invokes the runner exactly once on a clean happy path", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-once" })];
    const mock = createTriageMock();
    await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      sleep: async () => {},
    });
    expect(mock.callLog).toHaveLength(1);
  });

  it("passes the built prompt (with boundary markers) to the runner", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-prompt" })];
    const mock = createTriageMock();
    await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
    });
    const [call] = mock.callLog;
    expect(call.prompt).toContain("<untrusted_item ");
    expect(call.prompt).toContain("</untrusted_item>");
    expect(call.prompt).toContain("<policy>");
    expect(call.prompt).toContain("</policy>");
  });

  it("fills missing ids with an unsure 'agent-omitted' decision", async () => {
    // Drive an actual omission by handing the orchestrator two items but
    // returning an empty agent array. The orchestrator should fall back per
    // item to `unsure` with `reason: "agent-omitted"`, not to a global
    // fallback (which would require the agent itself to have failed).
    const items = [
      makeItem({ id: "src-1-2026-05-23-omit-a" }),
      makeItem({ id: "src-1-2026-05-23-omit-b" }),
    ];
    const result = await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: async () => ({ status: "ok", stdout: "[]", stderr: "", exitCode: 0 }),
    });
    expect(result.fallback).toBe(false);
    for (const item of items) {
      expect(result.decisions.get(item.id)?.decision).toBe("unsure");
      expect(result.decisions.get(item.id)?.reason).toBe("agent-omitted");
    }
  });
});

describe("core/triage/triageItems — empty input", () => {
  it("returns an empty result without invoking the runner", async () => {
    const mock = createTriageMock();
    const result = await triageItems([], {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
    });
    expect(result.decisions.size).toBe(0);
    expect(result.fallback).toBe(false);
    expect(mock.callLog).toHaveLength(0);
  });
});

describe("core/triage/triageItems — hallucinated id rejection", () => {
  it("does not store hallucinated entries on the output map", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-real" })];
    const mock = createTriageMock({ failureMode: "hallucinate-id" });
    const result = await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
    });
    expect(result.decisions.has("fake-hallucinated-id-not-in-input")).toBe(false);
    expect(result.decisions.get(items[0].id)?.decision).toBe("research");
    expect(result.errors.some((e) => e.includes("hallucinated"))).toBe(true);
  });
});

describe("core/triage/triageItems — audit log (W-E-3)", () => {
  it("writes one JSONL line per call when auditLog is set", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedradar-audit-"));
    const auditLog = path.join(dir, "triage.jsonl");

    const items = [makeItem({ id: "src-1-2026-05-23-aud" })];
    const mock = createTriageMock();
    await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      auditLog,
      now: () => "2026-05-23T00:00:00.000Z",
    });

    const content = await fs.readFile(auditLog, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.agent).toBe("gemini-cli");
    expect(record.status).toBe("ok");
    expect(record.itemIds).toEqual(["src-1-2026-05-23-aud"]);
    expect(record.request).toContain("<untrusted_item ");
    expect(record.response).toContain('"decision"');
    expect(record.fallback).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not write any file when auditLog is omitted", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-noaud" })];
    const mock = createTriageMock();
    // If the orchestrator tried to write somewhere, this would manifest as a
    // thrown error from fs/promises. The mock runner does no IO of its own.
    await expect(
      triageItems(items, { policy: POLICY, agent: "gemini-cli", runner: mock.runner }),
    ).resolves.toBeDefined();
  });

  it("does not crash when the audit log path is unwritable, surfacing the failure as a warning", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    // Create a regular file and then try to write the audit log into a path
    // that treats that file as if it were a directory — `mkdir` will fail
    // synchronously with EEXIST/ENOTDIR. Portable across platforms; avoids
    // touching /proc which has quirky semantics on WSL2.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedradar-bad-audit-"));
    const blockingFile = path.join(dir, "blocker");
    await fs.writeFile(blockingFile, "block");
    const badPath = path.join(blockingFile, "should-fail.jsonl");

    const items = [makeItem({ id: "src-1-2026-05-23-badaud" })];
    const mock = createTriageMock();
    const result = await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      auditLog: badPath,
    });
    expect(result.fallback).toBe(false);
    expect(result.errors.some((e) => e.includes("audit log write failed"))).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
