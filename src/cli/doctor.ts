import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { loadRadarConfig, RadarConfigError } from "../core/config.js";
import { applyZodLocale } from "../core/locale.js";
import {
  CHROMIUM_MISSING_HINT,
  PLAYWRIGHT_MODULE_MISSING_HINT,
  type ProbeOptions,
  probePlaywright,
} from "../core/playwright-check.js";
import { detectProxyUrl, maskProxyUrl } from "../core/proxy.js";
import { loadSources } from "../core/watcher.js";
import { createTranslator, type Translator } from "../i18n/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";

/**
 * Sinks for the `doctor` command's user-facing output.
 *
 * Mirrors the per-command `IO` convention (see `dismiss.ts`, `watch.ts`): tests
 * inject capturing sinks so we can assert against the structured output without
 * touching real stdio.
 */
export interface DoctorIO {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface DoctorCommandOptions {
  cwd?: string;
  io?: DoctorIO;
  /**
   * Test seam: override the Playwright probe (lets the doctor test stub the
   * `import("playwright")` path without monkey-patching `node:module`).
   */
  probeOptions?: ProbeOptions;
  /**
   * Test seam: override `process.env` lookup so the test can compose a
   * deterministic environment without leaking through `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: override the `which`-style binary lookup (lets tests assert
   * the warn / error transitions for missing agent CLIs without depending on
   * what is actually installed on the host machine).
   */
  whichImpl?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  /**
   * Skip the live proxy healthcheck (default: run the check when a proxy is
   * detected). Off-line developer machines and CI jobs that intentionally
   * isolate the network want a deterministic doctor run without paying for
   * a network round-trip that is guaranteed to fail.
   */
  noProxyCheck?: boolean;
  /**
   * Test seam / wiring: inject the translator that renders the (user-facing)
   * diagnostic messages. When omitted, `runDoctorChecks` resolves the workspace
   * locale itself and builds one; `runDoctor` always passes its already-resolved
   * translator so flag/env/config resolution happens exactly once (#312).
   */
  t?: Translator;
  /**
   * Test seam: override `fetch` used by the proxy healthcheck so the test can
   * drive the 200 / 407 / TLS / ECONNREFUSED branches deterministically
   * without hitting api.github.com.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam: override the wall-clock used to measure the healthcheck
   * latency. Returns an elapsed-milliseconds reading; we don't accept a raw
   * clock function because vitest's `vi.useFakeTimers()` interferes with
   * `performance.now()` in surprising ways.
   */
  nowImpl?: () => number;
}

/**
 * Possible statuses for a single doctor check.
 *
 * - `ok`     — feature is fully functional.
 * - `warn`   — non-blocking issue (e.g. agent CLI missing — only matters if
 *              the user wants to use that specific agent).
 * - `error`  — blocking issue for an enabled feature (e.g. Chromium missing
 *              when an html-js source is configured).
 */
export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  /** Stable identifier for the check (used in tests + structured output). */
  id: string;
  /** Human-friendly status line for terminal output. */
  message: string;
  status: DoctorStatus;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Aggregated counts per status. */
  summary: { ok: number; warn: number; error: number };
}

/**
 * Agent CLIs the `doctor` command probes for. Order matches the AgentId enum
 * declaration so the output is deterministic across runs and easy to scan.
 *
 * The `binary` field is the executable name expected on $PATH. Whether the
 * user actually needs each binary depends on which agent they pick at
 * `research --agent <id>` time, so missing agents are reported as `warn`
 * (not `error`) — only the user knows which subset they use.
 */
const AGENT_BINARIES: ReadonlyArray<{ agent: string; binary: string }> = [
  { agent: "claude-code", binary: "claude" },
  { agent: "codex-cli", binary: "codex" },
  { agent: "gemini-cli", binary: "gemini" },
  { agent: "copilot", binary: "copilot" },
];

/**
 * Workspace directories `init` creates. We check for each so a user who ran
 * `radar source add ...` in a non-initialized directory gets a clear pointer
 * back to `radar init` rather than a cryptic ENOENT later.
 */
const WORKSPACE_DIRS = ["sources", "items", "state", "research", "templates"] as const;

