---
name: research
description: Generate a research report for a detected item via the FeedRadar CLI.
argument-hint: <item-id> [--agent claude-code|codex-cli|gemini-cli|copilot] [--template <id>] [--emit-payload]
---

# research

Generate a Markdown research report for an `radar` workspace item.

This skill is a thin wrapper: it delegates to the `radar` CLI, which
handles item lookup, template loading, adapter dispatch (spawning the chosen
agent CLI), schema validation, and the `detected → researched` status
transition. The canonical research procedure (frontmatter format, body
layout, `<untrusted_item>` boundary handling) lives in
`.agents/skills/research/SKILL.md` (the SSoT) and is invoked by the agent
adapter that the CLI spawns. Do not duplicate that procedure here.

## Steps

1. Resolve `$ARGUMENTS`. If empty or `--help`, run:

   ```bash
   radar research --help
   ```

   and report the usage. Otherwise pass `$ARGUMENTS` through verbatim.
2. Execute:

   ```bash
   radar research $ARGUMENTS
   ```

3. Report the resulting research file path (printed on stdout by the CLI as
   `research: wrote <path>` and `research: <item-id> status -> researched`)
   and surface any stderr to the user.

### Host-agent mode (opt-in)

Only when the user **explicitly chooses host mode** (otherwise use the
default spawn flow above). Instead of letting the CLI spawn an agent, run the
research procedure yourself in this session:

1. Run `radar research <id> --emit-payload`. The CLI prints the research
   payload to stdout instead of spawning an agent.
2. Read the payload, then perform the research procedure yourself by
   following the engine SKILL at `.agents/skills/research/SKILL.md` (the
   SSoT) — using the `templateBody` / `items` / `outputPath` from the
   payload.
3. Write the Markdown report to the payload's `outputPath`.
4. Run `radar research --commit <path>`. The CLI validates the frontmatter
   and performs the `detected → researched` transition.

## Notes

- If the CLI exits non-zero (item not found, schema validation, adapter
  failure), surface the error message and exit code; do not retry blindly.
- Cross-review with a different agent is recommended (ADR-0001 / user-guide
  §クロスエージェント運用). After this skill produces `research/<id>.md`, the
  user typically follows up with `/review <id> --agent <different-agent>`.
- The CLI's default agent is `claude-code`; override with `--agent`.
- Host-agent mode (`--emit-payload` + `--commit`) is an interactive-only
  opt-in; CI / headless runs MUST use the default spawn flow. In host mode
  untrusted item content enters this interactive session itself, so strictly
  follow the engine SKILL's M2a / M2b / M3b untrusted-content boundary rules.
