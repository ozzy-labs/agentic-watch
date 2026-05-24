import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_API_BASE,
  ANTHROPIC_VERSION,
  DEFAULT_FIRE_TOKEN_ENV,
  type FetchLike,
  fireRoutine,
  isValidRoutineId,
  parseFireRoutineArgs,
  ROUTINE_FIRE_BETA,
  runFireRoutine,
} from "../../src/cli/routine/fire.js";
import { runRoutine } from "../../src/cli/routine.js";

/**
 * Coverage for `radar routine fire <trig_id>` (ADR-0020 /fire connector / #282).
 * Mirrors `routine-generate-watch.test.ts`: id validation, arg parser,
 * the fetch-mocked POST contract (URL / headers / body), the token-never-logged
 * invariant, and dispatcher integration.
 */

/** Build a stub `fetch` that records its single call and returns a canned response. */
function stubFetch(
  response: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  } = {},
): { fetch: FetchLike; calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      json: response.json ?? (async () => ({ session_id: "ses_123" })),
      text: response.text ?? (async () => ""),
    };
  };
  return { fetch, calls };
}

describe("cli/routine/fire", () => {
  describe("isValidRoutineId", () => {
    it("accepts trig_-prefixed ids", () => {
      expect(isValidRoutineId("trig_abc123")).toBe(true);
      expect(isValidRoutineId("trig_AbC-1.2_3")).toBe(true);
    });

    it("rejects ids without the trig_ prefix or empty", () => {
      expect(isValidRoutineId("abc123")).toBe(false);
      expect(isValidRoutineId("trig_")).toBe(false);
      expect(isValidRoutineId("")).toBe(false);
      expect(isValidRoutineId("ses_123")).toBe(false);
    });
  });

  describe("parseFireRoutineArgs", () => {
    it("parses the positional routine id", () => {
      const parsed = parseFireRoutineArgs(["trig_abc"]);
      expect(parsed.routineId).toBe("trig_abc");
      expect(parsed.text).toBeUndefined();
      expect(parsed.tokenEnv).toBe(DEFAULT_FIRE_TOKEN_ENV);
    });

    it("parses --text and --token-env", () => {
      const parsed = parseFireRoutineArgs([
        "trig_abc",
        "--text",
        "kick off now",
        "--token-env",
        "MY_TOKEN",
      ]);
      expect(parsed.text).toBe("kick off now");
      expect(parsed.tokenEnv).toBe("MY_TOKEN");
    });

    it("flags --help", () => {
      expect(parseFireRoutineArgs(["--help"]).help).toBe(true);
    });

    it("refuses --token on the command line (leak prevention)", () => {
      expect(() => parseFireRoutineArgs(["trig_abc", "--token", "secret"])).toThrow(
        /refusing --token/,
      );
    });

    it("rejects unknown options and extra positionals", () => {
      expect(() => parseFireRoutineArgs(["trig_abc", "--bogus"])).toThrow(/unknown option/);
      expect(() => parseFireRoutineArgs(["trig_a", "trig_b"])).toThrow(/unexpected positional/);
      expect(() => parseFireRoutineArgs(["trig_abc", "--text"])).toThrow(/requires a value/);
    });
  });

  describe("fireRoutine (fetch-mocked POST contract)", () => {
    it("POSTs to /v1/claude_code/routines/{id}/fire with the required headers", async () => {
      const { fetch, calls } = stubFetch();
      const result = await fireRoutine({ routineId: "trig_abc", token: "sk-rt-xyz", fetch });

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.url).toBe(`${ANTHROPIC_API_BASE}/v1/claude_code/routines/trig_abc/fire`);
      expect(call?.init?.method).toBe("POST");
      expect(call?.init?.headers?.authorization).toBe("Bearer sk-rt-xyz");
      expect(call?.init?.headers?.["anthropic-version"]).toBe(ANTHROPIC_VERSION);
      expect(call?.init?.headers?.["anthropic-beta"]).toBe(ROUTINE_FIRE_BETA);
      expect(call?.init?.headers?.["content-type"]).toBe("application/json");
      // No --text: empty JSON object body.
      expect(call?.init?.body).toBe("{}");
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ session_id: "ses_123" });
    });

    it("passes --text through as the free-form request body", async () => {
      const { fetch, calls } = stubFetch();
      await fireRoutine({ routineId: "trig_abc", token: "tok", text: "launch context", fetch });
      expect(calls[0]?.init?.body).toBe(JSON.stringify({ text: "launch context" }));
    });

    it("honors an apiBase override", async () => {
      const { fetch, calls } = stubFetch();
      await fireRoutine({
        routineId: "trig_abc",
        token: "tok",
        apiBase: "https://example.test",
        fetch,
      });
      expect(calls[0]?.url).toBe("https://example.test/v1/claude_code/routines/trig_abc/fire");
    });

    it("rejects an invalid routine id before calling fetch", async () => {
      const { fetch, calls } = stubFetch();
      await expect(fireRoutine({ routineId: "abc", token: "tok", fetch })).rejects.toThrow(
        /invalid routine id/,
      );
      expect(calls).toHaveLength(0);
    });

    it("rejects an empty token before calling fetch", async () => {
      const { fetch, calls } = stubFetch();
      await expect(fireRoutine({ routineId: "trig_abc", token: "  ", fetch })).rejects.toThrow(
        /missing per-routine fire token/,
      );
      expect(calls).toHaveLength(0);
    });

    it("throws with server detail on a non-2xx response (token not leaked)", async () => {
      const { fetch } = stubFetch({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({ error: { message: "routine not found" } }),
      });
      await expect(
        fireRoutine({ routineId: "trig_missing", token: "super-secret", fetch }),
      ).rejects.toThrow(/HTTP 404 Not Found/);
      await expect(
        fireRoutine({ routineId: "trig_missing", token: "super-secret", fetch }),
      ).rejects.not.toThrow(/super-secret/);
    });
  });

  describe("runFireRoutine (entry point)", () => {
    let logs: string[];
    let errors: string[];

    beforeEach(() => {
      logs = [];
      errors = [];
    });

    function io() {
      return { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
    }

    it("reads the token from the env and fires (exit 0), never logging it", async () => {
      const { fetch, calls } = stubFetch();
      const code = await runFireRoutine(
        ["trig_abc", "--text", "go"],
        io(),
        { [DEFAULT_FIRE_TOKEN_ENV]: "tok-secret-value" },
        fetch,
      );
      expect(code, `errors: ${errors.join("\n")}`).toBe(0);
      expect(calls[0]?.init?.headers?.authorization).toBe("Bearer tok-secret-value");
      const all = [...logs, ...errors].join("\n");
      expect(all).not.toContain("tok-secret-value");
      expect(logs.join("\n")).toContain("triggered trig_abc");
    });

    it("supports a --token-env override", async () => {
      const { fetch, calls } = stubFetch();
      const code = await runFireRoutine(
        ["trig_abc", "--token-env", "ALT_TOKEN"],
        io(),
        { ALT_TOKEN: "alt-value" },
        fetch,
      );
      expect(code).toBe(0);
      expect(calls[0]?.init?.headers?.authorization).toBe("Bearer alt-value");
    });

    it("errors (exit 2) when the token env var is unset", async () => {
      const fetchSpy = vi.fn();
      const code = await runFireRoutine(["trig_abc"], io(), {}, fetchSpy as unknown as FetchLike);
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain(DEFAULT_FIRE_TOKEN_ENV);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("errors (exit 2) when the routine id is missing", async () => {
      const code = await runFireRoutine([], io(), { [DEFAULT_FIRE_TOKEN_ENV]: "tok" });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("missing <trig_id>");
    });

    it("prints help (exit 0)", async () => {
      const code = await runFireRoutine(["--help"], io(), {});
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("radar routine fire <trig_id>");
    });

    it("returns exit 1 on an HTTP failure", async () => {
      const { fetch } = stubFetch({ ok: false, status: 401, statusText: "Unauthorized" });
      const code = await runFireRoutine(
        ["trig_abc"],
        io(),
        { [DEFAULT_FIRE_TOKEN_ENV]: "tok" },
        fetch,
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("HTTP 401");
    });
  });

  describe("runRoutine dispatcher integration", () => {
    it("lists the fire subcommand in routine help", async () => {
      const logs: string[] = [];
      const code = await runRoutine([], { io: { log: (m) => logs.push(m) } });
      expect(code).toBe(2);
      expect(logs.join("\n")).toContain("fire <trig_id>");
    });

    it("routes `fire --help` through the dispatcher (exit 0)", async () => {
      const logs: string[] = [];
      const code = await runRoutine(["fire", "--help"], { io: { log: (m) => logs.push(m) } });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("radar routine fire <trig_id>");
    });
  });
});
