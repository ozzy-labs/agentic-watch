#!/usr/bin/env node
/**
 * Triage smoke test (#243 / ADR-0018 §W4 / PR-6).
 *
 * Weekly liveness signal for the triage channel — exercises the full
 * "real recipe → live page fetch → real agent CLI → JSON decision → schema
 * validation" path against a small, predictable bundled recipe.
 *
 * Design notes:
 *
 *   - **Recipe choice**: uses `dev-to` rather than `aws-whats-new` despite
 *     #243's pseudocode mentioning AWS. dev-to has a single 30-item page
 *     and no facet sweep, whereas aws-whats-new's facet axis walks 23 years
 *     × up to 30 pages each = ~700 page fetches even on first run. The
 *     smoke's goal (verify triage agent + bundled recipe end-to-end) is
 *     met by either; dev-to keeps weekly API cost negligible. The bundled
 *     dev-to recipe already ships a `triagePolicy:` block (see
 *     `recipes/dev-to.yaml`).
 *
 *   - **`--max-items 5`**: caps the number of triage agent invocations
 *     regardless of how many keyword-matching items the page-0 fetch
 *     returns. Five items is enough to exercise the per-item path while
 *     keeping the cost per run < $0.01 on the cheap-model channel
 *     (gemini-2.5-flash-lite).
 *
 *   - **`--apply` over `--dry-run`**: #243's pseudocode shows
 *     `radar triage --dry-run --json`, but the v0.1.6 CLI does not expose
 *     `--json` on the triage subcommand (intentional — `radar items list
 *     --json` is the canonical JSON exit point for item state). To stay
 *     within the smoke job's scope (no CLI changes) we run `--apply`
 *     against the scratch workspace, then read decisions back via
 *     `radar items list --json`. The scratch workspace is recreated every
 *     run so the apply is effectively non-mutating from the operator's
 *     perspective.
 *
 *   - **Soft fail on all-unsure**: when every item returns `unsure`, the
 *     triage agent is technically functional (schema-valid output) but
 *     the policy is not discriminating. We emit a `::warning::` rather
 *     than `::error::` so prompt drift surfaces as a signal worth looking
 *     at without blocking the workflow on a single bad-day model run.
 *     The if:failure() workflow step still files a tracking issue.
 *
 *   - **Warning, not error**: per the recipes-smoke contract (ADR-0012
 *     §D3) and the workflow's `continue-on-error: true`, we exit 0 on
 *     soft failures and only set exit code 1 on hard failures (schema
 *     mismatch, agent crash, zero decisions returned). The workflow's
 *     `if: failure()` issue-filing step uses the exit code to gate.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TriageDecisionValueSchema } from "../dist/schemas/item.js";

// Tuning knobs. Kept at the top so weekly cost / wallclock can be adjusted
// without diving into the script body.
const RECIPE_NAME = "dev-to";
const SOURCE_ID = "smoke-dev-to";
const SAMPLE_KEYWORDS = "javascript,typescript,rust,python,ai";
const TRIAGE_MAX_ITEMS = 5;
const AGENT = process.env.RADAR_TRIAGE_SMOKE_AGENT ?? "gemini-cli";
// Hard wall clock per CLI step so a hung `gemini` / `radar` does not
// stall the whole job. The workflow's `timeout-minutes: 15` is the outer
// belt; this is the inner suspenders.
const STEP_TIMEOUT_MS = 5 * 60_000;

/**
 * Spawn helper that captures stdout / stderr and enforces a wall-clock
 * timeout. Returns `{ stdout, stderr, exitCode }` on completion; throws
 * on spawn failure (ENOENT, EACCES, etc.) or timeout.
 *
 * We deliberately do not pipe stdout to the parent — the script needs to
 * post-process `items list --json` output, and the workflow surfaces
 * progress via the script's own console.log calls.
 */
async function runCmd(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });

  let timeoutHandle;
  const exitCode = await new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${STEP_TIMEOUT_MS} ms: ${cmd} ${args.join(" ")}`));
    }, STEP_TIMEOUT_MS);
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });
  return { stdout, stderr, exitCode };
}

/**
 * Format a captured run for the failure issue body. Truncates long
 * stdout / stderr so the issue stays under GitHub's body length cap.
 */
function snippet(s, max = 1000) {
  if (!s) return "(empty)";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... (truncated, ${s.length - max} bytes elided)`;
}

