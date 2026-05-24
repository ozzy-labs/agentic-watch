import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadItems, saveItems } from "../core/items.js";
import { isValidTransition } from "../core/transitions.js";
import { createTranslator, type Translator } from "../i18n/index.js";
import type { Item } from "../schemas/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";

/**
 * `radar undismiss <item-id> [--force]` (ADR-0018 §W6).
 *
 * Reverses `dismissed → detected`. Origin-aware:
 *
 * - `dismissedBy: triage_<agent>` (or missing — legacy items default to
 *   "human" but the issue spec says triage origin should revert silently)
 *   → revert without warning
 * - `dismissedBy: "human"` → warn and require `--force` (the user dismissed
 *   the item explicitly, so reversing should be a deliberate act)
 *
 * Note on the W2 collapse: per ADR-0018 the `triaged_dismiss` status was
 * folded into the existing `dismissed` status with `dismissedBy` recording
 * the origin. This CLI therefore only ever sees `dismissed` as the input
 * status — the `triaged_dismiss` label exists in the ADR text but never in
 * `ItemStatusSchema`.
 */

export interface UndismissIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface UndismissCommandOptions {
  cwd?: string;
  io?: UndismissIO;
}

interface UndismissArgs {
  itemId?: string;
  force?: boolean;
  help?: boolean;
}

function parseArgs(args: string[]): UndismissArgs {
  const out: UndismissArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--force" || a === "-f") {
      out.force = true;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (!out.itemId) {
      out.itemId = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.undismiss.help"));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runUndismiss(
  args: string[],
  options: UndismissCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Strip `--lang <en|ja>` before the command's own parser sees argv, then
  // resolve the UI locale (--lang > RADAR_LANG > config.locale > en) for help.
  let langState: ReturnType<typeof parseLangFlag>;
  try {
    langState = parseLangFlag(args);
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`undismiss: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const locale = await resolveWorkspaceLocale({ flag: langState.flag, cwd, warn: error });
  const t = createTranslator(locale);

  let parsed: UndismissArgs;
  try {
    parsed = parseArgs(langState.rest);
  } catch (e) {
    error(`undismiss: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(t, log);
    return 0;
  }
  if (!parsed.itemId) {
    error(t("cli.undismiss.missingItemId"));
    printHelp(t, error);
    return 2;
  }

  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    error(t("cli.undismiss.itemsDirNotFound"));
    return 1;
  }

  let items: Item[];
  try {
    items = await loadItems(itemsDir);
  } catch (e) {
    error(`undismiss: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const item = items.find((i) => i.id === parsed.itemId);
  if (!item) {
    error(t("cli.undismiss.itemNotFound", { id: parsed.itemId }));
    return 1;
  }

  if (item.status !== "dismissed") {
    error(t("cli.undismiss.notDismissed", { id: item.id, status: item.status }));
    return 1;
  }
  // Defensive guard against future state machine changes: ensure
  // `dismissed → detected` is still legal before mutating.
  if (!isValidTransition("dismissed", "detected")) {
    error(t("cli.undismiss.forbiddenTransition"));
    return 1;
  }

  // Origin gating. `dismissedBy: undefined` means the item predates the
  // ADR-0018 field; treat it as "human" per the schema docstring's hint.
  const origin = item.dismissedBy ?? "human";
  const triageOrigin = origin.startsWith("triage_");

  if (!triageOrigin && !parsed.force) {
    error(t("cli.undismiss.humanOriginRequiresForce", { id: item.id }));
    return 2;
  }

  const updated: Item = { ...item, status: "detected" };
  // Reset `dismissedBy` on the way out so a future re-dismiss starts from a
  // clean slate. Keeping the stale value would confuse subsequent triage
  // runs (they'd see a `detected` item carrying a `dismissedBy: triage_*`
  // hint from the previous lifecycle).
  delete updated.dismissedBy;
  try {
    await saveItems(itemsDir, [updated]);
  } catch (e) {
    error(t("cli.undismiss.failedUpdate", { reason: e instanceof Error ? e.message : String(e) }));
    return 1;
  }

  if (!triageOrigin) {
    warn(t("cli.undismiss.revertedHumanOrigin", { id: item.id }));
  }
  log(t("cli.undismiss.transitioned", { sourceId: item.sourceId, id: item.id }));
  return 0;
}

export const undismissCommand: Command = {
  name: "undismiss",
  summary: "Reverse a dismiss (`dismissed → detected`)",
  summaryKey: "cli.summary.undismiss",
  run: (args) => runUndismiss(args),
};
