---
name: dismiss
description: Mark a detected item as dismissed (no research/review) via the FeedRadar CLI.
argument-hint: <item-id>
---

# dismiss

Transition a workspace item's `status` from `detected` to `dismissed`,
indicating the user has decided not to research it. This is a terminal state
(ADR-0008): items already in `researched` / `reviewed` cannot be dismissed.

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

3. Report the status transition (`<item-id> status -> dismissed`) or the
   user-friendly error if the item is already past `detected` (e.g.
   `status 'researched' ... expected 'detected'`).

## Notes

- `dismissed` is terminal: a dismissed item cannot be re-opened to
  `detected`. If the user wants to research the item later, they have to
  re-run `radar watch run` so the watcher re-detects it (the item
  must still be present in the upstream feed).
