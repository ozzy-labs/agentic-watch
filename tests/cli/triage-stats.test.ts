import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runTriage } from "../../src/cli/triage.js";
import type { Item, TriageDecision, TriageFeedback } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";
import type { Source } from "../../src/schemas/source.js";

/**
 * Unit coverage for `radar triage stats` (#242).
 *
 * The fixture below mirrors the issue's post-review proposal: 30 triaged
 * items across the four decision classes, with a deterministic mix of
 * correct / wrong feedback so the aggregation math hits every override
 * counter. The tests assert raw counts via the JSON path (so we don't have
 * to parse the text report), then a second test covers the rendered output
 * end-to-end to lock in the user-facing layout.
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

const NOW = "2026-05-23T10:00:00.000Z";

const FRESH_TRIAGED_AT = "2026-05-20T10:00:00.000Z";
const STALE_TRIAGED_AT = "2025-12-01T10:00:00.000Z";

function feedback(correct: boolean, reason?: string): TriageFeedback {
  return {
    correct,
    reason,
    feedbackAt: NOW,
  };
}

function triageDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    decision: overrides.decision ?? "research",
    confidence: overrides.confidence ?? 0.85,
    reason: overrides.reason ?? "default test reason",
    agent: overrides.agent ?? "gemini-cli",
    triagedAt: overrides.triagedAt ?? FRESH_TRIAGED_AT,
    group: overrides.group,
    feedback: overrides.feedback ?? [],
  };
}

function makeFixtureItem(
  id: string,
  sourceId: string,
  triage: TriageDecision,
  status: Item["status"],
  matchedKeywords: string[] = ["test"],
): Item {
  return ItemSchema.parse({
    id,
    sourceId,
    title: `Item ${id}`,
    url: `https://example.com/${id}`,
    fetchedAt: FRESH_TRIAGED_AT,
    matchedKeywords,
    status,
    triage,
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

async function writeSource(workdir: string, source: Source): Promise<void> {
  await mkdir(join(workdir, "sources"), { recursive: true });
  await writeFile(join(workdir, "sources", `${source.id}.yaml`), stringifyYaml(source), "utf8");
}

const SAMPLE_SOURCE: Source = {
  id: "aws-whats-new",
  kind: "rss" as const,
  url: "https://aws.amazon.com/whats-new.xml",
  tags: [],
  filters: {
    keywords: ["aws"],
    excludeKeywords: [],
    matchMode: "word" as const,
    matchFields: ["title", "summary"] as const,
    caseSensitive: false,
  },
  trustLevel: "untrusted" as const,
  triagePolicy: {
    agent: "gemini-cli",
    confidenceThreshold: 0.7,
    rules: "Test policy rules.",
  },
};

/**
 * Build the canonical 30-item fixture (per issue #242 post-review):
 *
 * - triaged_research → 25 correct + 5 false positives = 30 research items?
 *   No — the post-review breakdown is total 30 with 25 + 5 + 3 + 12 + 5
 *   adding up exactly. We follow that breakdown.
 *
 *   research correct          25  → triaged_research, feedback.correct=true
 *   research false positive    5  → dismissed (status mutated by human), feedback.correct=false
 *                                   NB: status is `dismissed` because a human
 *                                   followed up via `radar dismiss`; the
 *                                   triage.decision stays "research" because
 *                                   that's what the agent emitted.
 *   dismiss false negative     3  → status detected (human resurrected via undismiss), feedback.correct=false
 *   dismiss correct           12  → status dismissed, feedback.correct=true
 *   unsure                     5  → 2 ended at researched / 3 ended at dismissed
 *
 * Counts deliberately match the issue spec so the suggestion / override
 * thresholds fire as documented.
 */
