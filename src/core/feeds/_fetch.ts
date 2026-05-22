import type { FetchLike } from "./types.js";

/**
 * Shared HTTP fetch wrapper for every feed adapter (`rss` / `html` /
 * `npm-registry` / `github-releases`).
 *
 * Why a wrapper instead of having each adapter call `fetch` directly:
 * - Proxy environments and flaky public RSS endpoints regularly hang or 5xx,
 *   so a default 30s **timeout** and a small **retry loop** for transient
 *   errors are needed everywhere — not just one adapter (issue #165).
 * - 4xx responses (404 / 401 / 403) are permanent: retrying them just burns
 *   the user's GitHub rate-limit / wall time. We only retry transient signals.
 * - Each adapter still passes its own `headers` and reads its own response
 *   body, so the wrapper stays a thin "fetch + timeout + retry" layer rather
 *   than a request-builder. The `options.fetch` test seam keeps working
 *   because the wrapper takes a `FetchLike` from the caller; mocks injected
 *   by tests flow through unchanged.
 *
 * Default tuning (see `resolveFetchConfig`):
 * - Timeout: 30s per attempt.
 * - Retries: 2 (so up to 3 attempts total).
 * - Backoff: 200ms → 800ms (×4 exponential).
 *
 * Both timeout and retries can be overridden via env vars `RADAR_FETCH_TIMEOUT_MS`
 * and `RADAR_FETCH_RETRIES`. We resolve them at call time (not module load)
 * so tests can mutate `process.env` between runs without import cache games.
 */

/** Default per-attempt timeout in milliseconds. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default number of retries after the initial attempt. */
export const DEFAULT_FETCH_RETRIES = 2;

/** Initial backoff in ms; doubled-and-quadrupled each retry (200 → 800 → ...). */
export const DEFAULT_FETCH_BACKOFF_BASE_MS = 200;

/** Multiplier between successive backoff attempts. */
export const DEFAULT_FETCH_BACKOFF_FACTOR = 4;

/**
 * Resolved fetch configuration. Exposed so tests can assert env parsing
 * behavior without touching the wrapper.
 */
export interface FetchConfig {
  timeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  backoffFactor: number;
}

/** Optional overrides that take precedence over env-var defaults. */
export interface FetchWithRetryOptions {
  timeoutMs?: number;
  retries?: number;
  backoffBaseMs?: number;
  backoffFactor?: number;
  /** Caller-provided abort signal (composed with the per-attempt timeout signal). */
  signal?: AbortSignal;
  /**
   * Sleep function for backoff. Injected by tests so the retry test does not
   * stall the suite waiting on a real timer.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Override env for `RADAR_FETCH_*` parsing. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Parse a positive integer env var, falling back to `fallback` on missing / invalid. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * SSRF host-blocklist for the shared fetch wrapper (ADR-0009 §D5b /
 * ADR-0012 §D5b). Every adapter that funnels through `fetchWithRetry`
 * inherits this check, including pagination follow-up URLs and recipe-
 * supplied URLs in `kind: json-api` where a malicious recipe / compromised
 * upstream could otherwise point us at:
 *
 * - cloud instance metadata endpoints (`169.254.169.254`, etc.) — IAM
 *   credential theft
 * - LAN / VPC internal services (`10.0.0.0/8`, `192.168.0.0/16`,
 *   `172.16.0.0/12`) — internal admin panels, unauthenticated dev servers
 * - loopback (`127.0.0.0/8` / `::1`) — user's localhost dev / debug services
 * - link-local (`169.254.0.0/16` / `fe80::/10`)
 * - IPv6 ULA (`fc00::/7`)
 * - non-HTTP schemes (`file://`, `data:`, `gopher://`, `ftp://`, …) —
 *   filesystem reads / SMTP smuggling / arbitrary protocol abuse
 *
 * Scope: this is the minimum useful defense — we inspect the URL hostname
 * literal only. We do not resolve DNS; an attacker can still get past this
 * by pointing a public DNS record at `127.0.0.1` (DNS rebinding). That
 * deeper defense is tracked separately (see ADR-0009 §D5b note on DNS
 * rebinding); the literal check still cuts off the common SSRF recipes
 * (metadata IPs, `file://`, `localhost`) for negligible cost.
 *
 * Override via `RADAR_FETCH_HOST_ALLOWLIST` (comma-separated host literals).
 * Intended for testing (e2e smoke tests that spin up a local HTTP fixture
 * on `127.0.0.1`) and explicit opt-in to private-network targets. The
 * allowlist is matched against the URL hostname after lowercasing and
 * trimming IPv6 brackets; entries are exact-match (no glob / CIDR).
 */

/** IPv4 octet sequence — used as a heuristic to detect numeric-only hosts. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Hostnames that always resolve to a loopback / unspecified address. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/**
 * Parse the `RADAR_FETCH_HOST_ALLOWLIST` env into a normalized Set. We
 * lowercase and strip IPv6 brackets so users can write either `[::1]` or
 * `::1` and have the override apply.
 */
function parseHostAllowlist(value: string | undefined): Set<string> {
  if (!value) return new Set();
  const entries = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => normalizeHost(s));
  return new Set(entries);
}

