import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type HtmlJsAdapterOptions,
  htmlJsAdapter,
  type PlaywrightLike,
} from "../../src/core/feeds/html-js.js";
import type { Source } from "../../src/schemas/index.js";

/**
 * Integration tests for `kind: html-js` (ADR-0010).
 *
 * Two halves:
 *
 * 1. **Hardening / dedup / error path** (no Chromium binary needed) — drives
 *    the adapter with an injected fake `PlaywrightLike` so we can assert the
 *    exact arguments the adapter passes to Playwright (`headless: true`,
 *    `acceptDownloads: false`, fresh context per fetch, timeout plumbing,
 *    waitFor fallback to `selectors.item`) and observe `notModified: true`
 *    on a repeat fetch.
 *
 * 2. **Real Chromium render** (requires `npx playwright install chromium`)
 *    — spins up actual Chromium against a local `file://` HTML page whose
 *    items are injected via `<script>` after load, proving the adapter
 *    successfully waits for SPA-rendered DOM. Skipped (with a clear log) when
 *    the Chromium binary is not present so the test suite remains usable in
 *    environments where only `pnpm i` has run.
 *
 * Lives under `tests/integration/**` so it runs only via `pnpm test:integration`
 * (see `vitest.integration.config.ts`) and never blocks the fast `pnpm test`
 * unit loop.
 */

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "html-js-spec",
    kind: "html-js",
    url: "https://example.com/changelog",
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

const HTML_FIXTURE = `<!doctype html>
<html><body>
  <main>
    <article class="post">
      <h2><a href="https://example.com/changelog/one">One</a></h2>
      <p class="summary">Item one summary</p>
    </article>
    <article class="post">
      <h2><a href="https://example.com/changelog/two">Two</a></h2>
      <p class="summary">Item two summary</p>
    </article>
  </main>
</body></html>`;

/**
 * Build a fake Playwright module instrumented with spies so each test can
 * assert the exact options the adapter passed. The fake returns `htmlBody`
 * from `page.content()` so the parser path is exercised end-to-end.
 */
function makeFakePlaywright(htmlBody: string = HTML_FIXTURE) {
  const launchSpy = vi.fn();
  const newContextSpy = vi.fn();
  const gotoSpy = vi.fn();
  const waitForSelectorSpy = vi.fn();
  const pageCloseSpy = vi.fn();
  const contextCloseSpy = vi.fn();
  const browserCloseSpy = vi.fn();

  const page = {
    goto: async (
      url: string,
      opts?: { waitUntil?: string; timeout?: number },
    ): Promise<unknown> => {
      gotoSpy(url, opts);
      return null;
    },
    waitForSelector: async (selector: string, opts?: { timeout?: number }): Promise<unknown> => {
      waitForSelectorSpy(selector, opts);
      return null;
    },
    content: async () => htmlBody,
    close: async () => {
      pageCloseSpy();
    },
  };
  const context = {
    newPage: async () => page,
    close: async () => {
      contextCloseSpy();
    },
  };
  const browser = {
    newContext: async (opts?: { acceptDownloads?: boolean; userAgent?: string }) => {
      newContextSpy(opts);
      return context;
    },
    close: async () => {
      browserCloseSpy();
    },
  };
  const playwright: PlaywrightLike = {
    chromium: {
      launch: async (opts?: { headless?: boolean }) => {
        launchSpy(opts);
        return browser;
      },
    },
  };
  return {
    playwright,
    spies: {
      launch: launchSpy,
      newContext: newContextSpy,
      goto: gotoSpy,
      waitForSelector: waitForSelectorSpy,
      pageClose: pageCloseSpy,
      contextClose: contextCloseSpy,
      browserClose: browserCloseSpy,
    },
  };
}

