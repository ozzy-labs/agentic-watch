import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  maybeRespawnForProxy,
  NODE_USE_ENV_PROXY,
  OPT_OUT_ENV,
  PROXY_FLAG,
  RESPAWN_SENTINEL,
} from "../../src/cli/respawn.js";

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

interface Harness {
  spawn: ReturnType<typeof vi.fn>;
  child: ChildProcess & EventEmitter;
  signalHandlers: Map<NodeJS.Signals, () => void>;
  onSignal: (sig: NodeJS.Signals, h: () => void) => void;
  exit: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  calls: SpawnCall[];
}

function makeHarness(): Harness {
  const calls: SpawnCall[] = [];
  // Cast through `unknown` because we only implement the subset of
  // ChildProcess our respawn module touches (event emitter + `kill`).
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];

  const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    return child;
  });

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const onSignal = (sig: NodeJS.Signals, h: () => void) => {
    signalHandlers.set(sig, h);
  };

  return {
    spawn,
    child,
    signalHandlers,
    onSignal,
    exit: vi.fn(),
    warn: vi.fn(),
    calls,
  };
}

describe("cli/respawn :: maybeRespawnForProxy", () => {
  it("no-ops when no proxy env var is set", () => {
    const h = makeHarness();
    const decision = maybeRespawnForProxy({
      env: {},
      argv: ["/usr/bin/node", "/path/to/radar", "doctor"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    expect(decision).toEqual({ respawned: false, reason: "no-proxy" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("no-ops when RADAR_AUTO_PROXY=0 is set (opt-out)", () => {
    const h = makeHarness();
    const decision = maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080", [OPT_OUT_ENV]: "0" },
      argv: ["/usr/bin/node", "/path/to/radar", "doctor"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    expect(decision.respawned).toBe(false);
    expect(decision.reason).toBe("opt-out");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("also accepts 'false' / 'off' as opt-out values", () => {
    for (const value of ["false", "FALSE", "off", "OFF"]) {
      const h = makeHarness();
      const decision = maybeRespawnForProxy({
        env: { HTTPS_PROXY: "http://proxy:8080", [OPT_OUT_ENV]: value },
        argv: ["/usr/bin/node", "/path/to/radar", "doctor"],
        execPath: "/usr/bin/node",
        spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
        onSignal: h.onSignal,
        exit: h.exit,
        warn: h.warn,
      });
      expect(decision.respawned, `value=${value}`).toBe(false);
      expect(decision.reason).toBe("opt-out");
    }
  });

  it("no-ops when RADAR_PROXY_RESPAWNED=1 (already in respawned child)", () => {
    const h = makeHarness();
    const decision = maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080", [RESPAWN_SENTINEL]: "1" },
      argv: ["/usr/bin/node", "/path/to/radar", "doctor"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    expect(decision.respawned).toBe(false);
    expect(decision.reason).toBe("already-respawned");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("respawns with --use-env-proxy injected into NODE_OPTIONS and propagates env", () => {
    const h = makeHarness();
    const decision = maybeRespawnForProxy({
      env: {
        HTTPS_PROXY: "http://proxy:8080",
        NODE_OPTIONS: "--max-old-space-size=4096",
        EXISTING_VAR: "keep-me",
      },
      argv: ["/usr/bin/node", "/path/to/radar", "doctor", "--verbose"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });

    expect(decision.respawned).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    const call = h.calls[0];
    expect(call.command).toBe("/usr/bin/node");
    // argv.slice(1) → script + user args (drop node binary path)
    expect(call.args).toEqual(["/path/to/radar", "doctor", "--verbose"]);

    expect(call.options.stdio).toBe("inherit");
    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=4096 ${PROXY_FLAG}`);
    expect(env[RESPAWN_SENTINEL]).toBe("1");
    expect(env[NODE_USE_ENV_PROXY]).toBe("1");
    expect(env.EXISTING_VAR).toBe("keep-me");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
  });

  it("handles missing NODE_OPTIONS by setting it to just the flag", () => {
    const h = makeHarness();
    maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    const env = h.calls[0]?.options.env as NodeJS.ProcessEnv;
    expect(env.NODE_OPTIONS).toBe(PROXY_FLAG);
  });

  it("warns but still respawns when only ALL_PROXY is set", () => {
    const h = makeHarness();
    const decision = maybeRespawnForProxy({
      env: { ALL_PROXY: "socks5://proxy:1080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    expect(decision.respawned).toBe(true);
    expect(h.warn).toHaveBeenCalledTimes(1);
    const message = h.warn.mock.calls[0][0] as string;
    expect(message).toMatch(/ALL_PROXY/);
    expect(message).toMatch(/HTTPS_PROXY/);
  });

  it("does NOT warn when HTTPS_PROXY is set alongside ALL_PROXY", () => {
    const h = makeHarness();
    maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080", ALL_PROXY: "socks5://other:1080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("forwards SIGINT / SIGTERM / SIGHUP to the child", () => {
    const h = makeHarness();
    maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });

    expect(h.signalHandlers.has("SIGINT")).toBe(true);
    expect(h.signalHandlers.has("SIGTERM")).toBe(true);
    expect(h.signalHandlers.has("SIGHUP")).toBe(true);

    h.signalHandlers.get("SIGINT")?.();
    h.signalHandlers.get("SIGTERM")?.();
    h.signalHandlers.get("SIGHUP")?.();

    const killCalls = (h.child.kill as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(killCalls.map((c) => c[0])).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  it("propagates the child's exit code via exit()", () => {
    const h = makeHarness();
    maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    h.child.emit("exit", 42, null);
    expect(h.exit).toHaveBeenCalledWith(42);
  });

  it("defaults exit code to 0 when child reports a null code without a signal", () => {
    const h = makeHarness();
    maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    h.child.emit("exit", null, null);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("falls back to exit(1) on spawn error", () => {
    const h = makeHarness();
    maybeRespawnForProxy({
      env: { HTTPS_PROXY: "http://proxy:8080" },
      argv: ["/usr/bin/node", "/path/to/radar"],
      execPath: "/usr/bin/node",
      spawn: h.spawn as unknown as typeof import("node:child_process").spawn,
      onSignal: h.onSignal,
      exit: h.exit,
      warn: h.warn,
    });
    h.child.emit("error", new Error("ENOENT"));
    expect(h.warn).toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});
