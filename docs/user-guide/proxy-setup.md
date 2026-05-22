English | [日本語](./proxy-setup.ja.md)

# Corporate proxy setup

This page collects everything `radar` users need to know when running behind an
HTTP / HTTPS proxy (typical in enterprise / on-prem environments). `radar`
auto-detects the standard proxy env vars and reconfigures itself so most users
do not need to change CLI flags or config files — just set the env vars in your
shell.

If you only want to verify your setup, run `radar doctor` after exporting the
env vars described below.

## How it works (overview)

`radar` honors the POSIX-style proxy env vars:

| Env var       | Read by                                            |
|---------------|----------------------------------------------------|
| `HTTPS_PROXY` | Node `fetch()` (via `--use-env-proxy`), Playwright |
| `HTTP_PROXY`  | Node `fetch()` (via `--use-env-proxy`), Playwright |
| `ALL_PROXY`   | Playwright only — Node's `--use-env-proxy` ignores it (warning emitted) |
| `NO_PROXY`    | Both. Comma-separated host list; `.example.com` suffix syntax supported. Auto-translated to Playwright `bypass` glob form (`*.example.com`) for the `html-js` adapter |
| `NODE_EXTRA_CA_CERTS` | Node TLS stack — required for TLS-intercepting proxies (Zscaler / Netskope / etc.) |

When `radar` starts, it inspects `HTTPS_PROXY` / `HTTP_PROXY` and, if either is
set, **self-respawns** itself with `NODE_OPTIONS=--use-env-proxy` injected.
Without that flag Node's built-in `fetch()` (which `radar` uses for every feed
adapter except `html-js`) ignores proxy env vars. The respawn is invisible to
the user — same stdout / stderr / exit code — and only happens once per
invocation (a sentinel env var prevents recursion).

The `html-js` adapter does **not** rely on `fetch()`; it drives a real Chromium
browser via Playwright. Playwright also does not auto-honor `HTTPS_PROXY`, so
the adapter probes the same env vars itself and passes the URL to
`chromium.launch({ proxy: { server, bypass } })` explicitly.

Both paths converge on the same set of env vars, so you only need to configure
them once.

## Minimum setup

For a plain HTTP / HTTPS proxy with no TLS interception:

```bash
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export HTTP_PROXY=http://proxy.corp.example.com:8080
export NO_PROXY=localhost,127.0.0.1,.internal.example.com

radar doctor   # verify
radar watch run
```

`radar` will report `proxy: detected via $HTTPS_PROXY=...` and run the live
healthcheck against `api.github.com` to confirm the proxy is reachable.

If your proxy requires basic-auth credentials, embed them in the URL:

```bash
export HTTPS_PROXY=http://user:pass@proxy.corp.example.com:8080
```

`radar doctor` masks the credentials (`http://***:***@proxy.corp...`) when it
echoes the URL, so the value is safe to share in bug reports and CI logs.

## Opt-out: `RADAR_AUTO_PROXY=0`

If you want to manage `NODE_OPTIONS` yourself, or you need `radar` to **ignore**
a proxy that is set globally for the rest of your shell, set `RADAR_AUTO_PROXY`
to a falsy value before running `radar`:

```bash
export RADAR_AUTO_PROXY=0     # any of: 0 / false / off (case-insensitive)
radar watch run
```

When `RADAR_AUTO_PROXY` is set this way:

- The self-respawn is skipped — `NODE_OPTIONS=--use-env-proxy` is **not** injected.
- `fetch()` therefore ignores `HTTPS_PROXY` / `HTTP_PROXY` (unless you set
  `--use-env-proxy` in `NODE_OPTIONS` yourself).
- The `html-js` adapter **still** reads the env vars and passes them to
  Playwright — `RADAR_AUTO_PROXY=0` does not disable the Playwright path
  because that path doesn't depend on `NODE_OPTIONS`.

This is the right toggle when your fetch traffic must go direct but you still
want browser-driven scraping to traverse the proxy (or vice versa, by unsetting
`HTTPS_PROXY` in the same shell).

## TLS-intercepting proxies: `NODE_EXTRA_CA_CERTS`

Many corporate proxies (Zscaler, Netskope, Blue Coat, custom MITM gateways)
terminate TLS and re-sign every certificate with a private CA. Node will reject
the resulting chain with one of these errors:

