import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { runDoctor, runDoctorChecks } from "../../src/cli/doctor.js";
import type { ProbeOptions } from "../../src/core/playwright-check.js";

interface Captured {
  log: string[];
  error: string[];
}

function captureIo(): {
  io: { log: (m: string) => void; error: (m: string) => void };
  captured: Captured;
} {
  const captured: Captured = { log: [], error: [] };
  return {
    io: {
      log: (m) => captured.log.push(m),
      error: (m) => captured.error.push(m),
    },
    captured,
  };
}

/**
 * Helper: build a synthetic `radar init`-shaped workspace. The doctor
 * checks would otherwise warn about every missing directory and drown
 * out the playwright assertions we actually care about in each test.
 */
async function scaffold(workdir: string): Promise<void> {
  for (const dir of ["sources", "items", "state", "research", "templates"]) {
    await mkdir(join(workdir, dir), { recursive: true });
  }
}

async function writeSourceYaml(
  workdir: string,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(workdir, "sources", `${id}.yaml`), stringifyYaml(body), "utf8");
}

/**
 * Build a `whichImpl` stub that returns hits for a fixed allowlist of agent
 * binaries. Anything not in the allowlist resolves to `undefined`, matching
 * the real `which`-lookup contract.
 */
function whichReturning(found: Record<string, string>) {
  return async (binary: string): Promise<string | undefined> => {
    return found[binary];
  };
}

