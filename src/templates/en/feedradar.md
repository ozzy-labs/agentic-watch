# FeedRadar workspace

This directory is a **user workspace** where [`radar`](https://github.com/ozzy-labs/feedradar)
runs feed watching -> AI-agent research-report generation. This document is a
usage guide for the human who initialized the workspace; it is a separate layer
from `AGENTS.md` / `CLAUDE.md` (which are for AI agents).

## Premise: agent-driven is first-class

FeedRadar is a CLI, but its **primary usage style is to ask an AI agent
(Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI) in natural language
or via slash commands**. Direct CLI invocation remains for scheduled execution
and CI automation; it is generally not used for interactive triage.

Reasons:

- Triage involves judgment, so it is more natural for an AI agent to read items
  and choose research / dismiss
- Each agent's interactive session is auto-fed this workspace's context via
  `AGENTS.md` / `CLAUDE.md`, so the user can ask in natural language like
  "look into the latest Anthropic news"
- The same slash commands work across all 4 agents, so switching agents is cheap

## Setup in one minute

```bash
# (a) Add one watch target (e.g. Anthropic news RSS)
radar source add anthropic-news --kind rss --url https://anthropic.com/news/rss.xml --keywords "Claude Code,agents"

# (b) Fetch and accumulate new items into items/
radar watch run

# (c) Then just ask an AI agent (next section)
```

`source add` and `watch run` stay as CLI commands, anticipating scheduler
integration. If you init with `--with-actions` / `--with-routines`, you get
scaffolds for periodic execution via GitHub Actions / Claude Routines. If you
later need to add a workflow / switch cadence / chain watch + automated
research, you can retroactively generate them with
`radar workflow generate watch | combined`.

## Main operation: ask an agent

Launch your preferred agent CLI in the workspace directory and, inside the
interactive session, give instructions in one of the following ways.

### A. Ask in natural language (recommended)

The agent has read the workspace context via `AGENTS.md` / `CLAUDE.md`, so it
can resolve even vague instructions like the following to slash commands.

```text
> Pick one Claude Code related item from the new items and research it
> I want to review the latest research with a different agent
> v1 is stale, update it with the latest info
> This item is unnecessary, dismiss it
```

The agent internally calls a slash command like `/research <item-id>` and
reports the result to the user. You do not need to remember the `<item-id>`.

### B. Type slash commands directly

If you know the item-id / research-id, you can call them directly via slash.

| Slash | Role |
|---|---|
| `/research <item-id> [--agent <id>] [--template <id>]` | Generate a research report (status: `detected -> researched`) |
| `/review <research-id> [--agent <id>]` | Append a review from another agent to an existing report (status: `researched -> reviewed`) |
| `/update <research-id> [--agent <id>]` | Generate `_v<N+1>.md` with the latest info (older versions are immutable) |
| `/dismiss <item-id>` | Move an unnecessary item to the `dismissed` terminal state (no LLM needed) |

`<agent>` is one of `claude-code` / `codex-cli` / `gemini-cli` / `copilot`.
When omitted, it uses `defaultResearchAgent` / `defaultReviewAgent` from
`radar.config.yaml`, or `claude-code` if unset.

### Per-agent slash trigger forms

No matter which agent you launch, the same slash resolves to the same CLI
behavior (only the trigger form and read path differ).

| Agent | Launch | In session | File read |
|---|---|---|---|
| Claude Code | `claude` | `/research <item-id>` | `.claude/skills/research/SKILL.md` |
| Copilot CLI | `copilot` | `/research <item-id>` | `.claude/skills/` and `.agents/skills/` (reads both) |
| Gemini CLI | `gemini` | `/research <item-id>` | `.gemini/commands/research.toml` |
| Codex CLI | `codex` | `$research` mention or `/skills` panel | `.agents/skills/research/SKILL.md` (dual-mode) |

### Recommended: cross-agent operation

Asking **different agents** for research and review is recommended. In natural
language:

```text
> Research the most recent item with copilot, and have claude review the generated report
```

To call directly via slash:

```bash
# (inside the interactive session)
/research <item-id> --agent copilot
/review <research-id> --agent claude-code
```

This mutually corrects a single agent's blind spots (bias toward particular
sources, missed terminology).

## Typical workflow

```text
1. (scheduler or manual)  radar watch run
       -> new entries are written to items/ as detected

2. (agent interactive)  "Research something interesting from the new items"
       -> /research <item-id> runs, research/<YYYYMMDD>_<slug>_v1.md is generated
       -> items/.../*.yaml transitions to researched

3. (agent interactive, with a different agent)  "Cross-review the report from earlier"
       -> /review <research-id> --agent <other agent> runs
       -> a "## Review" section is appended to the research file, frontmatter stamped
       -> items/.../*.yaml transitions to reviewed

4. (optional, when info has been updated over time)  "Update with the latest"
       -> /update <research-id> runs, _v2.md is generated (v1 is immutable)
```

For unnecessary items, run `/dismiss <item-id>` or ask in natural language
("this item is unnecessary") to transition them to the terminal state.

## CLI-based (for scheduling / CI)

In automation contexts that do not launch an agent, call the CLI directly.
`radar <subcommand> --help` prints the help for every command.