function buildFixture(): Item[] {
  const items: Item[] = [];

  // 25 correct research items.
  for (let i = 1; i <= 25; i++) {
    items.push(
      makeFixtureItem(
        `research-correct-${i}`,
        "aws-whats-new",
        triageDecision({ decision: "research", feedback: [feedback(true)] }),
        "triaged_research",
      ),
    );
  }

  // 5 false-positive research items (human dismissed them).
  for (let i = 1; i <= 5; i++) {
    items.push(
      makeFixtureItem(
        `research-fp-${i}`,
        "aws-whats-new",
        triageDecision({
          decision: "research",
          feedback: [feedback(false, "marketing post")],
        }),
        "dismissed",
        ["marketing", "blog-post"],
      ),
    );
  }

  // 3 false-negative dismiss items (human reverted) — drive the false-negative
  // suggestion. Shared keyword "identity" / "sso" / "billing" so the
  // suggestion heuristic surfaces them as the recommended review target.
  const fnKeywords: ReadonlyArray<string> = ["identity", "sso", "billing"];
  for (const kw of fnKeywords) {
    items.push(
      makeFixtureItem(
        `dismiss-fn-${kw}`,
        "aws-whats-new",
        triageDecision({
          decision: "dismiss",
          feedback: [feedback(false, "actually important")],
        }),
        "detected",
        [kw, "identity"],
      ),
    );
  }

  // 12 correct dismiss items.
  for (let i = 1; i <= 12; i++) {
    items.push(
      makeFixtureItem(
        `dismiss-correct-${i}`,
        "aws-whats-new",
        triageDecision({ decision: "dismiss", feedback: [feedback(true)] }),
        "dismissed",
      ),
    );
  }

  // 5 unsure items split 2 → research, 3 → dismiss (current status reflects
  // the human's downstream action; the override counter walks status, not
  // feedback, for unsure).
  for (let i = 1; i <= 2; i++) {
    items.push(
      makeFixtureItem(
        `unsure-research-${i}`,
        "aws-whats-new",
        triageDecision({ decision: "unsure", confidence: 0.5 }),
        "researched",
      ),
    );
  }
  for (let i = 1; i <= 3; i++) {
    items.push(
      makeFixtureItem(
        `unsure-dismiss-${i}`,
        "aws-whats-new",
        triageDecision({ decision: "unsure", confidence: 0.5 }),
        "dismissed",
      ),
    );
  }

  return items;
}

