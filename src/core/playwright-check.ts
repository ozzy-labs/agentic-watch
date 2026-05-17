import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

/**
 * Detection / install helpers for the optional `playwright` peer dependency
 * used by the `html-js` feed adapter (ADR-0010).
 *
 * The `html-js` adapter resolves Playwright at fetch time via
 * `await import("playwright")`, so the package is intentionally optional in
 * `package.json#peerDependenciesMeta`. Two CLI surfaces need to inspect that
 * resolution outside of the adapter itself:
 *
 *   1. `radar doctor` — proactively reports whether Playwright + Chromium are
 *      installed so users can fix the environment before scheduling a watch.
 *   2. `radar watch run` — lazily probes Playwright on the first `html-js`
 *      source so a missing install does not abort the whole run; the affected
 *      source is skipped with an actionable error, other kinds continue.
 *
 * Both paths share the same probe / install helpers here to keep the install
 * hint and `RADAR_AUTO_INSTALL_CHROMIUM` escape hatch in one place. The escape
 * hatch exists for CI scenarios where a fresh runner has `playwright` itself
 * (e.g. via `npm i`) but no browser binary on disk yet.
 *
 * Policy choices (intentional, not for adapter to second-guess):
 *
 *   - We do NOT auto-install the `playwright` npm package. Global npm installs
 *     fail in non-obvious ways (permissions, version mismatches with the
 *     workspace's lockfile), so the user must run `npm i -g playwright`
 *     themselves and get a clear error from `npm` if it fails.
 *   - We DO auto-install Chromium when `RADAR_AUTO_INSTALL_CHROMIUM=1` is set
 *     and Playwright is present. `npx playwright install chromium` is the
 *     official path, idempotent, and well-supported in CI runners.
 */

/**
 * Minimal Playwright surface this module reasons about. We only need
 * `chromium.executablePath()` (sync function returning a fs path) — the
 * fetcher in `feeds/html-js.ts` keeps its own structural type for the launch
 * subset it actually uses.
 */
export interface PlaywrightModuleLike {
  chromium: {
    executablePath: () => string;
  };
}

/**
 * Outcome of a Playwright probe. Discriminated union so callers branch
 * cleanly on the failure mode without parsing error messages.
 *
 * - `ok`: module loaded AND `chromium.executablePath()` points at an
 *   existing file on disk.
 * - `module-missing`: `import("playwright")` threw (package not installed).
 * - `chromium-missing`: module loaded but the executable path is absent.
 *   The path is included so callers can show it to the user.
 */
export type PlaywrightProbeResult =
  | { status: "ok"; executablePath: string }
  | { status: "module-missing"; message: string }
  | { status: "chromium-missing"; executablePath: string };

/**
 * Test seam: lets unit tests inject a fake importer / `pathExists` so we can
 * exercise every branch (module missing, chromium missing, ok) without
 * touching the real Playwright install.
 *
 * The real CLI never passes these; defaults are dynamic import + `fs.access`.
 */
export interface ProbeOptions {
  /** Replace dynamic `import("playwright")` (tests only). */
  importPlaywright?: () => Promise<unknown>;
  /** Replace fs existence check (tests only). */
  pathExists?: (p: string) => Promise<boolean>;
}

async function defaultPathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether Playwright + Chromium are usable from this process.
 *
 * Order matters: we MUST surface "module missing" before attempting any
 * property access — `chromium.executablePath()` would throw with a less
 * actionable message ("Cannot read properties of undefined").
 */
export async function probePlaywright(options: ProbeOptions = {}): Promise<PlaywrightProbeResult> {
  const importPlaywright = options.importPlaywright ?? (() => import("playwright"));
  const pathExists = options.pathExists ?? defaultPathExists;

  let mod: PlaywrightModuleLike;
  try {
    mod = (await importPlaywright()) as PlaywrightModuleLike;
  } catch (e) {
    return {
      status: "module-missing",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  let execPath: string;
  try {
    execPath = mod.chromium.executablePath();
  } catch (e) {
    // `executablePath()` raises when no browsers were ever installed via
    // `npx playwright install`. Treat as the same user-actionable failure as a
    // missing file on disk; surface an empty path so callers know the message
    // came from this branch.
    return {
      status: "chromium-missing",
      executablePath: e instanceof Error ? `(${e.message})` : "(unknown)",
    };
  }

  if (!(await pathExists(execPath))) {
    return { status: "chromium-missing", executablePath: execPath };
  }
  return { status: "ok", executablePath: execPath };
}

/**
 * User-facing install hint emitted when Playwright (the npm package) is
 * missing. The text matches the wording in `feeds/html-js.ts#loadPlaywright`
 * so users see consistent guidance across `doctor` and `watch run`.
 *
 * `RADAR_AUTO_INSTALL_CHROMIUM` is mentioned only in the Chromium-missing
 * branch — auto-installing the npm package itself is intentionally out of
 * scope (see module header).
 */
export const PLAYWRIGHT_MODULE_MISSING_HINT =
  "Playwright is required for kind: html-js. Run: npm i -g playwright && npx playwright install chromium\n" +
  "Or set RADAR_AUTO_INSTALL_CHROMIUM=1 to auto-install on next run.";

/**
 * User-facing install hint emitted when the npm package is present but the
 * Chromium binary on disk is not. Mentions the auto-install escape hatch
 * since this is the branch it actually applies to.
 */
export const CHROMIUM_MISSING_HINT =
  "Chromium binary not found. Run: npx playwright install chromium\n" +
  "Or set RADAR_AUTO_INSTALL_CHROMIUM=1 to auto-install on next run.";

/**
 * Test seam for the spawn used by `installChromium`. Production passes
 * the real `child_process.spawn`; tests inject a fake that returns a
 * predetermined exit code without actually launching a subprocess.
 */
export type InstallSpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; stdio?: "inherit" | "pipe" | "ignore" },
) => {
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
};

export interface InstallChromiumOptions {
  /** Working directory for the spawned `npx`. Defaults to the caller's cwd. */
  cwd?: string;
  /** Test seam: swap out `child_process.spawn`. */
  spawnImpl?: InstallSpawnLike;
  /** Sink for progress messages (defaults to console.log). */
  log?: (message: string) => void;
}

/**
 * Spawn `npx playwright install chromium` and resolve when it exits.
 *
 * Used by the `RADAR_AUTO_INSTALL_CHROMIUM=1` escape hatch. We pipe output
 * through `stdio: "inherit"` so the user (or CI logs) sees Playwright's
 * progress in real time — `npx playwright install` already prints
 * download URLs and percentages that are helpful debugging signal when the
 * install fails. Resolves to the child's exit code so callers can decide
 * whether to retry the original operation.
 *
 * Note we explicitly use `npx` (not direct binary lookup) because Playwright
 * does not expose a JS API for browser install; the CLI is the supported
 * entrypoint per Playwright docs.
 */
export async function installChromium(options: InstallChromiumOptions = {}): Promise<number> {
  const spawnImpl = options.spawnImpl ?? (spawn as unknown as InstallSpawnLike);
  const log = options.log ?? ((m: string) => console.log(m));
  log("Installing Chromium via `npx playwright install chromium`...");
  return new Promise<number>((resolve, reject) => {
    const child = spawnImpl("npx", ["playwright", "install", "chromium"], {
      cwd: options.cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