- `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
- `SELF_SIGNED_CERT_IN_CHAIN`
- `DEPTH_ZERO_SELF_SIGNED_CERT`
- `CERT_HAS_EXPIRED`
- `ERR_TLS_CERT_ALTNAME_INVALID`

The fix is to point Node at your corporate CA bundle:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

`radar doctor` surfaces both the current value (or absence) of
`NODE_EXTRA_CA_CERTS` and any TLS errors observed during the live healthcheck,
with the exact env var to set in the hint message.

> **Do not** set `NODE_TLS_REJECT_UNAUTHORIZED=0`. It disables certificate
> verification for **every** outbound HTTPS request in the process — including
> calls to `api.github.com`, `registry.npmjs.org`, and whatever endpoints the
> agent CLI talks to. The whole point of the proxy CA chain is to keep those
> connections authenticated; turning off verification removes the only
> integrity guarantee you have. Use `NODE_EXTRA_CA_CERTS` instead.

### Where to find your corporate CA

Your IT / security team usually publishes the proxy CA on an internal portal.
Common locations on managed machines:

- macOS: Keychain → System / login → look for the proxy issuer; export to PEM.
- Linux: `/etc/ssl/certs/ca-certificates.crt` (Debian/Ubuntu — already includes
  the proxy CA if it was installed system-wide) or `/etc/pki/ca-trust/source/anchors/`
  (RHEL/Fedora).
- Windows: Certificate Manager (`certmgr.msc`) → Trusted Root Certification
  Authorities → export to Base-64 PEM.

If your machine already trusts the proxy CA for `curl` / `git`, you can usually
point `NODE_EXTRA_CA_CERTS` at the same bundle.

## NTLM / Kerberos / SAML proxies

`radar` (like Node's built-in `fetch()` and Playwright's Chromium launcher) only
speaks **basic** proxy auth — the `http://user:pass@host:port` form. **NTLM,
Kerberos / SPNEGO, and SAML-redirected proxies are not supported.**

If your proxy requires one of those auth methods, run a local protocol-bridging
proxy and point `radar` at the bridge instead:

