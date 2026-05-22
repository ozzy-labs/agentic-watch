[English](./proxy-setup.md) | 日本語

# 企業プロキシ環境のセットアップ

社内 HTTP / HTTPS プロキシ越しで `radar` を使う場合に必要な設定をまとめる
（オンプレ環境や IT 管理下の端末で典型的なケース）。`radar` は POSIX 標準の
プロキシ環境変数を自動検出して必要な内部設定を自分でやり直すため、ほとんどの
ユーザーは CLI フラグや設定ファイルを編集せず **シェルで env を export する
だけ** で動く。

設定後の動作確認は `radar doctor` を使う。

## 動作原理（概要）

`radar` は POSIX 標準のプロキシ環境変数を尊重する:

| 環境変数      | 読み取り元                                                |
|---------------|------------------------------------------------------------|
| `HTTPS_PROXY` | Node `fetch()` (`--use-env-proxy` 経由) / Playwright       |
| `HTTP_PROXY`  | Node `fetch()` (`--use-env-proxy` 経由) / Playwright       |
| `ALL_PROXY`   | Playwright のみ。Node の `--use-env-proxy` は無視するため `radar` が warning を出す |
| `NO_PROXY`    | 双方。`,` 区切りのホストリスト。`.example.com` の suffix 記法をサポート。`html-js` adapter 向けに Playwright の `bypass` glob 形式 (`*.example.com`) に自動変換する |
| `NODE_EXTRA_CA_CERTS` | Node TLS スタック。TLS 中継プロキシ (Zscaler / Netskope 等) で必須 |

`radar` 起動時に `HTTPS_PROXY` / `HTTP_PROXY` を検査し、どちらかが設定されて
いれば **`NODE_OPTIONS=--use-env-proxy` を注入したうえで self-respawn する**。
このフラグがないと Node の組み込み `fetch()` （`html-js` を除く全 feed
adapter が使う）はプロキシ環境変数を無視する。respawn はユーザーから見ると
透過的で（同じ stdout / stderr / exit code）、再起動ループを防ぐ sentinel
env var により 1 回限り発火する。

`html-js` adapter は `fetch()` ではなく Playwright で Chromium を直接起動する。
Playwright も `HTTPS_PROXY` を自動で読まないため、adapter 側が同じ env を
独自に probe して `chromium.launch({ proxy: { server, bypass } })` に明示的
に渡す。

どちらの経路も同じ env を見るので、ユーザー側の設定は 1 回で済む。

## 最小セットアップ

TLS 中継のない素直な HTTP / HTTPS プロキシの場合:

```bash
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export HTTP_PROXY=http://proxy.corp.example.com:8080
export NO_PROXY=localhost,127.0.0.1,.internal.example.com

radar doctor   # 動作確認
radar watch run
```

`radar doctor` は `proxy: detected via $HTTPS_PROXY=...` を表示し、続けて
`api.github.com` への live healthcheck を実行してプロキシ越しの到達性を確認
する。

プロキシが basic 認証を要求する場合は URL に embed する:

```bash
export HTTPS_PROXY=http://user:pass@proxy.corp.example.com:8080
```

`radar doctor` は URL を表示する際に認証情報を `http://***:***@proxy.corp...`
にマスクするため、出力は bug report や CI ログにそのまま貼っても安全。

## 自動有効化を止める: `RADAR_AUTO_PROXY=0`

`NODE_OPTIONS` を自分で管理したい場合や、シェル全体に設定済みのプロキシを
`radar` だけ **無視させたい** 場合は、`RADAR_AUTO_PROXY` に falsy な値を
セットしてから `radar` を起動する:

```bash
export RADAR_AUTO_PROXY=0     # 0 / false / off のいずれも可（大文字小文字区別なし）
radar watch run
```

このとき:

- self-respawn が skip され、`NODE_OPTIONS=--use-env-proxy` は注入されない
- そのため `fetch()` は `HTTPS_PROXY` / `HTTP_PROXY` を無視する（自分で
  `--use-env-proxy` を `NODE_OPTIONS` に入れない限り）
- `html-js` adapter は **依然として** env を読んで Playwright に渡す
  （Playwright 経路は `NODE_OPTIONS` に依存しないため、`RADAR_AUTO_PROXY=0` で
  も無効化されない）

「fetch は直接出したいが、ブラウザ駆動のスクレイピングだけはプロキシ経由に
したい」のように経路を分けたいケース向けのフラグ。

## TLS 中継プロキシ: `NODE_EXTRA_CA_CERTS`

社内プロキシの多く (Zscaler / Netskope / Blue Coat / 独自 MITM gateway) は
TLS を一旦終端し、自社プライベート CA で再署名した証明書を返す。Node は
これを次のいずれかのエラーで拒否する:

- `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
- `SELF_SIGNED_CERT_IN_CHAIN`
- `DEPTH_ZERO_SELF_SIGNED_CERT`
- `CERT_HAS_EXPIRED`
- `ERR_TLS_CERT_ALTNAME_INVALID`

対処は社内 CA bundle を Node に渡すこと:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

`radar doctor` は `NODE_EXTRA_CA_CERTS` の現在値（または未設定）と、live
healthcheck で観測した TLS エラーを表示し、設定すべき env var をヒントとして
出す。

> **`NODE_TLS_REJECT_UNAUTHORIZED=0` は使わないこと。** プロセス内 **すべて**
> の HTTPS 通信で証明書検証を無効にしてしまう（`api.github.com` /
> `registry.npmjs.org` / agent CLI が叩く endpoint も含む）。プロキシ CA chain
> の本来の目的はこれらの通信を認証することなので、検証を切れば唯一の整合性
> 保証も失う。必ず `NODE_EXTRA_CA_CERTS` を使う。

### 社内 CA の入手方法

通常は社内ポータルに掲示されている。IT 管理下の端末で見つけやすい場所:

- macOS: Keychain → System / login → プロキシの issuer を探し、PEM で書き出す
- Linux: `/etc/ssl/certs/ca-certificates.crt` (Debian/Ubuntu — システム全体
  にインストール済みならここに統合されている) または
  `/etc/pki/ca-trust/source/anchors/` (RHEL/Fedora)
- Windows: 証明書マネージャ (`certmgr.msc`) → 信頼されたルート証明機関 →
  Base-64 PEM でエクスポート

端末上で既に `curl` / `git` が社内 CA を信頼しているなら、同じ bundle を
`NODE_EXTRA_CA_CERTS` に指定すれば済むことが多い。

## NTLM / Kerberos / SAML プロキシ

`radar` (および Node の組み込み `fetch()` と Playwright の Chromium launcher)
が話せるのは **basic 認証** だけ。すなわち `http://user:pass@host:port` 形式
のみ。**NTLM / Kerberos (SPNEGO) / SAML リダイレクト型のプロキシには
対応しない。**

これらの認証方式が必要な場合は、ローカルでプロトコル変換するブリッジ
プロキシを動かし、`radar` はそのブリッジに向けて basic で話す:

| ツール     | 対応 OS              | 備考 |
|------------|----------------------|------|
| [cntlm](https://cntlm.sourceforge.net/) | Linux / macOS / Windows | NTLM v2 → basic 変換。歴史が長く、開発系勉強会でもよく見る |
| [Px](https://github.com/genotrance/px)  | Linux / macOS / Windows | NTLM / Kerberos / Negotiate → basic 変換。Windows では SSPI を利用 |
| [Authoxy](https://github.com/Cisco-Talos/Authoxy) | macOS                  | NTLM / Kerberos → basic 変換。macOS Keychain と統合 |

`cntlm` を使う典型例:

```bash
# cntlm を 127.0.0.1:3128 で待たせ、上流プロキシとは NTLM で話させる
cntlm -c /etc/cntlm.conf

# radar はローカル bridge に向ける
export HTTPS_PROXY=http://127.0.0.1:3128
export HTTP_PROXY=http://127.0.0.1:3128
export NO_PROXY=localhost,127.0.0.1,.internal.example.com

radar doctor
```

bridge を立てれば `radar` 側は普通の basic 認証対応プロキシとして扱える。
`radar` 自体に NTLM 専用設定は無い。

## WSL2 から Windows ホストのプロキシを参照する

WSL2 内で `radar` を動かしつつ、社内プロキシが Windows ホスト側で listen
している場合（Windows 上の `localhost:8080` は Windows のループバックで
あって WSL の VM ではない）、ホストを明示的に指す必要がある。WSL2 では
`host.docker.internal` が既定で Windows ホストに解決される。設定されていない
場合は `/etc/resolv.conf` の `nameserver` 行が Windows ホスト IP を指している
ので、そちらを使ってもよい。

```bash
# WSL2 シェル:
export HTTPS_PROXY=http://host.docker.internal:8080
export HTTP_PROXY=http://host.docker.internal:8080

# host.docker.internal が無効な場合:
export HTTPS_PROXY=http://$(grep -m1 nameserver /etc/resolv.conf | awk '{print $2}'):8080

# Windows 側プロキシが TLS 中継するなら CA bundle を Linux から読める場所に置く
# IT ポリシーが許せば /mnt/c/... 経由で参照する形でもよい
export NODE_EXTRA_CA_CERTS=/mnt/c/Users/<you>/corp-ca.pem

radar doctor
```

Windows 側で NTLM bridge (`cntlm` / `Px`) を動かす場合は、`0.0.0.0` で listen
させる（`127.0.0.1` だと WSL から到達できない）か、Windows Firewall で WSL →
bridge ポートを許可する設定が必要。

## `npm install -g @ozzylabs/feedradar` 自体のプロキシ設定

`radar` がプロキシを自動検出するためには先に install されている必要があり、
`npm install` は **`radar` のコードが走るより前** に走る。そのため `npm`
本体にプロキシを直接教える:

```bash
npm config set proxy http://proxy.corp.example.com:8080
npm config set https-proxy http://proxy.corp.example.com:8080
npm config set noproxy localhost,127.0.0.1,.internal.example.com

# registry の TLS 証明書を npm が拒否する場合:
npm config set cafile /path/to/corp-ca.pem

npm install -g @ozzylabs/feedradar
```

`npm` は独自の config (`~/.npmrc`) を読む。プラットフォームやシェルによっては
`HTTPS_PROXY` を自動で拾わないため、`npm config set` で明示するのが最も確実。
IT 部門がシステムワイドな `npmrc` を配布している場合はそれを使えば済む。

## `npx playwright install chromium`

Playwright の Chromium installer は内部で Node の `fetch()` を
`--use-env-proxy` 相当の挙動で使うため、`HTTPS_PROXY` / `HTTP_PROXY` が
export 済みなら **追加設定なしでプロキシ越しに動く**:

```bash
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem   # TLS 中継時のみ

npx playwright install chromium
```

TLS / 接続エラーが出る場合は `NODE_EXTRA_CA_CERTS` を再確認する。Chromium の
ダウンロード endpoint
(`https://playwright.azureedge.net` / `https://playwright-akamai.azureedge.net`)
も他の HTTPS 通信と同様に TLS 中継の対象になる。

## fetch タイムアウト / リトライ調整

低速な社内プロキシではタイムアウトを伸ばしたいことがある。`radar` の
`fetch()` 系 adapter (`rss` / `html` / `github-releases` / `npm-registry`)
は次の 2 つの env var で既定値を上書きできる:

| 環境変数 | 既定値 | 用途 |
|---|---|---|
| `RADAR_FETCH_TIMEOUT_MS` | `30000` | 1 attempt あたりのタイムアウト (ms) |
| `RADAR_FETCH_RETRIES`    | `2`     | 初回失敗後のリトライ回数 (`0` で即失敗) |

```bash
# 遅いプロキシ向けに緩める
export RADAR_FETCH_TIMEOUT_MS=60000
export RADAR_FETCH_RETRIES=4

radar watch run
```

これらは module ロード時ではなく fetch 呼び出し時に参照されるため、長寿命の
親プロセスを再起動せずとも実行間で変更できる。

## 動作確認

env を export したら `radar doctor` を実行する。プロキシ関連の出力は次の通り:

- `proxy: detected via $HTTPS_PROXY=<masked-url>` — URL 検出と認証情報の
  マスク
- `proxy: NODE_USE_ENV_PROXY active (auto-applied by radar)` — self-respawn
  成功。Node の `fetch()` がプロキシ経由になる。`NODE_USE_ENV_PROXY not set`
  が出る場合は `radar` を bin 経由ではなく直接 module import した（あるいは
  `RADAR_AUTO_PROXY=0` をセットしている）
- `tls: NODE_EXTRA_CA_CERTS=<path>` (または `not set`) — TLS CA bundle 状況
- `proxy healthcheck: ok (200 OK from api.github.com in <N>ms)` — プロキシ
  経由の HTTPS round-trip が成功。それ以外の分類:
  - `407 Proxy Authentication Required` → `$HTTPS_PROXY` の userinfo を確認
  - `TLS error (UNABLE_TO_VERIFY_LEAF_SIGNATURE / ...)` → `NODE_EXTRA_CA_CERTS`
    を設定
  - `connection refused` / `DNS lookup failed` / `timeout` → プロキシの
    host:port が到達可能か確認

live round-trip を skip したい場合（オフライン CI / プロキシに到達できない
runner 等）は `--no-proxy-check` を渡す:

```bash
radar doctor --no-proxy-check
```

静的チェック (env 検出 / `NODE_USE_ENV_PROXY` 状態 / TLS CA bundle path) は
引き続き実行される。

## 関連 env var 一覧

| 環境変数 | レイヤ | 用途 |
|---|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` | shell | `fetch()` および Playwright が使うプロキシ URL |
| `NO_PROXY` | shell | bypass 対象ホスト（`,` 区切り）。Playwright 形式に自動変換 |
| `ALL_PROXY` | shell | Playwright だけが読む fallback。Node の `--use-env-proxy` は無視するため `radar` が warning を出す |
| `RADAR_AUTO_PROXY` | radar | `0` / `false` / `off` で self-respawn を無効化（Playwright 経路は引き続き有効） |
| `NODE_USE_ENV_PROXY` | radar | self-respawn 成功時に `1` がセットされ、subprocess に伝播するヒント |
| `NODE_EXTRA_CA_CERTS` | Node TLS | TLS 中継プロキシ用の追加 CA bundle |
| `RADAR_FETCH_TIMEOUT_MS` | radar | 1 attempt あたりの fetch タイムアウト（既定 `30000`） |
| `RADAR_FETCH_RETRIES` | radar | fetch の初回失敗後リトライ回数（既定 `2`） |
| `RADAR_AUTO_INSTALL_CHROMIUM` | radar | `1` で `watch run` 時に Chromium 不在を検知したら `npx playwright install chromium` を自動 spawn する |
