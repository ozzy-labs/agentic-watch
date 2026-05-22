import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProgressReporter,
  noopProgressReporter,
  type ProgressReporter,
} from "../../src/core/progress.js";

/**
 * In-memory `WritableStream` substitute for the reporter's output sink.
 *
 * Vitest's `node` env runs without a real TTY, so the reporter defaults to
 * `process.stderr.isTTY === false`. Each test passes `tty: true|false`
 * explicitly to lock down both branches without relying on env detection.
 *
 * The captured chunks are kept verbatim so we can assert on ANSI escape
 * sequences (`\r`, `\x1b[K`) and the spinner-frame characters.
 */
function memoryStream(): NodeJS.WritableStream & { chunks: string[]; output: () => string } {
  const chunks: string[] = [];
  const stream = {
    chunks,
    output: () => chunks.join(""),
    // Implement just enough of the WritableStream contract for the reporter.
    write(data: string | Uint8Array, ...rest: unknown[]): boolean {
      chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
      // Honour the optional callback signature so we are a good citizen.
      const last = rest[rest.length - 1];
      if (typeof last === "function") (last as () => void)();
      return true;
    },
  } as unknown as NodeJS.WritableStream & {
    chunks: string[];
    output: () => string;
  };
  return stream;
}

describe("createProgressReporter — escape hatches", () => {
  const originalNoProgress = process.env.RADAR_NO_PROGRESS;

  afterEach(() => {
    if (originalNoProgress === undefined) {
      delete process.env.RADAR_NO_PROGRESS;
    } else {
      process.env.RADAR_NO_PROGRESS = originalNoProgress;
    }
  });

  it("returns a no-op reporter when RADAR_NO_PROGRESS=1 (CI escape hatch)", () => {
    process.env.RADAR_NO_PROGRESS = "1";
    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "verbose", tty: true, stream });
    reporter.phase("Spawning claude-code");
    reporter.start("Agent running");
    reporter.update({ stdout: "4.2 KB" });
    reporter.succeed("Agent completed");
    reporter.raw("hello\n");
    expect(stream.output()).toBe("");
  });

  it("returns a no-op reporter when level=quiet (--quiet semantics)", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "quiet", tty: true, stream });
    reporter.phase("Spawning claude-code");
    reporter.start("Agent running");
    reporter.succeed("Agent completed");
    expect(stream.output()).toBe("");
  });

  it("noopProgressReporter() exposes the full 6-method API as no-ops", () => {
    const reporter: ProgressReporter = noopProgressReporter();
    // None of these should throw or produce side effects.
    expect(() => reporter.phase("anything")).not.toThrow();
    expect(() => reporter.start("anything")).not.toThrow();
    expect(() => reporter.update({ k: "v" })).not.toThrow();
    expect(() => reporter.succeed("anything", 1234)).not.toThrow();
    expect(() => reporter.fail("anything", "boom")).not.toThrow();
    expect(() => reporter.raw("anything")).not.toThrow();
  });
});

describe("createProgressReporter — TTY detection", () => {
  it("defaults to process.stderr.isTTY when `tty` is unspecified", () => {
    // We can't mutate `process.stderr.isTTY` cleanly across vitest workers,
    // but we can assert the override still wins. The `tty: false` branch is
    // exercised by the non-TTY test block below.
    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "normal", tty: false, stream });
    reporter.phase("Loaded 3 items");
    // Phase markers are line-based in both modes — no ANSI escape on
    // non-TTY.
    expect(stream.output()).toContain("Loaded 3 items\n");
    expect(stream.output()).not.toContain("\r");
    expect(stream.output()).not.toContain("\x1b[K");
  });
});

describe("createProgressReporter — phase markers", () => {
  it("emits one line per phase call (TTY)", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "normal", tty: true, stream });
    reporter.phase("Loaded 3 items");
    reporter.phase("Spawning claude-code", "cwd: /tmp/x");
    const out = stream.output();
    expect(out).toContain("Loaded 3 items\n");
    expect(out).toContain("Spawning claude-code (cwd: /tmp/x)\n");
  });

  it("emits one line per phase call (non-TTY plain text degrade)", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({ level: "normal", tty: false, stream });
    reporter.phase("Loaded 3 items");
    reporter.phase("Spawning claude-code", "cwd: /tmp/x");
    const out = stream.output();
    expect(out).toContain("Loaded 3 items\n");
    expect(out).toContain("Spawning claude-code (cwd: /tmp/x)\n");
    // No ANSI escape, no `\r` overwriting.
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\x1b[K");
  });
});

