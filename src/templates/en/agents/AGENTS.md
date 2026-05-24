# AGENTS.md

This file holds the agent-agnostic, workspace-wide instructions that AI agents
(Codex CLI / Gemini CLI / GitHub Copilot CLI, etc.) auto-read. Claude Code
reads `CLAUDE.md` separately, but the industry-standard pattern is to pull this
file in from `CLAUDE.md` via `@AGENTS.md`.

## What this directory is

This directory is a **user workspace** for [`radar`](https://github.com/ozzy-labs/feedradar).
`radar` is a CLI tool that watches blogs, official updates, and release feeds,
hands keyword hits to an AI agent, and generates Markdown research reports.

This directory contains:

```text
.
├── sources/           # Watched-site definitions (YAML)
├── state/             # Seen IDs / etags (for diff detection)
├── items/             # Detected articles (YAML)
├── research/          # Research reports (Markdown + frontmatter)
├── templates/         # Markdown templates (editable)
├── .agents/skills/    # Engine SKILLs shared by all 4 CLIs (SSoT)
├── .claude/skills/    # Slash-command wrappers for Claude Code / Copilot CLI
├── .gemini/commands/  # Slash-command definitions for Gemini CLI (TOML)
└── FEEDRADAR.md   # Human-facing workspace guide (a separate layer from this AGENTS.md)
```

## Basic instructions for agents

Users make requests in **natural language**, like "research the latest
Anthropic news" or "this item is unnecessary, dismiss it." Memorizing and
typing CLI commands is not the user's job. Agents should behave as follows:

1. **Map the natural-language intent to a slash command** — decide which of
   research / review / update / dismiss it corresponds to
2. **Resolve the required arguments (item-id / research-id)** — when the user
   does not know the exact id, read `items/` / `research/` to identify it
3. **Run the slash command** — call `/research <item-id>` etc. and report the
   result to the user
4. **Confirm when there are multiple candidates** — if there are several
   "recent items", present the candidates and let the user choose

Calling via slash commands ensures the CLI's schema validation, status
transitions, and rollback all apply. Avoid low-level operations like editing
`items/*.yaml` directly; always go through the slash commands.

## Key commands

```bash
# Initialize a workspace
radar init                          # Default: generate CLAUDE.md + AGENTS.md + FEEDRADAR.md + skills + templates/default.md + dirs
radar init --lang en                # Place English templates / docs (default)
radar init --lang ja                # Place Japanese templates / docs
radar init --no-agents-md           # Skip generating AGENTS.md (CLAUDE.md is auto-skipped too)
radar init --no-claude-md           # Skip generating CLAUDE.md
radar init --no-feedradar-md    # Skip generating FEEDRADAR.md (human-facing guide)
radar init --no-claude-skills       # Skip .claude/skills/
radar init --no-gemini-commands     # Skip .gemini/commands/
radar init --no-templates           # Skip generating templates/default.md
radar init --with-routines          # Generate .claude/routines/watch-daily.yaml
radar init --with-actions           # Generate .github/workflows/watch.yaml
radar init --force                  # Overwrite existing files

# Manage watched targets
radar source add <id> --kind <rss|html|html-js|github-releases|npm-registry|json-feed|json-api> --url <url> [options]
radar source list
radar source recipes                                   # List bundled recipes
radar source add <id> --recipe <name> [--keywords ... --tags ... --name ...]  # Add a source in one line from a recipe
radar source test <id> [--limit N] [--show-content]   # Try fetch + filter without touching state/items
radar source remove <id>

# Add a JSON API recipe with pagination
# `facets:` (per-year / per-category sweep) cannot be set via flags — recipe only
radar source add aws-whats-new --kind json-api \
  --url "https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new-v2&size=100&page=0" \
  --keywords "Bedrock,Claude" \
  --pagination-strategy page --page-size 100 --max-pages 30

# The same thing in one line via a bundled recipe (with year facet sweep, covering all 21,834 entries)
radar source add aws-watch --recipe aws-whats-new --keywords "Bedrock,Claude"

# JSON Feed (1.0 / 1.1) is zero-config, working with just a URL
radar source add example-microblog --kind json-feed \
  --url https://example.micro.blog/feed.json \
  --keywords "release"

# Run a watch (detect new entries -> write to items/*.yaml as detected)
radar watch run

# Bulk-ingest the full past history (kind: json-api / github-releases / npm-registry)
# AWS fully covers 21,834 entries via the recipe's facets.year + per-facet maxPages=30
radar watch run --source aws-whats-new --backfill

# Operations on detected items
radar research <item-id> --agent <agent> [--verbose]   # Generate a research report (status: detected -> researched). Use --verbose to see agent stdout directly
radar research --digest <item-id> <item-id> ... [--agent <agent>]  # Bundle multiple items into one digest
radar research --batch [--max-items N] [--filter-tags <list>] [--agent <agent>]  # Bulk-research detected items (--max-items default 10)
radar review <research-id> --agent <agent>   # Review an existing report (status: researched -> reviewed)
radar update <research-id> --agent <agent>   # Generate v+1 (does not change item status)
radar dismiss <item-id>                       # No LLM needed; mark item as dismissed

# Retroactively generate a GitHub Actions workflow
radar workflow generate watch [--cron "<expr>"] [--agent <agent>] [--output <path>]
radar workflow generate combined [--watch-cron "<expr>"] [--max-items N] [--filter-tags <list>] [--agent <agent>] [--output <path>]
```

> **Cost control for automated research (important)**: `radar workflow generate combined`
> generates a workflow that chains watch -> automated research, baking in the
> `--max-items N` (default 10) hard cap as **double defense** via a YAML literal +
> CLI default. Before passing a large value like `--max-items 100`, always set up
> a billing alert with your agent provider. If you notice a runaway, stop the
> workflow immediately from the GitHub UI via `Disable workflow`. See
> "[`radar workflow generate`](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md#radar-workflow-generate)"
> in `docs/user-guide.md` for details.
>
> **Progress display**: `research` / `review` / `update` / `watch run --backfill` /
> html-js fetch / `source test` print phase markers + a spinner + side metrics
> (`stdout` / `output` / `page x/N`) to stderr. Use `--verbose` to pass through
> agent stdout (the first move when debugging or when it "looks frozen"), and
> `--quiet` or `RADAR_NO_PROGRESS=1` to silence it entirely. See
> "[Progress display / verbose / quiet](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md#progress-display--verbose--quiet)"
> in `docs/user-guide.md` for details.

`<agent>` values: `claude-code` / `codex-cli` / `gemini-cli` / `copilot`

## Available slash commands (shared across 4 agents)

These are thin wrappers placed at `init` time. They can be invoked in the
interactive session of any of Claude Code / Copilot CLI / Gemini CLI / Codex CLI
(the trigger form and read path differ per agent, but they all ultimately
resolve to the same `radar <subcommand>`):

| Slash | Behavior |
|---|---|
| `/research <item-id> [--agent ...]` | Calls `radar research` |
| `/review <research-id> [--agent ...]` | Calls `radar review` |
| `/update <research-id> [--agent ...]` | Calls `radar update` |
| `/dismiss <item-id>` | Calls `radar dismiss` (no LLM needed) |

| Agent | Trigger form | File read |
|---|---|---|
| Claude Code | `/research <id>` | `.claude/skills/research/SKILL.md` |
| Copilot CLI | `/research <id>` | `.github/skills/` / `.claude/skills/` / `.agents/skills/` (auto-reads all three) |
| Gemini CLI | `/research <id>` | `.gemini/commands/research.toml` |
| Codex CLI | `$research` mention / `/skills` panel | `.agents/skills/research/SKILL.md` (dual-mode) |

The procedure body itself references `.agents/skills/<name>/SKILL.md` (the
engine SKILL) as the SSoT.

## Typical workflow

**During a user conversation (interactive, agent-driven):**

```text
1. User: "Research something interesting from the latest Anthropic news"
   -> Agent: read items/, pick the matching item, run /research <item-id>

2. User: "I want to review the current report with a different agent"
   -> Agent: if it remembers the last research-id, run /review <research-id> --agent <other agent>
            if not, identify the latest from research/

3. User: "v1 is stale, update it"
   -> Agent: run /update <research-id> (a new _v2.md is generated, v1 is immutable)

4. User: "This item is unnecessary"
   -> Agent: run /dismiss <item-id>
```

**Scheduled execution / CI (direct CLI invocation):**

```text
radar watch run               # Detect new entries (write to items/*.yaml as detected)
radar research <item-id>      # Automated triage is not recommended (needs user judgment)
```

`watch run` is meant to be called from cron / GitHub Actions / Claude Routines.
`research` / `review` / `update` / `dismiss` involve human judgment, so going
through an interactive session is recommended.

### Example scheduled triage workflow

If you have registered a source with a `triagePolicy:`, you can run
`watch -> triage -> research -> review` **unattended** via a scheduled GHA cron.
Generate a scaffold with `radar workflow generate combined-with-triage`:

```bash
radar workflow generate combined-with-triage \
  --watch-cron "0 6 * * *" \
  --triage-agent gemini-cli \
  --research-agent claude-code \
  --review-agent codex-cli \
  --max-items 10
# -> .github/workflows/feedradar-daily.yaml
```

The 5 steps the generated workflow runs in one cron tick:

```text
1. radar watch run                                            # new entries -> detected
2. radar triage --apply --triage-agent gemini-cli             # detected -> triaged_research / triaged_digest / triaged_unsure / dismissed
3. radar research --batch --status triaged_research \
     --max-items 10 --agent claude-code                       # triaged_research -> researched (1 item, 1 report)
4. radar research --digest <ids per triage.group> \
     --agent claude-code                                      # triaged_digest -> researched (one report aggregated per group)
5. radar review --batch --status researched --agent codex-cli # researched -> reviewed (cross-agent)
```

At the end there is an `if: always()` step that Slack-notifies the
`triaged_unsure` queue depth, and a step using `peter-evans/create-pull-request@v6`
to bundle `items/ state/ research/` into a single PR. **Triage cost is 1-2
orders of magnitude cheaper than research** (the cheap-model channel, assuming
`gemini-2.5-flash-lite`, stays under \$0.10 even for thousands of items per
month), so the primary cost-gating defense is still `--max-items`.

See [`docs/user-guide.md` §triage workflow](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md#triage-workflow)
in the `radar` repo for details, secrets setup, how to write policies, cost
estimates, and troubleshooting.

## Agent selection guide (cross-agent review)

We recommend running `research` and `review` with **different agents**:

```bash
radar research <item-id> --agent codex-cli
radar review <research-id> --agent claude-code
```

Reasons:

- You can mutually correct a single agent's blind spots (dependence on
  particular sources, training-data bias)
- The review does not carry the same "assumptions" as the agent that wrote the
  research
- If you have contracts with multiple plans, you can spread the resource use

The CLI does not force the agent choice — it is the user's decision.

## Data management policy

We recommend that you **commit `sources/` `items/` `state/` `research/`
`templates/` to git in this directory**. Reasons:

- Scheduled runners (Claude Routines / GitHub Actions) do a fresh clone on every
  run, so if `lastSeenIds` in `state/*.yaml` is not carried over, every run
  re-detects everything from scratch
- Managing `research/` in git lets you track the history and diffs of past
  reports (it adopts an immutable history)
- The status transitions of `items/` (`detected` -> `researched` -> `reviewed`)
  also remain in git history

`init` places a `.gitkeep` placeholder in `sources/` `items/` `state/`
`research/`, so even in the initial (empty) state the directory structure is
tracked and not lost on `git add .`.

See [`docs/user-guide.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md)
in the `radar` repo for details.

## Security warning (untrusted external content)

The content of external feeds that `radar` fetches (RSS / HTML / HTML
(JS-rendered, `kind: html-js`) / GitHub Releases / npm registry / JSON Feed /
JSON API) is treated as **untrusted**. Because an attacker could plant a prompt
injection in the feed content:

- Content handed to the agent is wrapped in boundary markers, separating it from
  the procedure body
- You can specify `"trusted" | "untrusted"` per source via `trustLevel` in
  `sources/<id>.yaml` (default `"untrusted"`)
- When the agent runs, the SKILL instructs it not to follow instructions within
  untrusted content

Even so, the content of generated `research/*.md` should be human-reviewed
before being used for operational decisions.

## Documentation pointers

For details and the rationale behind design decisions, see the following under
the `radar` repo:

- [`docs/user-guide.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md) — reference for all commands, scheduler scaffolds, auth setup
- [`docs/architecture.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/architecture.md) — module layout, data flow, per-phase scope
- [`docs/adr/`](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/README.md) — records of design decisions
- [`docs/design/`](https://github.com/ozzy-labs/feedradar/tree/main/docs/design) — `filter-spec.md` / `skill-design.md` / `threat-model.md`
