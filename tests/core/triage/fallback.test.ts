import { describe, expect, it } from "vitest";
import { triageItems } from "../../../src/core/triage/index.js";
import type { SourceTriagePolicy } from "../../../src/schemas/source.js";
import { createTriageMock, makeItem } from "../../helpers/triage-mock.js";

/**
 * Failure fallback coverage (ADR-0018 §W-E acceptance criteria).
 *
 * The orchestrator must fail soft on three classes of catastrophic failure:
 *
 * 1. Agent CLI is down (ENOENT, spawn refused).
 * 2. Agent CLI hangs / times out (the runner throws or returns an error).
 * 3. Agent returns total garbage that the JSON parser cannot recover.
 *
 * In all three cases every input item must come back as `triaged_unsure`
 * with a sane reason, `fallback: true` on the result, and the workflow
 * (caller) is not interrupted by an exception.
 */

const POLICY: SourceTriagePolicy = {
  agent: "gemini-cli",
  confidenceThreshold: 0.7,
  rules: "test rules",
};

const ITEMS = [
  makeItem({ id: "src-1-2026-05-23-fb-a" }),
  makeItem({ id: "src-1-2026-05-23-fb-b" }),
];

describe("core/triage — full fallback paths", () => {
  it("agent CLI down → every item becomes triaged_unsure, fallback=true", async () => {
    const mock = createTriageMock({ failureMode: "cli-down" });
    const result = await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      sleep: async () => {},
      now: () => "2026-05-23T00:00:00.000Z",
    });

    expect(result.fallback).toBe(true);
    expect(result.decisions.size).toBe(ITEMS.length);
    for (const item of ITEMS) {
      const decision = result.decisions.get(item.id);
      expect(decision?.decision).toBe("unsure");
      expect(decision?.reason).toBe("agent CLI failure");
      expect(decision?.agent).toBe("gemini-cli");
      expect(decision?.triagedAt).toBe("2026-05-23T00:00:00.000Z");
    }
    expect(result.errors.some((e) => e.includes("triage agent CLI failed"))).toBe(true);
  });

  it("runner throws (simulating timeout) → fallback path engages, no exception bubbles", async () => {
    const result = await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: async () => {
        throw new Error("simulated timeout");
      },
      sleep: async () => {},
    });

    expect(result.fallback).toBe(true);
    for (const item of ITEMS) {
      expect(result.decisions.get(item.id)?.decision).toBe("unsure");
    }
    expect(result.errors.some((e) => e.includes("simulated timeout"))).toBe(true);
  });

  it("total JSON parse failure → fallback path engages, every item unsure", async () => {
    const mock = createTriageMock({ failureMode: "garbage-json" });
    const result = await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
    });

    expect(result.fallback).toBe(true);
    for (const item of ITEMS) {
      const decision = result.decisions.get(item.id);
      expect(decision?.decision).toBe("unsure");
      expect(decision?.reason).toBe("response parse failure");
    }
    expect(result.errors.some((e) => e.includes("triage response parse failed"))).toBe(true);
  });

  it("empty agent stdout → parse failure path (treated same as garbage)", async () => {
    const mock = createTriageMock({ failureMode: "empty-output" });
    const result = await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
    });
    expect(result.fallback).toBe(true);
    for (const item of ITEMS) {
      expect(result.decisions.get(item.id)?.decision).toBe("unsure");
    }
  });

  it("agent returns a JSON object instead of an array → fallback engages", async () => {
    const mock = createTriageMock({ failureMode: "non-array-json" });
    const result = await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
    });
    expect(result.fallback).toBe(true);
    for (const item of ITEMS) {
      expect(result.decisions.get(item.id)?.decision).toBe("unsure");
    }
  });

  it("partial agent response (only one item) → only the omitted item is unsure, fallback=false", async () => {
    // Configure the mock to drop ITEMS[1] from the response by returning a
    // stdout that only includes ITEMS[0]. Easiest: write a custom runner.
    const partialRunner = async (input: { agent: string; prompt: string; cwd: string }) => {
      void input;
      return {
        status: "ok" as const,
        stdout: JSON.stringify([
          {
            id: ITEMS[0].id,
            decision: "research",
            confidence: 0.9,
            reason: "ok",
          },
        ]),
        stderr: "",
        exitCode: 0,
      };
    };
    const result = await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: partialRunner,
    });
    expect(result.fallback).toBe(false);
    expect(result.decisions.get(ITEMS[0].id)?.decision).toBe("research");
    expect(result.decisions.get(ITEMS[1].id)?.decision).toBe("unsure");
    expect(result.decisions.get(ITEMS[1].id)?.reason).toBe("agent-omitted");
  });

  it("audit log captures the fallback record on agent CLI failure", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedradar-fb-audit-"));
    const auditLog = path.join(dir, "fb.jsonl");

    const mock = createTriageMock({ failureMode: "cli-down" });
    await triageItems(ITEMS, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      sleep: async () => {},
      auditLog,
    });

    const content = await fs.readFile(auditLog, "utf8");
    const record = JSON.parse(content.trim().split("\n")[0]);
    expect(record.status).toBe("error");
    expect(record.fallback).toBe(true);
    expect(record.itemIds).toEqual(ITEMS.map((i) => i.id));

    await fs.rm(dir, { recursive: true, force: true });
  });
});
