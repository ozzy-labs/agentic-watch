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
 * Load `templates/<id>.md` from the workspace.
 *
 * The CLI defaults `--template default`, so callers will typically pass
 * `"default"` here. If the file is missing we surface a clear error rather
 * than silently falling back to an empty body — the agent prompt is built
 * from the template, and a silently-empty template would produce confusing
 * agent output that's hard to diagnose.
 *
 * `default` is also accepted when no `templates/default.md` exists: the
 * agent's research SKILL has its own built-in default structure, so callers
 * may legitimately skip provisioning a template file. In that case we return
 * an empty body and the SKILL falls back to its bundled structure.
 */
export async function loadTemplate(id: string, dir: string): Promise<ResearchTemplate> {
  if (!isSafeTemplateId(id)) {
    throw new Error(
      `loadTemplate: invalid template id '${id}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`,
    );
  }
  const path = join(dir, `${id}.md`);
  if (!(await pathExists(path))) {
    if (id === "default") {
      // `default` is allowed to be absent — the bundled research SKILL ships
      // its own structure. Returning an empty body signals "use built-in".
      return { id, path, body: "" };
    }
    throw new Error(`loadTemplate: template not found: ${path}`);
  }
  const body = await readFile(path, "utf8");
  return { id, path, body };
}
