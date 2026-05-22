import { type AddressInfo, createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlAdapter } from "../../src/core/feeds/html.js";
import type { Source } from "../../src/schemas/index.js";

/**
 * Integration tests for `kind: html` (static HTML adapter).
 *
 * Unit tests in `tests/core/feeds/html.test.ts` exercise the adapter against
 * a hand-rolled `FetchLike` mock; that path skips the entire shared
 * `_fetch.ts` wrapper (SSRF blocklist, retry, timeout, real network round
 * trip). This file boots a real `node:http` server bound to `127.0.0.1` so
 * `htmlAdapter.fetch()` flows through `globalThis.fetch` → `fetchWithRetry`
 * → kernel → server, proving the full path works end-to-end:
 *
 * 1. Items extraction from a real HTTP body (selectors + relative URL resolution).
 * 2. Conditional GET: `If-None-Match` round trip producing a real `304`.
 * 3. SSRF blocklist (`127.0.0.1` rejected by default, allowlist opt-in works).
 *
 * Lives under `tests/integration/**` so it runs only via `pnpm test:integration`
 * (see `vitest.integration.config.ts`) and stays out of the fast `pnpm test`
 * unit loop. Unlike `html-js.test.ts` it does NOT require Playwright; the only
 * external dependency is a kernel-assigned loopback port.
 */

const HTML_FIXTURE = `<!doctype html>
<html><body>
  <main>
    <article class="post">
      <h2><a href="/changelog/hello">Hello World</a></h2>
      <p class="summary">First post summary</p>
    </article>
    <article class="post">
      <h2><a href="https://example.com/changelog/second">Second Post</a></h2>
      <p class="summary">Second post summary</p>
    </article>
  </main>
</body></html>`;

function makeSource(url: string, overrides: Partial<Source> = {}): Source {
  return {
    id: "html-integration",
    kind: "html",
    url,
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
    selectors: {
      item: "article.post",
      title: "h2 a",
      link: "h2 a",
      summary: "p.summary",
    },
    trustLevel: "untrusted",
    ...overrides,
  };
}

/**
 * Tracker for assertions on what the server received and what it sent back.
 * Filled by the request handler on every hit so tests can assert headers
 * (e.g. `if-none-match`) after the adapter returns.
 */
interface RequestLog {
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
}

/**
 * Boot a single-process HTTP server on a kernel-assigned 127.0.0.1 port.
 *
 * The handler is provided by the caller so each test can script the exact
 * status code / headers it needs (200 with body, 304 with ETag echo, etc.).
 * Returns the base URL plus a teardown that resolves after the server has
 * fully closed (so a slow GC does not leak file descriptors between cases).
 */
async function startServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ url: string; close: () => Promise<void>; log: RequestLog }> {
  const log: RequestLog = { requests: [] };
  const server: Server = createServer((req, res) => {
    log.requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: { ...req.headers },
    });
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    log,
  };
}

