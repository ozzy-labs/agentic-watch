import type { Source, SourceJsOptions } from "../../schemas/index.js";
import { detectProxyUrl, noProxyToPlaywrightBypass } from "../proxy.js";
import { contentHash, parseHtmlDocument } from "./_html-common.js";
import type { FeedAdapter, FeedAdapterOptions } from "./types.js";

/**
 * `kind: html-js` adapter — Playwright-rendered HTML scraping (ADR-0010).
 *
 * Same selector contract as `kind: html` (delegates to `parseHtmlDocument`),
 * but acquires the document by driving headless Chromium so SPA / CSR pages
 * (Next.js, Notion embeds, Algolia DocSearch, etc.) that ship empty initial
 * HTML can still be scraped.
 *
 * ## Hardening (ADR-0010 §D5 — hardcoded, NOT user-configurable)
 *
 * | Policy              | Value                | Rationale                                                |
 * |---------------------|----------------------|----------------------------------------------------------|
 * | `headless`          | `true`               | UI mode is CI-incompatible and an operator-UI risk.      |
 * | `acceptDownloads`   | `false`              | Block drive-by downloads (page JS-triggered file saves). |
 * | context reuse       | none — fresh each fetch | Prevent SW / IndexedDB / localStorage injection persistence and cross-source state mixing. |
 * | default `timeout`   | 30000ms              | Cap OOM / infinite loops on pathological pages.          |
 * | `page.close()`      | in `finally`         | Prevent page leak / memory accumulation.                 |
 * | viewport            | Playwright default   | Avoid bloating DOM with oversized viewports.             |
 *
 * The above are intentionally NOT exposed through `SourceJsOptions`. Users
 * may tune `waitFor` / `waitUntil` / `timeout` / `userAgent`, but the threat
 * model assumes the policy floor above always holds.
 *
 * ## Optional peer dep
 *
 * Playwright is declared as an *optional* peer dependency (ADR-0010 §D3) so
 * users who only run `kind: rss` / `kind: html` are not forced to install
 * Chromium. The import is therefore `await import("playwright")` and resolves
 * lazily on the first `html-js` fetch; missing-module errors are translated
 * into a user-friendly install hint.
 *
 * ## Proxy auto-injection
 *
 * Unlike Node's built-in `fetch()` (which honors `HTTPS_PROXY` once
 * `--use-env-proxy` is on), Playwright's `chromium.launch()` does NOT read
 * proxy env vars automatically. The adapter probes `HTTPS_PROXY` /
 * `HTTP_PROXY` / `ALL_PROXY` on every fetch and forwards the URL through
 * `launch({ proxy: { server, bypass } })`. `NO_PROXY` is translated from
 * the Node convention (`,`-separated, leading-dot subdomain match) to the
 * Playwright convention (`;`-separated, `*.example.com` glob) by
 * `noProxyToPlaywrightBypass`. In unproxied environments the `proxy` field
 * is omitted entirely so launch behavior is bit-identical to before.
 */

/**
 * Default per-step timeout in ms when `Source.js?.timeout` is omitted.
 * Mirrors `SourceJsOptionsSchema`'s default so adapter-direct callers (not
 * going through schema parse) still get the documented behavior.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Default Playwright `page.goto()` waitUntil mode. `networkidle` is the
 * safest default for SPA / CSR pages where item data arrives via XHR after
 * the document has loaded.
 */
const DEFAULT_WAIT_UNTIL: SourceJsOptions["waitUntil"] = "networkidle";

/**
 * Minimal subset of the Playwright surface this adapter uses. Defined
 * structurally so the `chromium` argument passed by tests does not need to
 * pull in the full Playwright type tree (which is itself an optional peer
 * dep and therefore not guaranteed to be installed in dev).
 */
/**
 * Subset of Playwright's `BrowserType.launch()` proxy options used by this
 * adapter. Playwright does NOT auto-honor `HTTPS_PROXY` / `HTTP_PROXY` the way
 * Node's `--use-env-proxy` does for built-in `fetch()` — it requires the proxy
 * to be passed explicitly into launch options. The adapter therefore probes
 * the env (via `detectProxyUrl`) on every fetch and forwards the URL to
 * Chromium so corporate proxies / NO_PROXY rules are respected end-to-end.
 */
export interface PlaywrightProxyOptions {
  /** Proxy URL (e.g. `http://proxy.corp:8080`). Playwright resolves SOCKS / HTTP automatically. */
  server: string;
  /** Optional semicolon-separated bypass list (NOT comma — see `noProxyToPlaywrightBypass`). */
  bypass?: string;
}

export interface PlaywrightLike {
  chromium: {
    launch(options?: {
      headless?: boolean;
      proxy?: PlaywrightProxyOptions;
    }): Promise<PlaywrightBrowserLike>;
  };
}

