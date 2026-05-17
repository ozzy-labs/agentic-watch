English | [日本語](README.ja.md)

# FeedRadar

> **Status: alpha** — Phases 1-6 complete (7 subcommands × 4 agent adapters × 4 feed kinds + cron scaffolding + [ADR-0009](./docs/adr/0009-untrusted-external-content-handling.md) adoption + `@ozzylabs/feedradar` v0.1.0 published to npm). Subsequent releases publish automatically via OIDC Trusted Publishers in the sibling-style `release.yaml` (procedure: [docs/release.md](./docs/release.md)).

CLI that watches blogs, official update streams, and release feeds, then hands keyword hits to one of four AI agents (Claude Code / Codex / Gemini / Copilot) to **produce Markdown research reports**.

## Problem it solves

Tracking multiple official blogs, docs, and release notes — and summarizing what actually changed — is a good fit for AI agents, but wiring up source management, diffing, template application, and multi-agent delegation by hand every time gets tedious. `radar` fixes that loop in a CLI and accumulates Markdown reports in your research directory.

## Highlights

- **Multi-agent**: switch between Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI via adapters.
- **Multiple feed kinds**: RSS / HTML scraping / GitHub Releases / npm registry are all driven through the same `Source` abstraction.
- **User-owned data**: `sources/` `items/` `state/` `research/` `templates/` live in **your workspace directory**. This package ships only the engine.
- **Single npm package**: distributed as `@ozzylabs/feedradar` via OIDC Trusted Publishers.

## Install

```bash
npm i -g @ozzylabs/feedradar
```

While developing locally, clone this repo and run `pnpm install && pnpm run build` to produce `dist/index.js`, then invoke `node dist/index.js <command>`.

## Usage

```bash
# Quickstart (watch anthropics/anthropic-sdk-python GitHub Releases)
radar init
radar source add anthropic-sdk \
  --kind github-releases \
  --url https://github.com/anthropics/anthropic-sdk-python \
  --keywords "feat,fix,release"
radar watch run
radar research <item-id>

# Other subcommands
radar source list             # list sources
radar dismiss <item-id>       # move an item to dismissed (no LLM)
radar review <research-id>    # cross-review a report with a different agent
radar update <research-id>    # refresh an existing report against the latest item (v+1)
radar --help                  # help
```

All 7 subcommands are implemented. See [docs/user-guide.md](./docs/user-guide.md) for the full spec.

## Development

```bash
pnpm install            # install dependencies
pnpm run build          # tsc build (dist/)
pnpm run typecheck      # type check
pnpm run test           # vitest run

# Invoking the CLI locally (after build)
pnpm radar --help        # = node dist/index.js --help (package.json scripts alias)
node dist/index.js --help        # equivalent
```

> The local `pnpm radar <cmd>` form is the `package.json` `scripts.radar` alias (`node dist/index.js`) and requires you to have run `pnpm run build` first to produce `dist/index.js`. The distributed `radar <cmd>` that end users invoke after `npm i -g @ozzylabs/feedradar` goes through `package.json` `bin.radar`, which points at the published `dist/`, so no build step is needed there. The two share a name but belong to different layers. Note also that `pnpm --prefix <path> radar <cmd>` switches CWD to `<path>` *before* running scripts, so when you want the scripts alias to run in a different directory (for example a smoke-test scratch workspace) you must call `node <repo-root>/dist/index.js <cmd>` directly — using `pnpm --prefix` would cause `init` et al. to run against the repo root by accident.

## Architecture overview

```text
src/
  index.ts              CLI entry point (#!/usr/bin/env node)
  cli/                  init / source / watch / research / dismiss / review / update
  core/
    watcher.ts          source → adapter → items
    filter.ts           keyword / excludeKeyword
    items.ts            items load / save
    templates.ts        research template loader
    state.ts            state/<sourceId>.yaml load / save
    config.ts           radar.config.yaml load / validate
    injection-detector.ts  prompt injection regex pre-filter (ADR-0009 M1a)
    feeds/              rss / html / github-releases / npm-registry
  agents/               4 CLI adapters (claude-code / codex-cli / gemini-cli / copilot)
  schemas/              Zod schemas (Source / Item / State / Research)
  skills/               engine SKILL bundle (research / review / update; init copies into .agents/skills/)
  claude-skills/        Claude Code slash-command wrappers (init copies into .claude/skills/)
  gemini-commands/      Gemini CLI TOML slash-command wrappers (init copies into .gemini/commands/)
  templates/            default workspace templates (init copies into templates/)
```

## Documentation

- [docs/architecture.md](./docs/architecture.md) — system diagrams / module responsibilities / data flow / per-phase scope
- [docs/user-guide.md](./docs/user-guide.md) — install / quickstart / command reference
- [docs/release.md](./docs/release.md) — release procedure (manual initial publish + Trusted Publisher registration + subsequent OIDC automation)
- [docs/adr/](./docs/adr/README.md) — FeedRadar design-decision records (Agent / Source / Output / Schedule / User Data / Filter / Skill Bundling / Status State Machine / Untrusted External Content Handling)

## Conventions

- **Language**: TypeScript ESM / Node.js 22+ / pnpm
- **Commits**: Conventional Commits (enforced via `commitlint`)
- **Branching**: GitHub Flow (`main` + feature branches, squash-merge only)
- **Distribution**: npm `@ozzylabs/feedradar`, OIDC Trusted Publishers (no `NPM_TOKEN`)
- **Shared config**: distributed from [`ozzy-labs/commons`](https://github.com/ozzy-labs/commons) via `sync.sh`
- **Shared skills**: pulled in from [`ozzy-labs/skills`](https://github.com/ozzy-labs/skills) via the `@ozzylabs/skills` Renovate preset

## License

MIT — see [LICENSE](./LICENSE).
