import type { FetchLike } from "./types.js";

const USER_AGENT = "agentic-watch/0.0.0 (+https://github.com/ozzy-labs/agentic-watch)";
const GITHUB_API_BASE = "https://api.github.com";

/**
 * Threshold under which we surface a rate-limit warning. GitHub resets the
 * counter every hour, so 10 leftover requests is the smallest cushion that
 * still lets a typical run (1–2 sources) complete before reset.
 */
const RATE_LIMIT_WARNING_THRESHOLD = 10;

/** A single GitHub Release as returned by the REST API. Only fields we touch are typed. */
export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string | null;
  created_at: string;
}

/** Parsed `owner/repo` extracted from various URL/shorthand inputs. */
export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Accept both `https://github.com/<owner>/<repo>` and shorthand `<owner>/<repo>`.
 *
 * We intentionally allow trailing path segments (`.../tree/main`, `.git`) so
 * users can paste any GitHub URL without trimming first.
 */
export function parseOwnerRepo(input: string): OwnerRepo {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("github-releases adapter: empty source URL");

  let candidate = trimmed;
  // URL form — strip protocol/host and any trailing path.
  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`github-releases adapter: invalid URL: ${input}`);
    }
    // Accept api.github.com/repos/<owner>/<repo> too, in case someone pastes an API URL.
    const path = url.pathname.replace(/^\/repos\//, "/").replace(/^\/+|\/+$/g, "");
    candidate = path;
  } else {
    candidate = candidate.replace(/^\/+|\/+$/g, "");
  }

  // Strip a `.git` suffix and anything past the second segment (`tree/main`, etc.).
  const segments = candidate.split("/").filter(Boolean);
  const [ownerSegment, repoSegment] = segments;
  if (!ownerSegment || !repoSegment) {
    throw new Error(`github-releases adapter: expected <owner>/<repo>, got: ${input}`);
  }
  const repo = repoSegment.replace(/\.git$/i, "");
  if (!repo) {
    throw new Error(`github-releases adapter: expected <owner>/<repo>, got: ${input}`);
  }
  return { owner: ownerSegment, repo };
}

/** Build the canonical Releases API URL for an `owner/repo`. */
export function buildReleasesUrl(owner: string, repo: string): string {
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
}

/** Inputs to `fetchReleases()`. `fetch` and `token` are injectable for tests. */
export interface FetchReleasesOptions {
  fetch?: FetchLike;
  /** GitHub PAT (or any token accepted by GitHub). Defaults to `process.env.GITHUB_TOKEN`. */
  token?: string;
  /** `If-None-Match` value from a previous response. */
  etag?: string;
  /** Logger for rate-limit warnings; defaults to `console.warn`. */
  warn?: (message: string) => void;
  signal?: AbortSignal;
}

/** Result shape returned by `fetchReleases()`. */
export interface FetchReleasesResult {
  status: number;
  releases: GitHubRelease[];
  etag: string | null;
  /** `true` when the server responded 304 Not Modified. */
  notModified: boolean;
  rateLimit: RateLimitInfo;
}

/** Subset of GitHub rate-limit headers we care about. */
export interface RateLimitInfo {
  /** Requests remaining in the current window (`X-RateLimit-Remaining`). */
  remaining: number | null;
  /** Total quota for the current window (`X-RateLimit-Limit`). */
  limit: number | null;
  /** Unix epoch seconds when the window resets (`X-RateLimit-Reset`). */
  resetAt: number | null;
}

/**
 * Fetch GitHub Releases for an `owner/repo`.
 *
 * Why we hit the REST API directly instead of bringing in `@octokit/rest`:
 * the adapter only needs one endpoint, and dropping the dep keeps the
 * published bundle small (see ADR-0002 / issue #37 commit 1 rationale).
 *
 * Authentication is opportunistic — without a token we still work, just at
 * the much lower 60 req/h anonymous rate. The caller (CLI) is expected to
 * surface `GITHUB_TOKEN` in user-facing docs.
 */
export async function fetchReleases(
  owner: string,
  repo: string,
  options: FetchReleasesOptions = {},
): Promise<FetchReleasesResult> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "github-releases adapter: no fetch implementation available (Node 22+ required)",
    );
  }

  const token = options.token ?? process.env.GITHUB_TOKEN;
  const warn = options.warn ?? ((m) => console.warn(m));

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    // Pinning the API version protects us from breaking schema changes on
    // the GitHub side without an explicit migration step.
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.etag) headers["if-none-match"] = options.etag;

  const url = buildReleasesUrl(owner, repo);
  const response = await fetchImpl(url, { headers, signal: options.signal });

  const rateLimit: RateLimitInfo = {
    remaining: parseIntHeader(response.headers.get("x-ratelimit-remaining")),
    limit: parseIntHeader(response.headers.get("x-ratelimit-limit")),
    resetAt: parseIntHeader(response.headers.get("x-ratelimit-reset")),
  };
  emitRateLimitWarning(rateLimit, owner, repo, token != null, warn);

  const etag = response.headers.get("etag");

  if (response.status === 304) {
    return { status: 304, releases: [], etag, notModified: true, rateLimit };
  }

  if (response.status === 403 && rateLimit.remaining === 0) {
    // Distinct error message so the CLI / docs can guide users to set
    // `GITHUB_TOKEN`. The bare HTTP 403 message is ambiguous (could be auth).
    const resetHint = formatResetHint(rateLimit.resetAt);
    throw new Error(
      `github-releases adapter: rate limit exhausted for ${owner}/${repo}${resetHint}. ` +
        (token
          ? "Authenticated quota is 5000 req/h."
          : "Set GITHUB_TOKEN to raise the quota from 60 to 5000 req/h."),
    );
  }

  if (response.status === 404) {
    throw new Error(`github-releases adapter: repository not found: ${owner}/${repo}`);
  }

  if (response.status === 401) {
    throw new Error(
      `github-releases adapter: authentication failed for ${owner}/${repo} (check GITHUB_TOKEN)`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`github-releases adapter: HTTP ${response.status} from ${url}`);
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `github-releases adapter: failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `github-releases adapter: expected JSON array from ${url}, got ${typeof parsed}`,
    );
  }
  const releases = parsed.filter(isGitHubRelease);
  return { status: response.status, releases, etag, notModified: false, rateLimit };
}

/** Narrow `unknown` to `GitHubRelease`. Defensive — drops malformed entries silently. */
function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    typeof v.tag_name === "string" &&
    typeof v.html_url === "string" &&
    typeof v.draft === "boolean" &&
    typeof v.prerelease === "boolean"
  );
}

function parseIntHeader(value: string | null): number | null {
  if (value == null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function emitRateLimitWarning(
  rateLimit: RateLimitInfo,
  owner: string,
  repo: string,
  authenticated: boolean,
  warn: (message: string) => void,
): void {
  const { remaining, limit } = rateLimit;
  if (remaining == null || remaining > RATE_LIMIT_WARNING_THRESHOLD) return;
  const limitHint = limit != null ? `/${limit}` : "";
  const authHint = authenticated
    ? ""
    : " Set GITHUB_TOKEN to raise the quota from 60 to 5000 req/h.";
  const resetHint = formatResetHint(rateLimit.resetAt);
  warn(
    `github-releases: rate limit low (${remaining}${limitHint} remaining) for ${owner}/${repo}${resetHint}.${authHint}`,
  );
}

function formatResetHint(resetAt: number | null): string {
  if (resetAt == null) return "";
  const date = new Date(resetAt * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return ` (resets at ${date.toISOString()})`;
}