describe("html-js adapter — hardening (injected Playwright)", () => {
  it("forces headless: true on chromium.launch", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), { playwright } as HtmlJsAdapterOptions);
    expect(spies.launch).toHaveBeenCalledTimes(1);
    // ADR-0010 §D5: headless must be hardcoded true; the option must be
    // present on every call so a future Playwright default change cannot
    // weaken the policy.
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({ headless: true });
  });

  it("forces acceptDownloads: false on every newContext call", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), { playwright } as HtmlJsAdapterOptions);
    expect(spies.newContext).toHaveBeenCalledTimes(1);
    // ADR-0010 §D5: acceptDownloads must be hardcoded false to block
    // drive-by download routes from page JS.
    expect(spies.newContext.mock.calls[0]?.[0]).toMatchObject({ acceptDownloads: false });
  });

  it("creates a fresh context per fetch (no reuse across calls)", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), { playwright } as HtmlJsAdapterOptions);
    await htmlJsAdapter.fetch(makeSource({ id: "other" }), {
      playwright,
    } as HtmlJsAdapterOptions);
    // Two fetches => two browsers => two contexts => two contexts closed.
    // Verifies the adapter does NOT cache or reuse contexts (ADR-0010 §D5).
    expect(spies.launch).toHaveBeenCalledTimes(2);
    expect(spies.newContext).toHaveBeenCalledTimes(2);
    expect(spies.contextClose).toHaveBeenCalledTimes(2);
    expect(spies.browserClose).toHaveBeenCalledTimes(2);
  });

  it("always closes page / context / browser even when waitForSelector throws", async () => {
    const { playwright, spies } = makeFakePlaywright();
    // Replace the page so waitForSelector rejects (timeout simulation).
    const browser = await playwright.chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const realNewPage = ctx.newPage;
    ctx.newPage = async () => {
      const page = await realNewPage.call(ctx);
      page.waitForSelector = async () => {
        throw new Error("Timeout 30000ms exceeded.");
      };
      return page;
    };
    // Patch launch to return our doctored browser/context.
    playwright.chromium.launch = async () => ({
      newContext: async () => ctx,
      close: browser.close,
    });
    await expect(
      htmlJsAdapter.fetch(makeSource(), { playwright } as HtmlJsAdapterOptions),
    ).rejects.toThrow(/Timeout/);
    // Each cleanup hook must still fire — page.close once, context.close
    // once, browser.close once — so a single timeout does not leak resources.
    expect(spies.pageClose).toHaveBeenCalled();
    expect(spies.contextClose).toHaveBeenCalled();
    expect(spies.browserClose).toHaveBeenCalled();
  });
});

describe("html-js adapter — options plumbing (injected Playwright)", () => {
  it("falls back waitFor to selectors.item when js.waitFor is omitted", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), { playwright } as HtmlJsAdapterOptions);
    // Default behavior: wait for the item selector itself so the common case
    // ("wait until the list rendered") needs no extra config.
    expect(spies.waitForSelector.mock.calls[0]?.[0]).toBe("article.post");
  });

  it("uses js.waitFor when provided", async () => {
    const { playwright, spies } = makeFakePlaywright();
    const source = makeSource({
      js: { waitFor: ".loaded", waitUntil: "networkidle", timeout: 30000 },
    });
    await htmlJsAdapter.fetch(source, { playwright } as HtmlJsAdapterOptions);
    expect(spies.waitForSelector.mock.calls[0]?.[0]).toBe(".loaded");
  });

  it("plumbs js.timeout into both goto and waitForSelector", async () => {
    const { playwright, spies } = makeFakePlaywright();
    const source = makeSource({
      js: { waitUntil: "networkidle", timeout: 5000 },
    });
    await htmlJsAdapter.fetch(source, { playwright } as HtmlJsAdapterOptions);
    expect(spies.goto.mock.calls[0]?.[1]).toMatchObject({ timeout: 5000 });
    expect(spies.waitForSelector.mock.calls[0]?.[1]).toMatchObject({ timeout: 5000 });
  });

  it("defaults timeout to 30000ms when js is omitted", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), { playwright } as HtmlJsAdapterOptions);
    // Mirrors `SourceJsOptionsSchema` default; the adapter ships its own copy
    // so direct callers (not going through schema.parse) still get the policy.
    expect(spies.goto.mock.calls[0]?.[1]).toMatchObject({ timeout: 30000 });
  });

  it("passes userAgent through to newContext when provided", async () => {
    const { playwright, spies } = makeFakePlaywright();
    const source = makeSource({
      js: { waitUntil: "networkidle", timeout: 30000, userAgent: "feedradar-ua/1.0" },
    });
    await htmlJsAdapter.fetch(source, { playwright } as HtmlJsAdapterOptions);
    expect(spies.newContext.mock.calls[0]?.[0]).toMatchObject({
      acceptDownloads: false,
      userAgent: "feedradar-ua/1.0",
    });
  });
});