```bash
radar source add <id> --kind <rss|html|html-js|github-releases|npm-registry|json-feed|json-api> --url <url> [options]
radar source add <id> --recipe <name> [--keywords ... --tags ... --name ...]  # Add a source in one line from a bundled recipe
radar source list
radar source recipes                                  # List bundled recipes
radar source test <id> [--limit N] [--show-content]
radar source remove <id>
radar watch run [--source <id>] [--bootstrap | --backfill [--max-pages N]] [-v|--verbose | -q|--quiet]
radar research <item-id> --agent <agent> [--verbose | --quiet]    # Progress display / stdout pass-through enabled with --verbose
radar research --digest <item-id> <item-id> ... [--agent <agent>]   # Bundle multiple items into one digest
radar review <research-id> --agent <agent> [--verbose | --quiet]
radar update <research-id> --agent <agent> [--verbose | --quiet]
radar dismiss <item-id>
radar research --batch [--max-items N] [--filter-tags <list>] [--agent <agent>] [--verbose | --quiet]  # Bulk-research detected items
radar workflow generate watch [--cron "<expr>"] [--agent <agent>] [--output <path>]            # Retroactively generate a GitHub Actions watch scaffold
radar workflow generate combined [--watch-cron "<expr>"] [--max-items N] [--filter-tags <list>] [--agent <agent>] [--output <path>]   # Generate watch + automated research with a --max-items hard cap
```

JSON API is recipe-based: choose `kind: json-api` and write `pagination` in the
YAML. Sites that comply with the JSON Feed 1.0 / 1.1 standard work with just a
URL — a zero-config kind (`kind: json-feed`). For full past ingestion, use
`radar watch run --backfill` (supports kind: json-api / github-releases /
npm-registry).

Long-running commands (`research` / `review` / `update` / `watch run --backfill`
/ html-js fetch / `source test`) display phase markers + a spinner + side
metrics (`stdout` / `output` / `page x/N`) on stderr. Behavior is switched in
priority order env > flag > TTY auto-detect:

- `--verbose` (or `-v`): pass through the agent CLI / Playwright stdout/stderr.
  The first move when debugging or when it "looks frozen"
- `--quiet` (or `-q`): silence the reporter entirely, keeping only the CLI's
  traditional one-line log
- `RADAR_NO_PROGRESS=1` (env): a stronger escape hatch than the above. For cases
  where you want to turn off only the reporter in a CI script without removing
  the flags

For details and troubleshooting (e.g. what to do when it looks stuck at
`Agent running [mm:ss]`), see
[docs/user-guide.md -> Progress display / verbose / quiet](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md#progress-display--verbose--quiet).

Scaffolds for periodic execution (GitHub Actions / Claude Routines) can be
generated as an initial bootstrap with `radar init --with-actions` /
`--with-routines`. If you later want to switch cadence / have multiple
coexisting workflows / add `combined` (watch + automated research), use
`radar workflow generate <type>`. `combined` bakes in the `--max-items` hard cap
as double defense via a YAML literal + CLI default, so it blocks LLM cost
explosions from a runaway feed (a publisher-side bug / a `--backfill` accident)
at the design level. For Claude Routines, Claude Code users can automate
registration (and re-registration) from the committed YAML with the
`/routine-setup` skill instead of hand-pasting into the Web UI; see
[docs/user-guide.md -> Automating registration in Claude Code](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md#claude-code-で登録を自動化するroutine-setup-skill).

## Layout of this directory

```text
.
├── sources/              # Watched-site definitions (YAML)
├── state/                # Seen IDs / etags (for diff detection)
├── items/                # Detected articles (YAML, status-managed)
├── research/             # Research reports (Markdown + frontmatter)
├── templates/            # Markdown templates (editable)
├── .agents/skills/       # Engine SKILLs shared by all 4 CLIs (SSoT)
├── .claude/skills/       # Slash-command wrappers for Claude Code / Copilot CLI
├── .gemini/commands/     # Slash-command definitions for Gemini CLI (TOML)
├── AGENTS.md             # Workspace instructions for AI agents
├── CLAUDE.md             # For Claude Code (imports @AGENTS.md)
└── FEEDRADAR.md      # This file (human-facing guide)
```

## Data management policy

We recommend committing `sources/` `items/` `state/` `research/` `templates/`
to git. Reasons:

- Scheduled runners (Claude Routines / GitHub Actions) do a fresh clone on every
  run, so if `lastSeenIds` in `state/*.yaml` is not carried over, every run
  re-detects everything from scratch
- Managing `research/` in git lets you track the history and diffs of past reports
- The status transitions of `items/` (`detected -> researched -> reviewed`) also
  remain in git history

`init` places a `.gitkeep` in `sources/` `items/` `state/` `research/`, so you
can preserve the directory structure on `git add .`.

## Security warning

The external feeds that FeedRadar fetches (RSS / HTML / HTML (JS-rendered,
`kind: html-js`) / GitHub Releases / npm registry / JSON Feed / JSON API) are
treated as **untrusted**. Because an attacker could plant a prompt injection in
the feed content:

- Registering only trusted official sources is the first line of defense
- You can opt in per source via `trustLevel: trusted` in `sources/<id>.yaml`
  (default `untrusted`)
- Human-review generated `research/*.md` before using it for operational decisions

## Learn more

- Full command spec: [`docs/user-guide.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/user-guide.md)
- Design decisions (ADR): [`docs/adr/`](https://github.com/ozzy-labs/feedradar/blob/main/docs/adr/README.md)
- Architecture: [`docs/architecture.md`](https://github.com/ozzy-labs/feedradar/blob/main/docs/architecture.md)
