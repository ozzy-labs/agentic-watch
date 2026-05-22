import { describe, expect, it } from "vitest";
import {
  DEFAULT_FETCH_RETRIES,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithRetry,
  resolveFetchConfig,
  validateFetchUrl,
} from "../../../src/core/feeds/_fetch.js";
import type { FetchLike } from "../../../src/core/feeds/types.js";

/**
 * Build a mock fetch that consumes a queue of scripted reactions.
 *
 * Each step can either:
 * - return an HTTP response (`{ status, body?, headers? }`), or
 * - throw an error (`{ throws: Error }`), or
 * - hang until the caller-supplied signal aborts (`{ hang: true }`) — used
 *   to exercise the timeout path without sleeping for real.
 */
type ScriptedStep =
  | { status: number; body?: string; headers?: Record<string, string> }
  | { throws: unknown }
  | { hang: true };

function makeFetch(script: ScriptedStep[]): {
  fetch: FetchLike;
  calls: { url: string; init: { headers?: Record<string, string>; signal?: AbortSignal } }[];
} {
  const queue = [...script];
  const calls: { url: string; init: { headers?: Record<string, string>; signal?: AbortSignal } }[] =
    [];
  const fetch: FetchLike = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const step = queue.shift();
    if (!step) throw new Error("makeFetch: no more scripted steps");
    if ("throws" in step) throw step.throws;
    if ("hang" in step) {
      // Resolve only when the per-attempt timeout (or caller signal) aborts.
      return await new Promise((_, reject) => {
        const signal = init.signal;
        if (signal == null) {
          // Without a signal we would hang forever — surface that as a test bug.
          reject(new Error("makeFetch: hang step requires init.signal"));
          return;
        }
        const onAbort = () => {
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    return {
      status: step.status,
      headers: {
        get(name: string): string | null {
          const lower = name.toLowerCase();
          for (const [k, v] of Object.entries(step.headers ?? {})) {
            if (k.toLowerCase() === lower) return v;
          }
          return null;
        },
      },
      text: async () => step.body ?? "",
    };
  };
  return { fetch, calls };
}

function noSleep() {
  // Backoff timer that does not actually wait — the retry semantics are what
  // we are testing, not the wall-clock spacing.
  return Promise.resolve();
}

describe("core/feeds/_fetch — resolveFetchConfig", () => {
  it("returns the documented defaults when no env / overrides are set", () => {
    const config = resolveFetchConfig({ env: {} });
    expect(config.timeoutMs).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    expect(config.retries).toBe(DEFAULT_FETCH_RETRIES);
  });

  it("reads RADAR_FETCH_TIMEOUT_MS / RADAR_FETCH_RETRIES from env", () => {
    const config = resolveFetchConfig({
      env: { RADAR_FETCH_TIMEOUT_MS: "1500", RADAR_FETCH_RETRIES: "5" },
    });
    expect(config.timeoutMs).toBe(1500);
    expect(config.retries).toBe(5);
  });

  it("falls back to defaults when env values are non-numeric or negative", () => {
    const config = resolveFetchConfig({
      env: { RADAR_FETCH_TIMEOUT_MS: "not-a-number", RADAR_FETCH_RETRIES: "-1" },
    });
    expect(config.timeoutMs).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    expect(config.retries).toBe(DEFAULT_FETCH_RETRIES);
  });

  it("lets explicit options override env vars", () => {
    const config = resolveFetchConfig({
      env: { RADAR_FETCH_TIMEOUT_MS: "1500", RADAR_FETCH_RETRIES: "5" },
      timeoutMs: 100,
      retries: 0,
    });
    expect(config.timeoutMs).toBe(100);
    expect(config.retries).toBe(0);
  });
});

describe("core/feeds/_fetch — fetchWithRetry", () => {
  it("returns the response on the first attempt when 2xx", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: "ok" }]);
    const res = await fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {} });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("retries a 5xx response and succeeds on the next attempt", async () => {
    const { fetch, calls } = makeFetch([
      { status: 503, body: "down" },
      { status: 200, body: "ok" },
    ]);
    const res = await fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {} });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry on 4xx responses", async () => {
    const { fetch, calls } = makeFetch([{ status: 404, body: "missing" }]);
    const res = await fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {} });
    expect(res.status).toBe(404);
    // One attempt only — the wrapper must not waste retries on permanent errors.
    expect(calls).toHaveLength(1);
  });

  it("returns the final 5xx response after retries are exhausted", async () => {
    const { fetch, calls } = makeFetch([
      { status: 500, body: "boom" },
      { status: 502, body: "still boom" },
      { status: 503, body: "really boom" },
    ]);
    const res = await fetchWithRetry(
      fetch,
      "https://example.com",
      {},
      { sleep: noSleep, env: {}, retries: 2 },
    );
    // After 3 attempts (1 + 2 retries) the wrapper hands the last response
    // back so the adapter's HTTP-status error message wins.
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("retries transient network errors and surfaces the last error if retries are exhausted", async () => {
    const ECONNRESET = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const { fetch, calls } = makeFetch([
      { throws: ECONNRESET },
      { throws: ECONNRESET },
      { throws: ECONNRESET },
    ]);
    await expect(
      fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {}, retries: 2 }),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(calls).toHaveLength(3);
  });

  it("retries a transient error and returns success on the next attempt", async () => {
    const ETIMEDOUT = Object.assign(new Error("etimedout"), { code: "ETIMEDOUT" });
    const { fetch, calls } = makeFetch([{ throws: ETIMEDOUT }, { status: 200, body: "ok" }]);
    const res = await fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {} });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries when fetch throws a TypeError with a transient cause (undici shape)", async () => {
    // undici wraps low-level errors in `TypeError('fetch failed', { cause })`.
    const cause = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
    const wrapped = new TypeError("fetch failed");
    Object.assign(wrapped, { cause });
    const { fetch, calls } = makeFetch([{ throws: wrapped }, { status: 200, body: "ok" }]);
    const res = await fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {} });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry non-transient thrown errors", async () => {
    const oddError = new Error("malformed url");
    const { fetch, calls } = makeFetch([{ throws: oddError }]);
    await expect(
      fetchWithRetry(fetch, "https://example.com", {}, { sleep: noSleep, env: {}, retries: 2 }),
    ).rejects.toBe(oddError);
    expect(calls).toHaveLength(1);
  });

  it("applies a per-attempt timeout and retries the timed-out attempt", async () => {
    // First step hangs until our timeout signal aborts (≤ 5ms);
    // second step returns a real 200 OK so we can verify retry happened.
    const { fetch, calls } = makeFetch([{ hang: true }, { status: 200, body: "ok" }]);
    const res = await fetchWithRetry(
      fetch,
      "https://example.com",
      {},
      { sleep: noSleep, env: {}, timeoutMs: 5 },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("re-throws caller aborts without retrying", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancel"));
    const { fetch, calls } = makeFetch([
      // Step will only be consumed if the wrapper actually calls fetch; the
      // composed signal is aborted, so the mock will throw immediately.
      { hang: true },
    ]);
    await expect(
      fetchWithRetry(
        fetch,
        "https://example.com",
        { signal: controller.signal },
        { sleep: noSleep, env: {}, retries: 2 },
      ),
    ).rejects.toBeTruthy();
    // Wrapper still issues the fetch (the abort happens at the layer below),
    // but it must NOT retry once the caller signal is aborted.
    expect(calls).toHaveLength(1);
  });

  it("propagates request headers through every retry attempt", async () => {
    const { fetch, calls } = makeFetch([{ status: 500 }, { status: 200, body: "ok" }]);
    await fetchWithRetry(
      fetch,
      "https://example.com",
      { headers: { "x-test": "yes" } },
      { sleep: noSleep, env: {} },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.headers?.["x-test"]).toBe("yes");
    expect(calls[1]?.init.headers?.["x-test"]).toBe("yes");
  });

  it("honors RADAR_FETCH_RETRIES=0 (no retries, fail fast)", async () => {
    const { fetch, calls } = makeFetch([{ status: 500, body: "boom" }]);
    const res = await fetchWithRetry(
      fetch,
      "https://example.com",
      {},
      { sleep: noSleep, env: { RADAR_FETCH_RETRIES: "0" } },
    );
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("rejects a blocked URL before issuing a request (private IP)", async () => {
    // ADR-0009 §D5b: SSRF host blocklist runs ahead of the retry loop, so
    // a blocked URL surfaces a single TypeError rather than 3 transient-
    // looking failures.
    const { fetch, calls } = makeFetch([]);
    await expect(
      fetchWithRetry(fetch, "http://192.168.1.1/admin", {}, { sleep: noSleep, env: {} }),
    ).rejects.toThrow(/private \/ loopback IPv4 address/);
    expect(calls).toHaveLength(0);
  });

  it("honors RADAR_FETCH_HOST_ALLOWLIST for the blocklist (testing override)", async () => {
    // The e2e CLI smoke test serves a fixture from 127.0.0.1; the same
    // override path needs to work end-to-end through the wrapper.
    const { fetch, calls } = makeFetch([{ status: 200, body: "ok" }]);
    const res = await fetchWithRetry(
      fetch,
      "http://127.0.0.1:8080/feed.xml",
      {},
      { sleep: noSleep, env: { RADAR_FETCH_HOST_ALLOWLIST: "127.0.0.1" } },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("core/feeds/_fetch — validateFetchUrl (ADR-0009 §D5b SSRF blocklist)", () => {
  it("allows public https URLs", () => {
    expect(() => validateFetchUrl("https://aws.amazon.com/blogs/", {})).not.toThrow();
    expect(() => validateFetchUrl("https://api.github.com/repos/o/r/releases", {})).not.toThrow();
    expect(() => validateFetchUrl("http://example.com/feed.xml", {})).not.toThrow();
  });

  it("rejects non-HTTP schemes", () => {
    // `file://` could read arbitrary local files when proxied through an
    // adapter; data: bypasses retry semantics entirely; gopher: / ftp:
    // are protocol-confusion vectors.
    expect(() => validateFetchUrl("file:///etc/passwd", {})).toThrow(/non-HTTP scheme/);
    expect(() => validateFetchUrl("data:text/plain,hello", {})).toThrow(/non-HTTP scheme/);
    expect(() => validateFetchUrl("gopher://example.com/", {})).toThrow(/non-HTTP scheme/);
    expect(() => validateFetchUrl("ftp://example.com/file", {})).toThrow(/non-HTTP scheme/);
    expect(() => validateFetchUrl("javascript:alert(1)", {})).toThrow(/non-HTTP scheme/);
  });

  it("rejects IPv4 RFC1918 private ranges", () => {
    expect(() => validateFetchUrl("http://10.0.0.1/", {})).toThrow(/private/);
    expect(() => validateFetchUrl("http://10.255.255.255/", {})).toThrow(/private/);
    expect(() => validateFetchUrl("http://172.16.0.1/", {})).toThrow(/private/);
    expect(() => validateFetchUrl("http://172.31.255.255/", {})).toThrow(/private/);
    expect(() => validateFetchUrl("http://192.168.1.1/", {})).toThrow(/private/);
    expect(() => validateFetchUrl("http://192.168.255.255/", {})).toThrow(/private/);
  });

  it("rejects IPv4 loopback (127.0.0.0/8) and unspecified (0.0.0.0/8)", () => {
    expect(() => validateFetchUrl("http://127.0.0.1/", {})).toThrow(/loopback/);
    expect(() => validateFetchUrl("http://127.99.99.99/", {})).toThrow(/loopback/);
    expect(() => validateFetchUrl("http://0.0.0.0/", {})).toThrow(/loopback/);
  });

  it("rejects IPv4 link-local (169.254.0.0/16, AWS metadata)", () => {
    // 169.254.169.254 is the well-known AWS / GCP / Azure metadata endpoint
    // — the canonical SSRF-to-IAM-credentials pipeline that this blocklist
    // is primarily defending against.
    expect(() => validateFetchUrl("http://169.254.169.254/latest/meta-data/", {})).toThrow(
      /private/,
    );
    expect(() => validateFetchUrl("http://169.254.0.1/", {})).toThrow(/private/);
  });

  it("rejects 'localhost' and IPv6 localhost aliases", () => {
    expect(() => validateFetchUrl("http://localhost:8080/", {})).toThrow(/loopback hostname/);
    expect(() => validateFetchUrl("http://LOCALHOST/", {})).toThrow(/loopback hostname/);
    expect(() => validateFetchUrl("http://ip6-localhost/", {})).toThrow(/loopback hostname/);
  });

  it("rejects IPv6 loopback (::1) and unspecified (::)", () => {
    expect(() => validateFetchUrl("http://[::1]/", {})).toThrow(/IPv6/);
    expect(() => validateFetchUrl("http://[::]/", {})).toThrow(/IPv6/);
  });

  it("rejects IPv6 link-local (fe80::/10)", () => {
    expect(() => validateFetchUrl("http://[fe80::1]/", {})).toThrow(/IPv6/);
    expect(() => validateFetchUrl("http://[febf::abcd]/", {})).toThrow(/IPv6/);
  });

  it("rejects IPv6 ULA (fc00::/7)", () => {
    expect(() => validateFetchUrl("http://[fc00::1]/", {})).toThrow(/IPv6/);
    expect(() => validateFetchUrl("http://[fd12:3456:789a::1]/", {})).toThrow(/IPv6/);
  });

  it("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    // Without this guard an attacker can sneak past the IPv4 check by
    // forcing the URL parser into IPv4-mapped form.
    expect(() => validateFetchUrl("http://[::ffff:127.0.0.1]/", {})).toThrow(/IPv6/);
    expect(() => validateFetchUrl("http://[::ffff:10.0.0.1]/", {})).toThrow(/IPv6/);
  });

  it("honors RADAR_FETCH_HOST_ALLOWLIST as comma-separated host literals", () => {
    expect(() =>
      validateFetchUrl("http://127.0.0.1:8080/", {
        RADAR_FETCH_HOST_ALLOWLIST: "127.0.0.1",
      }),
    ).not.toThrow();
    // Multiple entries, whitespace tolerated.
    expect(() =>
      validateFetchUrl("http://192.168.1.5/", {
        RADAR_FETCH_HOST_ALLOWLIST: "127.0.0.1, 192.168.1.5 , localhost",
      }),
    ).not.toThrow();
    // IPv6 with or without brackets — both should be accepted.
    expect(() =>
      validateFetchUrl("http://[::1]/", { RADAR_FETCH_HOST_ALLOWLIST: "::1" }),
    ).not.toThrow();
    expect(() =>
      validateFetchUrl("http://[::1]/", { RADAR_FETCH_HOST_ALLOWLIST: "[::1]" }),
    ).not.toThrow();
  });

  it("still rejects file:// URLs even when an allowlist is set (file:// has no host)", () => {
    // `file://localhost/etc/passwd` parses to hostname=""; the allowlist
    // check is by exact host match, so the scheme rejection still fires.
    // Documenting this: the allowlist is *not* a scheme-bypass for the
    // empty-host shape that `file://` produces.
    expect(() =>
      validateFetchUrl("file://localhost/etc/passwd", {
        RADAR_FETCH_HOST_ALLOWLIST: "localhost",
      }),
    ).toThrow(/non-HTTP scheme/);
  });

  it("rejects malformed / unparseable URLs", () => {
    expect(() => validateFetchUrl("not a url", {})).toThrow(/invalid URL/);
  });

  it("accepts URL objects, not just strings", () => {
    expect(() => validateFetchUrl(new URL("https://example.com/"), {})).not.toThrow();
    expect(() => validateFetchUrl(new URL("http://10.0.0.1/"), {})).toThrow(/private/);
  });
});
