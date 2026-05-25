import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runState } from "../../src/cli/state.js";

/**
 * Unit coverage for `radar state prune <source> --keep N` (#333).
 *
 * The command trims `state/<source>.yaml` lastSeenIds to its newest N ids
 * (FIFO) so an already-bloated facet-sweep state file can be shrunk manually.
 */

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function captureIo(): {
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  captured: Captured;
} {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (m) => captured.log.push(m),
      warn: (m) => captured.warn.push(m),
      error: (m) => captured.error.push(m),
    },
    captured,
  };
}

async function writeState(workdir: string, sourceId: string, ids: string[]): Promise<void> {
  const yaml = [
    `sourceId: ${sourceId}`,
    'lastFetchedAt: "2026-05-25T00:00:00.000Z"',
    "lastSeenIds:",
    ...ids.map((id) => `  - ${id}`),
    "",
  ].join("\n");
  await writeFile(join(workdir, "state", `${sourceId}.yaml`), yaml, "utf8");
}

describe("cli/state prune", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-state-prune-"));
    await mkdir(join(workdir, "state"), { recursive: true });
  });

  it("keeps the newest N ids and drops the oldest (FIFO)", async () => {
    await writeState(workdir, "aws", ["a", "b", "c", "d", "e"]);
    const { io, captured } = captureIo();

    const code = await runState(["prune", "aws", "--keep", "2"], { cwd: workdir, io });

    expect(code).toBe(0);
    const raw = await readFile(join(workdir, "state", "aws.yaml"), "utf8");
    const parsed = parseYaml(raw) as { lastSeenIds: string[] };
    expect(parsed.lastSeenIds).toEqual(["d", "e"]);
    expect(captured.log.join("\n")).toContain("5 -> 2");
    expect(captured.error).toEqual([]);
  });

  it("is a no-op (no write change) when the list is already within --keep", async () => {
    await writeState(workdir, "aws", ["a", "b"]);
    const { io, captured } = captureIo();

    const code = await runState(["prune", "aws", "--keep", "5"], { cwd: workdir, io });

    expect(code).toBe(0);
    const parsed = parseYaml(await readFile(join(workdir, "state", "aws.yaml"), "utf8")) as {
      lastSeenIds: string[];
    };
    expect(parsed.lastSeenIds).toEqual(["a", "b"]);
    expect(captured.log.join("\n")).toContain("nothing to trim");
  });

  it("errors with exit 1 when the source state file does not exist", async () => {
    const { io, captured } = captureIo();

    const code = await runState(["prune", "missing", "--keep", "2"], { cwd: workdir, io });

    expect(code).toBe(1);
    expect(captured.error.join("\n")).toContain("missing");
  });

  it("requires --keep (exit 2)", async () => {
    await writeState(workdir, "aws", ["a", "b", "c"]);
    const { io, captured } = captureIo();

    const code = await runState(["prune", "aws"], { cwd: workdir, io });

    expect(code).toBe(2);
    expect(captured.error.join("\n")).toContain("--keep");
  });

  it("rejects a non-positive / non-integer --keep (exit 2)", async () => {
    await writeState(workdir, "aws", ["a", "b", "c"]);

    const zero = captureIo();
    expect(await runState(["prune", "aws", "--keep", "0"], { cwd: workdir, io: zero.io })).toBe(2);
    expect(zero.captured.error.join("\n")).toContain("positive");

    const word = captureIo();
    expect(await runState(["prune", "aws", "--keep", "abc"], { cwd: workdir, io: word.io })).toBe(
      2,
    );
    expect(word.captured.error.join("\n")).toContain("integer");
  });

  it("rejects --older-than as unsupported (exit 2)", async () => {
    await writeState(workdir, "aws", ["a", "b", "c"]);
    const { io, captured } = captureIo();

    const code = await runState(["prune", "aws", "--older-than", "30d"], { cwd: workdir, io });

    expect(code).toBe(2);
    expect(captured.error.join("\n")).toContain("not supported");
  });

  it("errors with exit 2 when <source> is missing", async () => {
    const { io, captured } = captureIo();

    const code = await runState(["prune", "--keep", "2"], { cwd: workdir, io });

    expect(code).toBe(2);
    expect(captured.error.join("\n")).toContain("missing");
  });

  it("rejects an unknown subcommand (exit 2)", async () => {
    const { io, captured } = captureIo();

    const code = await runState(["frobnicate"], { cwd: workdir, io });

    expect(code).toBe(2);
    expect(captured.error.join("\n")).toContain("unknown subcommand");
  });

  it("prints help for `state` with no subcommand (exit 2) and `--help` (exit 0)", async () => {
    const none = captureIo();
    expect(await runState([], { cwd: workdir, io: none.io })).toBe(2);
    expect(none.captured.log.join("\n")).toContain("radar state prune");

    const help = captureIo();
    expect(await runState(["prune", "--help"], { cwd: workdir, io: help.io })).toBe(0);
    expect(help.captured.log.join("\n")).toContain("radar state prune");
  });
});