describe("cli/triage stats", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-triage-stats-"));
    await mkdir(join(workdir, "items"), { recursive: true });
    await writeSource(workdir, SAMPLE_SOURCE);
  });

  it("matches the post-review fixture breakdown (25/5/3/12/5)", async () => {
    for (const item of buildFixture()) await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runTriage(["stats", "--json"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const payload = JSON.parse(captured.log.join("\n"));
    const stat = payload.perSource[0];

    // Total triaged = 25 + 5 + 3 + 12 + 5 = 50 items, but the issue spec calls
    // out 30 in its prose. The post-review breakdown sums to 50; the prose
    // figure was an early sketch. We follow the breakdown.
    expect(stat.total).toBe(50);

    // research decisions = 25 correct + 5 false-positive = 30
    expect(stat.byDecision.research).toBe(30);
    // dismiss decisions = 3 false-negative + 12 correct = 15
    expect(stat.byDecision.dismiss).toBe(15);
    expect(stat.byDecision.digest).toBe(0);
    expect(stat.byDecision.unsure).toBe(5);

    // Overrides directly mirror the fixture intent.
    expect(stat.humanOverrides.triagedResearchToDismiss).toBe(5); // false positives
    expect(stat.humanOverrides.triagedDismissToResearch).toBe(3); // false negatives
    expect(stat.humanOverrides.triagedUnsureToResearch).toBe(2);
    expect(stat.humanOverrides.triagedUnsureToDismiss).toBe(3);
  });

  it("renders the per-source block with override + suggestion sections", async () => {
    for (const item of buildFixture()) await writeItem(workdir, item);
    const { io, captured } = captureIo();

    const code = await runTriage(["stats", "--since", "30d"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });

    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const out = captured.log.join("\n");
    expect(out).toContain("[aws-whats-new] triage stats (last 30 days)");
    expect(out).toContain("total triaged:    50");
    expect(out).toContain("research:          30");
    expect(out).toContain("dismiss:           15");
    expect(out).toContain("unsure:");
    expect(out).toContain("human overrides:");
    expect(out).toContain("triaged_dismiss → research:");
    expect(out).toContain("triaged_research → dismiss:");
    expect(out).toContain("triaged_unsure → research:");
    expect(out).toContain("triaged_unsure → dismiss:");
    expect(out).toMatch(/agent:\s+gemini-cli/);
    expect(out).toContain("policy: sources/aws-whats-new.yaml");
    // Suggestion block fires because false negatives >= 3 and false positives >= 3.
    expect(out).toContain("Suggestions:");
    expect(out).toContain("3 false negatives");
    expect(out).toContain("5 false positives");
  });

  it("filters out items older than --since", async () => {
    // Two items: one fresh, one stale beyond the cutoff.
    await writeItem(
      workdir,
      makeFixtureItem(
        "fresh",
        "aws-whats-new",
        triageDecision({ triagedAt: FRESH_TRIAGED_AT }),
        "triaged_research",
      ),
    );
    await writeItem(
      workdir,
      makeFixtureItem(
        "stale",
        "aws-whats-new",
        triageDecision({ triagedAt: STALE_TRIAGED_AT }),
        "triaged_research",
      ),
    );

    const { io, captured } = captureIo();
    const code = await runTriage(["stats", "--since", "30d", "--json"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });
    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const payload = JSON.parse(captured.log.join("\n"));
    expect(payload.perSource[0].total).toBe(1);
  });

  it("counts digest groups distinctly", async () => {
    // 3 items in group=ui-incremental + 2 in group=integrations + 1 ungrouped digest.
    const cases: Array<[string, string | undefined]> = [
      ["d1", "ui-incremental"],
      ["d2", "ui-incremental"],
      ["d3", "ui-incremental"],
      ["d4", "integrations"],
      ["d5", "integrations"],
      ["d6", undefined],
    ];
    for (const [id, group] of cases) {
      await writeItem(
        workdir,
        makeFixtureItem(
          id,
          "aws-whats-new",
          triageDecision({ decision: "digest", group }),
          "triaged_digest",
        ),
      );
    }

    const { io, captured } = captureIo();
    const code = await runTriage(["stats", "--json"], { cwd: workdir, io, now: () => NOW });
    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const payload = JSON.parse(captured.log.join("\n"));
    expect(payload.perSource[0].byDecision.digest).toBe(6);
    expect(payload.perSource[0].digestGroups).toBe(2);
  });

  it("returns 0 with an informational message when nothing has been triaged", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["stats"], { cwd: workdir, io, now: () => NOW });
    expect(code).toBe(0);
    expect(captured.log.join("\n")).toContain("nothing to report");
  });

  it("rejects an invalid --since value", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["stats", "--since", "30days"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid --since"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["stats", "--unknown"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
  });

  it("filters by --source", async () => {
    await writeItem(
      workdir,
      makeFixtureItem(
        "x",
        "aws-whats-new",
        triageDecision({ decision: "research" }),
        "triaged_research",
      ),
    );
    await writeItem(
      workdir,
      makeFixtureItem(
        "y",
        "anthropic-news",
        triageDecision({ decision: "research" }),
        "triaged_research",
      ),
    );

    const { io, captured } = captureIo();
    const code = await runTriage(["stats", "--source", "aws-whats-new", "--json"], {
      cwd: workdir,
      io,
      now: () => NOW,
    });
    expect(code, `stderr: ${captured.error.join("\n")}`).toBe(0);
    const payload = JSON.parse(captured.log.join("\n"));
    expect(payload.perSource).toHaveLength(1);
    expect(payload.perSource[0].source).toBe("aws-whats-new");
  });

  it("prints help on --help", async () => {
    const { io, captured } = captureIo();
    const code = await runTriage(["stats", "--help"], { cwd: workdir, io, now: () => NOW });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.includes("triage stats"))).toBe(true);
  });
});