/**
 * Annotation helpers — emit GitHub Actions workflow commands when running
 * under CI, fall back to plain console.log locally.
 */
function annotate(level, title, message) {
  // Newlines in annotations need escaping per GitHub docs.
  const safe = message.replace(/\r?\n/g, "%0A");
  console.log(`::${level} title=${title}::${safe}`);
}

async function main() {
  // Scratch workspace under the runner's temp dir. We blow it away at the
  // end so a subsequent local invocation gets a clean slate.
  const workspace = await mkdtemp(join(tmpdir(), "radar-triage-smoke-"));
  const resultFile = join(process.cwd(), "triage-result.json");
  console.log(`triage-smoke: scratch workspace at ${workspace}`);
  console.log(`triage-smoke: agent=${AGENT}, recipe=${RECIPE_NAME}, max-items=${TRIAGE_MAX_ITEMS}`);

  // Track captured details for the failure issue body.
  let lastError;
  let triageStdout = "";
  let listStdout = "";

  try {
    // 1. Init the scratch workspace. `--no-claude-md`/etc. keep the init
    //    output minimal; the smoke does not need any of the agent skill
    //    bundles, just the directory skeleton.
    {
      const r = await runCmd(
        "radar",
        [
          "init",
          "--no-claude-md",
          "--no-agents-md",
          "--no-feedradar-md",
          "--no-claude-skills",
          "--no-gemini-commands",
        ],
        { cwd: workspace },
      );
      if (r.exitCode !== 0) {
        throw new Error(`radar init exit ${r.exitCode}: ${snippet(r.stderr)}`);
      }
    }

    // 2. Add the source from the bundled recipe with a few sample keywords.
    //    The recipe ships a triagePolicy: block which propagates onto the
    //    generated sources/<id>.yaml so triage has a policy to consult.
    {
      const r = await runCmd(
        "radar",
        ["source", "add", SOURCE_ID, "--recipe", RECIPE_NAME, "--keywords", SAMPLE_KEYWORDS],
        { cwd: workspace },
      );
      if (r.exitCode !== 0) {
        throw new Error(`radar source add exit ${r.exitCode}: ${snippet(r.stderr)}`);
      }
    }

    // 3. Single watch pass. dev-to returns a single 30-item page on the
    //    first call which is well below the recipe's `maxPages: 10` cap;
    //    keyword filtering narrows the matched count further. We pass no
    //    --backfill flag so the facet sweep path (irrelevant for dev-to)
    //    stays off.
    {
      const r = await runCmd("radar", ["watch", "run", "--source", SOURCE_ID, "--quiet"], {
        cwd: workspace,
      });
      // Non-zero from watch is a hard fail — without items there is
      // nothing for triage to classify.
      if (r.exitCode !== 0) {
        throw new Error(`radar watch run exit ${r.exitCode}: ${snippet(r.stderr)}`);
      }
    }

    // 4. Triage: apply mode against the scratch workspace, capped at
    //    TRIAGE_MAX_ITEMS so cost is bounded regardless of how many
    //    items the watch pass produced.
    {
      const r = await runCmd(
        "radar",
        [
          "triage",
          "--apply",
          "--source",
          SOURCE_ID,
          "--triage-agent",
          AGENT,
          "--max-items",
          String(TRIAGE_MAX_ITEMS),
          "--quiet",
        ],
        { cwd: workspace },
      );
      triageStdout = r.stdout;
      if (r.exitCode !== 0) {
        throw new Error(`radar triage exit ${r.exitCode}: ${snippet(r.stderr)}`);
      }
    }

    // 5. Read decisions back as JSON via the items-list canonical exit
    //    point. We do not filter by status — triage may produce a mix of
    //    triaged_research / triaged_digest / triaged_unsure / dismissed,
    //    all of which carry the `triage:` field we want to validate.
    {
      const r = await runCmd("radar", ["items", "list", "--source", SOURCE_ID, "--json"], {
        cwd: workspace,
      });
      listStdout = r.stdout;
      if (r.exitCode !== 0) {
        throw new Error(`radar items list exit ${r.exitCode}: ${snippet(r.stderr)}`);
      }
    }

    // 6. Parse + validate. `items list --json` always emits a JSON array.
    let items;
    try {
      items = JSON.parse(listStdout);
    } catch (e) {
      throw new Error(`items list --json output is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(items)) {
      throw new Error(`items list --json expected an array, got ${typeof items}`);
    }

    // Filter to items that actually received a triage decision (= what
    // triage --apply touched). Items without a `triage:` field were
    // either not matched by the keyword filter or fell outside the
    // --max-items cap; either way they are not subject to the smoke's
    // schema assertions.
    const triaged = items.filter((i) => i.triage != null);
    if (triaged.length === 0) {
      throw new Error(
        `no triaged items after radar triage --apply (watched ${items.length} items total, 0 carry a triage decision — agent likely crashed or rate-limited)`,
      );
    }

    // Write captured JSON to disk so the failure-handling workflow step
    // can attach it to the auto-filed issue.
    await writeFile(resultFile, JSON.stringify(triaged, null, 2), "utf8");

    // 7. Schema assertions.
    //    a) Decision is one of the four valid enum values.
    //    b) Confidence is a number in [0, 1].
    //    c) Reason is a non-empty string.
    const validDecisions = TriageDecisionValueSchema.options;
    const issues = [];
    let unsureCount = 0;
    for (const item of triaged) {
      const t = item.triage;
      if (!validDecisions.includes(t.decision)) {
        issues.push(
          `item ${item.id}: decision '${t.decision}' not in {${validDecisions.join(", ")}}`,
        );
      }
      if (typeof t.confidence !== "number" || t.confidence < 0 || t.confidence > 1) {
        issues.push(`item ${item.id}: confidence ${t.confidence} not in [0, 1]`);
      }
      if (typeof t.reason !== "string" || t.reason.length === 0) {
        issues.push(`item ${item.id}: reason missing or empty`);
      }
      if (t.decision === "unsure") unsureCount += 1;
    }
    if (issues.length > 0) {
      for (const i of issues) annotate("error", "triage-smoke (schema)", i);
      throw new Error(`schema validation failed on ${issues.length} item(s)`);
    }

    // 8. Soft fail on all-unsure. The agent is technically working
    //    (returned schema-valid output) but discriminated none of the
    //    items, which is a signal worth a warning but not a hard failure.
    if (unsureCount === triaged.length) {
      annotate(
        "warning",
        "triage-smoke (all unsure)",
        `Every triaged item (${triaged.length}) came back as 'unsure'. ` +
          `The agent is responding but discriminating poorly — check for prompt drift, ` +
          `model retirement, or stale triagePolicy.rules.`,
      );
      console.log(
        `triage-smoke: SOFT FAIL — ${triaged.length}/${triaged.length} items returned 'unsure' (exit 0)`,
      );
      return;
    }

    // 9. Success path.
    const breakdown = countBy(triaged, (i) => i.triage.decision);
    const breakdownStr = Object.entries(breakdown)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`triage-smoke: OK — ${triaged.length} triaged item(s): ${breakdownStr}`);
  } catch (err) {
    lastError = err;
    const message = err instanceof Error ? err.message : String(err);
    annotate("error", "triage-smoke", message);
    console.error(`triage-smoke: FAIL — ${message}`);
    // Best-effort: write whatever we captured to disk so the issue body
    // has *something* to show, even if triage never returned valid JSON.
    const debugDump = {
      error: message,
      agent: AGENT,
      recipe: RECIPE_NAME,
      triageStdout: snippet(triageStdout, 4000),
      itemsListStdout: snippet(listStdout, 4000),
    };
    try {
      await writeFile(resultFile, JSON.stringify(debugDump, null, 2), "utf8");
    } catch {
      // Swallow — disk write failure here is not actionable.
    }
  } finally {
    // Best-effort scratch cleanup. Failure to remove the tmpdir is not
    // worth reporting (the runner image is ephemeral).
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (lastError) {
    process.exit(1);
  }
}

function countBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// Catch unexpected harness crashes (network blip mid-write, syntax error in
// dist/, etc.). The workflow's `continue-on-error: true` keeps the run
// green; the if:failure() step uses the non-zero exit to gate issue
// creation.
main().catch((err) => {
  console.error("triage-smoke: harness crashed:", err);
  annotate("error", "triage-smoke (harness)", err?.message ?? String(err));
  process.exit(1);
});
