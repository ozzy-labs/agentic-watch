/**
 * Proxy environment detection & NODE_OPTIONS merging helpers.
 *
 * `radar` runs `fetch()` on Node's built-in `undici`. Honoring `HTTPS_PROXY` /
 * `HTTP_PROXY` requires `NODE_OPTIONS=--use-env-proxy` (Node 22.21+ / 24.5+).
 * Rather than asking users to set it manually, the `bin` self-respawns with
 * the flag injected when a proxy env var is present.
 *
 * This module is intentionally pure (no I/O, no `process` access) so the
 * detection / merge logic can be unit tested with arbitrary env objects.
 */

/**
 * Result of probing the environment for a proxy URL. `source` records which
 * variable supplied the URL so the CLI can warn when only `ALL_PROXY` is set
 * (`ALL_PROXY` does not engage `--use-env-proxy`; users must also set
 * `HTTPS_PROXY` or `HTTP_PROXY`).
 */
export interface ProxyDetection {
  /** The proxy URL string as found in env (no normalization). */
  url: string;
  /** Variable name the URL was sourced from. */
  source: "HTTPS_PROXY" | "HTTP_PROXY" | "ALL_PROXY";
  /**
   * True when the URL came **only** from `ALL_PROXY` and no `HTTPS_PROXY` /
   * `HTTP_PROXY` is set. `--use-env-proxy` ignores `ALL_PROXY`, so the CLI
   * should warn the user before respawning would otherwise be a no-op.
   */
  allProxyOnly: boolean;
}

/**
 * Lookup order: HTTPS_PROXY → HTTP_PROXY → ALL_PROXY, each tried in upper-case
 * then lower-case form (POSIX convention, matches what `undici` itself checks).
 * Empty-string values are treated as unset, matching `curl` / `wget` behavior
 * where `HTTPS_PROXY=""` disables the proxy rather than configures it.
 */
export function detectProxyUrl(env: NodeJS.ProcessEnv): ProxyDetection | undefined {
  const pick = (name: string): string | undefined => {
    const upper = env[name];
    if (upper && upper.length > 0) return upper;
    const lower = env[name.toLowerCase()];
    if (lower && lower.length > 0) return lower;
    return undefined;
  };

  const https = pick("HTTPS_PROXY");
  if (https) return { url: https, source: "HTTPS_PROXY", allProxyOnly: false };

  const http = pick("HTTP_PROXY");
  if (http) return { url: http, source: "HTTP_PROXY", allProxyOnly: false };

  const all = pick("ALL_PROXY");
  if (all) return { url: all, source: "ALL_PROXY", allProxyOnly: true };

  return undefined;
}

/**
 * Append `flag` to an existing `NODE_OPTIONS` string, preserving user-supplied
 * options. Skips the append when the exact flag is already present (whitespace
 * separated) so re-spawn chains don't keep growing the env var.
 *
 * `existing` may be `undefined` (env var unset) or empty string — both yield
 * just `flag` with no leading whitespace.
 */
export function mergeNodeOptions(existing: string | undefined, flag: string): string {
  if (!existing || existing.length === 0) return flag;
  // Whitespace-split avoids false positives like matching `--use-env-proxy`
  // against an unrelated flag that contains the same substring.
  const tokens = existing.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.includes(flag)) return existing;
  return `${existing} ${flag}`;
}
