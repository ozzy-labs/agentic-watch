/**
 * English message catalog — the source of truth for the i18n layer (ADR-0021,
 * epic #307 P2).
 *
 * `en` defines the canonical key set and value shapes; every other locale
 * catalog (currently {@link import("./ja.js").ja}) is required by the
 * {@link Messages} type to mirror these keys exactly. A value is either:
 *
 *   - a plain `string` (no interpolation), or
 *   - a function `(params) => string` that receives a typed params object and
 *     returns the rendered string.
 *
 * The function form is the single, unified interpolation scheme for this layer
 * (no `{name}` placeholder string-replacement, no template engine, no new
 * runtime dependency): parameters are ordinary typed function arguments, so a
 * missing or misspelled param is a *compile* error, and `createTranslator`'s
 * `t(key, params?)` signature can derive its param type straight from the
 * catalog entry.
 *
 * Keys are namespaced by domain (`common.*`, `cli.*`) to keep future additions
 * collision-free as later P3/P4/P5 issues add their own message families. This
 * PR only fills the keys needed to prove the wiring on `src/cli/index.ts`'s
 * global help / version / unknown-command paths.
 */

export const en = {
  // --- global help (radar --help / radar / radar help) ----------------------
  /** First line of `radar --help`: the product tagline. */
  "cli.help.tagline": "FeedRadar — Multi-agent CLI for blog/release feed research",
  /** Usage synopsis line. */
  "cli.help.usage": "Usage: radar <command> [options]",
  /** Section heading listing the subcommands. */
  "cli.help.commandsHeading": "Commands:",
  /** Section heading listing the global options. */
  "cli.help.optionsHeading": "Options:",
  /** `-h, --help` option description. */
  "cli.help.optionHelp": "Show this help",
  /** `-v, --version` option description. */
  "cli.help.optionVersion": "Show version",
  /** `--lang <en|ja>` option description. */
  "cli.help.optionLang": "UI language (overrides RADAR_LANG / config)",

  // --- unknown command error ------------------------------------------------
  /** stderr line when an unrecognized subcommand is given. */
  "cli.error.unknownCommand": ({ command }: { command: string }): string =>
    `radar: unknown command '${command}'`,
  /** Follow-up hint pointing the user at `radar --help`. */
  "cli.error.unknownCommandHint": "Run 'radar --help' for available commands.",

  // --- progress phase markers (ProgressReporter, ADR-0015, #313) ------------
  // User-facing phase labels emitted by `research` / `review` / `update` via
  // `progress.phase()` / `start()` / `succeed()` / `fail()`. The verb-forms
  // follow ADR-0015 D4 (`Loaded …`, `Spawning …`, `Agent running…`, `Agent
  // completed (…)`, `Status: … → …`). Agent stdout/stderr pass-through
  // (`reporter.raw`) is NOT translated — it is external output forwarded
  // verbatim.
  /** "Loaded item: <id>" — single-item PRE phase marker. */
  "cli.progress.loadedItem": ({ id }: { id: string }): string => `Loaded item: ${id}`,
  /** "Loaded N items" — digest/batch PRE phase marker. */
  "cli.progress.loadedItems": ({ count }: { count: number }): string => `Loaded ${count} items`,
  /** "Loaded template: <id>.md" — template-resolved phase marker. */
  "cli.progress.loadedTemplate": ({ templateId }: { templateId: string }): string =>
    `Loaded template: ${templateId}.md`,
  /** "Spawning <agent>" — agent-spawn phase marker. */
  "cli.progress.spawning": ({ agent }: { agent: string }): string => `Spawning ${agent}`,
  /** Spinner label while the agent runs. */
  "cli.progress.agentRunning": "Agent running",
  /** "Agent completed (exit <code>)" — agent success line. */
  "cli.progress.agentCompleted": ({ exitCode }: { exitCode: number }): string =>
    `Agent completed (exit ${exitCode})`,
  /** Agent-failure spinner-fail label. */
  "cli.progress.agentFailed": "Agent failed",
  /** "Frontmatter validated" — schema-check phase marker. */
  "cli.progress.frontmatterValidated": "Frontmatter validated",
  /** "Status: <from> → <to>" — state-machine transition phase marker. */
  "cli.progress.statusTransition": ({ from, to }: { from: string; to: string }): string =>
    `Status: ${from} → ${to}`,

  // --- command summaries (global help list, #311) ---------------------------
  // One-line descriptions shown by `radar --help`. Mirror each command's
  // `Command.summary`; the dispatcher renders them via `t()`.
  "cli.summary.init": "Initialize a workspace (sources/items/state/research/templates)",
  "cli.summary.source": "Manage feed sources (add | list | recipes | remove | test)",
  "cli.summary.watch": "Fetch sources and produce filtered items (run)",
  "cli.summary.research": "Generate Markdown research reports from items via an AI agent",
  "cli.summary.triage": "LLM-based triage of detected items",
  "cli.summary.dismiss": "Mark detected items as dismissed (single id, multiple ids, or --batch)",
  "cli.summary.undismiss": "Reverse a dismiss (`dismissed → detected`)",
  "cli.summary.items": "Inspect items in the workspace (list | ...)",
  "cli.summary.review": "Cross-review existing research reports using a different AI agent",
  "cli.summary.update": "Refresh existing research reports against the latest items",
  "cli.summary.doctor": "Diagnose workspace, agent CLIs, and html-js Playwright install",
  "cli.summary.workflow": "Generate GitHub Actions workflows (generate <type>)",
  "cli.summary.routine": "Manage Claude Code Routines (generate <type> / fire <trig_id>)",

  // --- research help (#311) -------------------------------------------------
  "cli.research.help": ({ maxItems }: { maxItems: number }): string =>
    `Usage:
  radar research <item-id> [--agent <agent-id>] [--template <template-id>]
  radar research --digest <item-id> <item-id> ... [--triage-group <group>] [--agent <agent-id>] [--template <id>]
  radar research --batch [--status <status>] [--max-items N] [--filter-tags <list>] [--agent <id>]
  radar research <item-id> --emit-payload [--digest <ids...>] [--template <id>]
  radar research --commit <path>

Arguments:
  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)
                        Pass 2 or more ids together with --digest to bundle them.
                        Omit positional ids with --batch — items are discovered.

Options:
  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)
  --template <id>       Template id under templates/ (default: default; digest: digest)
  --digest              Bundle multiple items into a single digest report
  --triage-group <group> Digest-mode slug source: name the digest
                        file after this triage.group instead of the matchedKeywords
                        frequency. Required to keep per-group digests unique on the
                        same day when a single-keyword source emits multiple groups
                        (#255). Falls back to the matchedKeywords slug when omitted.
  --batch               Research every item matching --status (and --filter-tags)
                        respecting the --max-items hard-cap.
  --status <status>     Batch-mode filter: detected | triaged_research
                        (default: detected). \`triaged_research\` consumes items
                        the triage adapter promoted and
                        transitions them to \`researched\` on success.
  --max-items N         Batch-mode hard-cap on processed items (default: ${maxItems}).
                        Excess items are dropped and announced via warn() so a runaway
                        detection cannot blow the cap from inside a workflow.
  --filter-tags <list>  Batch-mode comma-separated allow-list matched against
                        each item's matchedKeywords (case-insensitive). Default: all.
  --emit-payload        Host-agent mode: print the research payload to
                        stdout and DO NOT spawn an agent. The interactive host
                        session runs the SKILL procedure itself, then finalizes
                        with \`radar research --commit <path>\`. Interactive/opt-in
                        only — CI/headless must use the default spawn path.
  --commit <path>       Host-agent mode: validate an externally-written
                        report (under <cwd>/research/) against ResearchFrontmatter-
                        Schema and apply the detected → researched transition.
  --verbose             Stream the agent CLI's stdout/stderr in addition to phase markers.
  --quiet               Suppress phase markers and spinner; print only the completion line.
                        Equivalent to setting RADAR_NO_PROGRESS=1.

Output:
  single-item:  research/<YYYYMMDD>_<slug>_v1.md
  digest:       research/<YYYYMMDD>_digest_<slug>_v1.md
  batch:        one single-item report per matched item (no digest aggregation).`,

  // --- review help (#311) ---------------------------------------------------
  "cli.review.help": ({ maxItems }: { maxItems: number }): string =>
    `Usage:
  radar review <research-id> [--agent <agent-id>] [--template <template-id>]
  radar review --batch [--status <status>] [--max-items N] [--filter-tags <list>] [--agent <id>]
  radar review <research-id> --emit-payload [--agent <id>] [--template <id>]
  radar review --commit <path>

Arguments:
  <research-id>         Research id (basename of research/<id>.md without .md)
                        Omit with --batch — research files are discovered.

Options:
  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)
  --template <id>       Template id under templates/ (default: default)
  --batch               Review every un-reviewed research file whose linked
                        items match --status (and --filter-tags), respecting
                        --max-items (default: ${maxItems}).
  --status <status>     Batch-mode filter: researched (default).
                        \`researched → reviewed\` is the only legal transition;
                        other values are rejected.
  --max-items N         Batch-mode hard-cap on processed reports (default: ${maxItems}).
  --filter-tags <list>  Batch-mode comma-separated allow-list matched against
                        each linked item's matchedKeywords (case-insensitive).
  --emit-payload        Host-agent mode: print the review payload to
                        stdout and DO NOT spawn an agent. The interactive host
                        session reviews the research file in place itself, then
                        finalizes with \`radar review --commit <path>\`.
                        Interactive/opt-in only — CI/headless must use the
                        default spawn path.
  --commit <path>       Host-agent mode: validate an externally-
                        reviewed report (under <cwd>/research/) against
                        ResearchFrontmatterSchema, assert the host stamped
                        reviewedAt / reviewedBy, and apply the researched →
                        reviewed transition for the linked items.
  --verbose             Stream the agent CLI's stdout/stderr in addition to phase markers.
  --quiet               Suppress phase markers and spinner; print only the completion line.
                        Equivalent to setting RADAR_NO_PROGRESS=1.

Appends a review block to research/<research-id>.md, stamps the
frontmatter \`reviewedAt\` / \`reviewedBy\`, and transitions the linked
items/<id>.yaml \`status\` from \`researched\` to \`reviewed\`. Both updates
happen atomically — a partial failure rolls back the research file.`,

  // --- update help (#311) ---------------------------------------------------
  "cli.update.help": `Usage:
  radar update <research-id> [--agent <agent-id>] [--template <template-id>]
  radar update <research-id> --emit-payload [--template <id>]
  radar update --commit <path>

Arguments:
  <research-id>         Research id (basename of research/<id>.md without .md)

Options:
  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)
  --template <id>       Template id under templates/ (default: default)
  --emit-payload        Host-agent mode: print the update payload to
                        stdout and DO NOT spawn an agent. The interactive host
                        session runs the SKILL procedure itself, then finalizes
                        with \`radar update --commit <path>\`. Interactive/opt-in
                        only — CI/headless must use the default spawn path.
  --commit <path>       Host-agent mode: validate an externally-written
                        v+1 report (under <cwd>/research/) against ResearchFrontmatter-
                        Schema, assert the v+1 invariants against the \`supersedes\`
                        predecessor, and leave items.yaml untouched.
  --verbose             Stream the agent CLI's stdout/stderr in addition to phase markers.
  --quiet               Suppress phase markers and spinner; print only the completion line.
                        Equivalent to setting RADAR_NO_PROGRESS=1.

Generates research/<base>_v<n+1>.md from the supplied predecessor id,
writing \`supersedes: <prev id>\` into the new file's frontmatter. The
predecessor file is never modified (immutable history), and
the linked items/<id>.yaml \`status\` is left untouched.`,

  // --- triage help (#311) ---------------------------------------------------
  "cli.triage.runHelp": `Usage: radar triage [--dry-run | --apply | --interactive] [options]
       radar triage --emit-payload [--source <id>] [options]
       radar triage --commit <path>

Classify \`detected\` items using the configured per-source triage policy.

Modes (mutually exclusive; default: --dry-run):
  --dry-run            print proposed decisions to stdout (no disk writes)
  --apply              write decisions to items/<id>.yaml + transition status
  --interactive        --dry-run output → $EDITOR → confirm → apply

Options:
  --source <id>            limit triage to a single source
  --filter-tags <a,b>      matchedKeywords allow-list (comma-separated)
  --triage-agent <id>      override policy.agent for this run
  --policy <path>          override per-source policy with a YAML file
  --max-items N            hard cap on items triaged in this run
  --audit-log <path>       append JSONL audit records of every triage call
  --emit-payload           Host-agent mode: print the triage payload to
                           stdout and DO NOT spawn an agent. The interactive host
                           session classifies the items itself, writes a decisions
                           JSON, then finalizes with \`radar triage --commit <path>\`.
                           Requires a single source group: pass --source unless only
                           one source has detected items. Interactive/opt-in only —
                           CI/headless must use the default spawn path.
  --commit <path>          Host-agent mode: validate a host-written
                           decisions JSON (under <cwd>/triage/) against the source's
                           policy + detected items and apply the status transitions.
  -v, --verbose            verbose progress output
  -q, --quiet              suppress progress output entirely

Sources missing a \`triagePolicy:\` block are skipped with a warning.`,
  "cli.triage.feedbackHelp": `Usage: radar triage feedback <item-id> --correct | --wrong [--reason <text>]

Record human feedback on a prior triage decision.
Feedback is appended to items/<id>.yaml > triage.feedback, used by
\`radar triage stats\` (#242) for policy tuning.

Options:
  --correct            mark the prior triage decision as correct
  --wrong              mark the prior triage decision as wrong
  --reason <text>      free-form rationale (recommended for --wrong)`,
  "cli.triage.statsHelp": `Usage: radar triage stats [--since <duration>] [--source <id>] [--json]

Aggregate triage decisions and human feedback.
Use after running \`radar triage --apply\` for some weeks; the output
highlights precision / recall drift and suggests \`triagePolicy.rules:\`
tweaks. See docs/user-guide.md \`policy tuning workflow\` for the
recommended monthly loop.

Options:
  --since <duration>   only count items triaged within the cutoff (e.g. 30d, 24h)
  --source <id>        limit stats to a single source (default: all sources)
  --json               emit machine-readable JSON instead of the text report`,
  "cli.triage.help": `Usage: radar triage <subcommand|--apply|--dry-run|--interactive> [...]

Subcommands:
  feedback <item-id> --correct | --wrong [--reason <text>]
  stats [--since <duration>] [--source <id>] [--json]

Run modes (when no subcommand given):
  --dry-run            print proposed decisions
  --apply              write decisions to items/<id>.yaml
  --interactive        edit decisions in $EDITOR before applying

Run \`radar triage --help\` for the full option list.`,

  // --- dismiss / undismiss help (#311) --------------------------------------
  "cli.dismiss.help": ({ maxItems }: { maxItems: number }): string =>
    `Usage:
  radar dismiss <item-id> [<item-id> ...]
  radar dismiss --batch [--status <status>] [--max-items N] [--filter-tags <list>]

Arguments:
  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)
                        Pass 2 or more ids to dismiss them in one call.
                        Omit positional ids with --batch — items are discovered.

Options:
  --batch               Dismiss every item matching --status (and --filter-tags)
                        respecting the --max-items hard-cap (default: ${maxItems}).
  --status <status>     Batch-mode filter: detected | triaged_unsure (default: detected).
                        Only these two statuses can transition to \`dismissed\`
                        per the state machine; other values are rejected.
  --max-items N         Batch-mode hard-cap on processed items (default: ${maxItems}).
                        Excess items are dropped and announced via warn() so a runaway
                        --backfill cannot blow the cap from inside a workflow.
  --filter-tags <list>  Batch-mode comma-separated allow-list matched against
                        each item's matchedKeywords (case-insensitive). Default: all.

Transitions the item's status to \`dismissed\`. Valid from \`detected\`
or \`triaged_unsure\`; items in \`researched\` / \`reviewed\` / \`dismissed\` /
\`triaged_research\` / \`triaged_digest\` cannot be dismissed.

Inverse: \`radar undismiss <item-id> [--force]\`.`,
  "cli.undismiss.help": `Usage: radar undismiss <item-id> [--force]

Arguments:
  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)

Options:
  --force, -f           Required when reversing a human-origin dismiss

Reverses \`dismissed → detected\`.
Triage-origin dismisses revert silently; human-origin dismisses require --force.

Inverse of \`radar dismiss\`.`,

  // --- items help (#311) ----------------------------------------------------
  "cli.items.listHelp": `Usage: radar items list [filters] [output options]

Filters:
  --status <status>        detected | triaged_research | triaged_digest |
                           triaged_unsure | researched | reviewed | dismissed
  --source <id>            limit to one source
  --triage-group <name>    items whose triage.group == <name>
                           (used by digest workflow)
  --since <duration>       drop items older than the cutoff (e.g. 7d, 24h)
  --limit N                cap result count

Output options:
  --json                   emit JSON array (one object per item)
  --field <expr>           emit one item field per row (e.g. id, sourceId,
                           triage.decision). Supports nested dot paths.`,
  "cli.items.help": `Usage: radar items <list> [...]

Subcommands:
  list [filters]           List items matching the supplied filters`,

  // --- watch help (#311) ----------------------------------------------------
  "cli.watch.help": `Usage: radar watch <run> [options]

Subcommands:
  run [--source <id>] [--bootstrap | --backfill [--max-pages N]]
                  Fetch sources and produce items

Options for run:
  --source <id>     Limit the run to a single source id
  --bootstrap       Seed lastSeenIds without emitting items (suppress initial noise)
  --backfill        Fetch all available history pages and emit items for each.
                    Supported fully by kind: json-api / github-releases / npm-registry.
                    Other kinds (rss / html / html-js) only return their current page.
  --max-pages N     Override pagination.maxPages cap (requires --backfill).
                    Applies to INNER pagination only — facet sweep
                    always walks every facet value regardless of this flag.
  -v, --verbose     Enable progress-reporter raw() pass-through (adapter stdout).
  -q, --quiet       Suppress the per-source progress reporter (legacy 1-line log
                    remains). RADAR_NO_PROGRESS=1 has the same effect.`,

  // --- doctor help (#311) ---------------------------------------------------
  "cli.doctor.help": `Usage: radar doctor [--no-proxy-check]

Diagnose the workspace and report dependency / configuration health.

Checks performed:
  - Workspace directories (sources/, items/, state/, research/, templates/)
  - radar.config.yaml schema validity
  - Agent CLI availability (claude / codex / gemini / copilot)
  - Playwright + Chromium install (only if html-js sources configured)
  - Proxy env vars (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY) with credential masking
  - NODE_USE_ENV_PROXY status (engaged when radar self-respawned for proxy)
  - NODE_EXTRA_CA_CERTS status (required for TLS-intercepting proxies)
  - Live proxy healthcheck (HTTPS request to api.github.com)

Options:
  --no-proxy-check  Skip the live proxy healthcheck (offline-friendly)

Exit codes:
  0  all ok (warnings may appear, but no errors)
  1  one or more error-level checks failed`,

  // --- source help (#311) ---------------------------------------------------
  "cli.source.addHelp": `Usage: radar source add <id> --kind <kind> --url <url> [options]
       radar source add <id> --recipe <name> [overrides]

Options:
  --kind <kind>            rss | html | html-js | github-releases | npm-registry | json-feed | json-api
  --url <url>              fetch target URL
  --recipe <name>          apply a bundled recipe (see \`radar source recipes\`).
                           Mutually exclusive with --kind / --url / --selector-* /
                           --pagination-*; --name / --tags / --keywords /
                           --exclude-keywords still override the recipe defaults.
  --name <name>            display name (defaults to <id>)
  --tags <a,b>             comma-separated tags
  --keywords <a,b>         comma-separated include keywords
                           (required for useful output — empty = match nothing)
  --exclude-keywords <a,b> comma-separated exclude keywords
  --selector-<field> <css> CSS selector for kind=html / html-js (required: item, title, link)
                           optional: summary, publishedAt, body, tags
                           For kind=html-js, selectors evaluate against the post-JS DOM.
                           The \`js:\` block (waitFor / timeout / userAgent) cannot be set
                           via flags; edit sources/<id>.yaml after add.

  For kind=json-api:
    --pagination-strategy <s>  page | offset | cursor | link-header | token | none (default: page)
    --pagination-param <name>  query param name for the page/offset/cursor value
    --pagination-start N       initial page/offset value (default: 0)
    --page-size N              items per page
    --page-size-param <name>   query param name for the page-size value
    --max-pages N              hard cap on pages traversed (default: 20)
    --next-cursor-path <jp>    JSONPath-lite to the next-cursor value (cursor/token strategy)
    --total-path <jp>          JSONPath-lite to the total-count value (backfill early-stop hint)

  Selector fields (\`jsonSelectors.*\`) for kind=json-api cannot be set via flags;
  the schema has a default fallback chain (items / title / link / publishedAt / summary),
  so simple APIs work without selectors. Edit sources/<id>.yaml directly when explicit
  selectors are needed (nested fields, non-standard envelopes).

  Facet sweep (e.g. year-by-year sweep) cannot be configured via flags;
  and bundle the year sweep through \`--recipe aws-whats-new\`. Recipe-only structural field.`,
  "cli.source.listHelp": `Usage: radar source list [--enabled-only] [-v|--verbose]

Lists sources/*.yaml in tabular form: id / kind / url / tags.

Options:
  --enabled-only   Reserved for forward compatibility (currently a no-op).
  -v, --verbose    Print a detailed block per source including keywords,
                   trustLevel, and lastFetchedAt (from state/<id>.yaml).`,
  "cli.source.removeHelp": `Usage: radar source remove <id>

Deletes sources/<id>.yaml. state/<id>.yaml and items/ are preserved.`,
  "cli.source.testHelp": `Usage: radar source test <id> [--limit N] [--show-content]

Dry-run a single source: fetch, filter, and print matched items.
state/ and items/ are not touched (no persistence). Useful for tuning
keywords when adding a new source.

For kind=json-api, \`source test\` fetches PAGE 0 ONLY.
Pagination is NOT walked even when the recipe declares multiple pages —
\`--limit N\` caps how many matched items are PRINTED, it does not change
the page budget. Use \`radar watch run --backfill\` for full-history ingest.
Page 0's \`Link\` header / \`nextCursor\` extraction is surfaced via
\`--show-content\` for pagination tuning without state mutation.

For facet-sweep recipes, \`source test\` probes a SINGLE
facet value: range facets use the upper bound (latest year), enum facets
use the first listed value. A warning names which value was tested so
keyword tuning is not silently scoped to one slice. Run \`radar watch run
--backfill\` to sweep every facet value.

Options:
  --limit N        Maximum number of matched items to print (default 10)
  --show-content   Also print the first 200 chars of each item's body, plus
                   (kind=json-api) the selector adoption table and pagination
                   preview (would-be next URL / Link header / nextCursor).
  -v, --verbose    Enable progress-reporter raw() pass-through (adapter stdout).
                   Most useful with kind=html-js (Playwright phase markers).
  -q, --quiet      Suppress the progress reporter entirely. RADAR_NO_PROGRESS=1
                   has the same effect.`,
  "cli.source.recipesHelp": `Usage: radar source recipes

List bundled recipes (recipes/*.yaml in the radar package).
Each recipe can be applied via:
  radar source add <id> --recipe <name> [--keywords <kw>] [--tags <t>] [--name <display>]

Bundled recipes ship with the radar npm package; user-authored recipes are
not yet supported. To add a new bundled recipe, contribute a YAML to the
radar repo's recipes/ directory.`,
  "cli.source.help": `Usage: radar source <add|list|recipes|remove|test> [...]

Subcommands:
  add <id> --kind <kind> --url <url> [...]
  add <id> --recipe <name> [--keywords <kw>] [--tags <t>] [--name <display>]
  list [--enabled-only]
  recipes
  remove <id>
  test <id> [--limit N] [--show-content]`,

  // --- workflow help (#311) -------------------------------------------------
  "cli.workflow.help": `Usage: radar workflow <subcommand> [...]

Subcommands:
  generate <type>  Generate a GitHub Actions workflow YAML
                   Types: watch | combined | combined-with-triage

Run \`radar workflow generate <type> --help\` for type-specific options.`,
  "cli.workflow.generateHelp": `Usage: radar workflow generate <type> [options]

Types:
  watch                  Periodic \`radar watch run\` (cron + state commit with rebase retry)
  combined               Periodic \`radar watch run\` -> auto research --batch with hard cap
  combined-with-triage   \`watch run\` -> \`triage --apply\` -> \`research --batch\` -> per-group \`research --digest\` -> \`review --batch\` in one job

Run \`radar workflow generate <type> --help\` for type-specific options.`,

  // --- routine help (#311) --------------------------------------------------
  "cli.routine.help": `Usage: radar routine <subcommand> [...]

Subcommands:
  generate <type>  Generate a Claude Code Routine YAML (.claude/routines/)
                   Types: watch | pipeline
  fire <trig_id>   Trigger a registered routine from the outside (/fire API)

Run \`radar routine <subcommand> --help\` for subcommand-specific options.`,
  "cli.routine.generateHelp": `Usage: radar routine generate <type> [options]

Types:
  watch     Periodic \`radar watch run\` self-session routine; commits items/state to a claude/* branch
  pipeline  Full watch -> triage -> research -> review self-session routine, one item at a time

Run \`radar routine generate <type> --help\` for type-specific options.`,

  // --- init help (#311) -----------------------------------------------------
  "cli.init.help": `Usage: radar init [--lang <en|ja>] [--force] [--with-routines] [--with-actions]
                          [--no-claude-skills] [--no-gemini-commands]
                          [--no-agents-md] [--no-claude-md] [--no-templates]
                          [--no-feedradar-md]

Creates the workspace directories and copies bundled skills:
  - Engine SKILLs (SSoT): .agents/skills/{research,review,update}/SKILL.md
  - Claude Code slash-command wrappers: .claude/skills/{research,review,update,dismiss}/SKILL.md
  - Gemini CLI slash commands: .gemini/commands/{research,review,update,dismiss}.toml
  - Agent-agnostic instructions: AGENTS.md (auto-read by Codex / Gemini / Copilot)
  - Claude Code workspace instructions: CLAUDE.md (imports @AGENTS.md so Claude reads it)
  - Starter report templates: templates/default.md (single item) and templates/digest.md (multi-item digest)
  - Human-facing workspace guide: FEEDRADAR.md (natural-language / slash usage)

Options:
  --lang <en|ja>         Language for generated report templates and workspace docs
                         (default: en; also honors RADAR_LANG; persisted to radar.config.yaml)
  --force                Overwrite existing files
  --with-routines        Generate .claude/routines/watch-daily.yaml (Claude Routines scaffold)
  --with-actions         Generate .github/workflows/watch.yaml (GitHub Actions cron scaffold)
  --no-claude-skills     Skip writing slash-command wrappers to .claude/skills/
                         (useful if @ozzylabs/skills Renovate preset manages that directory)
  --no-gemini-commands   Skip writing Gemini CLI slash commands to .gemini/commands/
                         (engine SKILLs still serve interactive Gemini via dual-mode)
  --no-agents-md         Skip writing AGENTS.md at the workspace root
                         (useful if the workspace already has its own AGENTS.md;
                          implies --no-claude-md since the bundled CLAUDE.md imports @AGENTS.md)
  --no-claude-md         Skip writing CLAUDE.md at the workspace root
                         (useful if the workspace already has its own CLAUDE.md)
  --no-templates         Skip writing templates/default.md and templates/digest.md
                         (research engine SKILL falls back to its built-in structure)
  --no-feedradar-md      Skip writing FEEDRADAR.md at the workspace root
                         (useful if the workspace already has its own user-facing docs)`,
} as const;

/** Union of all valid message keys. */
export type MessageKey = keyof typeof en;

/**
 * Widen a single English catalog entry into the shape every locale must
 * satisfy for that key. The `as const` on {@link en} narrows string entries to
 * *literal* types ("Show this help"), which would force `ja` to repeat the
 * English text verbatim — so we widen string entries back to `string` while
 * preserving function entries' precise param/return signature (that is the
 * part that must stay identical across locales, since `t`'s param type is
 * derived from it).
 */
type LocaleEntry<T> = T extends (...args: infer A) => infer R ? (...args: A) => R : string;

/**
 * The catalog shape every locale must satisfy. Derived from the English
 * catalog so that `ja` (and any future locale) is required — at compile time —
 * to provide the exact same key set, with string entries free to differ in
 * wording but function entries pinned to the same param/return shape.
 */
export type Messages = {
  [K in MessageKey]: LocaleEntry<(typeof en)[K]>;
};