/**
 * Public probe URL for the proxy healthcheck. api.github.com is reachable
 * from virtually every corporate proxy allowlist (since `gh` / `git` / npm
 * all depend on it), so a failure here is a strong signal that the proxy
 * config itself is broken rather than just missing this particular host.
 *
 * The check is informational only; doctor never escalates a failed
 * healthcheck to `error` because (a) the user might be running doctor
 * specifically because the network is down, and (b) a 407 from the proxy is
 * still a meaningful "proxy reachable, auth missing" state we want to
 * surface as a hint rather than block on.
 */
const PROXY_HEALTHCHECK_URL = "https://api.github.com/zen";

/**
 * Total upper bound on the healthcheck round-trip. Short enough that
 * `radar doctor` stays responsive on a broken proxy, long enough that a
 * slow corporate proxy still gets a chance to respond.
 */
const PROXY_HEALTHCHECK_TIMEOUT_MS = 5000;

/**
 * Node error codes that signal a TLS-intercepting proxy (e.g. Zscaler,
 * Netskope) replaced the leaf cert with its own CA. The fix is always
 * `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`, so we hint at that variable
 * in the doctor output.
 */
const TLS_INTERCEPT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default `which`-style lookup: walk `PATH` and return the first directory
 * containing an executable file named `binary`.
 *
 * We avoid invoking `which`/`where` itself because (a) it differs between
 * platforms (`where.exe` on Windows, `which` elsewhere), and (b) shelling out
 * for what is a simple filesystem walk pulls in process-spawn failure modes
 * (ENOENT for `which` on stripped-down container images, etc.) for no
 * benefit.
 */
async function defaultWhich(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathEnv = env.PATH ?? env.Path ?? "";
  if (!pathEnv) return undefined;
  const entries = pathEnv.split(delimiter).filter((p) => p.length > 0);
  for (const dir of entries) {
    const candidate = join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next directory.
    }
  }
  return undefined;
}

/**
 * Run all doctor checks and return a structured report.
 *
 * Exported separately from `runDoctor` so tests and downstream tooling can
 * consume the structured form without parsing the human-readable log.
 *
 * Check ordering matches the user's likely investigation order:
 *   1. Workspace directories (broken layout → nothing else matters).
 *   2. `radar.config.yaml` (loaders run on every command, so a malformed
 *      config blocks the whole CLI).
 *   3. Agent CLIs (research / review / update prerequisites).
 *   4. Playwright + Chromium (only when an html-js source is configured).
 */
