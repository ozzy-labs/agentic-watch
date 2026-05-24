/**
 * `radar routine fire <trig_id>` — trigger a Claude Routine from the outside
 * via the `/fire` API (ADR-0020 §「外部からの起動」; epic #277 / #282).
 *
 * The `/fire` endpoint creates a routine session and returns immediately — it
 * does NOT wait for the session to finish. The optional `--text` body is a
 * free-form string passed to the session as launch context; the API does not
 * parse it. Each routine has its own per-routine bearer token, issued ONCE in
 * the Web UI (shown a single time; Regenerate / Revoke from there). The token
 * is read from the environment and is NEVER printed to logs.
 */

/** Minimal `fetch` surface we depend on (request → response with json/text). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/**
 * Sinks for user-facing output. Mirrors `RoutineIO` in the generate commands;
 * the CLI binds these to `console.*`, tests inject capturing sinks.
 */
export interface RoutineIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Base URL of the Anthropic API. Exposed as a constant (not hardcoded inline)
 * so the fire URL stays in one place and tests can assert against it.
 */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com";

/** Beta header gating the experimental Claude Code routines surface. */
export const ROUTINE_FIRE_BETA = "experimental-cc-routine-2026-04-01";

/** Anthropic API version pin (stable date-versioned API). */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Default env var holding the per-routine `/fire` bearer token. */
export const DEFAULT_FIRE_TOKEN_ENV = "FEEDRADAR_ROUTINE_FIRE_TOKEN";

/**
 * Routine ids issued by the Web UI carry a `trig_` prefix. We validate the
 * shape before composing the URL so a typo'd id fails fast with a clear
 * message instead of a 404 from the server.
 */
export function isValidRoutineId(id: string): boolean {
  return /^trig_[A-Za-z0-9._-]+$/.test(id);
}

export interface FireRoutineOptions {
  /** Routine id (must start with `trig_`). */
  routineId: string;
  /** Per-routine bearer token. NEVER logged. */
  token: string;
  /** Optional free-form launch context passed as the request body `text`. */
  text?: string;
  /** Test seam: override the API base URL. */
  apiBase?: string;
  /** Test seam: inject a `fetch` implementation. */
  fetch?: FetchLike;
}

export interface FireRoutineResult {
  /** HTTP status of the `/fire` response. */
  status: number;
  /** Parsed JSON body if the response was JSON, else the raw text. */
  body: unknown;
}

/**
 * POST to `/v1/claude_code/routines/{trig_id}/fire`.
 *
 * The endpoint returns as soon as the session is created (it does not wait for
 * completion). On a non-2xx status this throws with the status text; the token
 * is never included in any error or log.
 */
export async function fireRoutine(options: FireRoutineOptions): Promise<FireRoutineResult> {
  const { routineId, token, text } = options;
  const apiBase = options.apiBase ?? ANTHROPIC_API_BASE;
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);

  if (!isValidRoutineId(routineId)) {
    throw new Error(
      `invalid routine id '${routineId}' (expected a Web UI id starting with 'trig_')`,
    );
  }
  if (token.trim().length === 0) {
    throw new Error("missing per-routine fire token");
  }

  const url = `${apiBase}/v1/claude_code/routines/${routineId}/fire`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ROUTINE_FIRE_BETA,
    "content-type": "application/json",
  };

  // The `text` body is free-form launch context; the API does not parse it.
  // Always send a JSON object so the content-type matches even when empty.
  const body = JSON.stringify(text === undefined ? {} : { text });

  const response = await fetchImpl(url, { method: "POST", headers, body });

  // Read the body once regardless of status so error and success paths share
  // the same parse and we can surface server detail without leaking the token.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = await response.text().catch(() => "");
  }

  if (!response.ok) {
    const detail =
      typeof parsed === "string" && parsed.length > 0
        ? `: ${parsed}`
        : parsed && typeof parsed === "object"
          ? `: ${JSON.stringify(parsed)}`
          : "";
    throw new Error(`fire failed (HTTP ${response.status} ${response.statusText})${detail}`);
  }

  return { status: response.status, body: parsed };
}

