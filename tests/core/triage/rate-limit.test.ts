import { describe, expect, it } from "vitest";
import { looksLikeRateLimit, triageItems } from "../../../src/core/triage/index.js";
import type { SourceTriagePolicy } from "../../../src/schemas/source.js";
import { createTriageMock, makeItem } from "../../helpers/triage-mock.js";

/**
 * Rate-limit coverage (ADR-0018 §W-E-2 — post-review addition).
 *
 * The cheap-model channel (gemini-2.5-flash-lite et al.) typically caps at
 * a few hundred to a few thousand requests per day. When multiple sources
 * triage in the same `radar watch run` we expect to brush against the cap;
 * the orchestrator must:
 *
 * 1. Retry transient 429 / 503 with exponential backoff (initial 1 s, cap
 *    60 s, max 3 retries). A retry that succeeds yields a normal
 *    happy-path result.
 * 2. Soft-fail after retry exhaustion: every affected item gets
 *    `decision: "unsure"` with `reason: "rate-limited"` and `fallback: true`.
 *    The workflow continues so subsequent sources / commands still run.
 */

const POLICY: SourceTriagePolicy = {
  agent: "gemini-cli",
  confidenceThreshold: 0.7,
  rules: "test rules",
};

describe("core/triage — looksLikeRateLimit classifier", () => {
  it("matches HTTP 429 / 503 markers", () => {
    expect(looksLikeRateLimit("HTTP 429 Too Many Requests")).toBe(true);
    expect(looksLikeRateLimit("Error: 503 Service Unavailable")).toBe(true);
    expect(looksLikeRateLimit("rate limit exceeded")).toBe(true);
    expect(looksLikeRateLimit("Quota exceeded for the day")).toBe(true);
    expect(looksLikeRateLimit("resource_exhausted")).toBe(true);
  });

  it("does NOT flag generic errors", () => {
    expect(looksLikeRateLimit("ENOENT: spawn claude")).toBe(false);
    expect(looksLikeRateLimit("syntax error at line 1")).toBe(false);
    expect(looksLikeRateLimit("")).toBe(false);
  });
});

describe("core/triage — retry on transient rate limit", () => {
  it("succeeds on the second attempt after a single 429", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-rl-once" })];
    const mock = createTriageMock({ failureMode: "rate-limit-once" });
    const sleepLog: number[] = [];
    const result = await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      // Tiny initial delay so the test stays fast; the test cares about the
      // call count, not real-world wait times.
      initialDelayMs: 1,
      maxDelayMs: 4,
      sleep: async (ms) => {
        sleepLog.push(ms);
      },
    });

    expect(result.fallback).toBe(false);
    expect(result.decisions.get(items[0].id)?.decision).toBe("research");
    // The runner was invoked twice: first 429, retry succeeds.
    expect(mock.callLog).toHaveLength(2);
    // Exactly one backoff sleep (1ms — initial delay).
    expect(sleepLog).toEqual([1]);
  });
});

describe("core/triage — persistent rate limit soft-fails", () => {
  it("demotes all items to unsure with reason 'rate-limited' after retry exhaustion", async () => {
    const items = [
      makeItem({ id: "src-1-2026-05-23-rl-a" }),
      makeItem({ id: "src-1-2026-05-23-rl-b" }),
    ];
    const mock = createTriageMock({ failureMode: "rate-limit-persistent" });
    const sleepLog: number[] = [];
    const result = await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 4,
      sleep: async (ms) => {
        sleepLog.push(ms);
      },
      now: () => "2026-05-23T00:00:00.000Z",
    });

    expect(result.fallback).toBe(true);
    expect(result.decisions.size).toBe(items.length);
    for (const item of items) {
      const decision = result.decisions.get(item.id);
      expect(decision?.decision).toBe("unsure");
      expect(decision?.reason).toBe("rate-limited");
      expect(decision?.confidence).toBe(0);
    }
    expect(result.errors.some((e) => e.includes("rate-limited"))).toBe(true);
    // 1 initial attempt + 3 retries = 4 calls; 3 backoff sleeps.
    expect(mock.callLog).toHaveLength(4);
    expect(sleepLog).toHaveLength(3);
  });

  it("respects the backoff cap (maxDelayMs)", async () => {
    const items = [makeItem({ id: "src-1-2026-05-23-cap" })];
    const mock = createTriageMock({ failureMode: "rate-limit-persistent" });
    const sleepLog: number[] = [];
    await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      maxRetries: 4,
      initialDelayMs: 10,
      maxDelayMs: 25,
      sleep: async (ms) => {
        sleepLog.push(ms);
      },
    });
    // initial 10 → 20 → 25 (cap) → 25 (cap)
    expect(sleepLog).toEqual([10, 20, 25, 25]);
    for (const s of sleepLog) {
      expect(s).toBeLessThanOrEqual(25);
    }
  });

  it("records a rate-limit audit log entry when auditLog is set", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedradar-rl-audit-"));
    const auditLog = path.join(dir, "rl.jsonl");

    const items = [makeItem({ id: "src-1-2026-05-23-rl-aud" })];
    const mock = createTriageMock({ failureMode: "rate-limit-persistent" });
    await triageItems(items, {
      policy: POLICY,
      agent: "gemini-cli",
      runner: mock.runner,
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 4,
      sleep: async () => {},
      auditLog,
    });

    const content = await fs.readFile(auditLog, "utf8");
    const record = JSON.parse(content.trim().split("\n")[0]);
    expect(record.status).toBe("rate-limited");
    expect(record.fallback).toBe(true);
    expect(record.rateLimited).toBe(true);
    expect(record.attempts).toBeGreaterThanOrEqual(2);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
