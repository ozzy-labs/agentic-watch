---
name: dismiss
description: Mark detected items as dismissed (no research/review) via the FeedRadar CLI. Accepts one or more ids, or --batch.
argument-hint: <item-id> [<item-id> ...] | --batch [--status <status>] [--filter-tags <list>] [--max-items N]
---

# dismiss

Transition workspace items' `status` to `dismissed`, indicating the user has
decided not to research them. Valid only from `detected` or `triaged_unsure`
(ADR-0008 / ADR-0018): items already in `researched` / `reviewed` /
`dismissed` / `triaged_research` / `triaged_digest` cannot be dismissed.

Supports one id, multiple ids (`radar dismiss a b c`), or `--batch` selection
by `--status` / `--filter-tags` / `--max-items` — useful for clearing a large
`detected` backlog produced by `radar watch run --backfill`.

This skill is a thin wrapper around the `radar dismiss` CLI command.
No agent invocation is involved — the CLI just rewrites the
`items/<sourceId>/<item-id>.yaml` file in place.

## Steps

1. Resolve `$ARGUMENTS`. If empty or `--help`, run:

   ```bash
   radar dismiss --help
   ```

   and report the usage. Otherwise pass `$ARGUMENTS` through verbatim.
2. Execute:

   ```bash
   radar dismiss $ARGUMENTS
   ```

3. Report the status transition (`<item-id> status -> dismissed`, one line per
   item) or the user-friendly error if an item is in a non-dismissible status
   (e.g. `status 'researched' ... expected one of detected | triaged_unsure`).

## Notes

- A dismissed item can be re-opened with `radar undismiss <item-id> [--force]`
  (ADR-0018 §W6): triage-origin dismisses revert silently, human-origin ones
  require `--force`.
- For multiple ids the call is all-or-nothing: if any id is missing or in a
  non-dismissible status, nothing is written.