export interface PlaywrightBrowserLike {
  newContext(options?: {
    acceptDownloads?: boolean;
    userAgent?: string;
  }): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

export interface PlaywrightPageLike {
  goto(
    url: string,
    options?: { waitUntil?: SourceJsOptions["waitUntil"]; timeout?: number },
  ): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Test-only extension to `FeedAdapterOptions` for the `html-js` adapter.
 *
 * Production callers leave `playwright` unset and the adapter dynamically
 * imports it. Tests inject a fake module so they can exercise the adapter
 * without spinning up real Chromium. The shape mirrors the subset above.
 */
export interface HtmlJsAdapterOptions extends FeedAdapterOptions {
  /** Injected Playwright module (tests only). Production uses dynamic import. */
  playwright?: PlaywrightLike;
  /**
   * Injected env (tests only) — production reads `process.env`. Used to probe
   * `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` so the proxy injection branch is
   * deterministically testable without polluting the real process env.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Dynamically import Playwright. Translates the very common
 * "package not installed" failure into the install hint from ADR-0010 §D3.
 */
async function loadPlaywright(): Promise<PlaywrightLike> {
  try {
    // Bare specifier: resolves via the consumer project's node_modules. The
    // type assertion narrows the dynamic import to the subset we use.
    const mod = (await import("playwright")) as unknown as PlaywrightLike;
    return mod;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `html-js adapter: failed to load Playwright (${message}). ` +
        "Install it with: `npm i playwright && npx playwright install chromium`",
    );
  }
}

export const htmlJsAdapter: FeedAdapter = {
  kind: "html-js",
  fetch: async (source: Source, options: HtmlJsAdapterOptions = {}) => {
    if (!source.selectors) {
      throw new Error(`html-js adapter: source '${source.id}' has no selectors`);
    }
    const selectors = source.selectors;
    const js = source.js;
    const timeout = js?.timeout ?? DEFAULT_TIMEOUT_MS;
    const waitUntil = js?.waitUntil ?? DEFAULT_WAIT_UNTIL;
    // When `waitFor` is omitted we wait for the item selector itself — the
    // common "wait until the item list rendered" intent without extra config.
    const waitFor = js?.waitFor ?? selectors.item;

    const playwright = options.playwright ?? (await loadPlaywright());
    const previous = options.state;
    const fetchedAt = new Date().toISOString();

    // Probe proxy env BEFORE launch. Playwright's `BrowserType.launch()` does
    // not honor `HTTPS_PROXY` / `HTTP_PROXY` automatically (unlike Node's
    // `--use-env-proxy` flag for built-in `fetch()`) — we must pass the URL
    // through `launch({ proxy: { server, bypass } })` explicitly. When no
    // proxy env is set, omit the field entirely so the launch path is bit-
    // identical to the pre-proxy behavior in unproxied environments.
    const env = options.env ?? process.env;
    const detection = detectProxyUrl(env);
    const proxyOption = detection
      ? {
          server: detection.url,
          // Honor `NO_PROXY` end-to-end so internal hosts skip the corporate
          // proxy. `noProxyToPlaywrightBypass` returns `undefined` when
          // NO_PROXY is unset/empty; spreading `undefined` is a no-op so the
          // `bypass` field is absent in that case (Playwright treats omitted
          // vs `""` slightly differently — we want omitted).
          ...(noProxyToPlaywrightBypass(env.NO_PROXY ?? env.no_proxy) !== undefined
            ? { bypass: noProxyToPlaywrightBypass(env.NO_PROXY ?? env.no_proxy) as string }
            : {}),
        }
      : undefined;

    // Hardening: headless is forced true. Even if a future Playwright default
    // changes, the adapter pins it explicitly here.
    const browser = await playwright.chromium.launch({
      headless: true,
      ...(proxyOption ? { proxy: proxyOption } : {}),
    });
    let html: string;
    try {
      // Hardening: fresh context per fetch (no SW / IndexedDB / localStorage
      // persistence across fetches or sources). `acceptDownloads: false`
      // blocks drive-by download routes (page JS triggering file saves).
      const context = await browser.newContext({
        acceptDownloads: false,
        ...(js?.userAgent ? { userAgent: js.userAgent } : {}),
      });
      try {
        const page = await context.newPage();
        try {
          await page.goto(source.url, { waitUntil, timeout });
          await page.waitForSelector(waitFor, { timeout });
          html = await page.content();
        } finally {
          // `finally` guarantees page close even on goto / waitFor timeout —
          // prevents page leak / memory accumulation per ADR-0010 §D5.
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }

    // Dedup via content hash stored in the `lastEtag` slot (same convention
    // as `kind: html` — see `_html-common.ts`). Server-side ETags are not
    // observable from `page.content()`, so the content hash is the only
    // dedup signal available here.
    const bodyHash = contentHash(html);
    if (previous?.lastEtag === bodyHash) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: bodyHash,
        },
      };
    }

    const items = parseHtmlDocument(html, source, fetchedAt);
    return {
      items,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: bodyHash,
      },
    };
  },
};
