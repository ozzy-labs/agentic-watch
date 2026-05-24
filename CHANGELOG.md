# Changelog

## [0.2.2](https://github.com/ozzy-labs/feedradar/compare/v0.2.1...v0.2.2) (2026-05-24)


### Features

* **agents:** research/review/update のレポート出力言語を locale 追従（プロンプトは英語正本維持） ([#324](https://github.com/ozzy-labs/feedradar/issues/324)) ([7facfd2](https://github.com/ozzy-labs/feedradar/commit/7facfd2d53ff7ba63ca7a9feb1ede47fc608312b))
* **cli:** i18n remaining per-type help and watch progress text ([#339](https://github.com/ozzy-labs/feedradar/issues/339)) ([fa70bc0](https://github.com/ozzy-labs/feedradar/commit/fa70bc0a297f9971ef25228b89a98247f0d1d2e7))
* **cli:** i18n の残り user-facing エラー・通知を移行 ([#336](https://github.com/ozzy-labs/feedradar/issues/336)) ([#338](https://github.com/ozzy-labs/feedradar/issues/338)) ([eb450f6](https://github.com/ozzy-labs/feedradar/commit/eb450f66b03fd8a7d2127f8c71260bb91aba907c))
* **cli:** user-facing エラー・結果通知を i18n 化（内部ログは対象外） ([#334](https://github.com/ozzy-labs/feedradar/issues/334)) ([0f609be](https://github.com/ozzy-labs/feedradar/commit/0f609be0bd9ae1a3196d166693e8e985cec608b0))
* **cli:** 各コマンドの help/usage を i18n 化 ([#330](https://github.com/ozzy-labs/feedradar/issues/330)) ([d4beeb4](https://github.com/ozzy-labs/feedradar/commit/d4beeb438381ed48d422c7f69e62b9b2fe66b05b))
* **cli:** 進捗レポート(ProgressReporter)のフェーズ文言を i18n 化 ([#329](https://github.com/ozzy-labs/feedradar/issues/329)) ([12da40d](https://github.com/ozzy-labs/feedradar/commit/12da40d013520a993525fe3c27cb63ac7b10dca6))
* **core:** i18n all watch-flow progress markers in watcher/html-js ([#341](https://github.com/ozzy-labs/feedradar/issues/341)) ([4e0170c](https://github.com/ozzy-labs/feedradar/commit/4e0170cf50841f9fd73935621ff3e1f430016c8e))
* **core:** locale 解決基盤 + config.locale + zod locale 連携 ([#319](https://github.com/ozzy-labs/feedradar/issues/319)) ([c15c282](https://github.com/ozzy-labs/feedradar/commit/c15c282042fb533457b4d44d00bdce7179454480))
* **i18n:** close audit-gap user-facing localization (A1-A6) + tests (B1-B6) + fire doc (C1) ([#343](https://github.com/ozzy-labs/feedradar/issues/343)) ([2b9965f](https://github.com/ozzy-labs/feedradar/commit/2b9965f92c648c2ffd2874b890681ab599c82668))
* **i18n:** メッセージカタログ + translator 基盤（global help/共通エラーで実証） ([#321](https://github.com/ozzy-labs/feedradar/issues/321)) ([35c4897](https://github.com/ozzy-labs/feedradar/commit/35c48975910b2feb93b78a567d3cafd85c94c37b))
* **init:** per-locale templates (en/ja) + --lang flag ([#322](https://github.com/ozzy-labs/feedradar/issues/322)) ([7705881](https://github.com/ozzy-labs/feedradar/commit/77058813e14a4481fd967d3c3dd9edb1adcb1a67))
* **workflow:** 生成 YAML(workflow/routine)の user-facing 文言を per-locale 化 ([#325](https://github.com/ozzy-labs/feedradar/issues/325)) ([4ba3247](https://github.com/ozzy-labs/feedradar/commit/4ba32475fe809ee1bd3b0e8c0f885b58513f9e01))


### Bug Fixes

* **ci:** drop backticks in pack-verify comment to satisfy shellcheck ([#328](https://github.com/ozzy-labs/feedradar/issues/328)) ([db6cd2f](https://github.com/ozzy-labs/feedradar/commit/db6cd2f3d2a7366edb8304026420ab431a9b77b5))
* **ci:** point pack-verify at per-locale template paths ([#323](https://github.com/ozzy-labs/feedradar/issues/323)) ([d2d7b30](https://github.com/ozzy-labs/feedradar/commit/d2d7b30bbfea94f0c7d2681d86ba907a4fe4c047))

## [0.2.1](https://github.com/ozzy-labs/feedradar/compare/v0.2.0...v0.2.1) (2026-05-24)


### Features

* **routine:** add --output-mode pr|auto-merge to routine generate pipeline ([#304](https://github.com/ozzy-labs/feedradar/issues/304)) ([01c0247](https://github.com/ozzy-labs/feedradar/commit/01c0247e192dce8805090497513f8272674ba05a))


### Bug Fixes

* **routine:** correct misleading /schedule guidance in generate output ([#302](https://github.com/ozzy-labs/feedradar/issues/302)) ([c280164](https://github.com/ozzy-labs/feedradar/commit/c2801649b0619528e15fe93b7d1b601cad4fb85a))

## [0.2.0](https://github.com/ozzy-labs/feedradar/compare/v0.1.9...v0.2.0) (2026-05-24)


### ⚠ BREAKING CHANGES

* **init:** unify routine scaffold to YAML under .claude/routines/ ([#289](https://github.com/ozzy-labs/feedradar/issues/289))

### refactor

* **init:** unify routine scaffold to YAML under .claude/routines/ ([#289](https://github.com/ozzy-labs/feedradar/issues/289)) ([b298f2d](https://github.com/ozzy-labs/feedradar/commit/b298f2d83fa968e0c73e79c179a63f6abff1be5d))


### Features

* **routine:** /fire 外部からの起動連携（routine fire + api トリガー雛形） ([#291](https://github.com/ozzy-labs/feedradar/issues/291)) ([34b5b07](https://github.com/ozzy-labs/feedradar/commit/34b5b07b42c03a79b13cd78f42f070a7ae51680d))
* **routine:** add `radar routine generate pipeline` full self-session pipeline ([#290](https://github.com/ozzy-labs/feedradar/issues/290)) ([9b56f02](https://github.com/ozzy-labs/feedradar/commit/9b56f02eed7328d758b7d639f43f5becaf85d27d))
* **routine:** add `radar routine generate watch` with 1h cron validation ([#287](https://github.com/ozzy-labs/feedradar/issues/287)) ([86a284b](https://github.com/ozzy-labs/feedradar/commit/86a284bdcd4ea48db1687f43277a3655c7e213e9))
* **triage:** add host-agent entry points (--emit-payload / --commit) ([#286](https://github.com/ozzy-labs/feedradar/issues/286)) ([3a2de36](https://github.com/ozzy-labs/feedradar/commit/3a2de36236b2f9e70616be24b2b7c86a73bdfe7c))


### Bug Fixes

* **routine:** correct model ID and network_access for generated routines ([#298](https://github.com/ozzy-labs/feedradar/issues/298)) ([af9484b](https://github.com/ozzy-labs/feedradar/commit/af9484b34c895ac13ecf645f12d7bcd7cbc8b1e0))
* **test:** provide networkAccessBlock in routine template contract test ([#299](https://github.com/ozzy-labs/feedradar/issues/299)) ([4e99591](https://github.com/ozzy-labs/feedradar/commit/4e99591241374234dd266a71c67dbe8769a575d9))

## [0.1.9](https://github.com/ozzy-labs/feedradar/compare/v0.1.8...v0.1.9) (2026-05-23)


### Features

* **watch:** label facet value on json-api per-page progress ([#269](https://github.com/ozzy-labs/feedradar/issues/269)) ([#271](https://github.com/ozzy-labs/feedradar/issues/271)) ([87f9b2d](https://github.com/ozzy-labs/feedradar/commit/87f9b2d6bc0fdf32173441e08aada22ead40b0cf))


### Bug Fixes

* **agents:** stream research/review/update payload via stdin ([#272](https://github.com/ozzy-labs/feedradar/issues/272)) ([#276](https://github.com/ozzy-labs/feedradar/issues/276)) ([6638a0d](https://github.com/ozzy-labs/feedradar/commit/6638a0d82e741fefdf9e2afd20fea40f07309c29))

## [0.1.8](https://github.com/ozzy-labs/feedradar/compare/v0.1.7...v0.1.8) (2026-05-23)


### Features

* **cli:** add --output-mode direct-commit to combined-with-triage generator ([#267](https://github.com/ozzy-labs/feedradar/issues/267)) ([8b71b7b](https://github.com/ozzy-labs/feedradar/commit/8b71b7b205e0c3db79e1b84d3d54a94266dac983))
* **cli:** host-agent in-session research via --emit-payload / --commit (closes [#254](https://github.com/ozzy-labs/feedradar/issues/254)) ([#260](https://github.com/ozzy-labs/feedradar/issues/260)) ([30dfd9a](https://github.com/ozzy-labs/feedradar/commit/30dfd9aad02c03ced30f762fff87c2b555d5f00d))
* **cli:** host-agent mode for review/update + symlink-hardened --commit (ADR-0019 follow-up) ([#262](https://github.com/ozzy-labs/feedradar/issues/262)) ([c22dfdf](https://github.com/ozzy-labs/feedradar/commit/c22dfdf318d52767c4142393e1603721c43d77e6))
* **cli:** radar dismiss batch support (multiple ids / --batch / --status / --filter-tags) ([#265](https://github.com/ozzy-labs/feedradar/issues/265)) ([d26a277](https://github.com/ozzy-labs/feedradar/commit/d26a277131ce7266dade741d6ab021f1353d3dce))


### Bug Fixes

* **cli:** derive digest slug from triage.group to avoid same-day collision ([#264](https://github.com/ozzy-labs/feedradar/issues/264)) ([53581f5](https://github.com/ozzy-labs/feedradar/commit/53581f5c6a1459d536b6df634938d08187bdea6b))
* **cli:** source test probes range facet upper bound and warns which value tested ([#266](https://github.com/ozzy-labs/feedradar/issues/266)) ([f3990cf](https://github.com/ozzy-labs/feedradar/commit/f3990cfe7688339c48b562e95eaa5b64bd216fad))

## [0.1.7](https://github.com/ozzy-labs/feedradar/compare/v0.1.6...v0.1.7) (2026-05-23)


### Features

* **agents,core:** triage adapter — cheap-model channel + boundary marker (PR-2) ([#247](https://github.com/ozzy-labs/feedradar/issues/247)) ([3a886c2](https://github.com/ozzy-labs/feedradar/commit/3a886c2db520e6084ffe80d0cb24de211ccb195b))
* **cli,recipes:** workflow generate combined-with-triage + bundled recipe triagePolicy + docs (PR-4 [#241](https://github.com/ozzy-labs/feedradar/issues/241)) ([#249](https://github.com/ozzy-labs/feedradar/issues/249)) ([aeaa17f](https://github.com/ozzy-labs/feedradar/commit/aeaa17ff6d00234098b06e4ff111769d1f0d63f5))
* **cli:** radar triage / triage feedback / undismiss + items list 拡張 (PR-3) ([#248](https://github.com/ozzy-labs/feedradar/issues/248)) ([df26486](https://github.com/ozzy-labs/feedradar/commit/df26486abb00d710accc8ec82fd87bd7ecc82887))
* **cli:** radar triage stats + policy tuning workflow guide (closes [#242](https://github.com/ozzy-labs/feedradar/issues/242)) ([#251](https://github.com/ozzy-labs/feedradar/issues/251)) ([8fc8d24](https://github.com/ozzy-labs/feedradar/commit/8fc8d245fd1aa8e4f4e923011d32f66508fcfbe7))
* **schemas:** triagePolicy / triageDecision schema + 3 new triaged_* statuses ([#245](https://github.com/ozzy-labs/feedradar/issues/245)) ([8b71ce2](https://github.com/ozzy-labs/feedradar/commit/8b71ce2ab029202e7eea4139fb5c5e341805f493))


### Bug Fixes

* **cli:** research/review --batch が triaged_* status を入力として受け付ける (closes [#250](https://github.com/ozzy-labs/feedradar/issues/250)) ([#253](https://github.com/ozzy-labs/feedradar/issues/253)) ([c6033ab](https://github.com/ozzy-labs/feedradar/commit/c6033ab265c7b8352d43893b2f054782ce5e0af6))

## [0.1.6](https://github.com/ozzy-labs/feedradar/compare/v0.1.5...v0.1.6) (2026-05-23)


### Features

* **feeds,recipes:** json-api facet sweep extension (ADR-0017) ([#233](https://github.com/ozzy-labs/feedradar/issues/233)) ([7755fc2](https://github.com/ozzy-labs/feedradar/commit/7755fc25f0019a1e8776f5772fcb56e2d3a193d0))
* **recipes:** raise bundled maxPages cap to 250 for whats-new-v2 full backfill ([#232](https://github.com/ozzy-labs/feedradar/issues/232)) ([6cfa83c](https://github.com/ozzy-labs/feedradar/commit/6cfa83c0dda39096b35985d20450a8927e8b1f8d))


### Bug Fixes

* **recipes:** switch aws-whats-new to whats-new-v2 directoryId ([#229](https://github.com/ozzy-labs/feedradar/issues/229)) ([5231021](https://github.com/ozzy-labs/feedradar/commit/523102173b77d566252ed5b2bed8903328dc2c82))

## [0.1.5](https://github.com/ozzy-labs/feedradar/compare/v0.1.4...v0.1.5) (2026-05-22)


### Features

* **cli,feeds:** watch run --backfill / html-js / source test に進捗統合 ([#218](https://github.com/ozzy-labs/feedradar/issues/218)) ([919cee1](https://github.com/ozzy-labs/feedradar/commit/919cee13b52903c650e5fd693bd693e153528cc6))
* **cli,recipes:** recipe CLI extension (radar source recipes / --recipe) ([#201](https://github.com/ozzy-labs/feedradar/issues/201)) ([5264c75](https://github.com/ozzy-labs/feedradar/commit/5264c753da953f6048600632ece55eb2bdef5cda))
* **cli:** integrate progress reporter and --verbose/--quiet into research/review/update ([#217](https://github.com/ozzy-labs/feedradar/issues/217)) ([5f12f69](https://github.com/ozzy-labs/feedradar/commit/5f12f69f044e5e636a06708c9228a837222a5969))
* **cli:** radar workflow generate combined (watch + auto research with hard cap) ([#215](https://github.com/ozzy-labs/feedradar/issues/215)) ([ba49a7d](https://github.com/ozzy-labs/feedradar/commit/ba49a7d5b3eca313f853757a6c6bd58d7b52af62))
* **cli:** radar workflow generate watch 実装 ([#214](https://github.com/ozzy-labs/feedradar/issues/214)) ([5d415f5](https://github.com/ozzy-labs/feedradar/commit/5d415f55bc6538e1f234441ac1d3314d55801dfe))
* **core,agents:** ProgressReporter + onProgress callback ([#213](https://github.com/ozzy-labs/feedradar/issues/213)) ([70a53bc](https://github.com/ozzy-labs/feedradar/commit/70a53bc59ff36fb6560bebec809464e28eecafb2))
* **feeds,cli:** add default selector chain and source add for json-api ([#192](https://github.com/ozzy-labs/feedradar/issues/192)) ([f35cd37](https://github.com/ozzy-labs/feedradar/commit/f35cd3752f07b8abe4bc9cb9925c1449c7daea50))
* **feeds:** add kind: json-api adapter with --backfill ([#185](https://github.com/ozzy-labs/feedradar/issues/185)) ([9dbd6af](https://github.com/ozzy-labs/feedradar/commit/9dbd6afa13bdb3857586ecb942583bf2be120678))
* **feeds:** add kind: json-feed adapter ([#183](https://github.com/ozzy-labs/feedradar/issues/183)) ([21a01d2](https://github.com/ozzy-labs/feedradar/commit/21a01d263092492d7b4823e5fc7ea814b4302a99))
* **recipes:** add bundled aws-whats-new + dev-to recipes with CI smoke ([#202](https://github.com/ozzy-labs/feedradar/issues/202)) ([7b5b285](https://github.com/ozzy-labs/feedradar/commit/7b5b2852dca92cb93fd3c80167eedc157e1e43c1)), closes [#178](https://github.com/ozzy-labs/feedradar/issues/178)


### Bug Fixes

* **feeds:** add SSRF host blocklist to shared fetch wrapper ([#209](https://github.com/ozzy-labs/feedradar/issues/209)) ([cf5c107](https://github.com/ozzy-labs/feedradar/commit/cf5c107abf722164c63d6687fb90a792f31b7182))
* **feeds:** resolve relative link URLs in json-api adapter ([#208](https://github.com/ozzy-labs/feedradar/issues/208)) ([07a487d](https://github.com/ozzy-labs/feedradar/commit/07a487d33a731e4bdd0f5fff3e03e4339b57f11c)), closes [#204](https://github.com/ozzy-labs/feedradar/issues/204)

## [0.1.4](https://github.com/ozzy-labs/feedradar/compare/v0.1.3...v0.1.4) (2026-05-22)


### Features

* **cli:** auto-enable HTTPS_PROXY via NODE_OPTIONS self-respawn ([#166](https://github.com/ozzy-labs/feedradar/issues/166)) ([42afaa3](https://github.com/ozzy-labs/feedradar/commit/42afaa36fb9b6f1abe55d70c3a577b391285ca60))
* **doctor:** add proxy/TLS diagnostics with credential masking ([#170](https://github.com/ozzy-labs/feedradar/issues/170)) ([d9a48d7](https://github.com/ozzy-labs/feedradar/commit/d9a48d7d7995276d19a877dc61590b0b9566e58c))
* **feeds:** add default timeout and retry to fetch adapters ([#167](https://github.com/ozzy-labs/feedradar/issues/167)) ([4d14277](https://github.com/ozzy-labs/feedradar/commit/4d1427751c1bce53652ddba87b782b6e8663878a))
* **feeds:** inject proxy env into Playwright launch for html-js adapter ([#169](https://github.com/ozzy-labs/feedradar/issues/169)) ([881935e](https://github.com/ozzy-labs/feedradar/commit/881935e66cb6a5a52c693f283d7946bd771b2144))

## [0.1.3](https://github.com/ozzy-labs/feedradar/compare/v0.1.2...v0.1.3) (2026-05-19)


### Features

* **agents:** support multi-item digest prompts across 4 adapters ([#154](https://github.com/ozzy-labs/feedradar/issues/154)) ([a5fb369](https://github.com/ozzy-labs/feedradar/commit/a5fb369344fa5ff683cdcd11b4474f5005921b3c))
* **cli:** add radar research --digest with multi-item input ([#155](https://github.com/ozzy-labs/feedradar/issues/155)) ([1193575](https://github.com/ozzy-labs/feedradar/commit/119357590fc0ddd9e00fd98dd42f0ef320ee2cd7))
* **cli:** add radar source test subcommand for source dry-run ([#149](https://github.com/ozzy-labs/feedradar/issues/149)) ([668057c](https://github.com/ozzy-labs/feedradar/commit/668057c60068b56e04c2e14c118a27b709715999))
* **core:** add dryRun option to watchRun for source preview ([#146](https://github.com/ozzy-labs/feedradar/issues/146)) ([a9c5824](https://github.com/ozzy-labs/feedradar/commit/a9c58243f439ecc702936cb519a764a96ea3421b))
* **feeds/html:** add If-Modified-Since to HTML adapter ([#148](https://github.com/ozzy-labs/feedradar/issues/148)) ([0484cd2](https://github.com/ozzy-labs/feedradar/commit/0484cd29e78efc4e823db75d29c654c911b9c112))
* **feeds/rss:** persist Last-Modified for conditional GET ([#147](https://github.com/ozzy-labs/feedradar/issues/147)) ([e6785c4](https://github.com/ozzy-labs/feedradar/commit/e6785c4a4ef837f2c4051a06e18c34b4d847c56e))
* **schemas, state:** add lastModified to SourceState ([#144](https://github.com/ozzy-labs/feedradar/issues/144)) ([859f154](https://github.com/ozzy-labs/feedradar/commit/859f15450799d083b77e4e8e9c8db017b68c4b22))
* **templates, init:** bundle default digest template ([#153](https://github.com/ozzy-labs/feedradar/issues/153)) ([3f9ea84](https://github.com/ozzy-labs/feedradar/commit/3f9ea848584d40ed68a50fd8110dac1702d1ae65))

## [0.1.2](https://github.com/ozzy-labs/feedradar/compare/v0.1.1...v0.1.2) (2026-05-17)


### Features

* **cli:** add radar doctor and lazy Chromium detection on watch run ([#122](https://github.com/ozzy-labs/feedradar/issues/122)) ([ae3c7cc](https://github.com/ozzy-labs/feedradar/commit/ae3c7ccc05dc15ab48c22412d15b99e2d923fda5))
* **schemas, feeds:** implement html-js adapter with Playwright peer dep ([#118](https://github.com/ozzy-labs/feedradar/issues/118)) ([f462e6e](https://github.com/ozzy-labs/feedradar/commit/f462e6efdecbb940603c136c7fc7f301d85c8470))


### Bug Fixes

* **cli:** include html-js in source add help and validation message ([#123](https://github.com/ozzy-labs/feedradar/issues/123)) ([dc6f67b](https://github.com/ozzy-labs/feedradar/commit/dc6f67b1e22ac6518ab1e3f7bc63da9027780903))
* **lint:** apply biome format to source CLI changes from [#123](https://github.com/ozzy-labs/feedradar/issues/123) ([#126](https://github.com/ozzy-labs/feedradar/issues/126)) ([5367e93](https://github.com/ozzy-labs/feedradar/commit/5367e932810df2870d9bf547d1125d99e4b4a660))

## [0.1.1](https://github.com/ozzy-labs/feedradar/compare/v0.1.0...v0.1.1) (2026-05-17)


### Bug Fixes

* **ci:** align release.yaml publish job with ci.yaml tool-chain (Node 24 + mise-action) ([#106](https://github.com/ozzy-labs/feedradar/issues/106)) ([7e351bb](https://github.com/ozzy-labs/feedradar/commit/7e351bb993407d1dea41776046dd82f46299934a))

## 0.1.0 (2026-05-17)


### Features

* **agents:** implement codex-cli adapter for research and review ([#45](https://github.com/ozzy-labs/feedradar/issues/45)) ([d0a6b9b](https://github.com/ozzy-labs/feedradar/commit/d0a6b9b39cb6c3fd83e82224e2560b33dbf3783f))
* **agents:** wrap item content with boundary marker in prompt builders ([#69](https://github.com/ozzy-labs/feedradar/issues/69)) ([34e2fe1](https://github.com/ozzy-labs/feedradar/commit/34e2fe177262a9012ff5418367867ea3fc84dd88))
* **cli:** close slash-command UX gap for Gemini CLI (.gemini/commands/) and Codex CLI (dual-mode engine SKILL) ([#80](https://github.com/ozzy-labs/feedradar/issues/80)) ([dead95e](https://github.com/ozzy-labs/feedradar/commit/dead95e0d4e34f849c5e43c10d11216a0061806d)), closes [#78](https://github.com/ozzy-labs/feedradar/issues/78)
* **cli:** implement dismiss command ([#42](https://github.com/ozzy-labs/feedradar/issues/42)) ([759945f](https://github.com/ozzy-labs/feedradar/commit/759945faecd0ad9cc64b1beba3b46333c0fa9811))
* **cli:** implement init --with-routines and --with-actions ([#55](https://github.com/ozzy-labs/feedradar/issues/55)) ([cdca698](https://github.com/ozzy-labs/feedradar/commit/cdca6983122fb5d03ed773771a97809536b24344)), closes [#39](https://github.com/ozzy-labs/feedradar/issues/39)
* **cli:** implement init command and bundle research/review/update skills ([#15](https://github.com/ozzy-labs/feedradar/issues/15)) ([f9f6d68](https://github.com/ozzy-labs/feedradar/commit/f9f6d68a24365ec9810dd752e1d00e2714999b00)), closes [#11](https://github.com/ozzy-labs/feedradar/issues/11)
* **cli:** implement research command with Claude Code adapter ([#19](https://github.com/ozzy-labs/feedradar/issues/19)) ([3be1ef2](https://github.com/ozzy-labs/feedradar/commit/3be1ef278d39cfcbdf90c339ffae71902a6575e6))
* **cli:** implement source add/list/remove subcommands ([#17](https://github.com/ozzy-labs/feedradar/issues/17)) ([8d2982f](https://github.com/ozzy-labs/feedradar/commit/8d2982f057de3c04ca8e97b541d020a801bc5cdd))
* **cli:** init generates AGENTS.md for multi-agent context ([#79](https://github.com/ozzy-labs/feedradar/issues/79)) ([4358f9e](https://github.com/ozzy-labs/feedradar/commit/4358f9e8c02bf493e4350ba60b448d3d33e4a5e7))
* **cli:** init populates .claude/skills/ for Claude Code slash-command discoverability ([#76](https://github.com/ozzy-labs/feedradar/issues/76)) ([e913469](https://github.com/ozzy-labs/feedradar/commit/e913469592f7cbee09c4fc24f91d9cc29a419e8c))
* **cli:** warn on empty-keyword sources and add source list --verbose ([#97](https://github.com/ozzy-labs/feedradar/issues/97)) ([9a56895](https://github.com/ozzy-labs/feedradar/commit/9a56895ab7325bf86ebb1fdd48b980681e27d8c0))
* **feeds:** implement GitHub Releases adapter ([#52](https://github.com/ozzy-labs/feedradar/issues/52)) ([d398185](https://github.com/ozzy-labs/feedradar/commit/d39818546735ac8de246f018c2fc44cbbbeafa10)), closes [#37](https://github.com/ozzy-labs/feedradar/issues/37)
* **feeds:** implement HTML scraping adapter ([#54](https://github.com/ozzy-labs/feedradar/issues/54)) ([e295c75](https://github.com/ozzy-labs/feedradar/commit/e295c750fa73c1786c1106119cfea35bcd9e1aec))
* **feeds:** implement npm-registry adapter ([#53](https://github.com/ozzy-labs/feedradar/issues/53)) ([439cf9d](https://github.com/ozzy-labs/feedradar/commit/439cf9dce0aa3d7c726f155ec9e8b6637e21f994)), closes [#38](https://github.com/ozzy-labs/feedradar/issues/38)
* implement copilot adapter for research and review ([#46](https://github.com/ozzy-labs/feedradar/issues/46)) ([0a64783](https://github.com/ozzy-labs/feedradar/commit/0a647834be90fe4e36c5aa76b4eda2d79745d45b))
* implement gemini-cli adapter for research and review ([#47](https://github.com/ozzy-labs/feedradar/issues/47)) ([5f931ab](https://github.com/ozzy-labs/feedradar/commit/5f931ab31f98ff07a10392db90550e0bc54be63e))
* implement radar.config.yaml for default agent selection ([#43](https://github.com/ozzy-labs/feedradar/issues/43)) ([a75076e](https://github.com/ozzy-labs/feedradar/commit/a75076e4167fb3265b2ee32f52e6c6487f4b7c16))
* implement review command with claude-code adapter ([#44](https://github.com/ozzy-labs/feedradar/issues/44)) ([9df6cdf](https://github.com/ozzy-labs/feedradar/commit/9df6cdfbb00c28caf8f5db4f5470aa809e20fcc2))
* implement update command with v+1 generation ([#57](https://github.com/ozzy-labs/feedradar/issues/57)) ([479605d](https://github.com/ozzy-labs/feedradar/commit/479605dcd70895adcdd3dc9017598917508ff2b9))
* implement watch run for RSS sources with filter and state machine ([#18](https://github.com/ozzy-labs/feedradar/issues/18)) ([c3ae852](https://github.com/ozzy-labs/feedradar/commit/c3ae852c7cf9f3e2aeb3d4e7534e66c688af3cb1))
* **init:** generate AGENTIC_WATCH.md as human-facing workspace guide ([#92](https://github.com/ozzy-labs/feedradar/issues/92)) ([ace7f0a](https://github.com/ozzy-labs/feedradar/commit/ace7f0acda1617a883b4fae764ab6f713956573d))
* **init:** generate minimal CLAUDE.md by default with @AGENTS.md import ([#89](https://github.com/ozzy-labs/feedradar/issues/89)) ([5edd1d7](https://github.com/ozzy-labs/feedradar/commit/5edd1d79611e73e725038485f01f92087ccba046))
* **init:** generate templates/default.md as starter template ([#90](https://github.com/ozzy-labs/feedradar/issues/90)) ([9e556c2](https://github.com/ozzy-labs/feedradar/commit/9e556c2356e5db35985c7f4b83adfa6b5623d374))
* **init:** place .gitkeep in empty data directories ([#88](https://github.com/ozzy-labs/feedradar/issues/88)) ([29a5ad6](https://github.com/ozzy-labs/feedradar/commit/29a5ad6c3920035afeae9079cd070c90713d0e97))
* **schema:** add supersedes frontmatter and revise ADR-0003 ([#56](https://github.com/ozzy-labs/feedradar/issues/56)) ([57d60ee](https://github.com/ozzy-labs/feedradar/commit/57d60ee4145920d247be4622cbbc52a090bbc8ef))
* **schemas:** add Source.trustLevel field (default untrusted) ([#66](https://github.com/ozzy-labs/feedradar/issues/66)) ([93d6e87](https://github.com/ozzy-labs/feedradar/commit/93d6e879a8a41f50ad7abee92044d21858a72fa7))


### Bug Fixes

* **agents:** gemini-cli adapter should bypass folder trust check + add prompt injection warning to docs ([#50](https://github.com/ozzy-labs/feedradar/issues/50)) ([d2bdb9d](https://github.com/ozzy-labs/feedradar/commit/d2bdb9d7b529ec07a2cfbf7bfc31ef80dfca908d))
* close 7 docs/impl drift items flagged by v0.1.0 pre-release audit ([#104](https://github.com/ozzy-labs/feedradar/issues/104)) ([ce8b91b](https://github.com/ozzy-labs/feedradar/commit/ce8b91bde462c24910902fce007a19f9a3d6d7af))
* **init:** include .gemini/commands/ in AGENTS.md directory tree ([#87](https://github.com/ozzy-labs/feedradar/issues/87)) ([23b72f9](https://github.com/ozzy-labs/feedradar/commit/23b72f9d6b8a9efcf6bc2ae48ec28973eb0bb1d5))
* **items:** sanitize item ids for filesystem-safe paths ([#21](https://github.com/ozzy-labs/feedradar/issues/21)) ([6ad9069](https://github.com/ozzy-labs/feedradar/commit/6ad906973f4d091e9b3eff0bad55b2783697fffb))
* **research:** align research skill output with ResearchFrontmatterSchema ([#22](https://github.com/ozzy-labs/feedradar/issues/22)) ([91a43bd](https://github.com/ozzy-labs/feedradar/commit/91a43bd8e6695452835aa2bb6b41e9493761a65e))