| Tool       | Platform              | Notes |
|------------|-----------------------|-------|
| [cntlm](https://cntlm.sourceforge.net/) | Linux / macOS / Windows | NTLM v2 → basic. Mature, widely deployed in dev workshops. |
| [Px](https://github.com/genotrance/px)  | Linux / macOS / Windows | NTLM / Kerberos / Negotiate → basic. Uses Windows SSPI when available. |
| [Authoxy](https://github.com/Cisco-Talos/Authoxy) | macOS                  | NTLM / Kerberos → basic. Native Keychain integration. |

Typical setup with `cntlm`:

```bash
# cntlm listens on 127.0.0.1:3128 and talks NTLM to the upstream proxy
cntlm -c /etc/cntlm.conf

# Point radar at the local bridge
export HTTPS_PROXY=http://127.0.0.1:3128
export HTTP_PROXY=http://127.0.0.1:3128
export NO_PROXY=localhost,127.0.0.1,.internal.example.com

radar doctor
```

Once the bridge is in place `radar` treats it like any other basic-auth-capable
proxy — no special config inside `radar` itself.

## WSL2 → Windows host proxy

When `radar` runs inside WSL2 and the corporate proxy is bound to the Windows
host (`localhost:8080` on Windows means the Windows loopback, not the WSL VM),
you need to refer to the host explicitly. WSL2 exposes the host as
`host.docker.internal` by default; alternatively read the Windows host IP from
`/etc/resolv.conf` (the `nameserver` line) — both resolve to the Windows host
from inside the WSL VM.

```bash
# WSL2 shell:
export HTTPS_PROXY=http://host.docker.internal:8080
export HTTP_PROXY=http://host.docker.internal:8080

# Or, if host.docker.internal is not configured:
export HTTPS_PROXY=http://$(grep -m1 nameserver /etc/resolv.conf | awk '{print $2}'):8080

# Add the proxy CA bundle if your Windows host runs a TLS-intercepting proxy.
# The CA file must be readable from inside WSL — copy it from Windows or
# symlink via /mnt/c/... if your IT policy allows it.
export NODE_EXTRA_CA_CERTS=/mnt/c/Users/<you>/corp-ca.pem

radar doctor
```

If you're running an NTLM bridge (`cntlm` / `Px`) on the Windows side, make sure
it listens on `0.0.0.0` (not `127.0.0.1`) or that Windows Firewall allows WSL to
reach the bridge port.

## `npm install -g @ozzylabs/feedradar` itself

Before `radar` can self-configure for the proxy, you need to install it — and
`npm install` runs **before** any `radar` code does. Configure `npm` directly:

```bash
npm config set proxy http://proxy.corp.example.com:8080
npm config set https-proxy http://proxy.corp.example.com:8080
npm config set noproxy localhost,127.0.0.1,.internal.example.com

# If npm complains about the registry's TLS cert:
npm config set cafile /path/to/corp-ca.pem

npm install -g @ozzylabs/feedradar
```

`npm` reads its own config (`~/.npmrc`) — it does **not** pick up
`HTTPS_PROXY` automatically on all platforms / shells, so the `npm config set`
form is the most reliable. If your IT team has already configured a
system-wide `npmrc`, you can skip these steps.

## `npx playwright install chromium`

The Playwright Chromium installer **does** honor `HTTPS_PROXY` / `HTTP_PROXY`
out of the box (it uses Node's `fetch()` internally with `--use-env-proxy`
behavior). As long as the env vars are exported, you can run the standard
install command:

```bash
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem   # only if TLS-intercepted

npx playwright install chromium
```

If Playwright reports a TLS / connection error, re-check `NODE_EXTRA_CA_CERTS`
— the Chromium download endpoint
(`https://playwright.azureedge.net` / `https://playwright-akamai.azureedge.net`)
gets the same TLS interception as any other HTTPS host.

## Fetch timeout / retry tuning

Slow corporate proxies sometimes need longer timeouts. `radar`'s `fetch()`
adapters (`rss` / `html` / `github-releases` / `npm-registry`) accept two env
vars to override the defaults:

| Env var | Default | Purpose |
|---|---|---|
| `RADAR_FETCH_TIMEOUT_MS` | `30000` | Per-attempt timeout in milliseconds. |
| `RADAR_FETCH_RETRIES`    | `2`     | Number of retries after the initial failure (`0` fails immediately). |

```bash
# Looser timeouts for slow proxies
export RADAR_FETCH_TIMEOUT_MS=60000
export RADAR_FETCH_RETRIES=4

radar watch run
```

These env vars are read on every fetch call (not cached at module load), so you
can change them between runs without restarting any long-running parent process.

## Verifying the setup

Run `radar doctor` after exporting the env vars. The proxy-relevant rows are:

- `proxy: detected via $HTTPS_PROXY=<masked-url>` — URL discovery + credential
  masking.
- `proxy: NODE_USE_ENV_PROXY active (auto-applied by radar)` — self-respawn
  succeeded; Node's `fetch()` will hit the proxy. If you see
  `NODE_USE_ENV_PROXY not set` instead, you either invoked `radar` via a path
  that bypasses the bin (e.g. importing modules directly) or set
  `RADAR_AUTO_PROXY=0`.
- `tls: NODE_EXTRA_CA_CERTS=<path>` (or `not set`) — TLS CA bundle status.
- `proxy healthcheck: ok (200 OK from api.github.com in <N>ms)` — a real HTTPS
  round-trip via the proxy succeeded. Other classifications:
  - `407 Proxy Authentication Required` → check userinfo in `$HTTPS_PROXY`
  - `TLS error (UNABLE_TO_VERIFY_LEAF_SIGNATURE / ...)` → set
    `NODE_EXTRA_CA_CERTS`
  - `connection refused` / `DNS lookup failed` / `timeout` → verify proxy
    host:port reachability

Add `--no-proxy-check` to skip the live round-trip (useful in air-gapped CI
jobs where the proxy host isn't reachable from the runner):

```bash
radar doctor --no-proxy-check
```

The static checks (env var detection, `NODE_USE_ENV_PROXY` status, TLS CA
bundle path) still run.

## Related env vars at a glance

| Env var | Layer | Purpose |
|---|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` | shell | Proxy URL for `fetch()` and Playwright. |
| `NO_PROXY` | shell | Bypass list (comma-separated). Auto-translated to Playwright glob form. |
| `ALL_PROXY` | shell | Playwright-only fallback. Ignored by Node's `--use-env-proxy` (warning emitted). |
| `RADAR_AUTO_PROXY` | radar | `0` / `false` / `off` to disable the self-respawn (Playwright path still active). |
| `NODE_USE_ENV_PROXY` | radar | Hint propagated to subprocesses; set to `1` after a successful self-respawn. |
| `NODE_EXTRA_CA_CERTS` | Node TLS | Extra CA bundle for TLS-intercepting proxies. |
| `RADAR_FETCH_TIMEOUT_MS` | radar | Per-attempt fetch timeout (default `30000`). |
| `RADAR_FETCH_RETRIES` | radar | Fetch retries after first failure (default `2`). |
| `RADAR_AUTO_INSTALL_CHROMIUM` | radar | `1` to let `watch run` spawn `npx playwright install chromium` when Chromium is missing. |
