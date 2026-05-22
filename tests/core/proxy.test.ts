import { describe, expect, it } from "vitest";
import { detectProxyUrl, mergeNodeOptions } from "../../src/core/proxy.js";

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