describe("html-js adapter — items & dedup (injected Playwright)", () => {
  it("returns parsed items on first fetch", async () => {
    const { playwright } = makeFakePlaywright();
    const result = await htmlJsAdapter.fetch(makeSource(), {
      playwright,
    } as HtmlJsAdapterOptions);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe("One");
    expect(result.items[1]?.url).toBe("https://example.com/changelog/two");
    expect(result.state.lastEtag).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.notModified).toBeFalsy();
  });

  it("returns notModified: true on identical re-fetch (contentHash dedup)", async () => {
    const { playwright: first } = makeFakePlaywright();
    const firstResult = await htmlJsAdapter.fetch(makeSource(), {
      playwright: first,
    } as HtmlJsAdapterOptions);
    const { playwright: second } = makeFakePlaywright();
    const secondResult = await htmlJsAdapter.fetch(makeSource(), {
      playwright: second,
      state: {
        sourceId: "html-js-spec",
        lastEtag: firstResult.state.lastEtag ?? "",
        lastSeenIds: [],
      },
    } as HtmlJsAdapterOptions);
    expect(secondResult.notModified).toBe(true);
    expect(secondResult.items).toEqual([]);
    expect(secondResult.state.lastEtag).toBe(firstResult.state.lastEtag);
  });

  it("returns fresh items when the rendered HTML changes", async () => {
    const { playwright: first } = makeFakePlaywright(HTML_FIXTURE);
    const firstResult = await htmlJsAdapter.fetch(makeSource(), {
      playwright: first,
    } as HtmlJsAdapterOptions);
    const updated = HTML_FIXTURE.replace("Item one summary", "Item one updated");
    const { playwright: second } = makeFakePlaywright(updated);
    const secondResult = await htmlJsAdapter.fetch(makeSource(), {
      playwright: second,
      state: {
        sourceId: "html-js-spec",
        lastEtag: firstResult.state.lastEtag ?? "",
        lastSeenIds: [],
      },
    } as HtmlJsAdapterOptions);
    expect(secondResult.notModified).toBeFalsy();
    expect(secondResult.items).toHaveLength(2);
    expect(secondResult.state.lastEtag).not.toBe(firstResult.state.lastEtag);
  });
});