interface ParsedFlags {
  routineId?: string;
  text?: string;
  tokenEnv: string;
  help: boolean;
}

/**
 * Parse `routine fire <trig_id> [--text <msg>] [--token-env <NAME>]`.
 *
 * The routine id is a positional argument (the first non-flag token). A
 * `--token-env` override lets a user point at a differently-named env var when
 * juggling multiple routines, but the value is ALWAYS read from the
 * environment — never accepted as a CLI flag (which would leak into process
 * listings / shell history).
 */
export function parseFireRoutineArgs(args: string[]): ParsedFlags {
  let routineId: string | undefined;
  let text: string | undefined;
  let tokenEnv = DEFAULT_FIRE_TOKEN_ENV;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "--text") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      text = value;
      continue;
    }
    if (a === "--token-env") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      tokenEnv = value;
      continue;
    }
    if (a === "--token") {
      // Refuse a token on the command line: it would leak into `ps` output and
      // shell history. Direct the user to the env-var path instead.
      throw new Error(
        "refusing --token on the command line (it leaks via process listing / shell history); " +
          `set the token in the ${DEFAULT_FIRE_TOKEN_ENV} env var (or use --token-env <NAME>)`,
      );
    }
    if (a?.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (routineId !== undefined) {
      throw new Error(`unexpected positional argument: ${a}`);
    }
    routineId = a;
  }

  return { routineId, text, tokenEnv, help };
}

export function printFireRoutineHelp(log: (m: string) => void): void {
  log("Usage: radar routine fire <trig_id> [options]");
  log("");
  log("Triggers a registered Claude Code Routine from the outside via the");
  log("/fire API. The call returns as soon as the routine session");
  log("is created — it does NOT wait for the session to finish.");
  log("");
  log("Arguments:");
  log("  <trig_id>             Routine id from the Web UI (starts with 'trig_')");
  log("");
  log("Options:");
  log("  --text <msg>          Free-form launch context (request body `text`).");
  log("                        The API does not parse it; it is passed as-is.");
  log(`  --token-env <NAME>    Env var holding the per-routine bearer token`);
  log(`                        (default: ${DEFAULT_FIRE_TOKEN_ENV}).`);
  log("");
  log("The per-routine token is issued ONCE in the Web UI (Regenerate / Revoke");
  log("there) and is read from the environment — it is never accepted as a flag");
  log("and never printed.");
}

/**
 * Entry point invoked by `runRoutine` when the user types
 * `radar routine fire`. Reads the token from the environment (never a flag,
 * never logged) and POSTs to `/fire`.
 */
export async function runFireRoutine(
  args: string[],
  io: RoutineIO = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<number> {
  const log = io.log ?? ((m: string) => console.log(m));
  const error = io.error ?? ((m: string) => console.error(m));

  let parsed: ParsedFlags;
  try {
    parsed = parseFireRoutineArgs(args);
  } catch (e) {
    error(`routine fire: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printFireRoutineHelp(log);
    return 0;
  }
  if (!parsed.routineId) {
    error("routine fire: missing <trig_id> argument (the routine id from the Web UI)");
    printFireRoutineHelp(error);
    return 2;
  }

  const token = env[parsed.tokenEnv];
  if (!token || token.trim().length === 0) {
    error(
      `routine fire: no token in ${parsed.tokenEnv}. ` +
        `Issue a per-routine token in the Web UI and export it, e.g. ` +
        `export ${parsed.tokenEnv}='...'`,
    );
    return 2;
  }

  try {
    const result = await fireRoutine({
      routineId: parsed.routineId,
      token,
      text: parsed.text,
      fetch: fetchImpl,
    });
    log(`routine fire: triggered ${parsed.routineId} (HTTP ${result.status}).`);
    log("The session was created — this call does not wait for it to finish.");
    return 0;
  } catch (e) {
    error(`routine fire: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
