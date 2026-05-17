# リリース手順

`@ozzylabs/feedradar` の npm publish 手順。**初回 (`v0.1.0`) は手動コマンドで実行**、2 回目以降は `release.yaml` workflow が OIDC Trusted Publishers 経由で自動 publish する。

## なぜ初回は手動か

npm Trusted Publisher (OIDC) は **publish 済みの package に対してのみ** npmjs.org 側で登録できる。よって:

- 初回: package が npmjs.org に存在しない → Trusted Publisher 登録不可 → 手動コマンドで publish
- 以降: Trusted Publisher 登録済み → workflow から OIDC publish

(handbook 横断の知識: [`standards/npm-trusted-publishers`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/standards/npm-trusted-publishers.md))

## 初回リリース手順 (`v0.1.0`)

### 1. release-please PR をマージ

`chore(main): release X.Y.Z` PR (例: [#100](https://github.com/ozzy-labs/feedradar/pull/100)) が release-please により自動生成される。これをマージすると:

- `CHANGELOG.md` が main にコミットされる
- tag `vX.Y.Z` が push される
- GitHub Release が作成される

このタイミングで `release.yaml` の `publish` job も発火するが、**Trusted Publisher 未登録のため 403 で失敗する**。これは想定挙動。失敗 run は無視してよい。

### 2. 手動で publish (ローカル)

タグを checkout してビルドし、`npm publish` で公開する。

```bash
git fetch --tags
git checkout v0.1.0

pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test

# npm 認証 (未ログインなら)
npm login

# Trusted Publisher が未設定なので一時的にトークン publish
npm publish --provenance --access public
```

`--provenance` を付けると Sigstore attestation も発行される（OIDC 経由ではないが、CI 環境変数 (GitHub Actions / GitLab CI) が必要。ローカル publish では provenance なしになる場合がある — `--provenance` フラグは試して fallback でよい）。

publish 後の確認:

```bash
npm view @ozzylabs/feedradar version    # 0.1.0
npm i -g @ozzylabs/feedradar
radar --version                          # 0.1.0
```

### 3. Trusted Publisher を登録

npmjs.org に sign in し、`@ozzylabs/feedradar` の package settings → Publishing → Add Trusted Publisher (GitHub Actions) で以下を登録:

| 項目 | 値 |
|---|---|
| Organization or User | `ozzy-labs` |
| Repository | `feedradar` |
| Workflow filename | `release.yaml` |
| Environment name | (空欄。sibling 4 リポと統一) |

### 4. 動作確認 (次回リリースで)

次回の release-please PR がマージされたとき、`release.yaml` の publish job が OIDC で自動 publish に成功することを確認する。失敗した場合は環境名や workflow filename の typo を疑う。

## 2 回目以降 (`v0.1.1` / `v0.2.0` / ...)

完全自動化される。手順は:

1. main へ feature/fix の PR をマージ → release-please が `chore(main): release X.Y.Z` PR を自動生成・更新する
2. release-please PR をマージ → tag 作成 + GitHub Release + `release.yaml` 連鎖発火
3. `publish` job が OIDC Trusted Publishers で npm publish する

手動コマンドは不要。

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| publish job が `403 Forbidden` | Trusted Publisher 未登録 / workflow filename mismatch | npmjs.org の package settings → Publishing を確認 |
| publish job が `OIDC token not available` | `id-token: write` 権限欠落 | `release.yaml:9-11` の permissions を確認 |
| `pnpm pack` 出力に self-link が混入 | workspace 設定で `@ozzylabs/feedradar: "link:"` が紛れ込んだ | publish job の self-link guard ([PR #93](https://github.com/ozzy-labs/feedradar/pull/93) 由来) が fail する。`package.json` を直接確認 |
| `radar --version` が古いまま | release-please の bump が src に届いていない | 本リポは `src/cli/index.ts` で `package.json` を runtime 読み込みするので bump 後は自動更新される (PR #104)。古い場合は build を疑う |
| version skew (npm と GitHub Release のタグが不一致) | 手動 publish 時に tag と異なる commit から build した | `git checkout v<version>` 直後の build かを確認 |

## 関連

- [`release.yaml`](../.github/workflows/release.yaml) — sibling 4 リポと同じ統合 workflow (release-please + publish)
- [ADR-0005 User Data Separation](./adr/0005-user-data-separation.md) — published tarball に何が含まれるか
- [ADR-0007 Skill Bundling](./adr/0007-skill-bundling-and-init-distribution.md) — `dist/` に bundle される SKILL の構造
- [`standards/npm-trusted-publishers`](https://github.com/ozzy-labs/mcp-server-knowledge/blob/main/knowledge/standards/npm-trusted-publishers.md) — OIDC publishing の標準（handbook#120 で再検討中）