export async function runDoctorChecks(options: DoctorCommandOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const whichImpl = options.whichImpl ?? defaultWhich;
  // Resolve the UI locale so the diagnostic lines are localized. doctor is a
  // user-facing health check (#312), so its check messages + summary go through
  // the translator. A test seam (`options.t`) lets callers inject a translator
  // directly; otherwise the locale is resolved from --lang / env / config.
  const t = options.t ?? createTranslator(await resolveWorkspaceLocale({ flag: undefined, cwd }));
  const checks: DoctorCheck[] = [];

  // 1. Workspace directories. Each missing dir is a `warn` — the user may
  //    not need every directory yet (e.g. `research/` is empty until after
  //    `radar research` runs), but the absence is a real signal that
  //    `radar init` was skipped or partially undone.
  for (const dir of WORKSPACE_DIRS) {
    const abs = join(cwd, dir);
    if (await pathExists(abs)) {
      checks.push({
        id: `workspace:${dir}`,
        status: "ok",
        message: t("cli.doctor.workspaceDirExists", { dir }),
      });
    } else {
      checks.push({
        id: `workspace:${dir}`,
        status: "warn",
        message: t("cli.doctor.workspaceDirMissing", { dir }),
      });
    }
  }

  // 2. `radar.config.yaml`. Absence is `ok` (the file is fully optional and
  //    every field has a built-in default). A schema violation is `error`
  //    because `radar` itself fails on every invocation when the config
  //    parses but mismatches the schema — see `core/config.ts#loadRadarConfig`.
  try {
    await loadRadarConfig(cwd, t);
    checks.push({
      id: "config",
      status: "ok",
      message: t("cli.doctor.configValid"),
    });
  } catch (e) {
    const reason = e instanceof RadarConfigError ? e.message : String(e);
    checks.push({
      id: "config",
      status: "error",
      message: t("cli.doctor.configInvalid", { reason }),
    });
  }

  // 3. Agent CLIs. Missing agents are `warn` only — a user who only runs
  //    `radar research --agent claude-code` does not care that `gemini` is
  //    absent. The check still surfaces every binary so the user can spot
  //    the one they actually need.
  for (const { agent, binary } of AGENT_BINARIES) {
    const found = await whichImpl(binary, env);
    if (found) {
      checks.push({
        id: `agent:${agent}`,
        status: "ok",
        message: t("cli.doctor.agentFound", { agent, binary, path: found }),
      });
    } else {
      checks.push({
        id: `agent:${agent}`,
        status: "warn",
        message: t("cli.doctor.agentMissing", { agent, binary }),
      });
    }
  }

  // 4. Playwright + Chromium. Only relevant when at least one source
  //    declares `kind: html-js`; otherwise the user does not need Playwright
  //    installed at all and a missing peer dep should not pollute the
  //    output. We load sources via `core/watcher#loadSources` so the kind
  //    detection matches what `watch run` actually iterates over.
  const sourcesDir = join(cwd, "sources");
  let htmlJsSources: string[] = [];
  if (await pathExists(sourcesDir)) {
    const sources = await loadSources(sourcesDir, () => {
      // Schema / read errors are surfaced separately via the workspace +
      // config checks above; here we only care about the kind distribution.
      // Silently dropping malformed YAMLs is fine for kind detection.
    });
    htmlJsSources = sources.filter((s) => s.kind === "html-js").map((s) => s.id);
  }
  if (htmlJsSources.length === 0) {
    checks.push({
      id: "playwright",
      status: "ok",
      message: t("cli.doctor.playwrightNotRequired"),
    });
  } else {
    const probe = await probePlaywright(options.probeOptions);
    if (probe.status === "ok") {
      checks.push({
        id: "playwright",
        status: "ok",
        message: t("cli.doctor.playwrightOk", { path: probe.executablePath }),
      });
    } else if (probe.status === "module-missing") {
      checks.push({
        id: "playwright",
        status: "error",
        message: t("cli.doctor.playwrightModuleMissing", {
          sources: htmlJsSources.join(", "),
          hint: PLAYWRIGHT_MODULE_MISSING_HINT,
        }),
      });
    } else {
      checks.push({
        id: "playwright",
        status: "error",
        message: t("cli.doctor.playwrightChromiumMissing", {
          path: probe.executablePath,
          sources: htmlJsSources.join(", "),
          hint: CHROMIUM_MISSING_HINT,
        }),
      });
    }
  }

  // 5. Proxy + TLS environment. Surfaces three signals so users can debug
  //    "fetch works on my laptop but not behind the corp proxy" style issues:
  //
  //    - `proxy:env`       — which env var is providing the proxy URL (and
  //                          confirms credentials are masked in our output).
  //    - `proxy:active`    — whether `NODE_USE_ENV_PROXY` is engaged (the
  //                          self-respawn path sets it; an external invoker
  //                          that bypassed our entry-point won't).
  //    - `tls:ca`          — `NODE_EXTRA_CA_CERTS` status. TLS-intercepting
  //                          proxies require a custom CA bundle, and the
  //                          symptom (UNABLE_TO_VERIFY_LEAF_SIGNATURE) is
  //                          opaque enough to justify a dedicated check.
  //    - `proxy:healthcheck` — a real HTTPS round-trip via the configured
  //                          proxy. Skipped when no proxy is detected (no
  //                          point) or when `--no-proxy-check` is set.
  const proxyDetection = detectProxyUrl(env);
  if (proxyDetection) {
    const masked = maskProxyUrl(proxyDetection.url);
    if (proxyDetection.allProxyOnly) {
      // ALL_PROXY alone won't engage `--use-env-proxy`; downgrade to warn so
      // the user notices and sets HTTPS_PROXY / HTTP_PROXY explicitly.
      checks.push({
        id: "proxy:env",
        status: "warn",
        message: t("cli.doctor.proxyEnvAllProxyOnly", { source: proxyDetection.source, masked }),
      });
    } else {
      checks.push({
        id: "proxy:env",
        status: "ok",
        message: t("cli.doctor.proxyEnvDetected", { source: proxyDetection.source, masked }),
      });
    }
  } else {
    checks.push({
      id: "proxy:env",
      status: "ok",
      message: t("cli.doctor.proxyEnvNone"),
    });
  }

  if (env.NODE_USE_ENV_PROXY === "1") {
    checks.push({
      id: "proxy:active",
      status: "ok",
      message: t("cli.doctor.proxyActive"),
    });
  } else if (proxyDetection && !proxyDetection.allProxyOnly) {
    // Proxy is set but the respawn sentinel is missing — usually means the
    // user invoked radar via a path that bypasses bin/index.js (e.g. a script
    // that imports the modules directly). Warn rather than error because
    // fetch may still work via other paths (e.g. user set `--use-env-proxy`
    // in NODE_OPTIONS themselves).
    checks.push({
      id: "proxy:active",
      status: "warn",
      message: t("cli.doctor.proxyActiveMissing"),
    });
  } else {
    checks.push({
      id: "proxy:active",
      status: "ok",
      message: t("cli.doctor.proxyActiveNotRequired"),
    });
  }

  const caBundle = env.NODE_EXTRA_CA_CERTS;
  if (caBundle && caBundle.length > 0) {
    checks.push({
      id: "tls:ca",
      status: "ok",
      message: t("cli.doctor.tlsCaSet", { path: caBundle }),
    });
  } else {
    checks.push({
      id: "tls:ca",
      status: "ok",
      message: t("cli.doctor.tlsCaUnset"),
    });
  }

  if (options.noProxyCheck) {
    checks.push({
      id: "proxy:healthcheck",
      status: "ok",
      message: t("cli.doctor.healthcheckSkippedFlag"),
    });
  } else if (!proxyDetection) {
    checks.push({
      id: "proxy:healthcheck",
      status: "ok",
      message: t("cli.doctor.healthcheckSkippedNoProxy"),
    });
  } else {
    const result = await runProxyHealthcheck(
      {
        fetchImpl: options.fetchImpl,
        nowImpl: options.nowImpl,
      },
      t,
    );
    checks.push(result);
  }

  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status]++;
      return acc;
    },
    { ok: 0, warn: 0, error: 0 },
  );
  return { checks, summary };
}