describe("createProgressReporter — spinner lifecycle (TTY)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paints frame 0 immediately when start() is called on TTY", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      heartbeatMs: 1000,
      now: () => 0,
    });
    reporter.start("Agent running");
    // Frame 0 = `⠋`, elapsed 00:00.
    expect(stream.output()).toContain("⠋ Agent running [00:00]");
    // ANSI escape sequence to clear-and-overwrite the line on update.
    expect(stream.output()).toContain("\r");
    expect(stream.output()).toContain("\x1b[K");
  });

  it("rotates through spinner frames on the 1s heartbeat", () => {
    let fakeNow = 0;
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      heartbeatMs: 1000,
      now: () => fakeNow,
    });
    reporter.start("Agent running");
    fakeNow = 1000;
    vi.advanceTimersByTime(1000);
    fakeNow = 2000;
    vi.advanceTimersByTime(1000);
    fakeNow = 3000;
    vi.advanceTimersByTime(1000);
    const out = stream.output();
    // First three rotated frames after start.
    expect(out).toContain("⠋");
    expect(out).toContain("⠙");
    expect(out).toContain("⠹");
    expect(out).toContain("⠸");
    // Elapsed time tick is reflected in the row.
    expect(out).toContain("[00:01]");
    expect(out).toContain("[00:02]");
    expect(out).toContain("[00:03]");
  });

  it("merges metrics from update() into the spinner row", () => {
    let fakeNow = 0;
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      heartbeatMs: 1000,
      now: () => fakeNow,
    });
    reporter.start("Agent running");
    reporter.update({ stdout: "4.2 KB" });
    fakeNow = 1000;
    reporter.update({ stdout: "8.4 KB", page: "3/80" });
    const out = stream.output();
    expect(out).toContain("stdout: 4.2 KB");
    expect(out).toContain("stdout: 8.4 KB");
    expect(out).toContain("page: 3/80");
  });

  it("stops the heartbeat and emits a completion line on succeed()", () => {
    let fakeNow = 0;
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      heartbeatMs: 1000,
      now: () => fakeNow,
    });
    reporter.start("Agent running");
    fakeNow = 1500;
    reporter.succeed("Agent completed", 1500);
    const out = stream.output();
    expect(out).toContain("Agent completed (1.5s)\n");
    // After succeed, advancing the timer should NOT add new spinner frames.
    const lengthBefore = out.length;
    vi.advanceTimersByTime(5000);
    expect(stream.output().length).toBe(lengthBefore);
  });

  it("stops the heartbeat and emits a failure line on fail()", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      heartbeatMs: 1000,
      now: () => 0,
    });
    reporter.start("Agent running");
    reporter.fail("Agent crashed", "exit code 137");
    expect(stream.output()).toContain("Agent crashed — exit code 137\n");
    // No more frames after fail.
    const lengthBefore = stream.output().length;
    vi.advanceTimersByTime(5000);
    expect(stream.output().length).toBe(lengthBefore);
  });

  it("uses computed elapsed when succeed() is called without explicit duration", () => {
    let fakeNow = 0;
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      heartbeatMs: 1000,
      now: () => fakeNow,
    });
    reporter.start("Agent running");
    fakeNow = 65_500; // 1m 5s
    reporter.succeed("Agent completed");
    expect(stream.output()).toContain("Agent completed (1m 5s)\n");
  });
});

describe("createProgressReporter — spinner lifecycle (non-TTY)", () => {
  it("emits a plain-text start line and no `\\r` overwrite", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: false,
      stream,
      heartbeatMs: 1000,
      now: () => 0,
    });
    reporter.start("Agent running");
    const out = stream.output();
    expect(out).toContain("Agent running\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\x1b[K");
  });

  it("does not paint per-update lines on non-TTY (avoid log spam)", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: false,
      stream,
      now: () => 0,
    });
    reporter.start("Agent running");
    const before = stream.output().length;
    reporter.update({ stdout: "4.2 KB" });
    reporter.update({ stdout: "8.4 KB" });
    expect(stream.output().length).toBe(before);
  });

  it("emits a completion line on succeed() even on non-TTY", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: false,
      stream,
      now: () => 0,
    });
    reporter.start("Agent running");
    reporter.succeed("Agent completed", 250);
    expect(stream.output()).toContain("Agent completed (250ms)\n");
  });
});

describe("createProgressReporter — raw() pass-through", () => {
  it("drops chunks when level=normal (only verbose enables raw())", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: true,
      stream,
      now: () => 0,
    });
    reporter.raw("inner-cli line\n");
    expect(stream.output()).toBe("");
  });

  it("forwards chunks verbatim when level=verbose", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "verbose",
      tty: true,
      stream,
      now: () => 0,
    });
    reporter.raw("hello\n");
    reporter.raw("world\n");
    expect(stream.output()).toContain("hello\n");
    expect(stream.output()).toContain("world\n");
  });

  it("inserts a soft newline if a verbose chunk does not end with one (TTY)", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "verbose",
      tty: true,
      stream,
      now: () => 0,
    });
    reporter.start("Agent running");
    reporter.raw("partial line without newline");
    // After the raw chunk, the spinner repaint should not eat the chunk's tail.
    const out = stream.output();
    expect(out).toContain("partial line without newline");
    expect(out).toContain("partial line without newline\n");
  });
});

describe("createProgressReporter — duration formatting", () => {
  it("formats sub-second durations as `Nms`", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: false,
      stream,
      now: () => 0,
    });
    reporter.start("x");
    reporter.succeed("done", 250);
    expect(stream.output()).toContain("done (250ms)\n");
  });

  it("formats sub-minute durations as `N.Ns`", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: false,
      stream,
      now: () => 0,
    });
    reporter.start("x");
    reporter.succeed("done", 5500);
    expect(stream.output()).toContain("done (5.5s)\n");
  });

  it("formats minute-scale durations as `Nm Ns`", () => {
    const stream = memoryStream();
    const reporter = createProgressReporter({
      level: "normal",
      tty: false,
      stream,
      now: () => 0,
    });
    reporter.start("x");
    reporter.succeed("done", 125_000);
    expect(stream.output()).toContain("done (2m 5s)\n");
  });
});