/** Lowercase a host and strip wrapping `[` / `]` from IPv6 literals. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) {
    return lower.slice(1, -1);
  }
  return lower;
}

/** Whether a host string is an IPv4 address in one of the private ranges. */
function isPrivateIPv4(host: string): boolean {
  const match = host.match(IPV4_PATTERN);
  if (!match) return false;
  const [, a, b, c, d] = match;
  const o1 = Number.parseInt(a ?? "", 10);
  const o2 = Number.parseInt(b ?? "", 10);
  const o3 = Number.parseInt(c ?? "", 10);
  const o4 = Number.parseInt(d ?? "", 10);
  // Reject malformed octets (>255). The URL parser already rejects most of
  // these but we keep the bound check for defense in depth.
  if (![o1, o2, o3, o4].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
    return true; // malformed = unsafe; treat as blocked.
  }
  // 10.0.0.0/8
  if (o1 === 10) return true;
  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  // 192.168.0.0/16
  if (o1 === 192 && o2 === 168) return true;
  // 127.0.0.0/8 (loopback)
  if (o1 === 127) return true;
  // 169.254.0.0/16 (link-local / AWS metadata)
  if (o1 === 169 && o2 === 254) return true;
  // 0.0.0.0/8 (unspecified — listens-everywhere on Linux)
  if (o1 === 0) return true;
  return false;
}

/**
 * Whether an IPv6 literal (already lowercase, brackets stripped) is in a
 * blocked range. We do not implement full address arithmetic — instead we
 * pattern-match the textual prefix, which is enough for the well-known
 * ranges we want to block (loopback, link-local, ULA, unspecified).
 *
 * Edge: `::ffff:a.b.c.d` IPv4-mapped form is normalized by Node's URL
 * parser to bracketed IPv6, so we also rerun the IPv4 check on the trailing
 * dotted-quad to catch the mapped-loopback case (`::ffff:127.0.0.1`).
 */
function isPrivateIPv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  // Link-local: fe80::/10 — first 10 bits are 1111 1110 10, which in hex
  // means `fe80::` through `febf::`. Match the first two chars after fe.
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
  // ULA: fc00::/7 — first 7 bits are 1111 110, i.e. fc00–fdff.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  // IPv4-mapped IPv6, dotted-quad form: ::ffff:127.0.0.1, ::ffff:10.0.0.1
  const v4MappedDotted = host.match(/^::ffff:([\d.]+)$/);
  if (v4MappedDotted?.[1] && isPrivateIPv4(v4MappedDotted[1])) return true;
  // IPv4-mapped IPv6, hex form: Node's URL parser normalizes
  // `::ffff:127.0.0.1` → `[::ffff:7f00:1]`, so we also accept the two
  // 16-bit hex groups after `::ffff:` and reconstruct the dotted quad.
  const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex?.[1] && v4MappedHex[2]) {
    const high = Number.parseInt(v4MappedHex[1], 16);
    const low = Number.parseInt(v4MappedHex[2], 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      if (isPrivateIPv4(dotted)) return true;
    }
  }
  return false;
}