describe("html-js adapter — proxy auto-injection (injected Playwright)", () => {
  it("omits the proxy field on launch when no proxy env is set", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: {},
    } as HtmlJsAdapterOptions);
    expect(spies.launch).toHaveBeenCalledTimes(1);
    const launchOpts = spies.launch.mock.calls[0]?.[0] as Record<string, unknown>;
    // Bit-identical to pre-feature behavior in unproxied environments: the
    // `proxy` key must be absent (not `proxy: undefined`) so Playwright does
    // not enter the proxy code path at all.
    expect(launchOpts).toMatchObject({ headless: true });
    expect("proxy" in launchOpts).toBe(false);
  });

  it("forwards HTTPS_PROXY into launch options as proxy.server", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: { HTTPS_PROXY: "http://proxy.corp:8080" },
    } as HtmlJsAdapterOptions);
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({
      headless: true,
      proxy: { server: "http://proxy.corp:8080" },
    });
  });

  it("prefers HTTPS_PROXY over HTTP_PROXY and ALL_PROXY", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: {
        HTTPS_PROXY: "http://https.example:8080",
        HTTP_PROXY: "http://http.example:8080",
        ALL_PROXY: "socks5://all.example:1080",
      },
    } as HtmlJsAdapterOptions);
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({
      proxy: { server: "http://https.example:8080" },
    });
  });

  it("falls back to HTTP_PROXY when HTTPS_PROXY is absent", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: { HTTP_PROXY: "http://http.example:8080" },
    } as HtmlJsAdapterOptions);
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({
      proxy: { server: "http://http.example:8080" },
    });
  });

  it("forwards ALL_PROXY (SOCKS) as proxy.server when only ALL_PROXY is set", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: { ALL_PROXY: "socks5://all.example:1080" },
    } as HtmlJsAdapterOptions);
    // Unlike Node's `--use-env-proxy` (which ignores ALL_PROXY), Playwright
    // accepts any URL scheme it recognizes (incl. socks5) directly, so the
    // adapter forwards it verbatim — corporate setups where ALL_PROXY is the
    // only proxy var should still work end-to-end.
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({
      proxy: { server: "socks5://all.example:1080" },
    });
  });

  it("translates NO_PROXY (comma / leading-dot) to Playwright bypass (semicolon / glob)", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: {
        HTTPS_PROXY: "http://proxy.corp:8080",
        NO_PROXY: "localhost,.internal.corp,127.0.0.1",
      },
    } as HtmlJsAdapterOptions);
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({
      proxy: {
        server: "http://proxy.corp:8080",
        bypass: "localhost;*.internal.corp;127.0.0.1",
      },
    });
  });

  it("accepts lower-case no_proxy alongside upper-case envs", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: {
        HTTPS_PROXY: "http://proxy.corp:8080",
        no_proxy: ".example.com",
      },
    } as HtmlJsAdapterOptions);
    expect(spies.launch.mock.calls[0]?.[0]).toMatchObject({
      proxy: { server: "http://proxy.corp:8080", bypass: "*.example.com" },
    });
  });

  it("omits proxy.bypass when NO_PROXY is unset (proxy alone, no bypass)", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: { HTTPS_PROXY: "http://proxy.corp:8080" },
    } as HtmlJsAdapterOptions);
    const proxyOpt = (spies.launch.mock.calls[0]?.[0] as { proxy: Record<string, unknown> }).proxy;
    expect(proxyOpt).toMatchObject({ server: "http://proxy.corp:8080" });
    // Asserting absence (not `bypass: undefined`) so Playwright's "no bypass
    // list" branch is selected rather than "empty bypass list".
    expect("bypass" in proxyOpt).toBe(false);
  });

  it("treats empty-string proxy env values as unset (curl/wget convention)", async () => {
    const { playwright, spies } = makeFakePlaywright();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      env: { HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "" },
    } as HtmlJsAdapterOptions);
    const launchOpts = spies.launch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("proxy" in launchOpts).toBe(false);
  });
});

describe("html-js adapter — error paths", () => {
  it("throws a user-friendly error when Playwright is not installed", async () => {
    // Force the dynamic import to fail by aliasing 'playwright' to a missing
    // specifier via a one-off helper. We bypass the injection point so the
    // real `loadPlaywright()` path runs.
    const source = makeSource();
    // We rely on the real import resolving to the installed devDep when
    // present; to exercise the error path deterministically, drive the
    // adapter through a `playwright` injection that throws on launch and
    // assert the error surfaces. The friendly-install-hint case is covered
    // by `loadPlaywright` itself; here we keep the assertion environment-
    // independent.
    const failing: PlaywrightLike = {
      chromium: {
        launch: async () => {
          throw new Error("Chromium binary not found");
        },
      },
    };
    await expect(
      htmlJsAdapter.fetch(source, { playwright: failing } as HtmlJsAdapterOptions),
    ).rejects.toThrow(/Chromium binary not found/);
  });

  it("throws when source has no selectors", async () => {
    const source = { ...makeSource(), selectors: undefined } as Source;
    const { playwright } = makeFakePlaywright();
    await expect(
      htmlJsAdapter.fetch(source, { playwright } as HtmlJsAdapterOptions),
    ).rejects.toThrow(/no selectors/);
  });

  it("wraps a failed `import('playwright')` with an install hint", async () => {
    // Mock the dynamic import to fail with the canonical ERR_MODULE_NOT_FOUND
    // shape so we exercise the `loadPlaywright()` translation branch.
    vi.resetModules();
    vi.doMock("playwright", () => {
      throw new Error("Cannot find package 'playwright'");
    });
    try {
      const { htmlJsAdapter: freshAdapter } = await import("../../src/core/feeds/html-js.js");
      // No `playwright` injection -> adapter falls back to dynamic import,
      // which now throws -> adapter must re-throw with the install hint.
      await expect(freshAdapter.fetch(makeSource())).rejects.toThrow(
        /Install it with: `npm i playwright && npx playwright install chromium`/,
      );
    } finally {
      vi.doUnmock("playwright");
      vi.resetModules();
    }
  });
});

