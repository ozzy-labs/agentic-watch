import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ResearchTemplate {
  id: string;
  path: string;
  body: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a template id as a safe filename component.
 *
 * Mirrors `source` id validation: reject path separators, dot-prefixed names,
 * and shell-unsafe characters so `templates/<id>.md` cannot escape the
 * templates directory.
 */
function isSafeTemplateId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

/**
 * Template ids that the CLI may legitimately invoke when the workspace file
 * has not been provisioned (e.g. the user has not run `radar init`, or has
 * deleted the file). The research SKILL ships built-in fallback structures
 * for each of these, so a missing workspace file is recoverable.
 *
 * - `default`: single-item research (the original `radar research <item>`
 *   default)
 * - `digest`: multi-item digest (ADR-0011 §6 — `radar research --digest`
 *   resolves to `templateId: "digest"`; the bundled template ships via
 *   `init`, but the research SKILL has its own digest structure as a
 *   fallback when the workspace file is absent).
 */
const IMPLICIT_FALLBACK_IDS = new Set(["default", "digest"]);

/**
 * Load `templates/<id>.md` from the workspace.
 *
 * The CLI defaults `--template default` (or `digest` for `--digest`), so
 * callers will typically pass one of those ids here. If the file is missing
 * we surface a clear error rather than silently falling back to an empty
 * body — the agent prompt is built from the template, and a silently-empty
 * template would produce confusing agent output that's hard to diagnose.
 *
 * `default` and `digest` are accepted when their workspace files do not
 * exist: the agent's research SKILL has its own built-in structures for
 * both modes (ADR-0011 §6), so callers may legitimately skip provisioning
 * a template file. In that case we return an empty body and the SKILL falls
 * back to its bundled structure.
 */
export async function loadTemplate(id: string, dir: string): Promise<ResearchTemplate> {
  if (!isSafeTemplateId(id)) {
    throw new Error(
      `loadTemplate: invalid template id '${id}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`,
    );
  }
  const path = join(dir, `${id}.md`);
  if (!(await pathExists(path))) {
    if (IMPLICIT_FALLBACK_IDS.has(id)) {
      // The bundled research SKILL ships a structure for these ids.
      // Returning an empty body signals "use built-in".
      return { id, path, body: "" };
    }
    throw new Error(`loadTemplate: template not found: ${path}`);
  }
  const body = await readFile(path, "utf8");
  return { id, path, body };
}
