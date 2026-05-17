import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadItems, saveItems } from "../core/items.js";
import type { Item } from "../schemas/index.js";
import type { Command } from "./index.js";

/** Sinks for the dismiss command's user-facing output. Tests inject capturing sinks. */
export interface DismissIO {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface DismissCommandOptions {
  cwd?: string;
  io?: DismissIO;
}

interface DismissArgs {
  itemId?: string;
  help?: boolean;
}

function parseArgs(args: string[]): DismissArgs {
  const out: DismissArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
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

function printHelp(log: (m: string) => void): void {
  log("Usage: radar dismiss <item-id>");
  log("");
  log("Arguments:");
  log("  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)");
  log("");
  log("Transitions the item's status from `detected` to `dismissed` (ADR-0008).");
  log("Items already in `researched`, `reviewed`, or `dismissed` cannot be dismissed.");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate `items/<sourceId>/<item-id>.yaml` across all source directories.
 *
 * Mirrors the lookup strategy used by `research`: `loadItems` walks every
 * source subdir and we match by id, so the caller only needs `<item-id>`
 * (sourceId is inferred from the loaded item).
 */
async function findItem(cwd: string, itemId: string): Promise<{ item: Item } | null> {
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) return null;
  const items = await loadItems(itemsDir);
  const match = items.find((i) => i.id === itemId);
  if (!match) return null;
  return { item: match };
}

/**
 * Implementation of `radar dismiss <item-id>`.
 *
 * Triggers the `detected → dismissed` state transition (ADR-0008). The command
 * is intentionally agent-free: it only mutates `items/<sourceId>/<item-id>.yaml`
 * so users can prune noise from `watch run` output without spending agent
 * tokens.
 *
 * Flow:
 *   1. Parse + validate args.
 *   2. Locate `items/<sourceId>/<item-id>.yaml`.
 *   3. Reject if the item is not in `detected` (terminal/researched states
 *      cannot be dismissed; there is no `undismiss`).
 *   4. Write back with `status: dismissed`.
 */
export async function runDismiss(
  args: string[],
  options: DismissCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: DismissArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    error(`dismiss: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(log);
    return 0;
  }
  if (!parsed.itemId) {
    error("dismiss: missing <item-id>");
    printHelp(error);
    return 2;
  }

  const found = await findItem(cwd, parsed.itemId);
  if (!found) {
    error(`dismiss: item '${parsed.itemId}' not found under items/`);
    return 1;
  }
  const { item } = found;

  if (item.status !== "detected") {
    error(
      `dismiss: item '${item.id}' is in status '${item.status}', expected 'detected' (dismiss is only valid from the detected state; ADR-0008)`,
    );
    return 1;
  }

  const updated: Item = { ...item, status: "dismissed" };
  try {
    // saveItems writes by sourceId+id, so it overwrites the existing file in
    // place. The status transition is the entire effect of the command.
    await saveItems(join(cwd, "items"), [updated]);
  } catch (e) {
    error(`dismiss: failed to update item status: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  log(`dismiss: items/${item.sourceId}/${item.id}.yaml status -> dismissed`);
  return 0;
}

export const dismissCommand: Command = {
  name: "dismiss",
  summary: "Mark a detected item as dismissed (no research/review)",
  run: (args) => runDismiss(args),
};