/**
 * Real Chromium render against a local `file://` HTML page whose items are
 * injected via `<script>` after load. Skipped when Chromium is not installed
 * so the suite remains usable in any environment that ran `pnpm i` but not
 * `npx playwright install chromium`.
 */
describe("html-js adapter — real Chromium render", () => {
  let tempDir: string;
  let filePath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "feedradar-html-js-"));
    filePath = join(tempDir, "spa.html");
    // The initial HTML deliberately ships with NO `.post` elements; an
    // inline script appends them after a short timer, simulating a CSR page
    // where items appear only after JS has run.
    writeFileSync(
      filePath,
      `<!doctype html>
<html><body>
  <main id="root"></main>
  <script>
    setTimeout(() => {
      document.getElementById('root').innerHTML = \`
        <article class="post">
          <h2><a href="https://example.com/changelog/spa-one">SPA One</a></h2>
          <p class="summary">Rendered after JS</p>
        </article>
        <article class="post">
          <h2><a href="https://example.com/changelog/spa-two">SPA Two</a></h2>
          <p class="summary">Also rendered after JS</p>
        </article>
      \`;
    }, 50);
  </script>
</body></html>`,
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("waits for JS-injected items before extracting", async () => {
    let playwright: PlaywrightLike;
    try {
      // Real Playwright import; rethrows the friendly hint when Chromium is
      // missing — we translate that into a skip so the test does not fail
      // in fresh-clone environments.
      playwright = (await import("playwright")) as unknown as PlaywrightLike;
    } catch {
      console.warn("Skipping real-Chromium test: 'playwright' not importable");
      return;
    }
    const source = makeSource({
      url: pathToFileURL(filePath).toString(),
      selectors: {
        item: "article.post",
        title: "h2 a",
        link: "h2 a",
        summary: "p.summary",
      },
      // file:// has no real "network", so domcontentloaded is reliable here.
      js: { waitFor: "article.post", waitUntil: "domcontentloaded", timeout: 10_000 },
    });
    let result: Awaited<ReturnType<typeof htmlJsAdapter.fetch>>;
    try {
      result = await htmlJsAdapter.fetch(source, {
        playwright,
      } as HtmlJsAdapterOptions);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Chromium binary missing manifests as launch failure; skip cleanly.
      if (/Executable doesn't exist|browserType\.launch|Chromium/.test(message)) {
        console.warn(`Skipping real-Chromium test: ${message}`);
        return;
      }
      throw e;
    }
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe("SPA One");
    expect(result.items[1]?.title).toBe("SPA Two");
  });
});

