import { z } from "zod";
import { AgentIdSchema } from "./research.js";

/**
 * Schema for `radar.config.yaml`, the workspace-level configuration file
 * placed at the workspace root (next to `sources/`, `items/`, etc.).
 *
 * Fields are intentionally minimal in Phase 2; the config is designed to grow
 * one field at a time as new defaults are needed (per [#25] Phase 2 epic).
 *
 * - `defaultResearchAgent`: agent used when `radar research` is run
 *   without an explicit `--agent`. Falls through to the hard-coded default
 *   (`claude-code`) when unset.
 * - `defaultReviewAgent`: same idea for `radar review`.
 *
 * Out-of-scope (tracked separately):
 *   - default agent for `update` (Phase 5)
 *   - agent-specific knobs (timeout / API key / etc.)
 */
export const RadarConfigSchema = z.object({
  defaultResearchAgent: AgentIdSchema.optional(),
  defaultReviewAgent: AgentIdSchema.optional(),
});
export type RadarConfig = z.infer<typeof RadarConfigSchema>;

/**
 * The set of commands for which a default agent can be configured. New
 * commands are added here (rather than to a free-form `string`) so that the
 * resolver below stays exhaustive and TypeScript flags missing branches.
 */
export type ConfigurableCommand = "research" | "review";