describe("html adapter — integration via local HTTP server", () => {
  /**
   * The shared fetch wrapper enforces an SSRF blocklist (ADR-0009 §D5b) that
   * rejects `127.0.0.1` by default. Every test below runs against a loopback
   * fixture, so we opt the host in via the documented allowlist env. We set
   * it for the whole suite and restore at the end to keep this isolated from
   * any other integration test that might run in the same vitest worker.
   */
  const ORIGINAL_ALLOWLIST = process.env.RADAR_FETCH_HOST_ALLOWLIST;

  beforeAll(() => {
    process.env.RADAR_FETCH_HOST_ALLOWLIST = "127.0.0.1";
  });

  afterAll(() => {
    if (ORIGINAL_ALLOWLIST === undefined) {
      delete process.env.RADAR_FETCH_HOST_ALLOWLIST;
    } else {
      process.env.RADAR_FETCH_HOST_ALLOWLIST = ORIGINAL_ALLOWLIST;
    }
  });

  it("fetches items end-to-end through globalThis.fetch and the shared wrapper", async () => {
    const { url, close, log } = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"v1"',
      });
      res.end(HTML_FIXTURE);
    });
    try {
      // No explicit `fetch` option — exercise the real `globalThis.fetch`
      // path (which is what production runs) rather than an injected stub.
      const result = await htmlAdapter.fetch(makeSource(`${url}/changelog`));

      expect(result.items).toHaveLength(2);
      // Relative `/changelog/hello` must be resolved against `source.url`,
      // not the loopback origin — that is the contract every adapter caller
      // (watcher, source test) relies on for output URLs.
      expect(result.items[0]?.title).toBe("Hello World");
      expect(result.items[0]?.url).toBe(`${url}/changelog/hello`);
      expect(result.items[1]?.url).toBe("https://example.com/changelog/second");

      // Real ETag echoed from the server is what gets persisted — NOT the
      // sha256 content-hash fallback. Confirms the wrapper preserved
      // response headers across the wire.
      expect(result.state.lastEtag).toBe('"v1"');

      // Exactly one request hit the server; user-agent + accept were sent.
      expect(log.requests).toHaveLength(1);
      expect(log.requests[0]?.headers["user-agent"]).toMatch(/feedradar/);
      expect(log.requests[0]?.headers.accept).toMatch(/text\/html/);
    } finally {
      await close();
    }
  });

  it("falls back to content-hash dedup when the server omits ETag (real HTTP)", async () => {
    // No `ETag` header in either response — the adapter must take the
    // sha256 path so the second fetch returns notModified=true.
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_FIXTURE);
    });
    try {
      const first = await htmlAdapter.fetch(makeSource(`${url}/changelog`));
      expect(first.state.lastEtag).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.notModified).toBeFalsy();

      const second = await htmlAdapter.fetch(makeSource(`${url}/changelog`), {
        state: {
          sourceId: "html-integration",
          lastEtag: first.state.lastEtag ?? "",
          lastSeenIds: [],
        },
      });
      expect(second.notModified).toBe(true);
      expect(second.items).toEqual([]);
      expect(second.state.lastEtag).toBe(first.state.lastEtag);
    } finally {
      await close();
    }
  });

  it("honors If-None-Match → 304 round trip end-to-end", async () => {
    // Server echoes 200 with ETag on first hit and 304 on the second when
    // it sees a matching `if-none-match`. Exercises the real header round
    // trip through `globalThis.fetch`.
    const { url, close, log } = await startServer((req, res) => {
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === '"server-tag"') {
        res.writeHead(304, { ETag: '"server-tag"' });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"server-tag"',
      });
      res.end(HTML_FIXTURE);
    });
    try {
      const first = await htmlAdapter.fetch(makeSource(`${url}/changelog`));
      expect(first.items).toHaveLength(2);
      expect(first.state.lastEtag).toBe('"server-tag"');

      const second = await htmlAdapter.fetch(makeSource(`${url}/changelog`), {
        state: {
          sourceId: "html-integration",
          lastEtag: first.state.lastEtag ?? "",
          lastSeenIds: [],
        },
      });
      // 304 path: items empty, notModified true, ETag preserved across the
      // round trip (server re-sent it on 304 here; the adapter also covers
      // the "server omits ETag on 304" case in unit tests).
      expect(second.notModified).toBe(true);
      expect(second.items).toEqual([]);
      expect(second.state.lastEtag).toBe('"server-tag"');

      // Second request actually sent `if-none-match: "server-tag"` —
      // confirms the wrapper did not strip or rewrite conditional headers.
      expect(log.requests).toHaveLength(2);
      expect(log.requests[1]?.headers["if-none-match"]).toBe('"server-tag"');
    } finally {
      await close();
    }
  });
});

describe("html adapter — integration: SSRF blocklist (ADR-0009 §D5b)", () => {
  /**
   * These two tests intentionally bracket the suite-level allowlist set by
   * the previous describe block: we explicitly clear it before the "reject"
   * case and explicitly set it for the "opt-in" case so the SSRF behavior
   * is asserted against the real env-driven path rather than a leftover
   * value from another test.
   */
  const ORIGINAL_ALLOWLIST = process.env.RADAR_FETCH_HOST_ALLOWLIST;

  afterAll(() => {
    if (ORIGINAL_ALLOWLIST === undefined) {
      delete process.env.RADAR_FETCH_HOST_ALLOWLIST;
    } else {
      process.env.RADAR_FETCH_HOST_ALLOWLIST = ORIGINAL_ALLOWLIST;
    }
  });

  it("rejects 127.0.0.1 by default (no allowlist) before any HTTP round trip", async () => {
    // Spin up the server only to give the adapter a real target; the
    // blocklist should fire BEFORE any connection is attempted, so the
    // request log must stay empty after the rejection.
    delete process.env.RADAR_FETCH_HOST_ALLOWLIST;
    const { url, close, log } = await startServer((_req, res) => {
      // If the blocklist somehow fails to fire and we reach the handler,
      // the test will still fail later (log.requests has entries) — this
      // body is just a harmless 200 to make the failure mode obvious.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_FIXTURE);
    });
    try {
      await expect(htmlAdapter.fetch(makeSource(`${url}/changelog`))).rejects.toThrow(
        /refused to fetch private \/ loopback IPv4 address "127\.0\.0\.1"/,
      );
      // Critical invariant: blocklist runs *before* the network attempt,
      // so the handler must not have observed a request.
      expect(log.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("passes when RADAR_FETCH_HOST_ALLOWLIST=127.0.0.1 (opt-in)", async () => {
    process.env.RADAR_FETCH_HOST_ALLOWLIST = "127.0.0.1";
    const { url, close, log } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_FIXTURE);
    });
    try {
      const result = await htmlAdapter.fetch(makeSource(`${url}/changelog`));
      // Allowlist short-circuits the blocklist; the fetch must reach the
      // server and produce items as it would for any non-private host.
      expect(result.items).toHaveLength(2);
      expect(log.requests).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
