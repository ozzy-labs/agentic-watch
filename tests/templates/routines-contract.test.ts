import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderPipelineRoutineTemplate } from "../../src/cli/routine/generate-pipeline.js";
import {
  renderNetworkAccessBlock,
  renderWatchRoutineTemplate,
} from "../../src/cli/routine/generate-watch.js";

/**
 * Contract guard for the bundled routine templates under
 * `src/templates/routines/` (epic #277 follow-up F5 / #295).
 *
 * Lefthook's `routines-validate` hook runs `scripts/routines/validate.py`
 * against `.claude/routines/*.yaml`, but the *bundled* templates that
 * `radar init` / `radar routine generate` emit live under
 * `src/templates/routines/` and are explicitly OUT of that hook's glob. The
 * `radar init` test only checks path existence + that the body parses as YAML;
 * nothing asserts the templates satisfy the same routine contract (required
 * fields, status enum, >= 1-hour cron) the validator enforces on user files.
 *
 * This test closes that gap. It runs the *same* `validate.py` the hook uses
 * against:
 *   1. `watch-daily.yaml` directly — the ready-to-edit scaffold `radar init
 *      --with-routines` copies (it has no placeholders, so it must already be
 *      contract-clean as shipped).
 *   2. The rendered output of `watch.yaml.tmpl` and `pipeline.yaml.tmpl` — the
 *      `.tmpl` placeholders are substituted via the SAME render functions the
 *      generators use, then validated.
 *
 * Reusing `validate.py` (rather than re-implementing its checks here) keeps the
 * bundled templates and the hook in lockstep: if the contract grows a new rule,
 * this test inherits it automatically.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const ROUTINES_TEMPLATES = join(REPO_ROOT, "src", "templates", "routines");
const WATCH_DAILY = join(ROUTINES_TEMPLATES, "watch-daily.yaml");
const WATCH_TMPL = join(ROUTINES_TEMPLATES, "watch.yaml.tmpl");
const PIPELINE_TMPL = join(ROUTINES_TEMPLATES, "pipeline.yaml.tmpl");
const VALIDATE_SCRIPT = join(REPO_ROOT, "scripts", "routines", "validate.py");

/**
 * `uv run` the standalone validator against a file. Returns the captured
 * stdout. If `uv` is unavailable the caller skips (the validator's own logic
 * is unit-covered by the generate tests' uv guard; here we only assert the
 * bundled templates pass it when the runtime is present).
 */
function uvAvailable(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function validate(path: string): string {
  return execFileSync("uv", ["run", VALIDATE_SCRIPT, path], { encoding: "utf8" });
}

describe("bundled routine templates :: contract", () => {
  it("watch-daily.yaml passes validate.py as shipped (no placeholders)", async () => {
    // The scaffold ships with concrete <owner>/<repo> placeholder *values* but
    // a structurally complete shape — there are no `{{...}}` template tokens to
    // substitute, so it must already be contract-clean.
    const body = await readFile(WATCH_DAILY, "utf8");
    expect(body).not.toMatch(/\{\{[a-zA-Z]+\}\}/);

    if (!uvAvailable()) return;
    const out = validate(WATCH_DAILY);
    expect(out).toContain(`OK   ${WATCH_DAILY}`);
  });

  it("rendered watch.yaml.tmpl passes validate.py", async () => {
    const tmpl = await readFile(WATCH_TMPL, "utf8");
    const rendered = renderWatchRoutineTemplate(tmpl, {
      name: "feedradar-watch",
      repository: "acme/widgets",
      cron: "0 0 * * *",
      timezone: "UTC",
      model: "claude-sonnet-4-6",
      // #298 added a network_access block placeholder the generator fills from
      // sources/*.yaml hosts; mirror that here so the rendered YAML is valid.
      networkAccessBlock: renderNetworkAccessBlock(["example.com"]),
    });
    // Every placeholder must be substituted before the contract holds.
    expect(rendered).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    // Sanity: it parses as a YAML mapping (the validator parses too, but a
    // local parse pins the failure here if the render breaks YAML structure).
    expect(parseYaml(rendered)).toMatchObject({ name: "feedradar-watch", status: "draft" });

    if (!uvAvailable()) return;
    const dir = await mkdtemp(join(tmpdir(), "feedradar-tmpl-watch-"));
    const dest = join(dir, "watch.yaml");
    await writeFile(dest, rendered, "utf8");
    const out = validate(dest);
    expect(out).toContain(`OK   ${dest}`);
  });

  it("rendered pipeline.yaml.tmpl passes validate.py", async () => {
    const tmpl = await readFile(PIPELINE_TMPL, "utf8");
    const rendered = renderPipelineRoutineTemplate(tmpl, {
      name: "feedradar-pipeline",
      repository: "acme/widgets",
      cron: "0 * * * *",
      timezone: "UTC",
      model: "claude-sonnet-4-6",
      maxItems: 10,
      networkAccessBlock: renderNetworkAccessBlock(["example.com"]),
    });
    expect(rendered).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    expect(parseYaml(rendered)).toMatchObject({ name: "feedradar-pipeline", status: "draft" });

    if (!uvAvailable()) return;
    const dir = await mkdtemp(join(tmpdir(), "feedradar-tmpl-pipeline-"));
    const dest = join(dir, "pipeline.yaml");
    await writeFile(dest, rendered, "utf8");
    const out = validate(dest);
    expect(out).toContain(`OK   ${dest}`);
  });
});
