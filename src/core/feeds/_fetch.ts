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
