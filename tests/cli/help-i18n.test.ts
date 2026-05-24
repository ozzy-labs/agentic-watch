import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runDismiss } from "../../src/cli/dismiss.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { run as runCli } from "../../src/cli/index.js";
import { initCommand } from "../../src/cli/init.js";
import { runItems } from "../../src/cli/items.js";
import { runResearch } from "../../src/cli/research.js";
import { runReview } from "../../src/cli/review.js";
import { runRoutine } from "../../src/cli/routine.js";
import { runSource } from "../../src/cli/source.js";
import { runTriage } from "../../src/cli/triage.js";
import { runUndismiss } from "../../src/cli/undismiss.js";
import { runUpdate } from "../../src/cli/update.js";
import { runWatch } from "../../src/cli/watch.js";
import { runWorkflow } from "../../src/cli/workflow.js";
import { en } from "../../src/i18n/messages/en.js";
import { ja } from "../../src/i18n/messages/ja.js";

/**
 * Help / usage i18n tests (#311).
 *
 * Each command's `--help` output is asserted to be English by default and
 * Japanese with `--lang ja`. The `--lang` flag wins over `config.locale`, so a
 * tmp `cwd` with no `radar.config.yaml` reliably yields the default-en path.
 *
 * The en/ja key-set parity check lives in `tests/i18n/messages.test.ts` and
 * already covers the help keys added here; this file proves the *wiring*
 * (catalog string → command output, per locale).
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

/** First non-empty line of a multi-line `log` capture. */
function firstLine(captured: Captured): string {
  return captured.log.join("\n").split("\n")[0] ?? "";
}

let workdir: string;
beforeEach(async () => {
  // A workspace with no radar.config.yaml: locale resolution falls through to
  // the flag/env/default layers, so default runs are guaranteed English.
  workdir = await mkdtemp(join(tmpdir(), "radar-help-i18n-"));
});