describe("html-js adapter — progress reporter phase markers (#198)", () => {
  function recordingReporter() {
    const phases: Array<{ name: string; info?: string }> = [];
    return {
      phases,
      reporter: {
        phase: (name: string, info?: string) => {
          phases.push({ name, info });
        },
        start: () => {},
        update: () => {},
        succeed: () => {},
        fail: () => {},
        raw: () => {},
      },
    };
  }

  it("emits the documented Playwright lifecycle phase markers in order", async () => {
    const { playwright } = makeFakePlaywright();
    const { reporter, phases } = recordingReporter();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      onProgress: reporter,
    } as HtmlJsAdapterOptions);
    const names = phases.map((p) => p.name);
    // Order matters: the user-guide and ADR-0015 D4 both pin the
    // Launching → Navigating → Waiting → Capturing → Closing sequence.
    expect(names).toEqual([
      "Launching Chromium…",
      "Navigating to https://example.com/changelog…",
      'Waiting for selector "article.post" (timeout: 30000ms)…',
      "Capturing page content…",
      "Closing browser…",
    ]);
  });

  it("emits Still waiting reminder when waitForSelector exceeds stillWaitingMs", async () => {
    vi.useFakeTimers();
    try {
      const { playwright } = makeFakePlaywright();
      // Override waitForSelector to never resolve until we advance the
      // fake clock past the threshold; this lets us assert the reminder
      // fires without burning real time.
      const realLaunch = playwright.chromium.launch;
      playwright.chromium.launch = async (opts) => {
        const browser = await realLaunch.call(playwright.chromium, opts);
        const realNewContext = browser.newContext.bind(browser);
        browser.newContext = async (ctxOpts) => {
          const ctx = await realNewContext(ctxOpts);
          const realNewPage = ctx.newPage.bind(ctx);
          ctx.newPage = async () => {
            const page = await realNewPage();
            page.waitForSelector = async (_sel: string, _opts?: { timeout?: number }) => {
              // Hold the selector wait open for 50 fake-ms so the
              // setTimeout(stillWaitingMs=10ms) callback gets a chance to
              // fire before we resolve.
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 50);
              });
              return null;
            };
            return page;
          };
          return ctx;
        };
        return browser;
      };
      const { reporter, phases } = recordingReporter();
      const fetchPromise = htmlJsAdapter.fetch(makeSource(), {
        playwright,
        onProgress: reporter,
        stillWaitingMs: 10,
      } as HtmlJsAdapterOptions);
      // Advance through the still-waiting threshold THEN the selector wait.
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(40);
      await fetchPromise;
      const stillWaitingHits = phases.filter((p) => p.name.startsWith("Still waiting"));
      expect(stillWaitingHits.length).toBeGreaterThanOrEqual(1);
      // The reminder embeds the selector verbatim so the user can tell
      // which wait is hanging when multiple are nested.
      expect(stillWaitingHits[0]?.name).toContain('"article.post"');
      // Reminder must include the elapsed-time prefix [mm:ss] so the user
      // can gauge whether to wait or Ctrl+C.
      expect(stillWaitingHits[0]?.name).toMatch(/\[\d{2}:\d{2}\]/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit Still waiting when selector resolves before threshold", async () => {
    // Default fake Playwright resolves waitForSelector immediately; the
    // 10s default threshold (or any positive value) must NOT fire when
    // the wait completes synchronously.
    const { playwright } = makeFakePlaywright();
    const { reporter, phases } = recordingReporter();
    await htmlJsAdapter.fetch(makeSource(), {
      playwright,
      onProgress: reporter,
      stillWaitingMs: 10,
    } as HtmlJsAdapterOptions);
    expect(phases.some((p) => p.name.startsWith("Still waiting"))).toBe(false);
  });

  it("still emits Closing browser when waitForSelector throws", async () => {
    // Closure invariant: the `Closing browser…` marker is in a `finally`
    // and must fire even on timeout / selector failure, so the user sees
    // a clean end-of-fetch boundary in the spinner.
    const { playwright } = makeFakePlaywright();
    const realLaunch = playwright.chromium.launch;
    playwright.chromium.launch = async (opts) => {
      const browser = await realLaunch.call(playwright.chromium, opts);
      const realNewContext = browser.newContext.bind(browser);
      browser.newContext = async (ctxOpts) => {
        const ctx = await realNewContext(ctxOpts);
        const realNewPage = ctx.newPage.bind(ctx);
        ctx.newPage = async () => {
          const page = await realNewPage();
          page.waitForSelector = async () => {
            throw new Error("Timeout 30000ms exceeded.");
          };
          return page;
        };
        return ctx;
      };
      return browser;
    };
    const { reporter, phases } = recordingReporter();
    await expect(
      htmlJsAdapter.fetch(makeSource(), {
        playwright,
        onProgress: reporter,
      } as HtmlJsAdapterOptions),
    ).rejects.toThrow(/Timeout/);
    expect(phases.map((p) => p.name)).toContain("Closing browser…");
  });
});
