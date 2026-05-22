import { describe, expect, it } from "vitest";
import {
  detectProxyUrl,
  mergeNodeOptions,
  noProxyToPlaywrightBypass,
} from "../../src/core/proxy.js";

describe("core/proxy :: detectProxyUrl", () => {
  it("returns undefined when no proxy env var is set", () => {
    expect(detectProxyUrl({})).toBeUndefined();
  });

  it("treats empty-string env values as unset (mirrors curl/wget convention)", () => {
    expect(detectProxyUrl({ HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "" })).toBeUndefined();
  });

  it("prefers HTTPS_PROXY (upper-case) over HTTP_PROXY and ALL_PROXY", () => {
    const result = detectProxyUrl({
      HTTPS_PROXY: "http://https.example:8080",
      HTTP_PROXY: "http://http.example:8080",
      ALL_PROXY: "socks5://all.example:1080",
    });
    expect(result).toEqual({
      url: "http://https.example:8080",
      source: "HTTPS_PROXY",
      allProxyOnly: false,
    });
  });

  it("falls back to lower-case https_proxy when HTTPS_PROXY is unset", () => {
    const result = detectProxyUrl({
      https_proxy: "http://lower.example:8080",
    });
    expect(result).toEqual({
      url: "http://lower.example:8080",
      source: "HTTPS_PROXY",
      allProxyOnly: false,
    });
  });

  it("prefers HTTP_PROXY when HTTPS_PROXY is absent", () => {
    const result = detectProxyUrl({
      HTTP_PROXY: "http://http.example:8080",
      ALL_PROXY: "socks5://all.example:1080",
    });
    expect(result).toEqual({
      url: "http://http.example:8080",
      source: "HTTP_PROXY",
      allProxyOnly: false,
    });
  });

  it("flags ALL_PROXY-only detections so the CLI can warn the user", () => {
    const result = detectProxyUrl({ ALL_PROXY: "socks5://all.example:1080" });
    expect(result).toEqual({
      url: "socks5://all.example:1080",
      source: "ALL_PROXY",
      allProxyOnly: true,
    });
  });

  it("also accepts lower-case all_proxy", () => {
    const result = detectProxyUrl({ all_proxy: "socks5://all.example:1080" });
    expect(result?.source).toBe("ALL_PROXY");
    expect(result?.allProxyOnly).toBe(true);
  });
});

describe("core/proxy :: mergeNodeOptions", () => {
  it("returns the flag verbatim when NODE_OPTIONS is unset", () => {
    expect(mergeNodeOptions(undefined, "--use-env-proxy")).toBe("--use-env-proxy");
  });

  it("returns the flag verbatim when NODE_OPTIONS is empty string", () => {
    expect(mergeNodeOptions("", "--use-env-proxy")).toBe("--use-env-proxy");
  });

  it("appends the flag to existing NODE_OPTIONS", () => {
    expect(mergeNodeOptions("--max-old-space-size=4096", "--use-env-proxy")).toBe(
      "--max-old-space-size=4096 --use-env-proxy",
    );
  });

  it("is idempotent: skips append when the exact flag is already present", () => {
    expect(mergeNodeOptions("--use-env-proxy", "--use-env-proxy")).toBe("--use-env-proxy");
    expect(mergeNodeOptions("--max-old-space-size=4096 --use-env-proxy", "--use-env-proxy")).toBe(
      "--max-old-space-size=4096 --use-env-proxy",
    );
  });

  it("treats whitespace-separated tokens (not substring matches) as duplicates", () => {
    // `--use-env-proxy-foo` is a different flag; we must still append.
    expect(mergeNodeOptions("--use-env-proxy-foo", "--use-env-proxy")).toBe(
      "--use-env-proxy-foo --use-env-proxy",
    );
  });
});

describe("core/proxy :: noProxyToPlaywrightBypass", () => {
  // Table-driven coverage of the Node ⇄ Playwright NO_PROXY conversion. Each
  // row exercises a separator / suffix-form / whitespace edge case so a future
  // refactor cannot silently regress one without flipping a named case.
  const cases: Array<{ name: string; input: string | undefined; expected: string | undefined }> = [
    { name: "undefined → undefined", input: undefined, expected: undefined },
    { name: "empty string → undefined", input: "", expected: undefined },
    {
      name: "whitespace-only string → undefined (no rules survive trim)",
      input: "   ,  ,",
      expected: undefined,
    },
    {
      name: "single bare host passes through unchanged",
      input: "example.com",
      expected: "example.com",
    },
    {
      name: "comma separator becomes semicolon",
      input: "a.com,b.com",
      expected: "a.com;b.com",
    },
    {
      name: "leading-dot suffix becomes *.suffix (Playwright glob form)",
      input: ".example.com",
      expected: "*.example.com",
    },
    {
      name: "mixed bare host and dot-suffix entries",
      input: "localhost,.internal.corp,api.example.com",
      expected: "localhost;*.internal.corp;api.example.com",
    },
    {
      name: "trailing comma is dropped (no empty rule)",
      input: "a.com,b.com,",
      expected: "a.com;b.com",
    },
    {
      name: "leading comma is dropped",
      input: ",a.com",
      expected: "a.com",
    },
    {
      name: "double comma collapses (defensive against accidental typos)",
      input: "a.com,,b.com",
      expected: "a.com;b.com",
    },
    {
      name: "whitespace around entries is trimmed",
      input: "  a.com , .b.com  ,c.com",
      expected: "a.com;*.b.com;c.com",
    },
    {
      name: "IP address bare host is preserved verbatim",
      input: "127.0.0.1,192.168.0.0/16",
      expected: "127.0.0.1;192.168.0.0/16",
    },
    {
      name: "host:port form is preserved (Playwright matches by host portion)",
      input: "localhost:3000,.example.com:8443",
      expected: "localhost:3000;*.example.com:8443",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(noProxyToPlaywrightBypass(c.input)).toBe(c.expected);
    });
  }
});