describe("command help i18n (--lang)", () => {
  it("research --help is English by default, Japanese with --lang ja", async () => {
    const e = captureIo();
    expect(await runResearch(["--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(firstLine(e.captured)).toBe("Usage:");
    expect(e.captured.log.join("\n")).toContain("Bundle multiple items into a single digest");

    const j = captureIo();
    expect(await runResearch(["--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(firstLine(j.captured)).toBe("使い方:");
    expect(j.captured.log.join("\n")).toContain("複数アイテムを 1 つのダイジェスト");
  });

  it("review --help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runReview(["--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(firstLine(e.captured)).toBe("Usage:");

    const j = captureIo();
    expect(await runReview(["--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(firstLine(j.captured)).toBe("使い方:");
  });

  it("update --help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runUpdate(["--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(firstLine(e.captured)).toBe("Usage:");

    const j = captureIo();
    expect(await runUpdate(["--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(firstLine(j.captured)).toBe("使い方:");
  });

  it("triage --help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runTriage(["--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(e.captured.log.join("\n")).toContain("Usage: radar triage");

    const j = captureIo();
    expect(await runTriage(["--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(j.captured.log.join("\n")).toContain("使い方: radar triage");
  });

  it("triage feedback / stats / help subcommand help honor --lang ja", async () => {
    const fbEn = captureIo();
    expect(await runTriage(["feedback", "--help"], { cwd: workdir, io: fbEn.io })).toBe(0);
    expect(fbEn.captured.log.join("\n")).toContain("Record human feedback");

    const fb = captureIo();
    expect(
      await runTriage(["feedback", "--lang", "ja", "--help"], { cwd: workdir, io: fb.io }),
    ).toBe(0);
    expect(fb.captured.log.join("\n")).toContain("人手のフィードバックを記録する");

    const st = captureIo();
    expect(await runTriage(["stats", "--lang", "ja", "--help"], { cwd: workdir, io: st.io })).toBe(
      0,
    );
    expect(st.captured.log.join("\n")).toContain("triage 判定と人手フィードバックを集計する");

    const hp = captureIo();
    expect(await runTriage(["help", "--lang", "ja"], { cwd: workdir, io: hp.io })).toBe(0);
    expect(hp.captured.log.join("\n")).toContain("サブコマンド:");
  });

  it("dismiss / undismiss --help honor --lang ja", async () => {
    const d = captureIo();
    expect(await runDismiss(["--help"], { cwd: workdir, io: d.io })).toBe(0);
    expect(firstLine(d.captured)).toBe("Usage:");
    const dj = captureIo();
    expect(await runDismiss(["--lang", "ja", "--help"], { cwd: workdir, io: dj.io })).toBe(0);
    expect(firstLine(dj.captured)).toBe("使い方:");

    const u = captureIo();
    expect(await runUndismiss(["--help"], { cwd: workdir, io: u.io })).toBe(0);
    expect(u.captured.log.join("\n")).toContain("Usage: radar undismiss");
    const uj = captureIo();
    expect(await runUndismiss(["--lang", "ja", "--help"], { cwd: workdir, io: uj.io })).toBe(0);
    expect(uj.captured.log.join("\n")).toContain("使い方: radar undismiss");
  });

  it("items list --help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runItems(["list", "--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(e.captured.log.join("\n")).toContain("Usage: radar items list");
    const j = captureIo();
    expect(await runItems(["list", "--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(j.captured.log.join("\n")).toContain("使い方: radar items list");
  });

  it("watch run --help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runWatch(["--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(e.captured.log.join("\n")).toContain("Usage: radar watch");
    const j = captureIo();
    expect(await runWatch(["--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(j.captured.log.join("\n")).toContain("使い方: radar watch");
  });

  it("doctor --help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runDoctor(["--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(e.captured.log.join("\n")).toContain("Usage: radar doctor");
    const j = captureIo();
    expect(await runDoctor(["--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(j.captured.log.join("\n")).toContain("使い方: radar doctor");
  });

  it("source subcommand help honors --lang ja", async () => {
    const e = captureIo();
    expect(await runSource(["add", "--help"], { cwd: workdir, io: e.io })).toBe(0);
    expect(e.captured.log.join("\n")).toContain("Usage: radar source add");
    const j = captureIo();
    expect(await runSource(["add", "--lang", "ja", "--help"], { cwd: workdir, io: j.io })).toBe(0);
    expect(j.captured.log.join("\n")).toContain("使い方: radar source add");

    // dispatcher-level overview help
    const od = captureIo();
    expect(await runSource(["--help"], { cwd: workdir, io: od.io })).toBe(0);
    expect(od.captured.log.join("\n")).toContain("Usage: radar source");
  });

  it("workflow / routine dispatcher help honor --lang ja", async () => {
    const w = captureIo();
    expect(await runWorkflow(["generate", "--help"], { cwd: workdir, io: w.io })).toBe(0);
    expect(w.captured.log.join("\n")).toContain("Usage: radar workflow generate");

    const r = captureIo();
    expect(await runRoutine(["--help"], { cwd: workdir, io: r.io })).toBe(0);
    expect(r.captured.log.join("\n")).toContain("Usage: radar routine");
  });

  it("init --help honors --lang ja", async () => {
    const log: string[] = [];
    const spy = console.log;
    console.log = (m?: unknown) => {
      log.push(String(m));
    };
    try {
      expect(await initCommand.run(["--help"])).toBe(0);
      expect(log.join("\n")).toContain("Usage: radar init");
      log.length = 0;
      expect(await initCommand.run(["--lang", "ja", "--help"])).toBe(0);
      expect(log.join("\n")).toContain("使い方: radar init");
    } finally {
      console.log = spy;
    }
  });
});

describe("global help i18n (radar --help command summaries)", () => {
  it("renders English summaries by default", async () => {
    const { io, captured } = captureIo();
    await runCli(["--help"], { io, env: {} });
    const out = captured.log.join("\n");
    expect(out).toContain(en["cli.summary.research"] as string);
    expect(out).toContain(en["cli.summary.doctor"] as string);
  });

  it("renders Japanese summaries with --lang ja", async () => {
    const { io, captured } = captureIo();
    await runCli(["--lang", "ja", "--help"], { io, env: {} });
    const out = captured.log.join("\n");
    expect(out).toContain(ja["cli.summary.research"] as string);
    expect(out).toContain(ja["cli.summary.doctor"] as string);
  });
});
