import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Result of {@link resolveCommitPathInside}: either the canonical absolute
 * `resolved` path (safe to finalize), or an `error` message fragment the
 * caller prefixes with its command name.
 */
export type CommitPathResult = { resolved: string } | { error: string };

/**
 * Resolve and constrain a host-agent `--commit <path>` to `<cwd>/<subdir>/`,
 * enforcing ADR-0009 M3b in code (not just SKILL guidance) for every
 * report-finalizing command (`research` / `review` / `update`, #254 / ADR-0019).
 *
 * Two layers:
 *
 * 1. **Literal prefix check** rejects `..` escapes and sibling directories
 *    (e.g. `research-evil/`) up front, even when nothing has been written yet
 *    — `resolve()` normalizes `..` so the comparison is on a canonical-ish
 *    string.
 * 2. **Symlink check** (`realpath`) rejects a path that escapes the base via a
 *    symlink the host was misled into committing (e.g. `research/link ->
 *    /etc`). `realpath` throws `ENOENT` when the report has not been written
 *    yet (or the base dir is absent); that is not an escape, so we fall
 *    through and let the caller's finalize step report the missing file.
 *
 * The returned `resolved` path is the literal `resolve(cwd, commitPath)` (not
 * the realpath) so the caller reads/writes the path the host actually named;
 * the realpath check is a guard, not a rewrite.
 */
export async function resolveCommitPathInside(
  cwd: string,
  subdir: string,
  commitPath: string,
): Promise<CommitPathResult> {
  const baseDir = resolve(cwd, subdir);
  const resolved = resolve(cwd, commitPath);
  if (!resolved.startsWith(baseDir + sep)) {
    return { error: `--commit path must be a file under ${baseDir} (got: ${commitPath})` };
  }
  try {
    const realBase = await realpath(baseDir);
    const realResolved = await realpath(resolved);
    if (realResolved !== realBase && !realResolved.startsWith(realBase + sep)) {
      return { error: `--commit path escapes ${baseDir} via a symlink (got: ${commitPath})` };
    }
  } catch {
    // Missing file / base dir: defer to the caller's finalize step, which
    // reports the report as not written rather than as an escape.
  }
  return { resolved };
}