interface ProxyHealthcheckOptions {
  fetchImpl?: typeof fetch;
  nowImpl?: () => number;
}

/**
 * Single live HTTPS request through whatever proxy `fetch` picks up. We
 * deliberately do **not** thread a custom `dispatcher` through fetch here —
 * the goal is to mirror exactly what the rest of radar (and any of the
 * spawned agent CLIs) will experience. If the user's proxy is broken,
 * doctor's report should match.
 *
 * Branches:
 *   - 2xx response          → ok (records status code + latency)
 *   - 407 Proxy Auth Req    → warn (credentials missing/wrong; not radar's fault)
 *   - other 4xx/5xx         → warn (proxy reachable but endpoint rejected)
 *   - TLS-intercept errors  → error (hint NODE_EXTRA_CA_CERTS)
 *   - ECONNREFUSED / ENOTFOUND / abort timeout → error (proxy unreachable)
 */
async function runProxyHealthcheck(
  opts: ProxyHealthcheckOptions,
  t: Translator,
): Promise<DoctorCheck> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowImpl = opts.nowImpl ?? (() => performance.now());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_HEALTHCHECK_TIMEOUT_MS);
  const start = nowImpl();

  try {
    const res = await fetchImpl(PROXY_HEALTHCHECK_URL, {
      method: "GET",
      signal: controller.signal,
    });
    const elapsed = Math.round(nowImpl() - start);
    if (res.status === 407) {
      // 407 from the proxy itself; auth missing or wrong. We don't escalate to
      // error because radar can't tell the user's intended credential strategy.
      return {
        id: "proxy:healthcheck",
        status: "warn",
        message: t("cli.doctor.healthcheck407", { url: PROXY_HEALTHCHECK_URL }),
      };
    }
    if (res.status >= 200 && res.status < 300) {
      return {
        id: "proxy:healthcheck",
        status: "ok",
        message: t("cli.doctor.healthcheckOk", {
          status: res.status,
          statusText: res.statusText || "OK",
          elapsed,
        }),
      };
    }
    return {
      id: "proxy:healthcheck",
      status: "warn",
      message: t("cli.doctor.healthcheckOther", {
        status: res.status,
        statusText: res.statusText || "",
        elapsed,
      }),
    };
  } catch (err) {
    const elapsed = Math.round(nowImpl() - start);
    return classifyProxyError(err, elapsed, t);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Map a thrown fetch error onto a DoctorCheck with an actionable hint. We
 * inspect (a) the abort flag (timeout we control), (b) `error.code` /
 * `error.cause.code` (Node's network error pathway), and (c) the message
 * text as a last-resort heuristic. Unknown errors fall through to a generic
 * "healthcheck failed" line.
 */
function classifyProxyError(err: unknown, elapsedMs: number, t: Translator): DoctorCheck {
  if (err instanceof Error && err.name === "AbortError") {
    return {
      id: "proxy:healthcheck",
      status: "error",
      message: t("cli.doctor.healthcheckTimeout", { elapsed: elapsedMs }),
    };
  }

  // Node's fetch wraps the underlying network error inside `cause`. We unwrap
  // up to two levels so undici-style nested errors (TLS errors typically sit
  // at `cause.cause`) are still classified.
  const codes = collectErrorCodes(err);

  for (const code of codes) {
    if (TLS_INTERCEPT_CODES.has(code)) {
      return {
        id: "proxy:healthcheck",
        status: "error",
        message: t("cli.doctor.healthcheckTls", { code }),
      };
    }
    if (code === "ECONNREFUSED") {
      return {
        id: "proxy:healthcheck",
        status: "error",
        message: t("cli.doctor.healthcheckRefused"),
      };
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return {
        id: "proxy:healthcheck",
        status: "error",
        message: t("cli.doctor.healthcheckDns", { code }),
      };
    }
    if (code === "ECONNRESET" || code === "ETIMEDOUT") {
      return {
        id: "proxy:healthcheck",
        status: "error",
        message: t("cli.doctor.healthcheckResetTimeout", { code }),
      };
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    id: "proxy:healthcheck",
    status: "error",
    message: t("cli.doctor.healthcheckFailed", { reason: message }),
  };
}

/**
 * Walk an Error chain (`err.cause` → `err.cause.cause`) and collect any
 * `code` properties along the way. Node's fetch error structure varies by
 * release; treating it as an opaque chain avoids brittle version-pinning.
 */
function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current && typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
    }
    if (current && typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return codes;
}

interface DoctorArgs {
  help?: boolean;
  noProxyCheck?: boolean;
}

function parseDoctorArgs(args: string[]): DoctorArgs {
  const out: DoctorArgs = {};
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--no-proxy-check") {
      out.noProxyCheck = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return out;
}

function printDoctorHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.doctor.help"));
}

/**
 * Implementation of `radar doctor`.
 *
 * Returns 0 if no checks are at `error` status (warnings still pass — they
 * indicate optional dependencies / partial workspace state). Returns 1 if
 * any check is `error` so CI / scripts can gate on a clean doctor run.
 */
export async function runDoctor(
  args: string[],
  options: DoctorCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Strip `--lang <en|ja>` before `parseDoctorArgs` (which rejects unknown
  // flags), then resolve the UI locale for the help text.
  let langState: ReturnType<typeof parseLangFlag>;
  try {
    langState = parseLangFlag(args);
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`doctor: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const locale = await resolveWorkspaceLocale({ flag: langState.flag, cwd, warn: error });
  // Localize zod's built-in messages so the `radar.config.yaml` schema-violation
  // issue bodies (rendered inside `cli.doctor.configInvalid`) follow the UI
  // locale alongside the wrapping preamble (#312).
  applyZodLocale(locale);
  const t = createTranslator(locale);

  let parsed: DoctorArgs;
  try {
    parsed = parseDoctorArgs(langState.rest);
  } catch (e) {
    error(`doctor: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printDoctorHelp(t, log);
    return 0;
  }

  // CLI flag wins over the option seam. Tests typically pass `noProxyCheck`
  // through `options`; users pass `--no-proxy-check`. OR semantics mean either
  // path can opt out without the other interfering. Pass the already-resolved
  // translator so locale resolution happens exactly once (#312).
  const report = await runDoctorChecks({
    ...options,
    t,
    noProxyCheck: options.noProxyCheck ?? parsed.noProxyCheck,
  });
  for (const check of report.checks) {
    const tag =
      check.status === "ok" ? "[ok]   " : check.status === "warn" ? "[warn]  " : "[error]";
    log(`${tag} ${check.message}`);
  }
  log("");
  log(
    t("cli.doctor.summary", {
      ok: report.summary.ok,
      warn: report.summary.warn,
      error: report.summary.error,
    }),
  );
  return report.summary.error > 0 ? 1 : 0;
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Diagnose workspace, agent CLIs, and html-js Playwright install",
  summaryKey: "cli.summary.doctor",
  run: (args) => runDoctor(args),
};
