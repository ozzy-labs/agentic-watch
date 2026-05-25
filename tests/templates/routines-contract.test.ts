import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildLocaleOutputDirective,
  buildOutputGateConstraint,
  buildOutputGateNote,
  buildPipelineLandingStep,
  buildSessionLocaleDirective,
  type OutputMode,
  renderPipelineRoutineTemplate,
} from "../../src/cli/routine/generate-pipeline.js";
import {
  renderNetworkAccessBlock,
  renderWatchRoutineTemplate,
} from "../../src/cli/routine/generate-watch.js";
import type { Locale } from "../../src/core/locale.js";
import { createTranslator } from "../../src/i18n/index.js";

/**
 * Contract guard for the bundled routine templates under
 * `src/templates/{en,ja}/routines/` (epic #277 follow-up F5 / #295; per-locale
 * since #315).
 *
 * Lefthook's `routines-validate` hook runs `scripts/routines/validate.py`
 * against `.claude/routines/*.yaml`, but the *bundled* templates that
 * `radar init` / `radar routine generate` emit live under
 * `src/templates/{en,ja}/routines/` and are explicitly OUT of that hook's glob.
 * The `radar init` test only checks path existence + that the body parses as
 * YAML; nothing asserts the templates satisfy the same routine contract
 * (required fields, status enum, >= 1-hour cron) the validator enforces on user
 * files.
 *
 * This test closes that gap. It runs the *same* `validate.py` the hook uses
 * against, for BOTH locales (#315):
 *   1. `watch-daily.yaml` directly — the ready-to-edit scaffold `radar init
 *      --with-routines` copies (it has no placeholders, so it must already be
 *      contract-clean as shipped).
 *   2. The rendered output of `watch.yaml.tmpl` and `pipeline.yaml.tmpl` — the
 *      `.tmpl` placeholders are substituted via the SAME render functions the
 *      generators use, then validated.
 *
 * Per-locale coverage matters because the i18n change only touches the
 * natural-language copy: the validator confirms the functional fields (status
 * enum, cron, model, network_access) survive identically in the `ja` variant.
 *
 * Reusing `validate.py` (rather than re-implementing its checks here) keeps the
 * bundled templates and the hook in lockstep: if the contract grows a new rule,
 * this test inherits it automatically.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const routinesDir = (locale: Locale) => join(REPO_ROOT, "src", "templates", locale, "routines");
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

describe.each<Locale>([
  "en",
  "ja",
] as Locale[])("bundled routine templates :: contract [%s]", (locale) => {
  const WATCH_DAILY = join(routinesDir(locale), "watch-daily.yaml");
  const WATCH_TMPL = join(routinesDir(locale), "watch.yaml.tmpl");
  const PIPELINE_TMPL = join(routinesDir(locale), "pipeline.yaml.tmpl");

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
    const dir = await mkdtemp(join(tmpdir(), `feedradar-tmpl-watch-${locale}-`));
    const dest = join(dir, "watch.yaml");
    await writeFile(dest, rendered, "utf8");
    const out = validate(dest);
    expect(out).toContain(`OK   ${dest}`);
  });

  // Both --output-mode values (#301) must render to a contract-clean routine.
  it.each<OutputMode>([
    "pr",
    "auto-merge",
  ])("rendered pipeline.yaml.tmpl (--output-mode %s) passes validate.py", async (mode) => {
    const tmpl = await readFile(PIPELINE_TMPL, "utf8");
    const rendered = renderPipelineRoutineTemplate(tmpl, {
      name: "feedradar-pipeline",
      repository: "acme/widgets",
      cron: "0 * * * *",
      timezone: "UTC",
      model: "claude-sonnet-4-6",
      maxItems: 10,
      networkAccessBlock: renderNetworkAccessBlock(["example.com"]),
      landingStep: buildPipelineLandingStep(mode, locale),
      outputGateConstraint: buildOutputGateConstraint(mode, locale),
      outputGateNote: buildOutputGateNote(mode, locale),
      localeOutputDirective: buildLocaleOutputDirective(locale, createTranslator(locale)),
      // Exercise the #382 opt-in directive on (locale != en) so validate.py also
      // covers the session-locale bullet in the rendered contract.
      sessionLocaleDirective: buildSessionLocaleDirective(locale, createTranslator(locale), true),
      allowUnrestrictedGitPush: mode === "auto-merge",
    });
    expect(rendered).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    expect(parseYaml(rendered)).toMatchObject({ name: "feedradar-pipeline", status: "draft" });

    if (!uvAvailable()) return;
    const dir = await mkdtemp(join(tmpdir(), `feedradar-tmpl-pipeline-${locale}-`));
    const dest = join(dir, "pipeline.yaml");
    await writeFile(dest, rendered, "utf8");
    const out = validate(dest);
    expect(out).toContain(`OK   ${dest}`);
  });
});
