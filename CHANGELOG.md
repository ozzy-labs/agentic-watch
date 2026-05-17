# Changelog

## 0.1.0 (2026-05-17)


### Features

* **agents:** implement codex-cli adapter for research and review ([#45](https://github.com/ozzy-labs/agentic-watch/issues/45)) ([d0a6b9b](https://github.com/ozzy-labs/agentic-watch/commit/d0a6b9b39cb6c3fd83e82224e2560b33dbf3783f))
* **agents:** wrap item content with boundary marker in prompt builders ([#69](https://github.com/ozzy-labs/agentic-watch/issues/69)) ([34e2fe1](https://github.com/ozzy-labs/agentic-watch/commit/34e2fe177262a9012ff5418367867ea3fc84dd88))
* **cli:** close slash-command UX gap for Gemini CLI (.gemini/commands/) and Codex CLI (dual-mode engine SKILL) ([#80](https://github.com/ozzy-labs/agentic-watch/issues/80)) ([dead95e](https://github.com/ozzy-labs/agentic-watch/commit/dead95e0d4e34f849c5e43c10d11216a0061806d)), closes [#78](https://github.com/ozzy-labs/agentic-watch/issues/78)
* **cli:** implement dismiss command ([#42](https://github.com/ozzy-labs/agentic-watch/issues/42)) ([759945f](https://github.com/ozzy-labs/agentic-watch/commit/759945faecd0ad9cc64b1beba3b46333c0fa9811))
* **cli:** implement init --with-routines and --with-actions ([#55](https://github.com/ozzy-labs/agentic-watch/issues/55)) ([cdca698](https://github.com/ozzy-labs/agentic-watch/commit/cdca6983122fb5d03ed773771a97809536b24344)), closes [#39](https://github.com/ozzy-labs/agentic-watch/issues/39)
* **cli:** implement init command and bundle research/review/update skills ([#15](https://github.com/ozzy-labs/agentic-watch/issues/15)) ([f9f6d68](https://github.com/ozzy-labs/agentic-watch/commit/f9f6d68a24365ec9810dd752e1d00e2714999b00)), closes [#11](https://github.com/ozzy-labs/agentic-watch/issues/11)
* **cli:** implement research command with Claude Code adapter ([#19](https://github.com/ozzy-labs/agentic-watch/issues/19)) ([3be1ef2](https://github.com/ozzy-labs/agentic-watch/commit/3be1ef278d39cfcbdf90c339ffae71902a6575e6))
* **cli:** implement source add/list/remove subcommands ([#17](https://github.com/ozzy-labs/agentic-watch/issues/17)) ([8d2982f](https://github.com/ozzy-labs/agentic-watch/commit/8d2982f057de3c04ca8e97b541d020a801bc5cdd))
* **cli:** init generates AGENTS.md for multi-agent context ([#79](https://github.com/ozzy-labs/agentic-watch/issues/79)) ([4358f9e](https://github.com/ozzy-labs/agentic-watch/commit/4358f9e8c02bf493e4350ba60b448d3d33e4a5e7))
* **cli:** init populates .claude/skills/ for Claude Code slash-command discoverability ([#76](https://github.com/ozzy-labs/agentic-watch/issues/76)) ([e913469](https://github.com/ozzy-labs/agentic-watch/commit/e913469592f7cbee09c4fc24f91d9cc29a419e8c))
* **cli:** warn on empty-keyword sources and add source list --verbose ([#97](https://github.com/ozzy-labs/agentic-watch/issues/97)) ([9a56895](https://github.com/ozzy-labs/agentic-watch/commit/9a56895ab7325bf86ebb1fdd48b980681e27d8c0))
* **feeds:** implement GitHub Releases adapter ([#52](https://github.com/ozzy-labs/agentic-watch/issues/52)) ([d398185](https://github.com/ozzy-labs/agentic-watch/commit/d39818546735ac8de246f018c2fc44cbbbeafa10)), closes [#37](https://github.com/ozzy-labs/agentic-watch/issues/37)
* **feeds:** implement HTML scraping adapter ([#54](https://github.com/ozzy-labs/agentic-watch/issues/54)) ([e295c75](https://github.com/ozzy-labs/agentic-watch/commit/e295c750fa73c1786c1106119cfea35bcd9e1aec))
* **feeds:** implement npm-registry adapter ([#53](https://github.com/ozzy-labs/agentic-watch/issues/53)) ([439cf9d](https://github.com/ozzy-labs/agentic-watch/commit/439cf9dce0aa3d7c726f155ec9e8b6637e21f994)), closes [#38](https://github.com/ozzy-labs/agentic-watch/issues/38)
* implement copilot adapter for research and review ([#46](https://github.com/ozzy-labs/agentic-watch/issues/46)) ([0a64783](https://github.com/ozzy-labs/agentic-watch/commit/0a647834be90fe4e36c5aa76b4eda2d79745d45b))
* implement gemini-cli adapter for research and review ([#47](https://github.com/ozzy-labs/agentic-watch/issues/47)) ([5f931ab](https://github.com/ozzy-labs/agentic-watch/commit/5f931ab31f98ff07a10392db90550e0bc54be63e))
* implement radar.config.yaml for default agent selection ([#43](https://github.com/ozzy-labs/agentic-watch/issues/43)) ([a75076e](https://github.com/ozzy-labs/agentic-watch/commit/a75076e4167fb3265b2ee32f52e6c6487f4b7c16))
* implement review command with claude-code adapter ([#44](https://github.com/ozzy-labs/agentic-watch/issues/44)) ([9df6cdf](https://github.com/ozzy-labs/agentic-watch/commit/9df6cdfbb00c28caf8f5db4f5470aa809e20fcc2))
* implement update command with v+1 generation ([#57](https://github.com/ozzy-labs/agentic-watch/issues/57)) ([479605d](https://github.com/ozzy-labs/agentic-watch/commit/479605dcd70895adcdd3dc9017598917508ff2b9))
* implement watch run for RSS sources with filter and state machine ([#18](https://github.com/ozzy-labs/agentic-watch/issues/18)) ([c3ae852](https://github.com/ozzy-labs/agentic-watch/commit/c3ae852c7cf9f3e2aeb3d4e7534e66c688af3cb1))
* **init:** generate AGENTIC_WATCH.md as human-facing workspace guide ([#92](https://github.com/ozzy-labs/agentic-watch/issues/92)) ([ace7f0a](https://github.com/ozzy-labs/agentic-watch/commit/ace7f0acda1617a883b4fae764ab6f713956573d))
* **init:** generate minimal CLAUDE.md by default with @AGENTS.md import ([#89](https://github.com/ozzy-labs/agentic-watch/issues/89)) ([5edd1d7](https://github.com/ozzy-labs/agentic-watch/commit/5edd1d79611e73e725038485f01f92087ccba046))
* **init:** generate templates/default.md as starter template ([#90](https://github.com/ozzy-labs/agentic-watch/issues/90)) ([9e556c2](https://github.com/ozzy-labs/agentic-watch/commit/9e556c2356e5db35985c7f4b83adfa6b5623d374))
* **init:** place .gitkeep in empty data directories ([#88](https://github.com/ozzy-labs/agentic-watch/issues/88)) ([29a5ad6](https://github.com/ozzy-labs/agentic-watch/commit/29a5ad6c3920035afeae9079cd070c90713d0e97))
* **schema:** add supersedes frontmatter and revise ADR-0003 ([#56](https://github.com/ozzy-labs/agentic-watch/issues/56)) ([57d60ee](https://github.com/ozzy-labs/agentic-watch/commit/57d60ee4145920d247be4622cbbc52a090bbc8ef))
* **schemas:** add Source.trustLevel field (default untrusted) ([#66](https://github.com/ozzy-labs/agentic-watch/issues/66)) ([93d6e87](https://github.com/ozzy-labs/agentic-watch/commit/93d6e879a8a41f50ad7abee92044d21858a72fa7))


### Bug Fixes

* **agents:** gemini-cli adapter should bypass folder trust check + add prompt injection warning to docs ([#50](https://github.com/ozzy-labs/agentic-watch/issues/50)) ([d2bdb9d](https://github.com/ozzy-labs/agentic-watch/commit/d2bdb9d7b529ec07a2cfbf7bfc31ef80dfca908d))
* **init:** include .gemini/commands/ in AGENTS.md directory tree ([#87](https://github.com/ozzy-labs/agentic-watch/issues/87)) ([23b72f9](https://github.com/ozzy-labs/agentic-watch/commit/23b72f9d6b8a9efcf6bc2ae48ec28973eb0bb1d5))
* **items:** sanitize item ids for filesystem-safe paths ([#21](https://github.com/ozzy-labs/agentic-watch/issues/21)) ([6ad9069](https://github.com/ozzy-labs/agentic-watch/commit/6ad906973f4d091e9b3eff0bad55b2783697fffb))
* **research:** align research skill output with ResearchFrontmatterSchema ([#22](https://github.com/ozzy-labs/agentic-watch/issues/22)) ([91a43bd](https://github.com/ozzy-labs/agentic-watch/commit/91a43bd8e6695452835aa2bb6b41e9493761a65e))
