English | [日本語](README.ja.md)

# FeedRadar

CLI that watches blogs, official update streams, and release feeds, then hands keyword hits to one of four AI agents (Claude Code / Codex / Gemini / Copilot) to **produce Markdown research reports**.

## Problem it solves

Tracking multiple official blogs, docs, and release notes — and summarizing what actually changed — is a good fit for AI agents, but wiring up source management, diffing, template application, and multi-agent delegation by hand every time gets tedious. `radar` fixes that loop in a CLI and accumulates Markdown reports in your research directory.

## Highlights

- **Multi-agent**: switch between Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI via adapters.
- **Multiple feed kinds**: RSS / HTML / **HTML (JS rendered)** / GitHub Releases / npm registry / **JSON Feed (1.0 / 1.1)** / **JSON API (recipe-driven, with `--backfill` for full history)** are all driven through the same `Source` abstraction ([ADR-0012](./docs/adr/0012-json-api-adapter-and-recipe-strategy.md)).
- **Bundled recipes**: `radar source recipes` lists maintained YAML recipes (e.g. AWS What's New, dev.to) and `radar source add <id> --recipe <name>` applies one in a single line — no boilerplate ([ADR-0012 §D3](./docs/adr/0012-json-api-adapter-and-recipe-strategy.md)).
- **Digest mode**: bundle multiple items hit in a short period — or across feeds on the same topic — into a single cross-cutting report ([ADR-0011](./docs/adr/0011-digest-research-output.md)).
- **User-owned data**: `sources/` `items/` `state/` `research/` `templates/` live in **your workspace directory**. This package ships only the engine.
- **Scheduled workflows**: `radar workflow generate watch` / `combined` emits GitHub Actions YAML on demand — combine watch with auto-research under a hard-capped `--max-items` budget so a runaway feed cannot blow your LLM bill ([ADR-0014](./docs/adr/0014-workflow-generate-and-auto-research-safety.md)).
- **Progress reporting & verbose mode**: long-running commands (`research` / `review` / `update` / `watch run --backfill` / html-js fetch / `source test`) stream phase markers + a spinner + side metrics (`stdout` / `output` / `page x/N`) on stderr. Pass `--verbose` to also stream the agent CLI's stdout/stderr, `--quiet` (or `RADAR_NO_PROGRESS=1` for CI) to silence the reporter ([ADR-0015](./docs/adr/0015-progress-reporting-ux.md)).
- **Single npm package**: distributed as `@ozzylabs/feedradar` via OIDC Trusted Publishers.

## Install

```bash
npm i -g @ozzylabs/feedradar
```

To use the `kind: html-js` adapter (SPA / CSR pages rendered after JS runs), install Playwright separately — it is declared as an *optional* peer dep so users who only need RSS / static HTML do not pay the ~300MB Chromium footprint ([ADR-0010](./docs/adr/0010-html-js-adapter-and-distribution.md)):

```bash
npm i -g playwright
npx playwright install chromium
```

Run `radar doctor` to verify Playwright / Chromium are detected before adding an `html-js` source. CI setup details and a sample workflow are in [docs/user-guide.md → `--kind html-js` → CI で使う](./docs/user-guide.md#ci-で使う).

While developing locally, clone this repo and run `pnpm install && pnpm run build` to produce `dist/index.js`, then invoke `node dist/index.js <command>`.

## Corporate proxy

Behind a corporate HTTP / HTTPS proxy, just export the standard env vars and
run `radar` — it auto-detects them and self-configures (no flags / config
edits). For TLS-intercepting proxies (Zscaler / Netskope / etc.) set
`NODE_EXTRA_CA_CERTS` instead of disabling certificate verification:

```bash
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem   # only if TLS is intercepted
radar doctor                                      # verify
```

NTLM / Kerberos proxies are not supported directly — bridge with `cntlm` / `Px`
/ `Authoxy`. WSL2 → Windows host, `npm install` proxy config, and the live
`radar doctor` healthcheck are documented in
[docs/user-guide/proxy-setup.md](./docs/user-guide/proxy-setup.md).

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
radar source test <id>        # dry-run preview a source (no state/items mutation)
radar research --digest <id1> <id2> ...  # bundle multiple items into one digest report (ADR-0011)
radar dismiss <item-id>       # move an item to dismissed (no LLM)
radar review <research-id>    # cross-review a report with a different agent
radar update <research-id>    # refresh an existing report against the latest item (v+1)
radar doctor                  # check workspace / agent CLI / Playwright / proxy / TLS health
                              #   --no-proxy-check skips the live proxy round-trip (offline-friendly)
radar workflow generate watch     # emit a GitHub Actions watch workflow on demand (ADR-0014)
radar workflow generate combined  # watch + auto-research with --max-items hard cap (ADR-0014)
radar --help                  # help
```

All 9 subcommands are implemented (`init` / `source` / `watch` / `research` / `dismiss` / `review` / `update` / `doctor` / `workflow`). See [docs/user-guide.md](./docs/user-guide.md) for the full spec.

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
  cli/                  init / source / watch / research / dismiss / review / update / doctor / workflow
  core/
    watcher.ts          source → adapter → items
    filter.ts           keyword / excludeKeyword
    items.ts            items load / save
    templates.ts        research template loader
    state.ts            state/<sourceId>.yaml load / save
    config.ts           radar.config.yaml load / validate
    injection-detector.ts  prompt injection regex pre-filter (ADR-0009 M1a)
    feeds/              rss / html / html-js / github-releases / npm-registry / json-feed / json-api
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
- [docs/user-guide/proxy-setup.md](./docs/user-guide/proxy-setup.md) — corporate proxy / TLS interception / NTLM bridge / WSL2 setup
- [docs/release.md](./docs/release.md) — release procedure (manual initial publish + Trusted Publisher registration + subsequent OIDC automation)
- [docs/adr/](./docs/adr/README.md) — FeedRadar design-decision records (Agent / Source / Output / Schedule / User Data / Filter / Skill Bundling / Status State Machine / Untrusted External Content Handling / html-js Adapter / Digest Research / JSON API & Recipes / Workflow Generate / Progress Reporting)

## Conventions

- **Language**: TypeScript ESM / Node.js 22+ / pnpm
- **Commits**: Conventional Commits (enforced via `commitlint`)
- **Branching**: GitHub Flow (`main` + feature branches, squash-merge only)
- **Distribution**: npm `@ozzylabs/feedradar`, OIDC Trusted Publishers (no `NPM_TOKEN`)
- **Shared config**: distributed from [`ozzy-labs/commons`](https://github.com/ozzy-labs/commons) via `sync.sh`
- **Shared skills**: pulled in from [`ozzy-labs/skills`](https://github.com/ozzy-labs/skills) via the `@ozzylabs/skills` Renovate preset

## License

MIT — see [LICENSE](./LICENSE).