describe("cli/doctor", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-doctor-"));
  });

  describe("workspace checks", () => {
    it("reports ok for every workspace directory when present", async () => {
      await scaffold(workdir);
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
        probeOptions: { importPlaywright: async () => ({ chromium: {} }) },
      });
      for (const dir of ["sources", "items", "state", "research", "templates"]) {
        const check = report.checks.find((c) => c.id === `workspace:${dir}`);
        expect(check?.status, `${dir} check`).toBe("ok");
      }
    });

    it("warns about each missing workspace directory and points at radar init", async () => {
      // Intentionally do NOT scaffold — every dir should warn.
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
      });
      for (const dir of ["sources", "items", "state", "research", "templates"]) {
        const check = report.checks.find((c) => c.id === `workspace:${dir}`);
        expect(check?.status, `${dir} check`).toBe("warn");
        expect(check?.message).toContain("radar init");
      }
    });
  });

  describe("radar.config.yaml checks", () => {
    it("treats a missing config as ok (defaults apply)", async () => {
      await scaffold(workdir);
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
      });
      const config = report.checks.find((c) => c.id === "config");
      expect(config?.status).toBe("ok");
    });

    it("flags an invalid config as error with the schema message", async () => {
      await scaffold(workdir);
      await writeFile(
        join(workdir, "radar.config.yaml"),
        // `defaultResearchAgent` must be one of the AgentId enum values; a
        // typo / arbitrary string trips the schema and proves the doctor
        // surfaces a real validation failure rather than silently passing.
        stringifyYaml({ defaultResearchAgent: "not-a-real-agent" }),
        "utf8",
      );
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
      });
      const config = report.checks.find((c) => c.id === "config");
      expect(config?.status).toBe("error");
      expect(config?.message).toMatch(/radar\.config\.yaml/);
    });
  });

  describe("agent CLI checks", () => {
    it("reports ok for agents present on PATH and warn for missing ones", async () => {
      await scaffold(workdir);
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({
          claude: "/usr/local/bin/claude",
          // codex / gemini / copilot omitted on purpose.
        }),
      });
      const claudeCheck = report.checks.find((c) => c.id === "agent:claude-code");
      const codexCheck = report.checks.find((c) => c.id === "agent:codex-cli");
      const geminiCheck = report.checks.find((c) => c.id === "agent:gemini-cli");
      const copilotCheck = report.checks.find((c) => c.id === "agent:copilot");

      expect(claudeCheck?.status).toBe("ok");
      expect(claudeCheck?.message).toContain("/usr/local/bin/claude");
      // Missing CLIs are non-blocking warnings — users only need the agents
      // they actually invoke.
      expect(codexCheck?.status).toBe("warn");
      expect(geminiCheck?.status).toBe("warn");
      expect(copilotCheck?.status).toBe("warn");
    });
  });

  describe("playwright + chromium checks", () => {
    it("reports ok and skips playwright when no html-js source is configured", async () => {
      await scaffold(workdir);
      await writeSourceYaml(workdir, "rss-only", {
        id: "rss-only",
        kind: "rss",
        url: "https://example.com/feed.xml",
      });
      // No html-js source means we never even try the probe — the probe
      // option here would throw if called, so the test also pins that
      // contract.
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
        probeOptions: {
          importPlaywright: async () => {
            throw new Error("probe should NOT run when no html-js source exists");
          },
        },
      });
      const playwright = report.checks.find((c) => c.id === "playwright");
      expect(playwright?.status).toBe("ok");
      expect(playwright?.message).toContain("not required");
    });

    it("reports error when playwright module is missing and html-js source exists", async () => {
      await scaffold(workdir);
      await writeSourceYaml(workdir, "spa-site", {
        id: "spa-site",
        kind: "html-js",
        url: "https://example.com/changelog",
        selectors: { item: ".post", title: ".post-title", link: ".post-link" },
      });
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
        probeOptions: {
          importPlaywright: async () => {
            throw new Error("Cannot find module 'playwright'");
          },
        },
      });
      const playwright = report.checks.find((c) => c.id === "playwright");
      expect(playwright?.status).toBe("error");
      // Hint must surface the install command the user is supposed to run,
      // plus the source ids that need it (so users know what to fix).
      expect(playwright?.message).toContain("npm i -g playwright");
      expect(playwright?.message).toContain("spa-site");
    });

    it("reports error when chromium binary is missing", async () => {
      await scaffold(workdir);
      await writeSourceYaml(workdir, "spa-site", {
        id: "spa-site",
        kind: "html-js",
        url: "https://example.com/changelog",
        selectors: { item: ".post", title: ".post-title", link: ".post-link" },
      });
      const fakePath = "/tmp/does-not-exist/chromium";
      const probeOptions: ProbeOptions = {
        importPlaywright: async () => ({
          chromium: { executablePath: () => fakePath },
        }),
        pathExists: async () => false,
      };
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
        probeOptions,
      });
      const playwright = report.checks.find((c) => c.id === "playwright");
      expect(playwright?.status).toBe("error");
      // Mentions the missing path so the user can verify the install root.
      expect(playwright?.message).toContain(fakePath);
      // Auto-install hint should be present in this branch (vs the
      // module-missing branch, where auto-install does not apply).
      expect(playwright?.message).toContain("RADAR_AUTO_INSTALL_CHROMIUM");
    });

    it("reports ok when playwright and chromium are both present", async () => {
      await scaffold(workdir);
      await writeSourceYaml(workdir, "spa-site", {
        id: "spa-site",
        kind: "html-js",
        url: "https://example.com/changelog",
        selectors: { item: ".post", title: ".post-title", link: ".post-link" },
      });
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
        probeOptions: {
          importPlaywright: async () => ({
            chromium: { executablePath: () => "/opt/chromium" },
          }),
          pathExists: async () => true,
        },
      });
      const playwright = report.checks.find((c) => c.id === "playwright");
      expect(playwright?.status).toBe("ok");
      expect(playwright?.message).toContain("/opt/chromium");
    });
  });

  describe("proxy / TLS environment checks", () => {
    // Common helper: every proxy test wants the workspace scaffolded (so the
    // workspace warnings don't drown out our proxy assertions) and the
    // healthcheck disabled by default (the proxy:env / tls:ca branches don't
    // need a live request).
    async function runWithEnv(env: NodeJS.ProcessEnv, opts: { noProxyCheck?: boolean } = {}) {
      await scaffold(workdir);
      return runDoctorChecks({
        cwd: workdir,
        env,
        whichImpl: whichReturning({}),
        noProxyCheck: opts.noProxyCheck ?? true,
      });
    }

    it("reports no proxy env var set when none is configured", async () => {
      const report = await runWithEnv({});
      const env = report.checks.find((c) => c.id === "proxy:env");
      expect(env?.status).toBe("ok");
      expect(env?.message).toContain("no proxy env var set");
    });

    it("masks credentials in the detected proxy URL (acceptance #2)", async () => {
      const report = await runWithEnv({
        HTTPS_PROXY: "http://corpuser:s3cret@proxy.corp.example:8080",
      });
      const env = report.checks.find((c) => c.id === "proxy:env");
      expect(env?.status).toBe("ok");
      // Credentials must NOT leak into doctor output.
      expect(env?.message).not.toContain("corpuser");
      expect(env?.message).not.toContain("s3cret");
      // Masked placeholders must appear in their place.
      expect(env?.message).toContain("***:***");
      expect(env?.message).toContain("proxy.corp.example:8080");
      // The source env var name must be surfaced so the user can locate the
      // value in their shell config.
      expect(env?.message).toContain("$HTTPS_PROXY");
    });

    it("warns when only ALL_PROXY is set (Node ignores it for fetch)", async () => {
      const report = await runWithEnv({ ALL_PROXY: "socks5://socks.example:1080" });
      const env = report.checks.find((c) => c.id === "proxy:env");
      expect(env?.status).toBe("warn");
      expect(env?.message).toContain("ALL_PROXY");
    });

    it("reports NODE_USE_ENV_PROXY=1 as active (radar self-respawn engaged)", async () => {
      const report = await runWithEnv({
        HTTPS_PROXY: "http://proxy.example:8080",
        NODE_USE_ENV_PROXY: "1",
      });
      const active = report.checks.find((c) => c.id === "proxy:active");
      expect(active?.status).toBe("ok");
      expect(active?.message).toContain("NODE_USE_ENV_PROXY active");
    });

    it("warns when proxy is set but NODE_USE_ENV_PROXY is not", async () => {
      const report = await runWithEnv({ HTTPS_PROXY: "http://proxy.example:8080" });
      const active = report.checks.find((c) => c.id === "proxy:active");
      expect(active?.status).toBe("warn");
      expect(active?.message).toContain("NODE_USE_ENV_PROXY not set");
    });

    it("reports NODE_USE_ENV_PROXY not required when no proxy is set", async () => {
      const report = await runWithEnv({});
      const active = report.checks.find((c) => c.id === "proxy:active");
      expect(active?.status).toBe("ok");
      expect(active?.message).toContain("not required");
    });

    it("surfaces NODE_EXTRA_CA_CERTS when set (TLS-intercept proxy support)", async () => {
      const report = await runWithEnv({ NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem" });
      const tls = report.checks.find((c) => c.id === "tls:ca");
      expect(tls?.status).toBe("ok");
      expect(tls?.message).toContain("/etc/ssl/corp-ca.pem");
    });

    it("notes when NODE_EXTRA_CA_CERTS is not set (still ok, but mentions risk)", async () => {
      const report = await runWithEnv({});
      const tls = report.checks.find((c) => c.id === "tls:ca");
      expect(tls?.status).toBe("ok");
      expect(tls?.message).toContain("not set");
      expect(tls?.message).toContain("TLS-intercepting");
    });
  });

  describe("proxy healthcheck", () => {
    async function setupWithProxy() {
      await scaffold(workdir);
    }

    it("skips the healthcheck with --no-proxy-check (acceptance #3)", async () => {
      await setupWithProxy();
      const fetchSpy = vi.fn();
      const report = await runDoctorChecks({
        cwd: workdir,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        noProxyCheck: true,
        fetchImpl: fetchSpy as never,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("ok");
      expect(hc?.message).toContain("skipped");
      expect(hc?.message).toContain("--no-proxy-check");
      // Most importantly: no network call attempted.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("skips the healthcheck when no proxy is detected (no point)", async () => {
      await setupWithProxy();
      const fetchSpy = vi.fn();
      const report = await runDoctorChecks({
        cwd: workdir,
        env: {},
        whichImpl: whichReturning({}),
        fetchImpl: fetchSpy as never,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("ok");
      expect(hc?.message).toContain("skipped (no proxy");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reports ok on 200 with status code + latency", async () => {
      await setupWithProxy();
      // Fake fetch returns a synthetic Response-shaped object. We use a
      // hand-rolled object instead of `new Response()` so the test stays
      // compatible with Node's slightly stricter Response constructor when
      // the URL parser rejects custom schemes.
      const fetchImpl = (async () => ({
        status: 200,
        statusText: "OK",
      })) as unknown as typeof fetch;
      // Deterministic clock so the latency assertion is stable.
      let t = 1000;
      const nowImpl = () => {
        const v = t;
        t += 234;
        return v;
      };
      const report = await runDoctorChecks({
        cwd: workdir,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        fetchImpl,
        nowImpl,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("ok");
      expect(hc?.message).toContain("200");
      expect(hc?.message).toContain("api.github.com");
      expect(hc?.message).toContain("234ms");
    });

    it("warns on 407 Proxy Authentication Required", async () => {
      await setupWithProxy();
      const fetchImpl = (async () => ({
        status: 407,
        statusText: "Proxy Authentication Required",
      })) as unknown as typeof fetch;
      const report = await runDoctorChecks({
        cwd: workdir,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        fetchImpl,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("warn");
      expect(hc?.message).toContain("407");
      // Hint must point users to the credential slot in their env var.
      expect(hc?.message).toContain("$HTTPS_PROXY");
    });

    it("reports error and hints NODE_EXTRA_CA_CERTS on TLS-intercept errors", async () => {
      await setupWithProxy();
      // Simulate the undici-style nested error structure: outer Error with
      // a `cause` whose `code` is a TLS intercept code.
      const tlsError = Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("certificate"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        }),
      });
      const fetchImpl = (async () => {
        throw tlsError;
      }) as unknown as typeof fetch;
      const report = await runDoctorChecks({
        cwd: workdir,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        fetchImpl,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("error");
      expect(hc?.message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      expect(hc?.message).toContain("NODE_EXTRA_CA_CERTS");
    });

    it("reports error on ECONNREFUSED with a reachable-host hint", async () => {
      await setupWithProxy();
      const refused = Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
      const fetchImpl = (async () => {
        throw refused;
      }) as unknown as typeof fetch;
      const report = await runDoctorChecks({
        cwd: workdir,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        fetchImpl,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("error");
      expect(hc?.message).toContain("connection refused");
      expect(hc?.message).toContain("$HTTPS_PROXY");
    });

    it("reports error on timeout (AbortError) with the elapsed time", async () => {
      await setupWithProxy();
      const fetchImpl = (async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }) as unknown as typeof fetch;
      const report = await runDoctorChecks({
        cwd: workdir,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        fetchImpl,
      });
      const hc = report.checks.find((c) => c.id === "proxy:healthcheck");
      expect(hc?.status).toBe("error");
      expect(hc?.message).toContain("timeout");
    });
  });

  describe("CLI surface", () => {
    it("prints status lines and a summary, exits 0 when no errors", async () => {
      await scaffold(workdir);
      const { io, captured } = captureIo();
      const code = await runDoctor([], {
        cwd: workdir,
        io,
        env: {},
        whichImpl: whichReturning({ claude: "/usr/local/bin/claude" }),
        probeOptions: { importPlaywright: async () => ({ chromium: {} }) },
        // Deterministic doctor run for the CLI surface test: no env → no
        // proxy → no healthcheck attempted, but pin the flag explicitly so a
        // future env-leak doesn't accidentally trigger a real network call.
        noProxyCheck: true,
      });
      // No errors -> exit 0 (warnings about missing codex / gemini /
      // copilot are non-blocking by design).
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("[ok]"))).toBe(true);
      expect(captured.log.some((m) => m.startsWith("doctor:"))).toBe(true);
    });

    it("exits 1 when at least one error-level check fails", async () => {
      await scaffold(workdir);
      // Malformed config = error.
      await writeFile(
        join(workdir, "radar.config.yaml"),
        stringifyYaml({ defaultResearchAgent: "bogus" }),
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await runDoctor([], {
        cwd: workdir,
        io,
        env: {},
        whichImpl: whichReturning({}),
        noProxyCheck: true,
      });
      expect(code).toBe(1);
      expect(captured.log.some((m) => m.startsWith("[error]"))).toBe(true);
    });

    it("prints help with --help", async () => {
      const { io, captured } = captureIo();
      const code = await runDoctor(["--help"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("Usage: radar doctor"))).toBe(true);
      expect(captured.log.some((m) => m.toLowerCase().includes("playwright"))).toBe(true);
    });

    it("rejects unknown options", async () => {
      const { io, captured } = captureIo();
      const code = await runDoctor(["--bogus"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
    });

    it("accepts --no-proxy-check and skips the live healthcheck", async () => {
      await scaffold(workdir);
      const { io, captured } = captureIo();
      const fetchSpy = vi.fn();
      const code = await runDoctor(["--no-proxy-check"], {
        cwd: workdir,
        io,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
        whichImpl: whichReturning({}),
        probeOptions: { importPlaywright: async () => ({ chromium: {} }) },
        fetchImpl: fetchSpy as never,
      });
      expect(code).toBe(0);
      // Hint line for the user that the check was intentionally skipped.
      expect(captured.log.some((m) => m.includes("skipped (--no-proxy-check)"))).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe("cli/watch run (lazy Playwright detection)", () => {
  // These tests cover the integration in src/core/watcher.ts that probes
  // Playwright on the first html-js source. We import runWatch dynamically
  // so we can keep the doctor unit tests above focused on the CLI surface.
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-watch-htmljs-"));
    await scaffold(workdir);
  });

  it("skips html-js sources when Playwright is missing but continues with RSS sources", async () => {
    const { runWatch } = await import("../../src/cli/watch.js");
    // RSS source first, html-js second so we can prove the order does not
    // matter: even when the html-js skip happens after the RSS success, the
    // RSS source still produced an item.
    await writeSourceYaml(workdir, "rss-blog", {
      id: "rss-blog",
      kind: "rss",
      url: "https://example.com/feed.xml",
      filters: { keywords: ["agents"] },
    });
    await writeSourceYaml(workdir, "spa-blog", {
      id: "spa-blog",
      kind: "html-js",
      url: "https://example.com/changelog",
      selectors: { item: ".post", title: ".post-title", link: ".post-link" },
      filters: { keywords: ["agents"] },
    });

    const captured: { log: string[]; warn: string[]; error: string[] } = {
      log: [],
      warn: [],
      error: [],
    };
    const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Blog</title>
    <link>https://example.com</link>
    <description>x</description>
    <item>
      <title>New agents announcement</title>
      <link>https://example.com/a</link>
      <description>desc</description>
      <guid isPermaLink="false">a</guid>
      <pubDate>Mon, 12 May 2026 09:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>
`;
    const fakeFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => RSS,
    });

    const code = await runWatch([], {
      cwd: workdir,
      io: {
        log: (m) => captured.log.push(m),
        warn: (m) => captured.warn.push(m),
        error: (m) => captured.error.push(m),
      },
      fetch: fakeFetch as never,
      env: {}, // no auto-install
      playwrightProbeOptions: {
        importPlaywright: async () => {
          throw new Error("Cannot find module 'playwright'");
        },
      },
      // installChromiumImpl should never be called when env opt-in is absent;
      // throw a clear error if it ever is so the test fails loudly.
      installChromiumImpl: async () => {
        throw new Error("installChromium must NOT run without RADAR_AUTO_INSTALL_CHROMIUM=1");
      },
    });

    // The html-js skip is an error (non-zero exit), but the RSS source still
    // ran successfully — both behaviors together satisfy the acceptance
    // criteria for issue #114.
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("spa-blog") && m.includes("skipped"))).toBe(true);
    expect(captured.error.some((m) => m.includes("npm i -g playwright"))).toBe(true);
    // RSS source success message still appears (other kinds were not blocked).
    expect(captured.log.some((m) => m.includes("rss-blog") && m.includes("new after filter"))).toBe(
      true,
    );
  });

  it("auto-installs Chromium when RADAR_AUTO_INSTALL_CHROMIUM=1 is set and Chromium is missing", async () => {
    const { runWatch } = await import("../../src/cli/watch.js");
    await writeSourceYaml(workdir, "spa-blog", {
      id: "spa-blog",
      kind: "html-js",
      url: "https://example.com/changelog",
      selectors: { item: ".post", title: ".post-title", link: ".post-link" },
      filters: { keywords: ["agents"] },
    });

    const installSpy = vi.fn(async () => 0);
    // Probe returns chromium-missing the first call, ok the second
    // (post-install). The watcher should re-probe once after the install.
    let probeCallCount = 0;
    const probeOptions: ProbeOptions = {
      importPlaywright: async () => ({
        chromium: { executablePath: () => "/tmp/chromium" },
      }),
      pathExists: async () => {
        probeCallCount++;
        return probeCallCount > 1; // first call (pre-install) = missing, second (post) = ok
      },
    };

    const captured: { log: string[]; warn: string[]; error: string[] } = {
      log: [],
      warn: [],
      error: [],
    };

    // We still need to mock the html-js adapter through getAdapter override
    // via the (existing) injection point — but watchRun's getAdapter knob
    // is exposed through `WatchRunOptions`, not `WatchCommandOptions`. To
    // avoid plumbing a second seam, we pass a fetch that satisfies the RSS
    // path and accept that the html-js adapter will then fail at the
    // playwright.launch step. For the purposes of this test we only assert
    // the install was spawned and the probe was re-run; the adapter outcome
    // is not load-bearing.
    await runWatch([], {
      cwd: workdir,
      io: {
        log: (m) => captured.log.push(m),
        warn: (m) => captured.warn.push(m),
        error: (m) => captured.error.push(m),
      },
      env: { RADAR_AUTO_INSTALL_CHROMIUM: "1" },
      playwrightProbeOptions: probeOptions,
      installChromiumImpl: installSpy,
    });

    expect(installSpy).toHaveBeenCalledTimes(1);
    // First call had cwd matching the workdir + log sink threaded through.
    const installArgs = installSpy.mock.calls[0]?.[0];
    expect(installArgs?.cwd).toBe(workdir);
    // The probe must have been re-run after install (second pathExists call).
    expect(probeCallCount).toBeGreaterThanOrEqual(2);
    // Should announce the install attempt on stdout so users see the action.
    expect(captured.log.some((m) => m.includes("RADAR_AUTO_INSTALL_CHROMIUM"))).toBe(true);
  });

  it("does not auto-install when env flag is absent even if Chromium is missing", async () => {
    const { runWatch } = await import("../../src/cli/watch.js");
    await writeSourceYaml(workdir, "spa-blog", {
      id: "spa-blog",
      kind: "html-js",
      url: "https://example.com/changelog",
      selectors: { item: ".post", title: ".post-title", link: ".post-link" },
      filters: { keywords: ["agents"] },
    });

    const installSpy = vi.fn(async () => 0);
    const captured: { log: string[]; warn: string[]; error: string[] } = {
      log: [],
      warn: [],
      error: [],
    };
    await runWatch([], {
      cwd: workdir,
      io: {
        log: (m) => captured.log.push(m),
        warn: (m) => captured.warn.push(m),
        error: (m) => captured.error.push(m),
      },
      env: {}, // no auto-install opt-in
      playwrightProbeOptions: {
        importPlaywright: async () => ({
          chromium: { executablePath: () => "/tmp/chromium" },
        }),
        pathExists: async () => false,
      },
      installChromiumImpl: installSpy,
    });

    expect(installSpy).not.toHaveBeenCalled();
    expect(
      captured.error.some((m) => m.includes("spa-blog") && m.includes("chromium binary missing")),
    ).toBe(true);
  });
});
