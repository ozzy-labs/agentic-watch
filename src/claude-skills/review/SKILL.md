---
name: review
description: Cross-review an existing research report with a different agent via the FeedRadar CLI.
argument-hint: <research-id> [--agent claude-code|codex-cli|gemini-cli|copilot] [--template <id>]
---

# review

Append a review block to an existing `research/<id>.md` and stamp the
frontmatter `reviewedAt` / `reviewedBy` fields.

This skill is a thin wrapper: it delegates to the `radar` CLI, which
handles research file resolution, template loading, adapter dispatch, schema
validation, and the `researched → reviewed` status transition. The canonical
review procedure (rubric, where the review block lands, frontmatter stamp
format) lives in `.agents/skills/review/SKILL.md` (the SSoT) and is invoked
by the agent adapter that the CLI spawns. Do not duplicate that procedure
here.

## Steps

1. Resolve `$ARGUMENTS`. If empty or `--help`, run:

   ```bash
   radar review --help
   ```

   and report the usage. Otherwise pass `$ARGUMENTS` through verbatim.
2. Execute:

   ```bash
   radar review $ARGUMENTS
   ```

3. Report the result: the CLI prints the research path it updated and the
   item status transition (`status -> reviewed`).

## Notes

- For meaningful cross-checking, pick `--agent` different from the one that
  wrote the original v1 (ADR-0001 § クロスエージェント運用). Example: if v1
  was authored by `claude-code`, run review with `--agent codex-cli` or
  `--agent gemini-cli`.
- If the CLI exits non-zero, surface the error and exit code; do not retry
  with a different agent without user direction.