/**
 * Validate a fetch URL against the SSRF host blocklist (ADR-0009 §D5b).
 *
 * Throws a `TypeError` with a user-friendly message when the URL is
 * rejected. Returns nothing on success.
 *
 * Exported so adapters / tests can trigger the check independently of
 * `fetchWithRetry` (e.g. validate a recipe URL at config-load time).
 */
export function validateFetchUrl(url: string | URL, env: NodeJS.ProcessEnv = process.env): void {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    throw new TypeError(`refused to fetch invalid URL: ${String(url)}`);
  }
  const allowlist = parseHostAllowlist(env.RADAR_FETCH_HOST_ALLOWLIST);
  const host = normalizeHost(parsed.hostname);

  // Allowlist short-circuits both scheme and host checks so users testing
  // a local fixture over `http://127.0.0.1:PORT/` do not need to fight
  // the blocklist for every adapter test.
  if (allowlist.has(host)) return;

  // Reject non-HTTP(S) schemes outright. `data:` / `file:` / `gopher:` /
  // `ftp:` / `javascript:` all have no business being fetched through an
  // adapter; even when they would not technically SSRF, they break the
  // wrapper's invariant ("HTTP request, retry on transient errors").
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `refused to fetch URL with non-HTTP scheme "${parsed.protocol}" (${String(url)}). ` +
        `Only http:// and https:// are allowed.`,
    );
  }

  // Blocked literal hostnames (`localhost` etc.).
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new TypeError(
      `refused to fetch loopback hostname "${host}" (${String(url)}). ` +
        `Set RADAR_FETCH_HOST_ALLOWLIST=${host} to override (testing only).`,
    );
  }

  // Numeric IPv4 / IPv6 ranges.
  if (isPrivateIPv4(host)) {
    throw new TypeError(
      `refused to fetch private / loopback IPv4 address "${host}" (${String(url)}). ` +
        `Set RADAR_FETCH_HOST_ALLOWLIST=${host} to override (testing only).`,
    );
  }
  if (host.includes(":") && isPrivateIPv6(host)) {
    throw new TypeError(
      `refused to fetch private / loopback IPv6 address "${host}" (${String(url)}). ` +
        `Set RADAR_FETCH_HOST_ALLOWLIST=${host} to override (testing only).`,
    );
  }
}

/**
 * Build a `FetchConfig` from env vars + explicit overrides.
 *
 * Precedence: explicit `options` → env vars → defaults. Negative / non-numeric
 * env values fall through to defaults so a typo never breaks fetching.
 */
export function resolveFetchConfig(options: FetchWithRetryOptions = {}): FetchConfig {
  const env = options.env ?? process.env;
  const timeoutMs =
    options.timeoutMs ?? parsePositiveInt(env.RADAR_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS);
  const retries =
    options.retries ?? parsePositiveInt(env.RADAR_FETCH_RETRIES, DEFAULT_FETCH_RETRIES);
  return {
    timeoutMs,
    retries,
    backoffBaseMs: options.backoffBaseMs ?? DEFAULT_FETCH_BACKOFF_BASE_MS,
    backoffFactor: options.backoffFactor ?? DEFAULT_FETCH_BACKOFF_FACTOR,
  };
}

/**
 * Node-style error code we want to retry on. Matches the codes the runtime
 * uses when a connection drops mid-flight or the OS routing layer rejects.
 */
const TRANSIENT_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"]);

/** Whether a thrown error from `fetch` looks like a transient network failure. */
function isTransientNetworkError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { code?: unknown; name?: unknown; cause?: unknown };
  // Direct Node-style errors (undici occasionally throws `{ code: 'ECONNRESET' }`).
  if (typeof e.code === "string" && TRANSIENT_ERROR_CODES.has(e.code)) return true;
  // AbortError from our per-attempt timeout — treat as transient so the retry
  // loop gets a chance. Caller-initiated aborts surface differently (their
  // signal already aborted before our `AbortSignal.any` collapsed).
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  // `fetch` wraps the underlying cause in `TypeError("fetch failed", { cause })`.
  if (e.cause != null) return isTransientNetworkError(e.cause);
  return false;
}

