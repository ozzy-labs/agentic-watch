import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/index.js";
import { watchCommand } from "../../src/cli/watch.js";

/**
 * Tests for the top-level CLI dispatcher's localized global help / version /
 * unknown-command paths (ADR-0021, epic #307 P2, issue #310).
 *
 * These paths are config-independent, so locale is driven purely by the
 * injected `--lang` flag / `RADAR_LANG` env. Output is captured through the
 * `options.io` seam so no `console` spying is needed. The unknown-command path
 * calls `process.exit(2)`; we stub it to throw a sentinel so the assertion can
 * inspect the captured stderr without tearing down the test runner.
 */

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function captureIo() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    io: { log: (m: string) => log.push(m), error: (m: string) => error.push(m) },
    log,
    error,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli run — global help", () => {
  it("prints English help by default", async () => {
    const { io, log } = captureIo();
    await run(["--help"], { io, env: {} });
    const out = log.join("\n");
    expect(out).toContain("FeedRadar — Multi-agent CLI for blog/release feed research");
    expect(out).toContain("Usage: radar <command> [options]");
    expect(out).toContain("Commands:");
    expect(out).toContain("Show this help");
  });

  it("prints Japanese help with --lang ja", async () => {
    const { io, log } = captureIo();
    await run(["--lang", "ja", "--help"], { io, env: {} });
    const out = log.join("\n");
    expect(out).toContain("FeedRadar — ブログ/リリースフィード調査のためのマルチエージェント CLI");
    expect(out).toContain("使い方: radar <コマンド> [オプション]");
    expect(out).toContain("コマンド:");
    expect(out).toContain("このヘルプを表示する");
  });

  it("prints Japanese help with RADAR_LANG=ja", async () => {
    const { io, log } = captureIo();
    await run([], { io, env: { RADAR_LANG: "ja" } });
    expect(log.join("\n")).toContain("コマンド:");
  });

  it("--lang flag overrides RADAR_LANG", async () => {
    const { io, log } = captureIo();
    await run(["--lang", "en", "--help"], { io, env: { RADAR_LANG: "ja" } });
    expect(log.join("\n")).toContain("Commands:");
  });
});

describe("cli run — unknown command", () => {
  it("emits the localized error and exits 2 (en)", async () => {
    const { io, error } = captureIo();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    await expect(run(["frobnicate"], { io, env: {} })).rejects.toMatchObject({ code: 2 });
    expect(error.join("\n")).toContain("radar: unknown command 'frobnicate'");
    expect(error.join("\n")).toContain("Run 'radar --help' for available commands.");
  });

  it("emits the localized error and exits 2 (ja)", async () => {
    const { io, error } = captureIo();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    await expect(run(["--lang", "ja", "frobnicate"], { io, env: {} })).rejects.toMatchObject({
      code: 2,
    });
    expect(error.join("\n")).toContain("radar: 不明なコマンド 'frobnicate' です");
    expect(error.join("\n")).toContain("利用可能なコマンドは 'radar --help' で確認できます。");
  });
});

describe("cli run — invalid --lang falls back to en", () => {
  it("warns through io.error and shows English help", async () => {
    const { io, log, error } = captureIo();
    await run(["--lang", "frnch", "--help"], { io, env: {} });
    expect(error.join("\n")).toContain("invalid locale 'frnch'");
    expect(log.join("\n")).toContain("Commands:");
  });
});

describe("cli run — dangling global --lang", () => {
  it("reports a usage error and exits 2", async () => {
    const { io, error } = captureIo();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    await expect(run(["--lang"], { io, env: {} })).rejects.toMatchObject({ code: 2 });
    expect(error.join("\n")).toContain("--lang requires a value");
  });
});

describe("cli run — subcommand argv forwarding", () => {
  it("forwards post-command args verbatim to the subcommand", async () => {
    const spy = vi.spyOn(watchCommand, "run").mockResolvedValue(0);
    await run(["watch", "run", "--source", "x"], { io: captureIo().io, env: {} });
    expect(spy).toHaveBeenCalledWith(["run", "--source", "x"]);
  });

  it("consumes a global --lang (before the command) and does not forward it", async () => {
    const spy = vi.spyOn(watchCommand, "run").mockResolvedValue(0);
    await run(["--lang", "ja", "watch", "run"], { io: captureIo().io, env: {} });
    expect(spy).toHaveBeenCalledWith(["run"]);
  });

  it("leaves a --lang placed after the command for the subcommand to resolve", async () => {
    // The dispatcher only consumes a *leading* --lang; one after the command
    // is the subcommand's own (config-aware) concern, so it is forwarded as-is.
    const spy = vi.spyOn(watchCommand, "run").mockResolvedValue(0);
    await run(["watch", "--lang", "ja", "run"], { io: captureIo().io, env: {} });
    expect(spy).toHaveBeenCalledWith(["--lang", "ja", "run"]);
  });

  it("does not leak the --lang value token when it collides with a command name", async () => {
    // Regression: a naive `argv.indexOf(first)` would match the `--lang`
    // *value* ("watch") instead of the command token, forwarding a stray arg.
    const spy = vi.spyOn(watchCommand, "run").mockResolvedValue(0);
    await run(["--lang", "watch", "watch"], { io: captureIo().io, env: {} });
    // `--lang watch` is an invalid locale (warns, falls back to en); the
    // command receives an empty argv, not a spurious ["watch"].
    expect(spy).toHaveBeenCalledWith([]);
  });
});
