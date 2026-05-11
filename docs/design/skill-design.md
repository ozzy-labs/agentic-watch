# Skill Design — `.agents/skills/` Bundling and Agent Invocation

Status: **draft v2** (Phase 2 — `review` command implementation, [#29](https://github.com/ozzy-labs/agentic-watch/issues/29))
Tracks: [#9](https://github.com/ozzy-labs/agentic-watch/issues/9) §2 / §3 (subset)

This document is the implementation-side companion to [ADR-0001](../adr/0001-agent-adapter-interface.md), [ADR-0003](../adr/0003-output-format-and-versioning.md), and [ADR-0007](../adr/0007-skill-bundling-and-init-distribution.md). It pins down the concrete contract between the CLI, the bundled SKILL.md files, and each agent CLI's child process. Phase 1 pinned `research`; Phase 2 pins `review` (this revision); `update` remains a stub and will be normalised in Phase 4.

## 1. Research SKILL.md — prompt body

[`src/skills/research/SKILL.md`](../../src/skills/research/SKILL.md) is the canonical research procedure shipped to every workspace. The CLI does **not** embed procedure text in the prompt; it only points the agent at this file. This keeps prompt drift out of the codebase: editing the SKILL is enough to change behaviour across all four agent CLIs.

The CLI-side wrapper prompt is intentionally thin. Concretely, [`src/agents/claude-code.ts`](../../src/agents/claude-code.ts) emits:

```text
Run the `.agents/skills/research/SKILL.md` skill to produce a Markdown
research report from the supplied detected items.

Inputs (one JSON document on stdin):
  - agent:        the agent id you are running as
  - templateId:   research template id (e.g. `default`)
  - templateBody: contents of templates/<templateId>.md, or empty string
                  if the workspace did not provide one (use SKILL default)
  - items:        validated Item objects (see src/schemas/item.ts)
  - outputPath:   absolute path where you MUST write the report

Items to research: <id list>
Write the Markdown report to: <outputPath>

Constraints:
  - Follow `.agents/skills/research/SKILL.md` exactly for layout and
    frontmatter; ADR-0003 is the canonical format spec.
  - Set frontmatter fields `reviewedAt: null` and `reviewedBy: null`.
    The `review` command (Phase 2) stamps those later.
  - Do not modify items/*.yaml — the CLI handles the status transition.
```

Rationale:

- **Procedure stays in SKILL.md.** The wrapper says "execute this skill", not "do these steps". Future tweaks to the procedure ship via a SKILL.md update through `@ozzylabs/skills` and `agentic-watch init --force`.
- **Inputs travel on stdin as one JSON document.** Argv has length limits and quoting hazards; env vars leak into agent tool calls; stdin is universally supported by every agent CLI's `-p` invocation. Tests can produce the JSON deterministically.
- **`outputPath` is repeated in the prompt** even though it is also in the stdin JSON. Empirically, agents key on the human-readable phrasing for filesystem writes; the JSON keeps it machine-readable. The duplication is cheap.

## 2. Init copy strategy

[`src/cli/init.ts`](../../src/cli/init.ts) ships three SKILL.md files into the workspace:

```text
.agents/skills/research/SKILL.md
.agents/skills/review/SKILL.md   (Phase 1 stub; canonicalised in Phase 2)
.agents/skills/update/SKILL.md   (Phase 1 stub; canonicalised in Phase 4)
```

Rules:

- **Existing files are protected.** A SKILL.md that the user has edited is skipped with a warning. `--force` opts in to overwrite, which is the documented path for picking up an upstream SKILL update after a `pnpm up` / Renovate bump.
- **No silent merge.** If we ever need three-way merge of user edits with upstream changes, we would add it as a separate `init --merge-skills` flow rather than smuggling it into the default `init`.
- **Diff display is not implemented in Phase 1.** When users disagree with `--force` overwriting, they can rely on `git diff` (workspaces are expected to be git-managed). Adding a built-in diff is a Phase 2 nice-to-have.

## 3. `allowed-tools` recommendations

Every bundled SKILL.md declares the tools it needs in its frontmatter. The Phase 1 baseline is:

```yaml
allowed-tools: Read,Grep,Bash,WebFetch
```

Rationale:

- `Read` / `Grep`: the agent must read `items/<id>.yaml`, `sources/<id>.yaml`, and (in `review`) the existing research file.
- `Bash`: required for the agent to write the output Markdown via `cat <<EOF > path` or equivalent; some agent CLIs expose file writes only through Bash.
- `WebFetch`: required for fetching the article URL and related docs.

Agent-by-agent differences:

| Agent | Tool name parity | Notes |
|---|---|---|
| Claude Code | exact | `WebFetch` is a built-in tool |
| Codex CLI | broadly compatible | runs in repository sandbox; file write is implicit through shell |
| Gemini CLI | broadly compatible | needs `-y` to skip approval prompts; `allowed-tools` is informational only |
| GitHub Copilot CLI | partial | `--allow-all-tools` is the operative knob; `allowed-tools` is not enforced |

We pin the same `allowed-tools` set across all agents so the SKILL bodies stay agent-agnostic. Per-agent overrides become CLI-specific companion files (see §4).

## 4. CLI-specific companion files

For Phase 1 we ship **one** SKILL.md per skill, agent-agnostic. If, in Phase 2+, a specific agent needs a different prompt body (for example, because Gemini's tool selection has different ergonomics), we will add CLI-specific companions next to the base:

```text
.agents/skills/research/SKILL.md                 # base, agent-agnostic
.agents/skills/research/SKILL.claude-code.md     # optional override
.agents/skills/research/SKILL.codex-cli.md       # optional override
```

Resolution rule: the adapter looks up `SKILL.<agent-id>.md` first and falls back to `SKILL.md`. This keeps the common case (one SKILL covers everything) free of duplication while making per-agent escape hatches additive.

We do not implement the override path in Phase 1 — `research` calls the base SKILL.md only. Phase 2 may flip this on when `review` lands and we have concrete per-agent friction to address.

## 5. Multi-agent skill placement

[Issue #11](https://github.com/ozzy-labs/agentic-watch/issues/11) decided that `init` writes a **single canonical copy** under `.agents/skills/`. This document codifies the rationale:

- `.agents/skills/` is the [AGENTS.md](../../AGENTS.md) convention adopted by Codex CLI and GitHub Copilot CLI, and it's where this repository's own agent assets live.
- Claude Code reads `.claude/skills/`, which is **separately managed** by the [`@ozzylabs/skills`](https://github.com/ozzy-labs/skills) Renovate preset. `init` deliberately does **not** write there because:
  1. The Renovate preset would clobber any local copy on the next bump.
  2. Phase 1 SKILLs are workspace-scoped (research/review/update), not org-wide skill primitives, so they do not belong in the preset.
- Gemini CLI is configured to fall back to `AGENTS.md` (see [`.gemini/settings.json`](../../.gemini/settings.json)) and indirectly picks up `.agents/skills/`.

When users want Claude Code itself to invoke these SKILLs (rather than the Claude Code CLI agent that `agentic-watch research` spawns), they can manually symlink or copy `.agents/skills/research/SKILL.md` into `.claude/skills/`. We do not automate this in Phase 1; revisit if user feedback shows the manual step is a recurring friction.

For agent adapters that spawn the CLI as a subprocess (which is what Phase 1's `research` does), the working directory is the workspace root and the SKILL is read via `Read` against `.agents/skills/research/SKILL.md`. Every supported agent CLI honours this — there is no path-resolution branching inside the adapter.

## 6. Phase 1 contract summary

| Decision | Value | Source |
|---|---|---|
| Skill discovery path | `.agents/skills/<name>/SKILL.md` | [#11](https://github.com/ozzy-labs/agentic-watch/issues/11), [ADR-0007](../adr/0007-skill-bundling-and-init-distribution.md) |
| Prompt body | thin wrapper, no procedure inlined | this doc §1 |
| Input transport | JSON on stdin | this doc §1 |
| `outputPath` location | mentioned in prompt **and** stdin JSON | this doc §1 |
| Template loading | CLI reads `templates/<id>.md`, passes `templateBody` via stdin | [ADR-0001](../adr/0001-agent-adapter-interface.md) `ResearchRequest.templateBody` |
| Output validation | CLI parses generated frontmatter against `ResearchFrontmatterSchema`; failure → exit 1 | [src/schemas/research.ts](../../src/schemas/research.ts) |
| Re-run policy | refuse to overwrite an existing `_v1.md`; use `agentic-watch update` for new versions | [ADR-0003](../adr/0003-output-format-and-versioning.md) |
| `reviewedAt` / `reviewedBy` on first write | **always `null`** | this doc §1 + [ADR-0003](../adr/0003-output-format-and-versioning.md) |
| Status transition | CLI sets `items/<id>.yaml` `status: detected → researched` after frontmatter validation | [ADR-0008](../adr/0008-status-state-machine.md) |

## 7. `review` skill body and CLI contract

[`src/skills/review/SKILL.md`](../../src/skills/review/SKILL.md) is the canonical procedure for the `review` command and ships to workspaces under `.agents/skills/review/SKILL.md` (Phase 2, [#29](https://github.com/ozzy-labs/agentic-watch/issues/29)). The CLI-side wrapper prompt — emitted by [`src/agents/claude-code.ts`](../../src/agents/claude-code.ts) — mirrors `research`'s thin-wrapper style: it points the agent at the SKILL, names the file the agent must modify, and re-states the filesystem invariants.

### 7.1 Prompt body and stdin contract

```text
Run the `.agents/skills/review/SKILL.md` skill to cross-check the
existing research report and append a review block.

Inputs (one JSON document on stdin):
  - agent:               the agent id you are running as
  - templateId:          review template id (e.g. `default`)
  - templateBody:        contents of templates/<templateId>.md, or empty
                         string if the workspace did not provide one
  - researchPath:        absolute path to the research file you MUST modify
  - researchFrontmatter: parsed frontmatter object (pre-review state)
  - researchBody:        full file body including frontmatter at adapter
                         invocation (the CLI re-reads after you return)

Research file to review: <researchPath>
Reviewing agent id (stamp this into reviewedBy): <agent>

Constraints:
  - Follow `.agents/skills/review/SKILL.md` exactly for the review block
    layout and frontmatter stamp; ADR-0003 / ADR-0008 are the canonical
    contract specs.
  - Set frontmatter `reviewedAt` to the current ISO 8601 timestamp (UTC)
    and `reviewedBy` to the agent id above.
  - Append a single `## レビュー (<agent-id>, <ISO 8601>)` section at the
    end of the body. Do not rewrite the existing research content.
  - Do not modify items/*.yaml — the CLI handles the status transition
    and the atomic rollback if anything fails.
  - Write to `researchPath` only. Do not create new files.
```

The stdin JSON also carries `researchFrontmatter` (the parsed pre-review frontmatter) and `researchBody` (the full file content). Re-`Read`ing `researchPath` inside the agent is allowed, but the stdin snapshot is the canonical "pre-state" reference — the CLI uses it to detect drift on the way out.

### 7.2 Atomic dual-update contract

Reviews mutate **two artifacts** in a single CLI invocation:

| Artifact | Owner | Mutation |
|---|---|---|
| `research/<id>.md` body | Agent (SKILL) | Append a single `## レビュー (<agent>, <ts>)` section at end of body |
| `research/<id>.md` frontmatter | Agent (SKILL) | Stamp `reviewedAt` (ISO 8601 UTC) + `reviewedBy` (agent id) |
| `items/<sourceId>/<itemId>.yaml` `status` | CLI | `researched → reviewed` |

[`src/cli/review.ts`](../../src/cli/review.ts) takes an in-memory snapshot of the research file body and each linked item payload before invoking the adapter, then runs the snapshot's `restoreSnapshot` if any of the following fails:

1. The adapter throws or exits non-zero (`runReview` catches and rolls back).
2. The post-adapter frontmatter does not parse against `ResearchFrontmatterSchema`.
3. The agent did not stamp `reviewedAt`, or stamped `reviewedBy` with a value other than the invoked agent id.
4. The agent mutated any immutable field (`id` / `itemIds` / `agent` / `templateId` / `createdAt`).
5. `saveItems` fails when writing the `researched → reviewed` transition.

Rollback is **best-effort**: if `restoreSnapshot` itself fails (e.g. the filesystem fault that broke the original write is still active), the CLI emits a `workspace may be in an inconsistent state` notice and exits non-zero so the user knows manual recovery is needed. The snapshot stays in process memory only — persisting backups to disk would just trade one partial-failure window for another.

### 7.3 Cross-agent recommendation (not enforced)

The CLI does **not** enforce "different agent for review than research". The SKILL body and [`docs/user-guide.md`](../user-guide.md) steer towards a cross-agent flow (write with `codex-cli`, review with `claude-code`, etc.) because the blind-spot-mitigation value comes from a different model running the second pass. We keep enforcement out of code for two reasons:

- Single-account workspaces may only have one agent configured. Hard-erroring on same-agent review would block legitimate solo use.
- `radar.config.yaml` will land a `researchAgent` / `reviewAgent` default in a separate Phase 2 sub-issue ([#25](https://github.com/ozzy-labs/agentic-watch/issues/25) tracks the parent epic). Once that lands, the default config can suggest the cross-agent pairing without making it a hard rule.

### 7.4 Review perspective set

The Phase 2 SKILL ships a **four-axis rubric**:

1. 事実関係 (factual accuracy) — primary-source cross-checks
2. 抜け (missing points) — required topics not covered
3. 憶測 / 主観の混入 (speculation / opinion creep)
4. 出典の妥当性 (source quality)

Workspaces that need a different rubric can drop a `templates/<id>.md` and call `review --template <id>`. The CLI passes `templateBody` through stdin unchanged; an empty string means "use the SKILL's built-in rubric".

We do **not** adopt the [handbook ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) multi-perspective Schema v1 yet. The handbook ADR targets *code* review (correctness, security, architecture etc.), whereas the `agentic-watch` review is a *content* review of an existing Markdown report. Phase 4 (`update`) may need a stable parse-able structure inside the review block; until then the free-form Japanese-heading layout in §3 of the SKILL is the contract.

### 7.5 Re-review semantics

ADR-0008 leaves "re-review after `update`" undefined. Phase 2 makes the following concrete decisions, scoped to a single research file version:

- **Same-version re-review is refused.** Running `agentic-watch review` on a research file whose frontmatter already has `reviewedAt != null` exits non-zero with `review: research '<id>' is already reviewed`. This guarantees a single canonical review block per file and avoids appending stale critiques.
- **Cross-version re-review is deferred to Phase 4.** When `update` lands and produces `_v2.md`, the new file's frontmatter resets `reviewedAt` / `reviewedBy` to `null` (per [skill-design §8.3](#83-frontmatter-relationship-to-predecessors)). A fresh `review` over `_v2.md` is allowed and treated as a brand-new review pass.

### 7.6 Implementation pointers

| Decision | Value | Source |
|---|---|---|
| Wrapper prompt | thin, points at SKILL.md | this doc §7.1 |
| Input transport | JSON on stdin (`agent` / `templateId` / `templateBody` / `researchPath` / `researchFrontmatter` / `researchBody`) | [`src/agents/claude-code.ts`](../../src/agents/claude-code.ts) |
| Output validation | CLI re-reads file, parses frontmatter against `ResearchFrontmatterSchema`, asserts `reviewedAt != null`, `reviewedBy == agent`, immutable fields unchanged | [`src/cli/review.ts`](../../src/cli/review.ts) |
| Rollback target | in-memory snapshot of research body + linked item payloads | this doc §7.2 |
| Status transition | CLI sets each linked `items/<sourceId>/<itemId>.yaml` `status: researched → reviewed` after frontmatter validation | [ADR-0008](../adr/0008-status-state-machine.md) |
| Re-review | refused at the CLI when `reviewedAt != null`; cross-version handled by Phase 4 `update` | this doc §7.5 |

## 8. `update` skill body and diff-detection strategy — Phase 4 direction

[`src/skills/update/SKILL.md`](../../src/skills/update/SKILL.md) is a Phase 1 stub. The body is exercised by `agentic-watch update <research-id> --agent <agent-id>` (Phase 4). Phase 4 will pin down:

### 8.1 What counts as "new information"

| Signal | Source of truth | Likely heuristic |
|---|---|---|
| Original article was edited | `<url>` re-fetch + `etag` / `lastModified` from `state/*.yaml` | If etag / lastModified moved → fetch and diff |
| Related item appeared in same source | `items/<itemId>.yaml` with matching `sourceId` and overlapping `matchedKeywords` | Phase 4 may walk `items/` listing |
| Time elapsed since `createdAt` | research frontmatter `createdAt` | Threshold is user-configurable (default: 30 days)|
| Linked release / docs page updated | URLs in v1 `## 出典` block | WebFetch + content hash compare |

The skill body will surface these signals to the agent rather than have the CLI compute a diff itself — the agent's strength is judging *whether* a textual change is materially new vs trivial copy-edits.

### 8.2 Old version handling: rewrite vs diff-only

Two strategies are on the table:

- **Strategy A (rewrite-and-supersede):** generate a complete new `_v(N+1).md` that stands alone. `supersedes: <previous filename>` in frontmatter links back to v1. v1 is immutable per [ADR-0003](../adr/0003-output-format-and-versioning.md). Pros: each file is self-contained, easy to read in isolation. Cons: redundant text across versions.
- **Strategy B (diff-only block):** v(N+1) contains only a "Changes since v\<N\>" block plus updated metadata. Cons: requires readers to chase the v1 file for context; breaks "self-contained" reading.

**Phase 4 default: Strategy A.** Self-contained files match user expectation when reading from a static-site generator or grep. A diff block (`## v<N+1> での変更点`) is also added at the top of v(N+1) to make the delta visible — but the rest of the report is regenerated, not redacted from v1.

### 8.3 Frontmatter relationship to predecessors

The new file's frontmatter records the lineage explicitly:

```yaml
---
id: <new id>           # e.g. 20260612_anthropic-claude-3-7_v2
itemIds: [...]
agent: <agent-id>
templateId: <id>
createdAt: <ISO 8601 of v1 createdAt>     # preserved, NOT bumped
updatedAt: <ISO 8601 now>                  # set on update
reviewedAt: null                           # reset; new version needs new review
reviewedBy: null
supersedes: 20260512_anthropic-claude-3-7_v1.md   # filename (relative to research/)
---
```

Note that `createdAt` is **preserved** from v1 so the original detection timeline is not lost. `updatedAt` is the new write time. `reviewedAt` / `reviewedBy` reset to `null` because a v1 review does not automatically transfer to v2 (Phase 2 may revisit; see §7).

`supersedes` is **not in `ResearchFrontmatterSchema` today** (see [`src/schemas/research.ts`](../../src/schemas/research.ts)). Phase 4 will extend the schema with `supersedes: z.string().optional()` when `update` lands; the field is documented here so the lineage contract is reviewable before code arrives.

### 8.4 Item status interaction

`update` does **not** change `items/<itemId>.yaml` `status`. Per [ADR-0008](../adr/0008-status-state-machine.md), `status` tracks the **item lifecycle**, not the research version. The CLI updates `items/<itemId>.yaml` `researchPath` to point at the new file but leaves `status` untouched (an item already at `reviewed` remains `reviewed` even though the linked research is now v2; the user must re-run `review` to refresh the review stamp).

### 8.5 No-op suppression

If the post-fetch comparison shows no material change, the skill must **skip creating a new file** and report "no update needed" rather than emit a v(N+1) that is byte-identical to v1. The exact materiality threshold (whitespace-only? typo-fix only?) is a Phase 4 decision; the v1 contract is simply "do not write an empty diff".

## 9. Open questions deferred to later phases

- **CLI-specific companion files**: scaffolded in §4 above; not exercised until Phase 2 surfaces a concrete need.
- **Three-way merge on `init --force`**: deferred; `git diff` is the workspace-side fallback.
- **`.claude/skills/` automation**: revisit when user feedback demands it.
- **Re-review after `update`**: see §7 final bullet.
- **Materiality threshold in `update`**: see §8.5.