/** Whether an HTTP status code should trigger a retry (5xx is transient). */
function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** Default sleep used between retries; injectable for tests via options.sleep. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compose two signals: returns a signal that aborts when either input aborts.
 * Uses `AbortSignal.any` (Node 20.3+ / 22+). Falls back to a manual controller
 * for the legacy path (kept defensive — package engines is `>=22` but we still
 * guard so the wrapper does not hard-depend on the static method).
 */
function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s != null);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** The fetch response shape adapters consume (matches `FetchLike` return). */
type FetchResponse = Awaited<ReturnType<FetchLike>>;

/**
 * Issue an HTTP request via `fetchImpl` with timeout + retry semantics.
 *
 * The caller still owns the request shape (headers / method) and the response
 * body — we only retry the network round-trip. 5xx responses are returned to
 * the retry loop, but on the **final** attempt the response is returned to
 * the caller as-is (so the caller's adapter-specific error message wins).
 *
 * Retries kick in for:
 * - Thrown errors that look transient (ECONNRESET / ETIMEDOUT / ENETUNREACH
 *   / EAI_AGAIN, or our own timeout AbortError).
 * - HTTP 5xx responses.
 *
 * Retries do NOT happen for:
 * - HTTP 4xx (permanent — fail fast so users see real config issues).
 * - HTTP 2xx / 3xx (already success / handled by the adapter).
 * - Caller-initiated aborts (we re-throw to surface the cancellation).
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string | URL,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  options: FetchWithRetryOptions = {},
): Promise<FetchResponse> {
  const config = resolveFetchConfig(options);
  const sleep = options.sleep ?? defaultSleep;
  const callerSignal = options.signal ?? init.signal;

  // SSRF host blocklist (ADR-0009 / ADR-0012 §D5b). Runs *before* the retry
  // loop so a blocked URL fails fast with a single clear error rather than
  // looking like a transient network failure across multiple attempts.
  validateFetchUrl(url, options.env ?? process.env);

  let lastError: unknown;
  let lastResponse: FetchResponse | undefined;

  // attempts = retries + 1; e.g. retries=2 → 3 total attempts.
  const totalAttempts = config.retries + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    // Per-attempt timeout. We rebuild the signal each iteration so a slow
    // attempt does not poison the budget for the next one.
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = composeSignals(callerSignal, timeoutSignal);

    try {
      const response = await fetchImpl(url, { ...init, signal });
      // Retry transient 5xx; permanent 4xx / 2xx / 3xx fall through to the caller.
      if (isTransientStatus(response.status) && attempt < totalAttempts - 1) {
        lastResponse = response;
        await sleep(backoffDelay(attempt, config));
        continue;
      }
      return response;
    } catch (err) {
      // Caller-initiated abort short-circuits the retry loop — re-throw so the
      // adapter / consumer can see the cancellation.
      if (callerSignal?.aborted) throw err;

      if (isTransientNetworkError(err) && attempt < totalAttempts - 1) {
        lastError = err;
        await sleep(backoffDelay(attempt, config));
        continue;
      }
      throw err;
    }
  }

  // We only reach here if every attempt was a retryable 5xx (no exception
  // was thrown). Surface the last response so the adapter's HTTP-status error
  // message wins (the wrapper does not know each adapter's preferred phrasing).
  if (lastResponse) return lastResponse;
  // Defensive — should be unreachable, but if every attempt threw and we
  // exited the loop without returning, re-throw the last error.
  throw lastError ?? new Error("fetchWithRetry: exhausted retries with no response");
}

/** Compute the backoff delay for the given attempt index (0-based). */
function backoffDelay(attemptIndex: number, config: FetchConfig): number {
  return config.backoffBaseMs * config.backoffFactor ** attemptIndex;
}
