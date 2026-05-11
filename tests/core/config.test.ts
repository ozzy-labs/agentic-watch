import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  getDefaultAgent,
  HARDCODED_DEFAULT_AGENT,
  loadRadarConfig,
  RadarConfigError,
} from "../../src/core/config.js";

async function makeWorkspace(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentic-watch-config-"));
  if (content !== undefined) {
    await writeFile(join(dir, CONFIG_FILENAME), content, "utf8");
  }
  return dir;
}

describe("core/config :: loadRadarConfig", () => {
  it("returns an empty config when radar.config.yaml is missing", async () => {
    const dir = await makeWorkspace();
    const config = await loadRadarConfig(dir);
    expect(config).toEqual({});
  });

  it("parses both default agents from a well-formed config", async () => {
    const dir = await makeWorkspace(
      "defaultResearchAgent: codex-cli\ndefaultReviewAgent: claude-code\n",
    );
    const config = await loadRadarConfig(dir);
    expect(config).toEqual({
      defaultResearchAgent: "codex-cli",
      defaultReviewAgent: "claude-code",
    });
  });

  it("normalizes an empty file to an empty config (no fields)", async () => {
    const dir = await makeWorkspace("");
    const config = await loadRadarConfig(dir);
    expect(config).toEqual({});
  });

  it("throws RadarConfigError on unknown agent id", async () => {
    const dir = await makeWorkspace("defaultResearchAgent: nope\n");
    await expect(loadRadarConfig(dir)).rejects.toBeInstanceOf(RadarConfigError);
    await expect(loadRadarConfig(dir)).rejects.toThrow(/defaultResearchAgent/);
  });

  it("throws RadarConfigError on malformed YAML", async () => {
    // Unbalanced `[` is a YAML parse error, not a schema error — the loader
    // should still surface it as a RadarConfigError so the CLI can map it to
    // exit code 2 uniformly.
    const dir = await makeWorkspace("defaultResearchAgent: [unclosed\n");
    await expect(loadRadarConfig(dir)).rejects.toBeInstanceOf(RadarConfigError);
    await expect(loadRadarConfig(dir)).rejects.toThrow(/parse/);
  });

  it("accepts a partial config (only one field set)", async () => {
    const dir = await makeWorkspace("defaultReviewAgent: gemini-cli\n");
    const config = await loadRadarConfig(dir);
    expect(config).toEqual({ defaultReviewAgent: "gemini-cli" });
    expect(config.defaultResearchAgent).toBeUndefined();
  });
});

describe("core/config :: getDefaultAgent", () => {
  it("honors explicit --agent over config and hard-coded default", async () => {
    const dir = await makeWorkspace("defaultResearchAgent: gemini-cli\n");
    const agent = await getDefaultAgent("research", { explicit: "codex-cli", cwd: dir });
    expect(agent).toBe("codex-cli");
  });

  it("falls back to config default when --agent is omitted", async () => {
    const dir = await makeWorkspace("defaultResearchAgent: codex-cli\n");
    const agent = await getDefaultAgent("research", { cwd: dir });
    expect(agent).toBe("codex-cli");
  });

  it("falls back to hard-coded default when neither --agent nor config is set", async () => {
    const dir = await makeWorkspace();
    const agent = await getDefaultAgent("research", { cwd: dir });
    expect(agent).toBe(HARDCODED_DEFAULT_AGENT);
    expect(agent).toBe("claude-code");
  });

  it("falls back to hard-coded default when config has the OTHER command's field only", async () => {
    // defaultReviewAgent is set but research is queried -> hard-coded default.
    const dir = await makeWorkspace("defaultReviewAgent: codex-cli\n");
    const agent = await getDefaultAgent("research", { cwd: dir });
    expect(agent).toBe("claude-code");
  });

  it("resolves review command independently from research command", async () => {
    const dir = await makeWorkspace(
      "defaultResearchAgent: codex-cli\ndefaultReviewAgent: gemini-cli\n",
    );
    const review = await getDefaultAgent("review", { cwd: dir });
    const research = await getDefaultAgent("research", { cwd: dir });
    expect(review).toBe("gemini-cli");
    expect(research).toBe("codex-cli");
  });

  it("uses configOverride when supplied (skips disk read)", async () => {
    // No config file on disk; passing an override should still pick it up.
    const dir = await makeWorkspace();
    const agent = await getDefaultAgent("research", {
      cwd: dir,
      configOverride: { defaultResearchAgent: "copilot" },
    });
    expect(agent).toBe("copilot");
  });

  it("propagates RadarConfigError when config is malformed", async () => {
    const dir = await makeWorkspace("defaultResearchAgent: not-a-known-agent\n");
    await expect(getDefaultAgent("research", { cwd: dir })).rejects.toBeInstanceOf(
      RadarConfigError,
    );
  });
});
