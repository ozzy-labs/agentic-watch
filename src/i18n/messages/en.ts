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

  // --- watch-flow progress markers (#337, deferred from #313) ---------------
  // Per-source phase markers emitted by `radar watch run` (`src/core/watcher.ts`)
  // and the html-js Playwright adapter (`src/core/feeds/html-js.ts`). The
  // embedded values (source id, page counters, selector name, elapsed mm:ss)
  // are functional fields and stay verbatim; only the surrounding prose is
  // translated. Internal debug logs are NOT translated (ADR-0021 boundary).
  /**
   * "[<source-id>] <facet>Page <i>/<n>: <items> items fetched" — paginating-
   * adapter (json-api) page phase marker. `facet` is a pre-built functional
   * prefix (e.g. `year=2018 (15/23) `) or empty; the page / item counters are
   * functional and stay verbatim. Only the "Page … items fetched" prose is
   * translated.
   */
  "cli.progress.watchPage": ({
    sourceId,
    facet,
    page,
    pageTotal,
    items,
  }: {
    sourceId: string;
    facet: string;
    page: number;
    pageTotal: number;
    items: number;
  }): string => `[${sourceId}] ${facet}Page ${page}/${pageTotal}: ${items} items fetched`,
  /** "[<source-id>] Completed: <total> total, <fresh> new" — per-source success line. */
  "cli.progress.watchSourceCompleted": ({
    sourceId,
    total,
    fresh,
  }: {
    sourceId: string;
    total: number;
    fresh: number;
  }): string => `[${sourceId}] Completed: ${total} total, ${fresh} new`,
  /** "Still waiting for "<sel>"… [<mm:ss>]" — long html-js selector-wait reminder. */
  "cli.progress.stillWaiting": ({
    selector,
    elapsed,
  }: {
    selector: string;
    elapsed: string;
  }): string => `Still waiting for "${selector}"… [${elapsed}]`,
  /** "[<source-id>] Fetching…" — per-source start-of-fetch phase marker. */
  "cli.progress.watchFetching": ({ sourceId }: { sourceId: string }): string =>
    `[${sourceId}] Fetching…`,
  /** "kind: <kind>" — side-metric info shown alongside the Fetching phase. */
  "cli.progress.watchKindInfo": ({ kind }: { kind: string }): string => `kind: ${kind}`,
  /** "[<source-id>] Failed" — per-source fetch-failure phase label. */
  "cli.progress.watchFailed": ({ sourceId }: { sourceId: string }): string =>
    `[${sourceId}] Failed`,
  /** "Launching Chromium…" — html-js browser-launch phase marker. */
  "cli.progress.htmlJsLaunching": "Launching Chromium…",
  /** "Navigating to <url>…" — html-js page-navigation phase marker. */
  "cli.progress.htmlJsNavigating": ({ url }: { url: string }): string => `Navigating to ${url}…`,
  /** "Waiting for selector "<sel>" (timeout: <ms>ms)…" — html-js selector-wait phase marker. */
  "cli.progress.htmlJsWaitingSelector": ({
    selector,
    timeout,
  }: {
    selector: string;
    timeout: number;
  }): string => `Waiting for selector "${selector}" (timeout: ${timeout}ms)…`,
  /** "Capturing page content…" — html-js content-capture phase marker. */
  "cli.progress.htmlJsCapturing": "Capturing page content…",
  /** "Closing browser…" — html-js browser-close phase marker. */
  "cli.progress.htmlJsClosing": "Closing browser…",

  // --- command summaries (global help list, #311) ---------------------------
  // One-line descriptions shown by `radar --help`. Mirror each command's
  // `Command.summary`; the dispatcher renders them via `t()`.
  "cli.summary.init": "Initialize a workspace (sources/items/state/research/templates)",
  "cli.summary.source": "Manage feed sources (add | list | recipes | remove | test)",
  "cli.summary.watch": "Fetch sources and produce filtered items (run)",
  "cli.summary.state": "Manage per-source watch state (prune)",
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

  // --- per-type workflow generate help (#337, deferred from #311) -----------
  // Type-specific `--help` bodies for `radar workflow generate <type>`. The
  // option names / cron expression / secret names are functional fields and
  // stay verbatim; only the natural-language descriptions are translated.
  "cli.workflow.generateWatchHelp": `Usage: radar workflow generate watch [options]

Generates a GitHub Actions workflow that runs \`radar watch run\` on a cron schedule.
The generated workflow includes git pull --rebase retry logic to mitigate push
conflicts with other concurrent workflows.

Options:
  --cron <expression>   5-field cron expression (default: "0 0 * * *")
  --output <path>       Output file under .github/workflows/
                        (default: .github/workflows/feedradar-watch.yaml)
  --agent <name>        claude-code | codex-cli | gemini-cli | copilot (default: claude-code)
                        Determines which secret name the workflow references.
  --force, -f           Overwrite existing output file
  --lang <en|ja>        Language for the generated YAML's comments / step names
                        (default: en; also honors RADAR_LANG and config.locale)

Required secrets (Settings → Secrets and variables → Actions):
  ANTHROPIC_API_KEY    when --agent claude-code (default)
  OPENAI_API_KEY       when --agent codex-cli
  GEMINI_API_KEY       when --agent gemini-cli
  GITHUB_TOKEN         auto-provisioned for --agent copilot (no setup needed)`,
  "cli.workflow.generateCombinedHelp": ({ maxItems }: { maxItems: number }): string =>
    `Usage: radar workflow generate combined [options]

Generates a GitHub Actions workflow that chains \`radar watch run\` ->
a no-new-items guard -> \`radar research --batch\` with hard-capped cost
controls.

Options:
  --watch-cron <expression>  5-field cron expression (default: "0 0 * * *")
  --output <path>            Output file under .github/workflows/
                             (default: .github/workflows/feedradar-combined.yaml)
  --agent <name>             claude-code | codex-cli | gemini-cli | copilot (default: claude-code)
  --max-items N              Hard cap on auto-research per run (default: ${maxItems})
  --filter-tags <list>       Comma-separated allow-list of matchedKeywords
                             (default: unset, matches every detected item)
  --force, -f                Overwrite existing output file
  --lang <en|ja>             Language for the generated YAML's comments / step names
                             (default: en; also honors RADAR_LANG and config.locale)

Required secrets (Settings → Secrets and variables → Actions):
  ANTHROPIC_API_KEY    when --agent claude-code (default)
  OPENAI_API_KEY       when --agent codex-cli
  GEMINI_API_KEY       when --agent gemini-cli
  GITHUB_TOKEN         auto-provisioned for --agent copilot (no setup needed)`,
  "cli.workflow.generateCombinedWithTriageHelp": ({
    watchCron,
    output,
    maxItems,
  }: {
    watchCron: string;
    output: string;
    maxItems: number;
  }): string =>
    `Usage: radar workflow generate combined-with-triage [options]

Generates a GitHub Actions workflow that chains \`radar watch run\` ->
\`radar triage --apply\` -> \`radar research --batch --status triaged_research\` ->
per-group \`radar research --digest\` -> \`radar review --batch\` in one job.

Options:
  --watch-cron <expression>  5-field cron expression (default: "${watchCron}")
  --output <path>            Output file under .github/workflows/
                             (default: ${output})
  --triage-agent <name>      claude-code | codex-cli | gemini-cli | copilot (default: gemini-cli)
  --research-agent <name>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)
  --review-agent <name>      claude-code | codex-cli | gemini-cli | copilot (default: codex-cli)
  --max-items N              Hard cap on research --batch per run (default: ${maxItems})
  --slack-webhook <ref>      Secret reference (e.g. secrets.SLACK_WEBHOOK) for the
                             triaged_unsure-queue alert (optional)
  --output-mode <mode>       pr | direct-commit (default: pr). 'pr' opens a
                             review PR; 'direct-commit' commits & pushes straight
                             to the default branch (drops pull-requests: write)
  --force, -f                Overwrite existing output file
  --lang <en|ja>             Language for the generated YAML's comments / step names
                             (default: en; also honors RADAR_LANG and config.locale)

Required secrets (Settings → Secrets and variables → Actions):
  ANTHROPIC_API_KEY  when any role uses --agent claude-code
  OPENAI_API_KEY     when any role uses --agent codex-cli
  GEMINI_API_KEY     when any role uses --agent gemini-cli (default for triage)
  GITHUB_TOKEN       auto-provisioned (no manual setup needed)`,

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

  // --- per-type routine generate / fire help (#337, deferred from #311) -----
  // Type-specific `--help` bodies for `radar routine generate <type>` and
  // `radar routine fire`. Model ids / cron / token env var name are functional
  // fields and stay verbatim; only the prose is translated. `models` is the
  // pre-joined `SUPPORTED_MODELS.join(" | ")` string so the catalog stays
  // agnostic of the model list's contents.
  "cli.routine.generateWatchHelp": ({ models }: { models: string }): string =>
    `Usage: radar routine generate watch [options]

Generates a Claude Code Routine YAML that runs \`radar watch run\` on a schedule
and commits detected items/state to a claude/* branch.
The routine completes in one Claude session — it does NOT spawn other agents.

Options:
  --name <name>         Routine name (default: "feedradar-watch")
                        Also the default output filename.
  --repo <owner/repo>   Target repository (default: <owner>/<repo>)
  --cron <expression>   5-field cron, min interval 1 HOUR (default: "0 * * * *")
                        Sub-hourly (e.g. "*/5 * * * *") is rejected.
  --timezone <tz>       Schedule timezone (default: "UTC")
  --model <name>        ${models}
                        (default: claude-sonnet-4-6)
  --prompt-mode <mode>  inline | bootstrap (default: inline). 'bootstrap' makes the
                        completion print a SHORT prompt to paste into the Web UI
                        (the routine reads its instructions from the committed
                        YAML at run time — no re-paste on edits). The generated
                        YAML's instructions block is unchanged either way.
  --emit-bootstrap-prompt
                        Print ONLY the bootstrap prompt body to stdout and exit
                        (read-only: writes no YAML, prints no paste guidance).
                        Same text the bootstrap prompt-mode would paste; used by
                        the /routine-setup skill to fill the registration body.
  --output <path>       Output file under .claude/routines/
                        (default: .claude/routines/<name>.yaml)
  --force, -f           Overwrite existing output file
  --lang <en|ja>        Language for the generated YAML's notes / instructions / comments
                        (default: en; also honors RADAR_LANG and config.locale)`,
  "cli.routine.generatePipelineHelp": ({
    models,
    maxItems,
  }: {
    models: string;
    maxItems: number;
  }): string =>
    `Usage: radar routine generate pipeline [options]

Generates a Claude Code Routine YAML whose single session runs the FULL
pipeline — \`radar watch run\` -> triage -> research -> review — IN SEQUENCE,
processing items ONE AT A TIME. It does NOT spawn
other agents, so the cross-agent review of the GHA combined-with-triage
workflow is NOT present. Per-run item count is bounded by CLI flags.

Options:
  --name <name>         Routine name (default: "feedradar-pipeline")
                        Also the default output filename.
  --repo <owner/repo>   Target repository (default: <owner>/<repo>)
  --cron <expression>   5-field cron, min interval 1 HOUR (default: "0 * * * *")
                        Sub-hourly (e.g. "*/5 * * * *") is rejected.
  --timezone <tz>       Schedule timezone (default: "UTC")
  --model <name>        ${models}
                        (default: claude-sonnet-4-6)
  --max-items N         Hard cap on items triaged/researched/reviewed per run
                        (default: ${maxItems}). Drives triage --max-items and items --limit.
  --output-mode <mode>  pr | auto-merge (default: pr). 'auto-merge' squash-merges
                        the routine's own PR to main (requires the Web UI 'Allow
                        unrestricted branch pushes' toggle).
  --prompt-mode <mode>  inline | bootstrap (default: inline). 'bootstrap' makes the
                        completion print a SHORT prompt to paste into the Web UI
                        (the routine reads its instructions from the committed
                        YAML at run time — no re-paste on edits). The generated
                        YAML's instructions block is unchanged either way.
  --emit-bootstrap-prompt
                        Print ONLY the bootstrap prompt body to stdout and exit
                        (read-only: writes no YAML, prints no paste guidance).
                        Same text the bootstrap prompt-mode would paste; used by
                        the /routine-setup skill to fill the registration body.
  --output <path>       Output file under .claude/routines/
                        (default: .claude/routines/<name>.yaml)
  --force, -f           Overwrite existing output file
  --lang <en|ja>        Language for the generated YAML's notes / instructions / comments
                        (default: en; also honors RADAR_LANG and config.locale)`,
  "cli.routine.fireHelp": ({ tokenEnv }: { tokenEnv: string }): string =>
    `Usage: radar routine fire <trig_id> [options]

Triggers a registered Claude Code Routine from the outside via the
/fire API. The call returns as soon as the routine session
is created — it does NOT wait for the session to finish.

Arguments:
  <trig_id>             Routine id from the Web UI (starts with 'trig_')

Options:
  --text <msg>          Free-form launch context (request body \`text\`).
                        The API does not parse it; it is passed as-is.
  --token-env <NAME>    Env var holding the per-routine bearer token
                        (default: ${tokenEnv}).
  --lang <en|ja>        UI language for this command's messages / help
                        (default: en; also honors RADAR_LANG and config.locale)

The per-routine token is issued ONCE in the Web UI (Regenerate / Revoke
there) and is read from the environment — it is never accepted as a flag
and never printed.`,

  // --- user-facing errors & result notifications (#312) ---------------------
  // Catalog of the user-facing error / result-notification strings emitted by
  // the CLI commands (option-validation errors, file/state errors needing user
  // action, and completion notices). Developer-facing internal logs / traces
  // are intentionally NOT translated (ADR-0021 boundary). Dynamic values are
  // interpolated via the function-entry params, not placeholder strings.

  // dismiss (#312)
  "cli.dismiss.batchIncompatiblePositional": ({ count }: { count: number }): string =>
    `dismiss: --batch is incompatible with positional <item-id> arguments (got ${count})`,
  "cli.dismiss.invalidStatus": ({ status, allowed }: { status: string; allowed: string }): string =>
    `dismiss: invalid --status '${status}' (expected: ${allowed})`,
  "cli.dismiss.statusRequiresBatch": "dismiss: --status requires --batch",
  "cli.dismiss.maxItemsRequiresBatch": "dismiss: --max-items requires --batch",
  "cli.dismiss.filterTagsRequiresBatch": "dismiss: --filter-tags requires --batch",
  "cli.dismiss.invalidMaxItemsInteger": ({ raw }: { raw: string }): string =>
    `dismiss: invalid --max-items '${raw}' (expected positive integer)`,
  "cli.dismiss.invalidMaxItemsPositive": ({ raw }: { raw: string }): string =>
    `dismiss: invalid --max-items '${raw}' (must be > 0)`,
  "cli.dismiss.missingItemId": "dismiss: missing <item-id>",
  "cli.dismiss.itemNotFound": ({ id }: { id: string }): string =>
    `dismiss: item '${id}' not found under items/`,
  "cli.dismiss.itemWrongStatus": ({
    id,
    status,
    allowed,
    nextStatuses,
  }: {
    id: string;
    status: string;
    allowed: string;
    nextStatuses: string;
  }): string =>
    `dismiss: item '${id}' is in status '${status}', expected one of ${allowed} (dismiss transitions to 'dismissed' only from these). Valid next statuses for '${status}': ${nextStatuses}`,
  "cli.dismiss.failedUpdate": ({ reason }: { reason: string }): string =>
    `dismiss: failed to update item status: ${reason}`,
  "cli.dismiss.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `dismiss: items/${sourceId}/${id}.yaml status -> dismissed`,
  "cli.dismiss.noItemsMatched": ({ status, tags }: { status: string; tags: string }): string =>
    `dismiss: no items matched --batch filters (status=${status}${tags})`,
  "cli.dismiss.capReached": ({
    maxItems,
    dropped,
    matched,
  }: {
    maxItems: number;
    dropped: number;
    matched: number;
  }): string =>
    `dismiss: --max-items ${maxItems} cap reached; dropping ${dropped} excess item(s) (matched ${matched})`,
  "cli.dismiss.batchWillProcess": ({
    count,
    status,
    tags,
    cap,
  }: {
    count: number;
    status: string;
    tags: string;
    cap: number;
  }): string =>
    `dismiss: --batch will process ${count} item(s) (status=${status}${tags}, cap=${cap})`,
  "cli.dismiss.batchCompleted": ({ count }: { count: number }): string =>
    `dismiss: --batch completed ${count} item(s)`,

  // undismiss (#312)
  "cli.undismiss.missingItemId": "undismiss: missing <item-id>",
  "cli.undismiss.itemsDirNotFound": "undismiss: items/ not found (run `radar init`)",
  "cli.undismiss.itemNotFound": ({ id }: { id: string }): string =>
    `undismiss: item '${id}' not found under items/`,
  "cli.undismiss.notDismissed": ({ id, status }: { id: string; status: string }): string =>
    `undismiss: item '${id}' is in status '${status}', expected 'dismissed' (undismiss reverses a dismiss, not other transitions)`,
  "cli.undismiss.forbiddenTransition":
    "undismiss: state machine forbids 'dismissed → detected' (internal error)",
  "cli.undismiss.humanOriginRequiresForce": ({ id }: { id: string }): string =>
    `undismiss: item '${id}' was dismissed by human; pass --force to revert (this is a deliberate safety gate)`,
  "cli.undismiss.failedUpdate": ({ reason }: { reason: string }): string =>
    `undismiss: failed to update item: ${reason}`,
  "cli.undismiss.revertedHumanOrigin": ({ id }: { id: string }): string =>
    `undismiss: reverted human-origin dismiss for '${id}' (used --force)`,
  "cli.undismiss.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `undismiss: items/${sourceId}/${id}.yaml status -> detected`,

  // doctor diagnostics (#312)
  "cli.doctor.workspaceDirExists": ({ dir }: { dir: string }): string => `${dir}/ exists`,
  "cli.doctor.workspaceDirMissing": ({ dir }: { dir: string }): string =>
    `${dir}/ missing — run \`radar init\` to scaffold the workspace`,
  "cli.doctor.configValid": "radar.config.yaml valid (or absent — defaults apply)",
  "cli.doctor.configInvalid": ({ reason }: { reason: string }): string =>
    `radar.config.yaml invalid: ${reason}`,
  "cli.doctor.agentFound": ({
    agent,
    binary,
    path,
  }: {
    agent: string;
    binary: string;
    path: string;
  }): string => `${agent}: ${binary} found at ${path}`,
  "cli.doctor.agentMissing": ({ agent, binary }: { agent: string; binary: string }): string =>
    `${agent}: ${binary} not found in PATH (install it to use \`radar research --agent ${agent}\`)`,
  "cli.doctor.playwrightNotRequired": "playwright: not required (no html-js sources configured)",
  "cli.doctor.playwrightOk": ({ path }: { path: string }): string =>
    `playwright: ok — chromium at ${path}`,
  "cli.doctor.playwrightModuleMissing": ({
    sources,
    hint,
  }: {
    sources: string;
    hint: string;
  }): string =>
    `playwright: module not installed (required by html-js sources: ${sources})\n  ${hint}`,
  "cli.doctor.playwrightChromiumMissing": ({
    path,
    sources,
    hint,
  }: {
    path: string;
    sources: string;
    hint: string;
  }): string =>
    `playwright: chromium missing at '${path}' (required by html-js sources: ${sources})\n  ${hint}`,
  "cli.doctor.proxyEnvAllProxyOnly": ({
    source,
    masked,
  }: {
    source: string;
    masked: string;
  }): string =>
    `proxy: detected via $${source}=${masked} (Node --use-env-proxy ignores ALL_PROXY; set HTTPS_PROXY or HTTP_PROXY instead)`,
  "cli.doctor.proxyEnvDetected": ({ source, masked }: { source: string; masked: string }): string =>
    `proxy: detected via $${source}=${masked}`,
  "cli.doctor.proxyEnvNone": "proxy: no proxy env var set (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY)",
  "cli.doctor.proxyActive": "proxy: NODE_USE_ENV_PROXY active (auto-applied by radar)",
  "cli.doctor.proxyActiveMissing":
    "proxy: NODE_USE_ENV_PROXY not set; if fetch ignores HTTPS_PROXY, re-run radar via the bin (not direct import)",
  "cli.doctor.proxyActiveNotRequired": "proxy: NODE_USE_ENV_PROXY not required (no proxy detected)",
  "cli.doctor.tlsCaSet": ({ path }: { path: string }): string => `tls: NODE_EXTRA_CA_CERTS=${path}`,
  "cli.doctor.tlsCaUnset": "tls: NODE_EXTRA_CA_CERTS not set (TLS-intercepting proxies may fail)",
  "cli.doctor.healthcheckSkippedFlag": "proxy healthcheck: skipped (--no-proxy-check)",
  "cli.doctor.healthcheckSkippedNoProxy": "proxy healthcheck: skipped (no proxy detected)",
  "cli.doctor.healthcheck407": ({ url }: { url: string }): string =>
    `proxy healthcheck: 407 Proxy Authentication Required from ${url} (check userinfo in $HTTPS_PROXY)`,
  "cli.doctor.healthcheckOk": ({
    status,
    statusText,
    elapsed,
  }: {
    status: number;
    statusText: string;
    elapsed: number;
  }): string =>
    `proxy healthcheck: ok (${status} ${statusText} from api.github.com in ${elapsed}ms)`,
  "cli.doctor.healthcheckOther": ({
    status,
    statusText,
    elapsed,
  }: {
    status: number;
    statusText: string;
    elapsed: number;
  }): string =>
    `proxy healthcheck: ${status} ${statusText} from api.github.com in ${elapsed}ms`.trimEnd(),
  "cli.doctor.healthcheckTimeout": ({ elapsed }: { elapsed: number }): string =>
    `proxy healthcheck: timeout after ${elapsed}ms (proxy may be unreachable; verify $HTTPS_PROXY host:port)`,
  "cli.doctor.healthcheckTls": ({ code }: { code: string }): string =>
    `proxy healthcheck: TLS error (${code}). Set NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem to trust your proxy's intercepting CA.`,
  "cli.doctor.healthcheckRefused":
    "proxy healthcheck: connection refused. Verify the proxy host:port in $HTTPS_PROXY is reachable.",
  "cli.doctor.healthcheckDns": ({ code }: { code: string }): string =>
    `proxy healthcheck: DNS lookup failed (${code}). The proxy host in $HTTPS_PROXY can't be resolved.`,
  "cli.doctor.healthcheckResetTimeout": ({ code }: { code: string }): string =>
    `proxy healthcheck: connection ${code === "ETIMEDOUT" ? "timed out" : "reset"} (${code}).`,
  "cli.doctor.healthcheckFailed": ({ reason }: { reason: string }): string =>
    `proxy healthcheck: failed — ${reason}`,
  "cli.doctor.summary": ({
    ok,
    warn,
    error,
  }: {
    ok: number;
    warn: number;
    error: number;
  }): string => `doctor: ${ok} ok, ${warn} warn, ${error} error`,

  // init result summary / next-steps (#312)
  "cli.init.workspaceReady": ({ cwd }: { cwd: string }): string =>
    `init: workspace ready at ${cwd}`,
  "cli.init.directoriesCreated": ({ dirs }: { dirs: string }): string =>
    `init: directories created: ${dirs}`,
  "cli.init.skillsCopied": ({ files }: { files: string }): string =>
    `init: skills copied: ${files}`,
  "cli.init.filesSkipped": ({ files }: { files: string }): string =>
    `init: files skipped: ${files}`,
  "cli.init.nextSteps":
    "init: next steps — read FEEDRADAR.md for natural-language and slash usage.",

  // items (#312)
  "cli.items.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `items: unknown subcommand '${sub}'`,
  "cli.items.invalidStatus": ({ status, allowed }: { status: string; allowed: string }): string =>
    `items list: invalid --status '${status}' (expected: ${allowed})`,
  "cli.items.invalidSince": ({ since }: { since: string }): string =>
    `items list: invalid --since '${since}' (expected Ns | Nm | Nh | Nd)`,
  "cli.items.noItemsDir": "items list: no items/ directory (run `radar init` first)",
  "cli.items.noMatch": "items list: no items match the filter",

  // watch (#312 / #336)
  // The `--bootstrap`/`--backfill` mutual-exclusion + `--max-pages requires
  // --backfill` errors are thrown from the sync `parseRunArgs` (before a
  // translator is in scope). #336 keys the errors (`WatchArgError.key`) so the
  // caller translates them once the locale is resolved.
  "cli.watch.bootstrapBackfillExclusive": "--bootstrap and --backfill are mutually exclusive",
  "cli.watch.maxPagesRequiresBackfill": "--max-pages requires --backfill",
  "cli.watch.verboseQuietExclusive": "--verbose and --quiet are mutually exclusive",
  "cli.watch.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `watch: unknown subcommand '${sub}'`,
  "cli.watch.bootstrapComplete": ({ sources }: { sources: number }): string =>
    `watch run: bootstrap complete (${sources} sources)`,
  "cli.watch.backfillComplete": ({ total, sources }: { total: number; sources: number }): string =>
    `watch run: backfill complete — ${total} item(s) ingested across ${sources} source(s)`,
  "cli.watch.runComplete": ({ total, sources }: { total: number; sources: number }): string =>
    `watch run: ${total} new item(s) across ${sources} source(s)`,

  // zod-validation error preamble (#312) ------------------------------------
  // The localized issue bodies come from zod's per-locale messages (wired via
  // `applyZodLocale`); only the wrapping preamble lines are translated here.
  "cli.config.schemaViolation": ({ file, issues }: { file: string; issues: string }): string =>
    `${file} schema violation:\n${issues}`,
  "cli.config.failedRead": ({ file, reason }: { file: string; reason: string }): string =>
    `failed to read ${file}: ${reason}`,
  "cli.config.failedParse": ({ file, reason }: { file: string; reason: string }): string =>
    `failed to parse ${file} as YAML: ${reason}`,

  // --- remaining user-facing errors & notifications (#336) ------------------
  // Catalogue of the user-facing validation errors, file/state errors needing
  // user action, and completion notices emitted by research / review / update /
  // source / triage. Internal debug logs / traces (frontmatter parse failures,
  // adapter rollback diagnostics, schema-issue dumps) stay untranslated per the
  // ADR-0021 boundary. The `<cmd>:` prefix is kept verbatim so existing scripts
  // and the test suite key off the stable command tag.

  // shared: invalid --agent (research / review / update / triage all reuse the
  // same adapter id allow-list)
  "cli.agent.invalid": ({ cmd, agent }: { cmd: string; agent: string }): string =>
    `${cmd}: invalid --agent '${agent}' (expected: claude-code | codex-cli | gemini-cli | copilot)`,

  // research (#336)
  "cli.research.batchIncompatiblePositional": ({ count }: { count: number }): string =>
    `research: --batch is incompatible with positional <item-id> arguments (got ${count})`,
  "cli.research.batchIncompatibleDigest": "research: --batch is incompatible with --digest",
  "cli.research.batchIncompatibleTriageGroup":
    "research: --batch is incompatible with --triage-group",
  "cli.research.invalidStatus": ({
    status,
    allowed,
  }: {
    status: string;
    allowed: string;
  }): string => `research: invalid --status '${status}' (expected: ${allowed})`,
  "cli.research.invalidMaxItemsInteger": ({ raw }: { raw: string }): string =>
    `research: invalid --max-items '${raw}' (expected positive integer)`,
  "cli.research.invalidMaxItemsPositive": ({ raw }: { raw: string }): string =>
    `research: invalid --max-items '${raw}' (must be > 0)`,
  "cli.research.commitIncompatibleBatch": "research: --commit is incompatible with --batch",
  "cli.research.commitIncompatibleDigest": "research: --commit is incompatible with --digest",
  "cli.research.commitIncompatibleEmitPayload":
    "research: --commit is incompatible with --emit-payload",
  "cli.research.commitIncompatibleTriageGroup":
    "research: --commit is incompatible with --triage-group",
  "cli.research.commitTakesPath": ({ count, ids }: { count: number; ids: string }): string =>
    `research: --commit takes a <path>, not <item-id> arguments (got ${count}: ${ids})`,
  "cli.research.emitPayloadIncompatibleBatch":
    "research: --emit-payload is incompatible with --batch",
  "cli.research.statusRequiresBatch": "research: --status requires --batch",
  "cli.research.maxItemsRequiresBatch": "research: --max-items requires --batch",
  "cli.research.filterTagsRequiresBatch": "research: --filter-tags requires --batch",
  "cli.research.triageGroupRequiresDigest": "research: --triage-group requires --digest",
  "cli.research.missingItemId": "research: missing <item-id>",
  "cli.research.multipleRequireDigest": ({ count, ids }: { count: number; ids: string }): string =>
    `research: multiple <item-id> arguments require --digest (got ${count}: ${ids})`,
  "cli.research.digestRequiresTwo": ({ count }: { count: number }): string =>
    `research: --digest requires 2 or more <item-id> arguments (got ${count})`,
  "cli.research.itemNotFound": ({ id }: { id: string }): string =>
    `research: item '${id}' not found under items/`,
  "cli.research.digestDismissed": ({ ids }: { ids: string }): string =>
    `research: cannot include dismissed items in a digest: ${ids}`,
  "cli.research.alreadyExists": ({ path }: { path: string }): string =>
    `research: ${path} already exists (use \`radar update\` to re-research)`,
  "cli.research.noItemsMatched": ({ status, tags }: { status: string; tags: string }): string =>
    `research: no items matched --batch filters (status=${status}${tags})`,
  "cli.research.capReached": ({
    maxItems,
    dropped,
    matched,
  }: {
    maxItems: number;
    dropped: number;
    matched: number;
  }): string =>
    `research: --max-items ${maxItems} cap reached; dropping ${dropped} excess item(s) (matched ${matched})`,
  "cli.research.batchWillProcess": ({
    count,
    status,
    tags,
    agent,
    cap,
  }: {
    count: number;
    status: string;
    tags: string;
    agent: string;
    cap: number;
  }): string =>
    `research: --batch will process ${count} item(s) (status=${status}${tags}, agent=${agent}, cap=${cap})`,
  "cli.research.batchHalted": ({ id, exitCode }: { id: string; exitCode: number }): string =>
    `research: --batch halted on item '${id}' (exit ${exitCode})`,
  "cli.research.batchCompleted": ({ count }: { count: number }): string =>
    `research: --batch completed ${count} item(s)`,
  "cli.research.wrote": ({ path }: { path: string }): string => `research: wrote ${path}`,
  "cli.research.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `research: items/${sourceId}/${id}.yaml status -> researched`,

  // review (#336)
  "cli.review.batchIncompatiblePositional": ({ researchId }: { researchId: string }): string =>
    `review: --batch is incompatible with positional <research-id> ('${researchId}')`,
  "cli.review.invalidStatus": ({ status, allowed }: { status: string; allowed: string }): string =>
    `review: invalid --status '${status}' (expected: ${allowed})`,
  "cli.review.invalidMaxItemsInteger": ({ raw }: { raw: string }): string =>
    `review: invalid --max-items '${raw}' (expected positive integer)`,
  "cli.review.invalidMaxItemsPositive": ({ raw }: { raw: string }): string =>
    `review: invalid --max-items '${raw}' (must be > 0)`,
  "cli.review.commitIncompatibleBatch": "review: --commit is incompatible with --batch",
  "cli.review.commitIncompatibleEmitPayload":
    "review: --commit is incompatible with --emit-payload",
  "cli.review.commitTakesPath": ({ researchId }: { researchId: string }): string =>
    `review: --commit takes a <path>, not a <research-id> argument (got '${researchId}')`,
  "cli.review.emitPayloadIncompatibleBatch": "review: --emit-payload is incompatible with --batch",
  "cli.review.statusRequiresBatch": "review: --status requires --batch",
  "cli.review.maxItemsRequiresBatch": "review: --max-items requires --batch",
  "cli.review.filterTagsRequiresBatch": "review: --filter-tags requires --batch",
  "cli.review.missingResearchId": "review: missing <research-id>",
  "cli.review.fileNotFound": ({ path }: { path: string }): string =>
    `review: research file not found: ${path}`,
  "cli.review.batchFoundNone": "review: --batch found no un-reviewed research/*.md files",
  "cli.review.batchMatchedZero": ({ status, tags }: { status: string; tags: string }): string =>
    `review: --batch matched 0 research file(s) (status=${status}${tags})`,
  "cli.review.capReached": ({
    maxItems,
    dropped,
    matched,
  }: {
    maxItems: number;
    dropped: number;
    matched: number;
  }): string =>
    `review: --max-items ${maxItems} cap reached; dropping ${dropped} excess research file(s) (matched ${matched})`,
  "cli.review.batchWillProcess": ({
    count,
    status,
    tags,
    agent,
    cap,
  }: {
    count: number;
    status: string;
    tags: string;
    agent: string;
    cap: number;
  }): string =>
    `review: --batch will process ${count} research file(s) (status=${status}${tags}, agent=${agent}, cap=${cap})`,
  "cli.review.batchHalted": ({
    researchId,
    exitCode,
  }: {
    researchId: string;
    exitCode: number;
  }): string => `review: --batch halted on research '${researchId}' (exit ${exitCode})`,
  "cli.review.batchCompleted": ({ count }: { count: number }): string =>
    `review: --batch completed ${count} research file(s)`,
  "cli.review.commitNotStamped": ({
    id,
    reviewedAt,
    reviewedBy,
  }: {
    id: string;
    reviewedAt: string;
    reviewedBy: string;
  }): string =>
    `review: --commit report '${id}' is not stamped (reviewedAt=${reviewedAt}, reviewedBy=${reviewedBy}); the host session must stamp the review before committing`,
  "cli.review.alreadyReviewed": ({
    id,
    reviewedAt,
    reviewedBy,
  }: {
    id: string;
    reviewedAt: string;
    reviewedBy: string;
  }): string =>
    `review: research '${id}' is already reviewed (reviewedAt=${reviewedAt}, reviewedBy=${reviewedBy})`,
  "cli.review.wroteCommit": ({ path }: { path: string }): string => `review: wrote ${path}`,
  "cli.review.stamped": ({
    path,
    reviewedAt,
    reviewedBy,
  }: {
    path: string;
    reviewedAt: string;
    reviewedBy: string;
  }): string => `review: stamped ${path} reviewedAt=${reviewedAt} reviewedBy=${reviewedBy}`,
  "cli.review.transitioned": ({ sourceId, id }: { sourceId: string; id: string }): string =>
    `review: items/${sourceId}/${id}.yaml status -> reviewed`,

  // update (#336)
  "cli.update.commitIncompatibleEmitPayload":
    "update: --commit is incompatible with --emit-payload",
  "cli.update.commitTakesPath": ({ researchId }: { researchId: string }): string =>
    `update: --commit takes a <path>, not a <research-id> (got '${researchId}')`,
  "cli.update.missingResearchId": "update: missing <research-id>",
  "cli.update.fileNotFound": ({ path }: { path: string }): string =>
    `update: research file not found: ${path}`,
  "cli.update.alreadyExists": ({ path, version }: { path: string; version: number }): string =>
    `update: ${path} already exists. v${version} was already generated — pick a different predecessor or remove the stale file.`,
  "cli.update.commitSupersedesNull":
    "update: --commit report has `supersedes: null`. update finalizes a v+1 (use `radar research --commit` for a v1).",
  "cli.update.wrote": ({ path }: { path: string }): string => `update: wrote ${path}`,
  "cli.update.supersedes": ({ prevId }: { prevId: string }): string =>
    `update: supersedes ${prevId} (items.yaml status unchanged)`,

  // source (#336)
  "cli.source.missingId": ({ sub }: { sub: string }): string => `source ${sub}: missing <id>`,
  "cli.source.invalidId": ({ sub, id }: { sub: string; id: string }): string =>
    `source ${sub}: invalid <id> '${id}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`,
  "cli.source.kindRequired": "source add: --kind is required",
  "cli.source.urlRequired": "source add: --url is required",
  "cli.source.invalidKind": ({ kind }: { kind: string }): string =>
    `source add: invalid --kind '${kind}' (expected: rss | html | html-js | github-releases | npm-registry | json-feed | json-api)`,
  "cli.source.paginationOnlyJsonApi": ({ kind }: { kind: string }): string =>
    `source add: --pagination-* flags are only valid with --kind json-api (got --kind '${kind}')`,
  "cli.source.validationFailed": "source add: validation failed",
  "cli.source.recipeForbiddenFlags": ({
    recipe,
    flags,
  }: {
    recipe: string;
    flags: string;
  }): string =>
    `source add: --recipe '${recipe}' supplies kind / url / structural fields; the following flags are not allowed with --recipe: ${flags}`,
  "cli.source.recipeInvalidSource": ({ recipe }: { recipe: string }): string =>
    `source add: recipe '${recipe}' produced an invalid source`,
  "cli.source.alreadyExists": ({ id }: { id: string }): string =>
    `source add: '${id}' already exists (sources/${id}.yaml)`,
  "cli.source.created": ({ id }: { id: string }): string =>
    `source add: created sources/${id}.yaml`,
  "cli.source.createdFromRecipe": ({ id, recipe }: { id: string; recipe: string }): string =>
    `source add: created sources/${id}.yaml from recipe '${recipe}'`,
  "cli.source.noKeywordsWarn": ({ id }: { id: string }): string =>
    `source add: warning — '${id}' has no keywords; all fetched items will be filtered out. Edit sources/${id}.yaml or re-add with --keywords to start ingesting.`,
  "cli.source.noKeywordsWarnRecipe": ({ id }: { id: string }): string =>
    `source add: warning — '${id}' has no keywords; all fetched items will be filtered out. Re-add with --keywords or edit sources/${id}.yaml to start ingesting.`,
  "cli.source.listNoDir": "source list: no sources directory (run `radar init` first)",
  "cli.source.listNoSources": "source list: no sources defined (use `radar source add ...`)",
  "cli.source.removeNotFound": ({ id }: { id: string }): string =>
    `source remove: '${id}' not found (sources/${id}.yaml)`,
  "cli.source.deleted": ({ id }: { id: string }): string =>
    `source remove: deleted sources/${id}.yaml`,
  "cli.source.testNotFound": ({ id }: { id: string }): string =>
    `source test: '${id}' not found (sources/${id}.yaml)`,
  "cli.source.recipesNone": "source recipes: no recipes bundled (recipes/ is empty or absent)",
  "cli.source.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `source: unknown subcommand '${sub}'`,

  // triage (#336)
  "cli.triage.modesExclusive": "--dry-run / --apply / --interactive are mutually exclusive",
  "cli.triage.verboseQuietExclusive": "--verbose and --quiet are mutually exclusive",
  "cli.triage.commitIncompatibleModes":
    "triage: --commit is incompatible with --dry-run / --apply / --interactive",
  "cli.triage.commitIncompatibleEmitPayload":
    "triage: --commit is incompatible with --emit-payload",
  "cli.triage.emitPayloadIncompatibleModes":
    "triage: --emit-payload is incompatible with --dry-run / --apply / --interactive",
  "cli.triage.emitPayloadSingleSource": ({
    count,
    sources,
  }: {
    count: number;
    sources: string;
  }): string =>
    `triage: --emit-payload requires a single source group, but ${count} sources have detected items (${sources}). Narrow with --source <id>.`,
  "cli.triage.invalidTriageAgent": ({ agent }: { agent: string }): string =>
    `triage: --triage-agent '${agent}' is not a valid agent id (claude-code | codex-cli | gemini-cli | copilot)`,
  "cli.triage.noSourcesDir": "triage: no sources/ directory (run `radar init` first)",
  "cli.triage.noSourcesDefined": "triage: no sources defined; nothing to triage",
  "cli.triage.noItemsDir": "triage: no items/ directory; nothing to triage",
  "cli.triage.noDetectedMatch": "triage: no detected items match the filter (nothing to do)",
  "cli.triage.maxItemsExceeded": ({
    detected,
    maxItems,
  }: {
    detected: number;
    maxItems: number;
  }): string =>
    `triage: ${detected} detected item(s) exceed --max-items ${maxItems}; processing the first ${maxItems} only`,
  "cli.triage.skippingNoPolicy": ({
    count,
    sourceId,
  }: {
    count: number;
    sourceId: string;
  }): string =>
    `triage: skipping ${count} item(s) from source '${sourceId}' (no triagePolicy configured)`,
  "cli.triage.noItemsTriaged": "triage: no items were triaged (all sources skipped)",
  "cli.triage.dryRunNoChanges": "triage: dry-run — no changes written",
  "cli.triage.abortedByUser": "triage: aborted by user",
  "cli.triage.applied": ({ count }: { count: number }): string =>
    `triage: applied ${count} decision(s)`,
  "cli.triage.committed": ({ count, sourceId }: { count: number; sourceId: string }): string =>
    `triage: committed ${count} decision(s) for source '${sourceId}'`,
  "cli.triage.decisionsFileNotFound": ({ path }: { path: string }): string =>
    `triage: decisions file not found: ${path}`,
  "cli.triage.unknownSource": ({ sourceId }: { sourceId: string }): string =>
    `triage: decisions file references unknown source '${sourceId}'`,
  "cli.triage.sourceNoPolicy": ({ sourceId }: { sourceId: string }): string =>
    `triage: source '${sourceId}' has no triagePolicy (cannot validate decisions; pass --policy <path>)`,
  "cli.triage.noItemsDirCommit": "triage: no items/ directory; nothing to commit",
  "cli.triage.noDetectedForSource": ({ sourceId }: { sourceId: string }): string =>
    `triage: no detected items remain for source '${sourceId}' (already triaged, or wrong source?)`,
  "cli.triage.invalidDecisionsAgent": ({ agent }: { agent: string }): string =>
    `triage: decisions file agent '${agent}' is not a valid agent id (claude-code | codex-cli | gemini-cli | copilot)`,
  "cli.triage.feedbackMissingItemId": "triage feedback: missing <item-id>",
  "cli.triage.feedbackModesExclusive":
    "triage feedback: --correct and --wrong are mutually exclusive",
  "cli.triage.feedbackModeRequired": "triage feedback: one of --correct | --wrong is required",
  "cli.triage.feedbackItemsDirNotFound": "triage feedback: items/ not found (run `radar init`)",
  "cli.triage.feedbackItemNotFound": ({ id }: { id: string }): string =>
    `triage feedback: item '${id}' not found under items/`,
  "cli.triage.feedbackNoPriorDecision": ({ id }: { id: string }): string =>
    `triage feedback: item '${id}' has no prior triage decision to give feedback on`,
  "cli.triage.feedbackRecorded": ({
    sourceId,
    id,
    verdict,
  }: {
    sourceId: string;
    id: string;
    verdict: string;
  }): string => `triage feedback: items/${sourceId}/${id}.yaml feedback -> ${verdict}`,
  "cli.triage.statsInvalidSince": ({ since }: { since: string }): string =>
    `triage stats: invalid --since '${since}' (expected Ns | Nm | Nh | Nd)`,
  "cli.triage.statsNoItemsDir": "triage stats: no items/ directory (run `radar init` first)",
  "cli.triage.statsNoMatch": "triage stats: no triaged items match the filter (nothing to report)",

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
                         and .claude/skills/routine-setup/SKILL.md (Claude-only register skill)
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

  // --- audit gap follow-up: dispatcher errors (#342 A1) ---------------------
  // `unknown subcommand` / `unknown type` errors emitted by the workflow /
  // routine dispatchers. The dispatcher already resolved a translator for its
  // help text; these errors now route through it too. The command/subcommand
  // tag (`workflow` / `routine` / `workflow generate` / `routine generate`)
  // stays verbatim so scripts key off the stable prefix.
  "cli.workflow.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `workflow: unknown subcommand '${sub}'`,
  "cli.workflow.unknownType": ({ type }: { type: string }): string =>
    `workflow generate: unknown type '${type}'`,
  "cli.routine.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `routine: unknown subcommand '${sub}'`,
  "cli.routine.unknownType": ({ type }: { type: string }): string =>
    `routine generate: unknown type '${type}'`,

  // --- audit gap follow-up: workflow generate summaries (#342 A2) -----------
  // The generate-completion summary lines (`wrote …`, the key=value detail
  // rows, the "Required secrets" heading, and the post-edit warnings) were
  // English-only even though the locale is resolved. Embedded values
  // (destRel / cron / agent / max-items / secret names) stay verbatim; only
  // the surrounding prose is translated.
  "cli.workflow.generateWatchWrote": ({ path }: { path: string }): string =>
    `workflow generate watch: wrote ${path}`,
  "cli.workflow.generateWatchSummary": ({ cron, agent }: { cron: string; agent: string }): string =>
    `workflow generate watch: cron='${cron}', agent='${agent}'`,
  "cli.workflow.generateWatchOverwriting": ({ path }: { path: string }): string =>
    `workflow generate watch: overwriting existing file ${path}`,
  "cli.workflow.requiredSecretsHeading":
    "Required GitHub Actions secrets (Settings → Secrets and variables → Actions):",
  "cli.workflow.secretCopilotToken":
    "  GITHUB_TOKEN — auto-provisioned by GitHub Actions (no manual setup needed)",
  "cli.workflow.secretAgentKey": ({ envKey, agent }: { envKey: string; agent: string }): string =>
    `  ${envKey} — required for the '${agent}' agent`,
  "cli.workflow.secretGithubTokenAuto":
    "  GITHUB_TOKEN — auto-provisioned by GitHub Actions (no manual setup needed)",
  "cli.workflow.generateCombinedWrote": ({ path }: { path: string }): string =>
    `workflow generate combined: wrote ${path}`,
  "cli.workflow.generateCombinedOverwriting": ({ path }: { path: string }): string =>
    `workflow generate combined: overwriting existing file ${path}`,
  "cli.workflow.detailAgent": ({ agent }: { agent: string }): string => `  agent:       ${agent}`,
  "cli.workflow.detailCron": ({ cron }: { cron: string }): string => `  cron:        ${cron}`,
  "cli.workflow.detailMaxItems": ({ maxItems }: { maxItems: number }): string =>
    `  max-items:   ${maxItems}`,
  "cli.workflow.detailFilterTags": ({ tags }: { tags: string }): string => `  filter-tags: ${tags}`,
  "cli.workflow.filterTagsNone": "(none)",
  "cli.workflow.maxItemsCapWarning": ({ cmd }: { cmd: string }): string =>
    `${cmd}: the --max-items cap is also enforced by \`radar research --batch\`; editing the YAML alone will not raise it`,
  "cli.workflow.generateCombinedWithTriageWrote": ({ path }: { path: string }): string =>
    `workflow generate combined-with-triage: wrote ${path}`,
  "cli.workflow.generateCombinedWithTriageOverwriting": ({ path }: { path: string }): string =>
    `workflow generate combined-with-triage: overwriting existing file ${path}`,
  "cli.workflow.detailWatchCron": ({ cron }: { cron: string }): string =>
    `  watch-cron:     ${cron}`,
  "cli.workflow.detailTriageAgent": ({ agent }: { agent: string }): string =>
    `  triage-agent:   ${agent}`,
  "cli.workflow.detailResearchAgent": ({ agent }: { agent: string }): string =>
    `  research-agent: ${agent}`,
  "cli.workflow.detailReviewAgent": ({ agent }: { agent: string }): string =>
    `  review-agent:   ${agent}`,
  "cli.workflow.detailMaxItemsWide": ({ maxItems }: { maxItems: number }): string =>
    `  max-items:      ${maxItems}`,
  "cli.workflow.detailOutputMode": ({ mode }: { mode: string }): string =>
    `  output-mode:    ${mode}`,
  "cli.workflow.detailSlackWebhook": ({ webhook }: { webhook: string }): string =>
    `  slack-webhook:  ${webhook}`,
  "cli.workflow.slackWebhookNone": "(none — notify step no-ops)",
  "cli.workflow.secretsNoneAutoToken":
    "  (none — every selected agent rides the auto-provisioned GITHUB_TOKEN)",
  "cli.workflow.secretGithubTokenAutoNoSetup": "  GITHUB_TOKEN (auto-provisioned, no setup needed)",

  // --- audit gap follow-up: routine generate summaries (#342 A2) ------------
  // The routine generate completion blocks (`wrote …`, the parameter summary,
  // the Web UI paste instructions, the /schedule note, and the output-gate
  // line) were English-only. Embedded values (destRel / name / repo / cron /
  // model / max-items / output-mode) stay verbatim.
  "cli.routine.generateWatchWrote": ({ path }: { path: string }): string =>
    `routine generate watch: wrote ${path}`,
  "cli.routine.generateWatchSummary": ({
    name,
    repo,
    cron,
    model,
  }: {
    name: string;
    repo: string;
    cron: string;
    model: string;
  }): string =>
    `routine generate watch: name='${name}', repo='${repo}', cron='${cron}', model='${model}'`,
  "cli.routine.generateWatchOverwriting": ({ path }: { path: string }): string =>
    `routine generate watch: overwriting existing file ${path}`,
  "cli.routine.generatePipelineWrote": ({ path }: { path: string }): string =>
    `routine generate pipeline: wrote ${path}`,
  "cli.routine.generatePipelineSummary": ({
    name,
    repo,
    cron,
    model,
    maxItems,
    outputMode,
  }: {
    name: string;
    repo: string;
    cron: string;
    model: string;
    maxItems: number;
    outputMode: string;
  }): string =>
    `routine generate pipeline: name='${name}', repo='${repo}', cron='${cron}', model='${model}', max-items=${maxItems}, output-mode='${outputMode}'`,
  "cli.routine.generatePipelineOverwriting": ({ path }: { path: string }): string =>
    `routine generate pipeline: overwriting existing file ${path}`,
  "cli.routine.autoMergeWarning": ({ cmd }: { cmd: string }): string =>
    `${cmd}: --output-mode auto-merge sets ` +
    "`allow_unrestricted_git_push: true`, but that is NECESSARY, NOT SUFFICIENT — " +
    "you must ALSO turn ON the Web UI 'Allow unrestricted branch pushes' toggle " +
    "(the RemoteTrigger API does not accept this field). Note that unattended AI " +
    "output then lands on the default branch with NO human review.",
  // The Web UI paste flow (shared by watch / pipeline). `path` is the rendered
  // routine's relative path, interpolated into the yq lines.
  "cli.routine.pasteNoApi":
    "Routines has no declarative apply API — paste this routine into the Web UI by hand:",
  "cli.routine.pasteStep1": "  1. Open https://claude.ai/code/routines and click New routine.",
  "cli.routine.pasteStep2":
    "  2. Fill the form fields from the YAML (Name / Model / Repositories / Trigger / Permissions).",
  "cli.routine.pasteStep3":
    "  3. For the multi-line Instructions and Setup script fields, extract them with yq:",
  "cli.routine.pasteYqInstructions": ({ path }: { path: string }): string =>
    `       yq -r '.instructions'             ${path}`,
  "cli.routine.pasteYqSetupScript": ({ path }: { path: string }): string =>
    `       yq -r '.environment.setup_script' ${path}`,
  // --prompt-mode bootstrap (#327): instead of pasting the full instructions
  // into the Web UI Prompt field, paste a SHORT bootstrap prompt that tells the
  // routine to read the committed YAML at run time. The generated YAML's
  // `instructions:` block is unchanged (it stays the runtime source of truth);
  // only the paste guidance differs. The bootstrap prompt body (lines 1-4) is
  // the EXACT text to paste — it must read as a direct second-person command.
  "cli.routine.pasteStep3Bootstrap":
    "  3. For the Instructions field, paste this SHORT bootstrap prompt (prompt-mode bootstrap):",
  "cli.routine.bootstrapPromptLine1": ({ name }: { name: string }): string =>
    `       You are the \`${name}\` routine.`,
  "cli.routine.bootstrapPromptLine2": ({ path }: { path: string }): string =>
    `       Read \`${path}\` in this repository and faithfully execute its top-level`,
  "cli.routine.bootstrapPromptLine3":
    "       `instructions:` block. Run autonomously: AskUserQuestion is NOT available,",
  "cli.routine.bootstrapPromptLine4":
    "       and local MCP servers are NOT available in this environment.",
  "cli.routine.pasteStep3BootstrapSetup":
    "     For the multi-line Setup script field, extract it with yq:",
  "cli.routine.bootstrapReuseNote":
    "     (bootstrap prompt: future instructions edits land via repo commits — no Web UI re-paste needed.)",
  "cli.routine.pasteStep4":
    "  4. After registering, copy the issued routine_id (trig_xxxx) back into the YAML and set status: active.",
  // /routine-setup skill hint (#367): an alternative to the manual Web UI paste
  // flow above. The skill reads the committed YAML and drives the RemoteTrigger
  // API for you, so steps 1-4 collapse into one command. Claude Code only (the
  // RemoteTrigger tool is injected in-process by the Claude Code harness), so
  // this is offered alongside — not instead of — the Web UI flow.
  "cli.routine.setupSkillHint1":
    "Using Claude Code? The /routine-setup skill can automate the steps above:",
  "cli.routine.setupSkillHint2":
    "it reads this YAML and registers (or re-applies) the routine via the RemoteTrigger",
  "cli.routine.setupSkillHint3":
    "API — a Claude-only alternative to the manual Web UI registration.",
  "cli.routine.scheduleNote1":
    "Note on /schedule (Claude Code): it is conversational — `/schedule <description>`",
  "cli.routine.scheduleNote2":
    "to create one, plus `list` / `update` / `run` subcommands. There is no flag-based",
  "cli.routine.scheduleNote3":
    "form (no `--name` / `--cron` / `--repo` arguments). It also cannot ingest this YAML",
  "cli.routine.scheduleNote4":
    "verbatim, so for the long Instructions field the Web UI paste flow above (yq",
  "cli.routine.scheduleNote5":
    "extraction) is the practical path. Finally, the unrestricted-git-push permission an",
  "cli.routine.scheduleNote6":
    "auto-merge routine needs is set only via the Web UI 'Allow unrestricted branch",
  "cli.routine.scheduleNote7": "pushes' toggle — /schedule cannot configure it.",
  "cli.routine.outputGateBranchPr":
    "Output gate: this routine writes to a claude/* branch / PR only — never main directly.",
  "cli.routine.outputGateAutoMerge":
    "Output gate: this routine opens a claude/* PR then squash-merges it to main (review-complete via step 6).",
  "cli.routine.pipelineNoSpawn1":
    "Single Claude session, no spawn: unlike the GHA combined-with-triage",
  "cli.routine.pipelineNoSpawn2":
    "workflow, there is NO cross-agent review here — one Claude does every step.",
  "cli.routine.pipelineItemCaps": ({ maxItems }: { maxItems: number }): string =>
    `Item caps are CLI-enforced: triage --max-items ${maxItems} / items --limit ${maxItems}.`,
  // routine fire result notification (#342 A2-adjacent: fire completion lines)
  "cli.routine.fireTriggered": ({
    routineId,
    status,
  }: {
    routineId: string;
    status: number;
  }): string => `routine fire: triggered ${routineId} (HTTP ${status}).`,
  "cli.routine.fireSessionCreated":
    "The session was created — this call does not wait for it to finish.",

  // --- audit gap follow-up: init operational warnings (#342 A3) -------------
  // Operational warnings emitted while init copies bundled assets / writes the
  // config locale. These are user-facing ("here is what init skipped and why")
  // even though the post-run summary was already localized in #312. Paths are
  // interpolated verbatim.
  "cli.init.bundledSkillNotFound": ({ src }: { src: string }): string =>
    `init: bundled skill not found, skipped: ${src}`,
  "cli.init.bundledClaudeSkillNotFound": ({ src }: { src: string }): string =>
    `init: bundled claude discovery skill not found, skipped: ${src}`,
  "cli.init.bundledGeminiCommandNotFound": ({ src }: { src: string }): string =>
    `init: bundled gemini command not found, skipped: ${src}`,
  "cli.init.bundledTemplateNotFound": ({ src }: { src: string }): string =>
    `init: bundled template not found, skipped: ${src}`,
  "cli.init.skippedExisting": ({ file }: { file: string }): string =>
    `init: skipped existing file (use --force to overwrite): ${file}`,
  "cli.init.skippedClaudeMdNoAgentsMd":
    "init: skipped CLAUDE.md because --no-agents-md was passed (the bundled CLAUDE.md imports @AGENTS.md and would dangle)",
  "cli.init.configLocaleNotYaml": ({ file, reason }: { file: string; reason: string }): string =>
    `init: skipped writing ${file} locale (existing file is not valid YAML: ${reason})`,
  "cli.init.configLocaleNotMapping": ({ file }: { file: string }): string =>
    `init: skipped writing ${file} locale (existing file is not a mapping)`,
  "cli.init.configLocaleSkippedUpdate": ({
    file,
    current,
    locale,
  }: {
    file: string;
    current: string;
    locale: string;
  }): string =>
    `init: skipped updating ${file} locale '${current}' -> '${locale}' (use --force to overwrite)`,

  // --- audit gap follow-up: source list/test/recipes display (#342 A4) ------
  // The `source list -v` / `source test` / `source recipes` display output
  // (field labels, the fetched/filtered/matched summary, the selector-adoption
  // and pagination-preview blocks, and the recipes table headings/prose) were
  // English (or mixed en/ja) literals. Field IDs / values stay verbatim; only
  // labels and prose are translated.
  "cli.source.fieldKind": ({ value }: { value: string }): string => `  kind:           ${value}`,
  "cli.source.fieldUrl": ({ value }: { value: string }): string => `  url:            ${value}`,
  "cli.source.fieldName": ({ value }: { value: string }): string => `  name:           ${value}`,
  "cli.source.fieldTags": ({ value }: { value: string }): string => `  tags:           ${value}`,
  "cli.source.fieldKeywords": ({ value }: { value: string }): string =>
    `  keywords:       ${value}`,
  "cli.source.fieldExcludeKeywords": ({ value }: { value: string }): string =>
    `  excludeKeywords: ${value}`,
  "cli.source.fieldTrustLevel": ({ value }: { value: string }): string =>
    `  trustLevel:     ${value}`,
  "cli.source.fieldLastFetchedAt": ({ value }: { value: string }): string =>
    `  lastFetchedAt:  ${value}`,
  "cli.source.keywordsEmpty": "(none — items will be filtered out)",
  "cli.source.valueNone": "-",
  "cli.source.listHeaderId": "ID",
  "cli.source.listHeaderKind": "KIND",
  "cli.source.listHeaderUrl": "URL",
  "cli.source.listHeaderTags": "TAGS",
  "cli.source.testHeading": ({ id }: { id: string }): string => `source test: ${id}`,
  "cli.source.testCounts": ({
    fetched,
    filtered,
    matched,
  }: {
    fetched: number;
    filtered: number;
    matched: number;
  }): string => `  fetched: ${fetched} / filtered: ${filtered} / matched: ${matched}`,
  "cli.source.facetSweepNotice": ({
    facet,
    testedValue,
    totalValues,
  }: {
    facet: string;
    testedValue: string | number;
    totalValues: number;
  }): string =>
    `source test: facet sweep enabled: testing only ${facet}=${testedValue} (the other ${totalValues} facet value(s) are NOT walked). ` +
    "Range facets test the upper bound (latest value). Run `radar watch run --backfill` to verify every facet value.",
  "cli.source.selectorAdoptionHeading": "  selector adoption:",
  "cli.source.selectorNoCandidate": ({ field }: { field: string }): string =>
    `    ${field}: (no candidate matched)`,
  "cli.source.selectorAdopted": ({ field, path }: { field: string; path: string }): string =>
    `    ${field} ← adopted ${path}`,
  "cli.source.paginationPreviewHeading": "  pagination preview (page 0 only — state not mutated):",
  "cli.source.paginationStrategy": ({ strategy }: { strategy: string }): string =>
    `    strategy:  ${strategy}`,
  "cli.source.paginationNextUrl": ({ nextUrl }: { nextUrl: string }): string =>
    `    nextUrl:   ${nextUrl}`,
  "cli.source.paginationEndOfPagination": "(end of pagination)",
  "cli.source.paginationLinkNext": ({ value }: { value: string }): string =>
    `    Link rel=next: ${value}`,
  "cli.source.paginationNextCursor": ({ value }: { value: string }): string =>
    `    nextCursor: ${value}`,
  "cli.source.paginationAbsent": "(absent)",
  "cli.source.testNoMatched": "  (no matched items)",
  "cli.source.testShowing": ({ shown, total }: { shown: number; total: number }): string =>
    `Showing ${shown} of ${total} matched item(s):`,
  "cli.source.testItemTitle": ({ index, title }: { index: number; title: string }): string =>
    `  ${index}. ${title}`,
  "cli.source.testItemUrl": ({ url }: { url: string }): string => `     url:             ${url}`,
  "cli.source.testItemMatchedKeywords": ({ value }: { value: string }): string =>
    `     matchedKeywords: ${value}`,
  "cli.source.testItemMatchedFields": ({ value }: { value: string }): string =>
    `     matchedFields:   ${value}`,
  "cli.source.testItemContent": ({ value }: { value: string }): string =>
    `     content:         ${value}`,
  "cli.source.testMoreItems": ({ count }: { count: number }): string =>
    `  … ${count} more (raise --limit to see them)`,
  "cli.source.recipesNoValid":
    "source recipes: no valid recipes found (all bundled entries failed to load)",
  "cli.source.recipesHeaderName": "NAME",
  "cli.source.recipesHeaderKind": "KIND",
  "cli.source.recipesHeaderDescription": "DESCRIPTION",
  "cli.source.recipesErrorsHeading": "Recipes with errors:",
  "cli.source.recipesErrorRow": ({ name, error }: { name: string; error: string }): string =>
    `  ${name}: ${error}`,
  "cli.source.recipesErrorUnknown": "(unknown error)",
  "cli.source.recipesApplyHeading": "Apply a recipe with:",
  "cli.source.recipesApplyExample":
    "  radar source add <id> --recipe <name> [--keywords <kw>] [--tags <t>] [--name <display>]",

  // --- audit gap follow-up: triage progress + confirm prompt (#342 A6/B1) ---
  // The per-source triage progress marker and the interactive apply-confirm
  // prompt were English literals. Source id / agent / count stay verbatim.
  "cli.triage.progressTriaging": ({
    count,
    sourceId,
    agent,
  }: {
    count: number;
    sourceId: string;
    agent: string;
  }): string => `Triaging ${count} item(s) from source '${sourceId}' via ${agent}`,
  "cli.triage.confirmApply": "Apply these decisions? [y/N]",

  // --- state prune (#333) ---------------------------------------------------
  /** `radar state` / `radar state prune` help text. */
  "cli.state.help": `Usage: radar state prune <source> --keep <N>

Trim state/<source>.yaml lastSeenIds to its newest N ids (FIFO; oldest dropped first).
Use it to shrink a state file that has already grown large from facet sweeps.

Options:
  --keep <N>          Keep the newest N ids; drop the rest (required)
  --older-than <dur>  Not supported (lastSeenIds carries no per-id timestamps)
  -h, --help          Show this help`,
  /** stderr line when arg parsing fails (unknown flag / missing value). */
  "cli.state.parseError": ({ reason }: { reason: string }): string => `state prune: ${reason}`,
  /** stderr line for an unrecognized `state` subcommand. */
  "cli.state.unknownSubcommand": ({ sub }: { sub: string }): string =>
    `state: unknown subcommand '${sub}'`,
  /** stderr line when `<source>` positional is missing. */
  "cli.state.missingSource": "state prune: missing <source>",
  /** stderr line when neither `--keep` nor a supported mode is given. */
  "cli.state.keepRequired": "state prune: --keep <N> is required",
  /** stderr line when `--older-than` is used (deliberately unimplemented). */
  "cli.state.olderThanUnsupported":
    "state prune: --older-than is not supported (lastSeenIds carries no per-id timestamps); use --keep <N>",
  /** stderr line when `--keep` is not an integer. */
  "cli.state.invalidKeepInteger": ({ raw }: { raw: string }): string =>
    `state prune: --keep expects an integer, got '${raw}'`,
  /** stderr line when `--keep` is not a positive integer. */
  "cli.state.invalidKeepPositive": ({ raw }: { raw: string }): string =>
    `state prune: --keep expects a positive integer, got '${raw}'`,
  /** stderr line when state/<source>.yaml does not exist. */
  "cli.state.sourceNotFound": ({ sourceId }: { sourceId: string }): string =>
    `state prune: no state found for source '${sourceId}' (state/${sourceId}.yaml)`,
  /** Summary line when the list is already within the keep window (no write). */
  "cli.state.pruneNoop": ({
    sourceId,
    count,
    keep,
  }: {
    sourceId: string;
    count: number;
    keep: number;
  }): string =>
    `state prune: '${sourceId}' already has ${count} id(s) (<= --keep ${keep}); nothing to trim`,
  /** Summary line after a successful trim + write. */
  "cli.state.pruneDone": ({
    sourceId,
    before,
    after,
    dropped,
  }: {
    sourceId: string;
    before: number;
    after: number;
    dropped: number;
  }): string =>
    `state prune: '${sourceId}' trimmed lastSeenIds ${before} -> ${after} (${dropped} dropped)`,
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
