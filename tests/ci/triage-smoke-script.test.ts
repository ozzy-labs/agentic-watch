import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Lightweight guardrail for `scripts/triage-smoke.mjs` (#243).
 *
 * The smoke script itself is the actual integration test — it spawns
 * `radar` + a real agent CLI against a live recipe and asserts the
 * returned JSON validates against `TriageDecisionSchema`. Running that
 * end-to-end here would require network access, a published radar build,
 * and a paid agent CLI key, which we deliberately do NOT exercise from
 * the unit suite (cost / flakiness).
 *
 * What this test DOES cover:
 *
 *   1. The script exists at its expected path.
 *   2. `node --check` parses it cleanly (catches typos, missing braces,
 *      and accidental top-level await syntax errors before they bite the
 *      weekly cron run).
 *   3. The script imports `TriageDecisionValueSchema` from `dist/`, which
 *      is the contract the workflow relies on for the schema assertion.
 *      A rename/move of that export would silently break the smoke; this
 *      assertion gives us a fast in-CI signal.
 *
 * What this test does NOT cover (intentional — see #243):
 *
 *   - actual fetch / triage / agent CLI invocation (covered by the
 *     weekly cron itself)
 *   - schema validation logic (covered transitively by the cron, and by
 *     unit tests on the schema in `src/schemas/item.ts`)
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts", "triage-smoke.mjs");

/**
 * Run `node --check <path>` and return the captured stderr / exit code.
 * `--check` syntax-validates without executing, so this is safe to call
 * on the smoke script (which would otherwise spawn `radar` and hit the
 * network on import-time evaluation of `import { ... } from "../dist/..."`).
 */
async function nodeSyntaxCheck(path: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveProm, reject) => {
    const child = spawn("node", ["--check", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolveProm({ code: code ?? 0, stderr }));
  });
}

describe("scripts/triage-smoke.mjs", () => {
  it("exists at the expected path", async () => {
    // `fs.stat` rather than existsSync so the failure message includes
    // the actual ENOENT path when the script is missing or moved.
    const st = await stat(SCRIPT_PATH);
    expect(st.isFile()).toBe(true);
  });

  it("parses as valid Node ESM syntax", async () => {
    const result = await nodeSyntaxCheck(SCRIPT_PATH);
    expect(result.stderr, `node --check stderr:\n${result.stderr}`).toBe("");
    expect(result.code).toBe(0);
  });

  it("imports TriageDecisionValueSchema from dist/", async () => {
    // The smoke script's primary correctness assertion is that the
    // agent's `decision` field is a member of `TriageDecisionValueSchema`.
    // If the import path drifts (e.g. someone reorganises src/schemas/),
    // the cron would fail at runtime with a confusing module-resolution
    // error. Pin the import here so a rename is caught at PR time.
    const source = await readFile(SCRIPT_PATH, "utf8");
    expect(source).toMatch(
      /from\s+["']\.\.\/dist\/schemas\/item\.js["']/,
      "smoke script must import schemas from dist/schemas/item.js",
    );
    expect(source).toMatch(
      /TriageDecisionValueSchema/,
      "smoke script must reference TriageDecisionValueSchema for the decision enum assertion",
    );
  });
});
