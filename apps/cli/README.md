# CLI (`kvox`)

First-party command-line client for the API. It authenticates with the same
device authorization flow as any other headless client, stores a personal
access token, and then lets you call any API endpoint from a shell — which
matters because this repository is a **baseline**: new endpoints get added
and old ones get renamed constantly, and a CLI that hard-codes a subcommand
per resource goes stale the day it ships. `kvox` has exactly one command
that talks to the API (`api <method> <path>`), so it stays correct against
endpoints that don't exist yet.

Run with no arguments in an interactive terminal and it opens a full-screen
menu (login, call an endpoint, view config, deploy this server, logout) built
with [ink](https://github.com/vadimdemedes/ink). Everything that menu can do
is also a plain subcommand, and the subcommands are what this document
covers — they're what you'd script or run in CI.

## Install

There's no published package; the installer builds `kvox` from this repo
and deploys a standalone copy — you don't need a local clone to end up with
a working `kvox` on your PATH.

**Platforms:** `install.sh` is a bash script — macOS, Linux and WSL are
supported. There is no native Windows (PowerShell/cmd) support; on Windows,
install inside WSL. The installer detects WSL and prints a dedicated box
about `~/.local/bin` usually not being on `$PATH` there (see below).

Three ways to end up with `kvox`, depending on what you're doing:

| Path | Command | When |
| --- | --- | --- |
| Piped one-liner | `curl -fsSL .../install.sh \| bash` | Normal use — no clone needed |
| Local clone | `KVOX_SRC=/path/to/repo bash /path/to/repo/install.sh` | You already have the repo, or you're offline / testing the installer |
| Workspace build | `npm run build --workspace=cli` then `node apps/cli/dist/cli.js` | You're developing the CLI itself — see [Building from source](#building-from-source-development) |

The piped one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh | bash
```

It's safe to re-run: the installer detects an existing install at
`~/.kvox/app`, shows the old → new version transition, and updates it in
place — the same command is also how you update.

### Install from a local clone

If you already have the repo checked out (or want to test the installer
itself without a network round-trip), point it at that directory with
`KVOX_SRC` instead of letting it `git clone`:

```bash
KVOX_SRC=/path/to/repo bash /path/to/repo/install.sh
```

### Verify the install

```bash
kvox --version
kvox --help
```

The installer already does this for you as its last step: it runs the new
shim's `--version`, prints an install summary (version, install size, and
the app/shim paths), and warns if the version reported by the binary doesn't
match the version it just built from source — a sign something went wrong
partway through the deploy step.

If the shell instead reports `kvox: command not found`, the shim's
directory isn't on your `$PATH` — see the `export PATH=...` guidance below.

### What to do next

- Log in: `kvox login` (see [Logging in](#logging-in)).
- Make a call: `kvox api GET /api/auth/me` (see
  [Calling the API](#calling-the-api)).
- Run `kvox` with no arguments in a real terminal to open the interactive
  ink menu instead of using subcommands.

### Installing a specific version or branch

`KVOX_REF` (default `main`) controls what the installer checks out. It is
passed straight to `git clone --depth 1 --branch`, so a branch or tag name
always works; a raw commit SHA is not reliably accepted there, so pin to a
tag rather than a SHA. It has to be set for the `bash` process itself, not
for `curl`, since a variable set before a command in a pipeline only applies
to that command:

```bash
# Works — KVOX_REF is set on the process that reads it
curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh | KVOX_REF=v1.2.3 bash

# Does NOT work — this sets KVOX_REF for curl, not for bash
KVOX_REF=v1.2.3 curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh | bash
```

The `KVOX_SRC` form doesn't need this — a local clone is already checked
out at whatever ref you have on disk.

### Installing from a private fork

`GITHUB_TOKEN` and `KVOX_REPO` (both in the
[environment variable table](#installer-environment-variables) below) work
together for a private fork: set `KVOX_REPO` to your fork's clone URL and
`GITHUB_TOKEN` to a PAT that can read it. The same "set it on `bash`, not
`curl`" rule applies:

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh \
  | KVOX_REPO=https://github.com/youruser/your-fork.git GITHUB_TOKEN=ghp_xxx bash
```

The installer only rewrites a literal `https://github.com/` prefix in
`KVOX_REPO` into `https://$GITHUB_TOKEN@github.com/`, and only for that one
`git clone`. The token ends up in the temporary checkout's git remote URL —
nowhere else — and that temp directory is deleted (via an `EXIT` trap) as
soon as the installer finishes, whether it succeeds or fails.

### Update

Re-run the same command you installed with — the curl one-liner above, or
the `KVOX_SRC` form for a local clone. Either way the installer detects
the existing install and updates it in place.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh | bash -s -- --uninstall
```

or, from a local clone:

```bash
bash install.sh --uninstall
```

This removes the installed app directory (`~/.kvox/app`) and the `kvox`
shim (`~/.local/bin/kvox` by default). It leaves
`~/.kvox/config.json` — your stored server URL and credentials — untouched;
uninstalling doesn't log you out.

`install.sh --help` (or `-h`) prints its usage, options and environment
variables and exits without installing or touching anything on disk.

### Where things land

| Path | What |
| --- | --- |
| `~/.kvox/app` | The installed CLI — replaced wholesale on every update |
| `~/.local/bin/kvox` | The shim that `exec`s `node ~/.kvox/app/dist/cli.js "$@"` |
| `~/.kvox/config.json` | Your server URL and stored credentials — never touched by install, update or uninstall |

The app root and shim directory are overridable via `KVOX_HOME` and
`KVOX_BIN_DIR` — see the
[environment variable table](#installer-environment-variables) below.

### Requirements

The installer checks for these before doing anything else:

| Tool | Version | Notes |
| --- | --- | --- |
| `node` | >= 20 | apps/cli's own `engines.node` floor |
| `npm` | any | ships with Node.js |
| `git` | any | only needed unless you use `KVOX_SRC` |
| `curl` | any | only needed for the piped one-liner |

apps/cli has no native modules, so there's no C-compiler / build-toolchain
requirement — just these four.

### What the installer does

1. Checks dependencies (`node`, `npm`, `git`, `curl`; warns, but doesn't
   fail, on low disk space).
2. Gets the source — either `git clone --depth 1` of `KVOX_REPO` at
   `KVOX_REF`, or a copy of `KVOX_SRC` if set — into a temp directory
   that's cleaned up on exit.
3. Builds the CLI workspace: `npm install --workspace=cli` then
   `npm run build --workspace=cli`, from that temp checkout.
4. Deploys the standalone app: copies `apps/cli/dist`, `package.json` and
   `README.md` into `$KVOX_HOME/app` (replacing any previous install), then
   runs `npm install --omit=dev` there to pull in just the runtime
   dependencies (commander, ink, ink-select-input, ink-spinner,
   ink-text-input, react). `KVOX_HOME` defaults to `~/.kvox` — or to
   `/usr/local/lib/kvox` when the installer is run as root, see below.
5. Writes the `kvox` shim to `$KVOX_BIN_DIR/kvox` — a small script that
   `exec`s `node $KVOX_HOME/app/dist/cli.js "$@"` — and makes it executable.
   `KVOX_BIN_DIR` defaults to `~/.local/bin`, or to `/usr/local/bin` as root.
6. Checks whether the shim's directory is on `$PATH` and, if not, prints the
   `export` line to add to your shell config (see below). Running as a
   non-root user also prints an advisory here if `sudo` is present, since a
   user-scope install is invisible to it — see Troubleshooting below.
7. Verifies the install by running the new shim's `--version` and printing
   an install summary (version, install size, paths).

If `~/.local/bin` (or your custom `KVOX_BIN_DIR`) isn't on `$PATH`, add
this to `~/.bashrc` or `~/.zshrc` and reload your shell:

```bash
export PATH="$PATH:$HOME/.local/bin"
```

(On WSL specifically, the installer prints a dedicated box with the exact
two commands to run, since `~/.local/bin` is rarely on `$PATH` there by
default.)

### Installer environment variables

Set these before running the installer to override its defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KVOX_REPO` | `https://github.com/marinoscar/kvox.git` | Git clone URL |
| `KVOX_REF` | `main` | Branch/tag/commit to install |
| `KVOX_HOME` | `$HOME/.kvox` (root: `/usr/local/lib/kvox`) | Where the CLI's code is unpacked — not where `config.json` lives, see below |
| `KVOX_BIN_DIR` | `$HOME/.local/bin` (root: `/usr/local/bin`) | Directory for the `kvox` shim |
| `GITHUB_TOKEN` | (unset) | Optional GitHub PAT, for cloning a private repo |
| `KVOX_SRC` | (unset) | Local directory to install from instead of cloning |

`NO_COLOR` and the installer's own `--no-color` flag both disable ANSI
colour in its output.

`KVOX_HOME` and `KVOX_BIN_DIR` pick a different default when the installer
detects it's running as root (`id -u` = 0), and an explicit value for either
still wins over both branches. This isn't cosmetic: `sudo` replaces `$PATH`
with `secure_path` from `/etc/sudoers`, which never contains a home
directory, so a user-scope install left `sudo kvox` answering `command not
found` even though every `kvox deploy` command in
[`docs/deployment/vps.md`](../../docs/deployment/vps.md) assumes a root
shell. `/usr/local/lib/kvox` is world-readable, so one root install serves
both `kvox` and `sudo kvox`; keeping the app tree under `/root/.kvox` instead
would only turn `command not found` into `permission denied`. This moves no
credentials — the CLI's config directory is derived at runtime from the
*running* user's home (`configDirPath()` in `apps/cli/src/config.ts`), so
tokens stay per-user regardless of where the code was unpacked.

### Troubleshooting the install

- **`kvox: command not found`** — the shim directory isn't on `$PATH`.
  Add the `export PATH="$PATH:$HOME/.local/bin"` line above (substituting
  your `KVOX_BIN_DIR` if you set one) to your shell config and reload the
  shell (`source ~/.bashrc` or `source ~/.zshrc`).
- **`sudo kvox: command not found`, while plain `kvox` works fine** — the
  install is user-scoped (shim under `~/.local/bin`), and `sudo` replaces
  `$PATH` with `secure_path` from `/etc/sudoers`, which never contains a
  home directory — no `export PATH=` line in your shell config changes that,
  since `sudo` doesn't read it. Install system-wide instead, which lands the
  shim on `secure_path`:
  ```bash
  sudo bash install.sh
  ```
  (or `sudo KVOX_SRC="..." bash install.sh` from a local checkout). Running
  the installer as root defaults `KVOX_BIN_DIR` to `/usr/local/bin` and
  `KVOX_HOME` to `/usr/local/lib/kvox` for exactly this reason — every `kvox
  deploy` command in `docs/deployment/vps.md` assumes a root shell. A
  non-root install prints this same advice right after installing, when
  `sudo` is present on the machine.
- **Node too old, or missing** — the installer checks `node >= 20` before
  doing anything else and exits with `Node.js >= 20 is required (found:
  ...)` if it's too old, or `node is required but not found.` if it's
  missing at all, pointing at nvm (`nvm install --lts`) or your distro's
  Node package either way.
- **`Git clone failed. If the repo is private, set GITHUB_TOKEN or use
  KVOX_SRC.`** — the script's own message on a failed clone. This also
  covers a bad `KVOX_REF`: `git clone --branch` fails the same way for a
  ref that doesn't exist as it does for a private repo with no credential.
- **Low disk space** — printed as a warning (`Low disk space at install
  target (...MB free; ~50 MB needed)`), never a failure; the install
  continues.
- **"Version mismatch" warning after install** — the installer compares the
  version it just built against what the freshly-installed binary reports
  and warns if they differ. Usually a stale shim, or a second `kvox`
  earlier on `$PATH` shadowing the one just installed — `which -a kvox`
  shows every copy and the order your shell will find them in.

## Logging in

```bash
kvox login
```

This runs the device authorization flow (RFC 8628) — the same "open this URL
and enter this code" flow you'd use for the CLI on a smart TV. It:

1. Requests a device code and user code from the server.
2. Prints a short instruction panel with the verification URL and the code,
   and tries to open your default browser to it (skip that with
   `--no-browser`, which just prints the URL instead).
3. Polls the server until you approve the request in the browser (or it
   expires — RFC 8628's `authorization_pending` / `slow_down` / `expired_token`
   / `access_denied` outcomes all apply).
4. On approval, validates the issued credential against `GET /api/auth/me`
   and saves it — validating before saving means a bad or already-invalid
   credential never overwrites a working one already on disk.

The credential minted here is a **personal access token** (a `pat_...`
string), not a short-lived session JWT — that's what makes it practical to
stay logged in for days between commands. It's stored, along with the server
URL, in `~/.kvox/config.json`. That file is created with `0600`
permissions (owner read/write only) even across restarts and partial
rewrites — see the extensive comment on `writeConfigFile` in
`apps/cli/src/config.ts` if you want the mechanics of how that's guaranteed
under a hostile umask. The token itself is never printed by any command; if
you need to see what's stored, `kvox config` prints the server URL and a
masked hint (`pat_abcd••••••••` — the first eight characters, then a
fixed-width mask) instead.

`login --server <url>` skips the interactive prompt for the server. If you
already have a personal access token (minted from the web UI's Access Tokens
page, or from a previous device-flow login), `login --server <url> --token
pat_...` validates and stores it directly, skipping the device flow entirely
— useful for a one-off headless setup, though prefer the environment
variables below for anything that runs unattended and repeatedly. Passing a
token on the command line puts it in your shell history and in `ps` output
for other users on the machine, which is why the CLI warns about it after a
successful `--token` login.

There is deliberately no `kvox logout` subcommand — logout only exists as
a screen in the interactive menu (`kvox` with no arguments, then choose
Logout). It calls `DELETE /api/pat/{id}` to revoke the token on the server
*before* deleting the local file, on purpose: the PAT this CLI holds is
long-lived, so simply deleting the local copy would leave a fully valid,
unrevoked token that nobody can see is still active. If you're scripting and
need to invalidate a token, revoke it from the web UI's Access Tokens page
(`DELETE /api/pat/{id}` — the same call the TUI makes) — there is no headless
equivalent of the interactive logout.

## Calling the API

```bash
kvox api GET /api/auth/me
```

`api` is the one command that talks to arbitrary endpoints. The response
body goes to stdout and nothing else does — status line, spinner and errors
all go to stderr — so a pipeline sees exactly the server's JSON:

```bash
kvox api GET /api/users --raw | jq '.data[].email'
```

`--raw` prints compact, uncoloured JSON with a trailing newline and nothing
else on stdout; without it, the same body is pretty-printed with colour when
stdout is a terminal. Either way it's the server's response body verbatim —
not the unwrapped `data` field — because a paginated list's `data` +
`pagination` shape and a single resource wrapped by the API's
`TransformInterceptor` as `{ data, meta }` look identical from the outside,
and unwrapping one of them silently drops the pagination info.

Other flags, from `kvox api --help`:

```
Arguments:
  method               HTTP method (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS)
  path                 Request path, e.g. /api/auth/me

Options:
  --query <key=value>  Query parameter; repeat for more than one
  --data <json>        Request body: inline JSON, @file.json, or - for stdin
  --raw                Print unformatted JSON on stdout and nothing else
  -q, --quiet          Suppress the status line and spinner on stderr
  --no-color           Disable colour even on a terminal
  --timeout <ms>       Per-request timeout in milliseconds
```

The exit code is `0` only for a 2xx response; anything else exits non-zero
with the server's own error message, so `kvox api ... || echo failed` (or
just relying on `set -e`) works the way you'd expect in a script. The `/api`
prefix is optional — `kvox api GET /api/auth/me` and `kvox api GET
/auth/me` request the same thing, since the client's base URL already ends
in `/api`.

## Deploying to a server

```bash
kvox deploy doctor
```

Seven subcommands (`doctor`, `install`, `uninstall`, `update`, `status`,
`about`, `certs`) take this repository — or, far more likely, your fork of it — from an empty
VPS to running, migrated, seeded, and served over HTTPS at a real domain, and
back to the latest revision on every subsequent deploy. They run **on the
VPS itself**: SSH in with your own credentials, build `kvox` from a checkout
there (see [Building from source](#building-from-source-development) below),
and run these from inside it. There's no SSH client in `kvox` and no
laptop-driven orchestration — it never dials out to a server on your behalf.

For the full walkthrough — prerequisites, the manual step after install,
troubleshooting — see [`docs/deployment/vps.md`](../../docs/deployment/vps.md).
For why it's built this way, see
[`docs/specs/vps-deploy.md`](../../docs/specs/vps-deploy.md).

Every subcommand exits `0` on success. The exit codes that matter for
scripting:

| Exit | Meaning | Which commands use it |
|---|---|---|
| `0` | Success | all |
| `1` | A step failed / installed but unhealthy | `bootstrap-vps.sh`; `status` (unhealthy); `certs status` (a certificate has expired) |
| `2` | Usage error, or nothing is installed where asked | `bootstrap-vps.sh`; `status`, `about` (nothing under `--apps-root`/`--root`); `certs status` (no certificates under the proxy) |
| `6` (`EXIT.PRECONDITION`) | A required `doctor` check failed before anything was changed | `doctor`; `install`/`update`'s own preflight step (a logged-out `gh` stops `install`/`update` here too, before anything is cloned) |

`about` is the one exception worth calling out: it is informational and
never a health verdict, so a stopped API container or an unreachable remote
is reported inline and still exits `0` — only "nothing is installed" is an
error there, and it shares exit `2` with `status` for that one case, so a
script can tell "no deployment" apart from "a deployment whose API is
down."

### Fresh server in three commands

Getting `kvox` onto a fresh VPS by hand means installing the GitHub CLI,
logging in, cloning the repository, installing Node ≥ 20, building the CLI
workspace and putting the binary on the PATH before `deploy doctor` can even
run. [`bootstrap-vps.sh`](bootstrap-vps.sh) does all of that from a root
shell, idempotently, and ends at the wizard. From a fresh root shell on an
Ubuntu or Debian server that already has Docker:

```bash
gh auth login --hostname github.com --git-protocol https
gh repo view <owner>/<repo> --json name && curl -fsSL "$(gh api repos/<owner>/<repo>/contents/apps/cli/bootstrap-vps.sh --jq .download_url)" -o /tmp/bootstrap-vps.sh
bash /tmp/bootstrap-vps.sh --repo <owner>/<repo>
```

The `gh api` form fetches the script through your login, so it works for a
**private** repository. (If `gh` itself isn't installed yet, the script
installs it — but then it can't be the thing that fetches the script; install
`gh` first from the two `apt` lines the script prints, or use the public
form.) For a **public** repository the plain raw URL works with nothing
installed at all:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/apps/cli/bootstrap-vps.sh -o /tmp/bootstrap-vps.sh
bash /tmp/bootstrap-vps.sh --repo <owner>/<repo>
```

Download-then-run rather than `curl | bash`, deliberately: step 2 may run
`gh auth login`, which needs your terminal on stdin.

Six steps, each printed before it runs, each verified after:

1. **Preconditions** — `id -u` is 0, `/etc/os-release` is Ubuntu/Debian,
   `docker` and `docker compose version` work. Not root, or no Docker, and
   it stops here with the reason; for Docker it prints the `apt` commands
   from docs.docker.com and **never installs Docker itself**.
2. **GitHub CLI** — installs `gh` from GitHub's apt repository if missing,
   runs `gh auth login --hostname github.com --git-protocol https` if not
   logged in (the one interactive step), then `gh auth setup-git` so plain
   `git` uses that token too.
3. **Node.js** — if `node` is missing or older than 20, asks `[y/N]` before
   installing Node 22 from NodeSource; `--yes` answers for you. An existing
   Node ≥ 20 is never touched.
4. **CLI checkout** — `gh repo clone <owner>/<repo> /opt/infra/cli/<repo>`,
   then that checkout's own `install.sh` with `KVOX_SRC` pointing at it (so
   nothing is cloned twice and no `GITHUB_TOKEN` is needed) and
   `KVOX_BIN_DIR=/usr/local/bin`, so `kvox` is on every root shell's PATH.
   Verified with `kvox --version`.
5. **Deploy folder** — `mkdir -p /opt/infra/apps`, nothing more.
6. **Launch** — `kvox deploy doctor --skip-proxy` for a first read-only look
   (its exit code is reported, not fatal), then `kvox` — the interactive
   menu — or with `--no-tui` the exact next command:
   `kvox deploy install --domain <your-domain>`.

Step 6 runs from inside `/opt/infra/cli/<repo>`, and the next-command hint
starts with `cd` there, because `kvox deploy` reads the repository and
branch to deploy from the git checkout it is run in (see
[Deploying a fork](#deploying-a-fork)). That checkout is **not** the
deployment's own `repo/` under `/opt/infra/apps/<name>/` — `deploy install`
clones that separately. The two stay separate on purpose: the running CLI
must never rebuild its own `dist/` in the middle of a deploy pipeline.

| Flag | Meaning |
| --- | --- |
| `--repo <owner>/<name>` | Required. The repository to build `kvox` from; there is no default, so a fork never edits the script |
| `--ref <branch>` | Branch to check out (default: the repository's default branch) |
| `--yes` | Install Node.js without asking when it is missing or too old |
| `--no-tui` | Print the next command instead of opening the menu |
| `--update` | Pull the CLI checkout and rebuild `kvox` — the CLI's own self-update, separate from `kvox deploy update`, which updates the deployed app |
| `--dry-run` | Print every command; run none, probe nothing |

Exit codes: `0` done, `1` a step failed (the step is named in the output),
`2` usage error.

Re-running is a no-op: an installed `gh`, a logged-in account, a Node ≥ 20,
an existing checkout and a working `kvox --version` are each left alone.
`--update` is the exception — it pulls and rebuilds. `--dry-run` prints
exactly what a fresh server would see (it probes nothing, assumes nothing is
installed, and never reads `$HOME` or the hostname), which is also how the
script is tested: `apps/cli/src/bootstrap-vps.test.ts` compares its output
to a committed fixture.

### Where an app lives

Every app deployed from this template gets its own folder under one apps
root, `/opt/infra/apps/<name>/`, holding `repo/` (the CLI's own clone),
`logs/`, `data/` and the state file. `<name>` is also the **compose project
name**, so the containers are `<name>-api-1`, `<name>-web-1`,
`<name>-nginx-1` and two apps on one server never replace each other's.
The same three flags select the app on every subcommand:

```
  --apps-root <dir>  Directory that holds one folder per app (default:
                     "/opt/infra/apps")
  --name <app>       App folder and compose project name
  --root <dir>       Deployment directory, overriding --apps-root/--name
```

`install` defaults `--name` to the repository's own name (`…/kvox.git`
installs as `kvox`). `update`, `status` and `doctor` default to the one app
already installed under `--apps-root`; with several installed they refuse and
list them until `--name` says which. `--root` is the escape hatch that names
the full path outright.

### Checking prerequisites

```bash
kvox deploy doctor
kvox deploy doctor --domain app.example.com
```

Nothing is installed, written or started — it's read-only, so it's safe to
run against a production server at any time, not just before a first
install. It runs around 32 checks, in five groups:

- **Host** — Docker and its daemon, the Compose v2 plugin, the `devnet`
  Docker network, git, node, disk
  and memory headroom, the loopback port; the shared reverse proxy's
  directory and its `conf.d`/webroot being writable; the proxy **container**
  (found by `--proxy-container`, else whatever publishes `:443`, else
  `proxy-nginx`), that it runs on the host network, that its config passes
  `nginx -t` *inside* the container, and that it has IPv6 (the vhost binds
  `[::]`); the `certbot/certbot` image being pulled (certificates are issued
  with `docker run`, never a host `certbot`); ports 80 and 443; and, when
  `ufw` is installed, that it allows both.
- **GitHub CLI** — `gh` installed, `gh auth status` passing, and the
  repository being deployed visible to that account (`gh repo view`). All
  three are required: the server clones a private repository over HTTPS with
  gh's token — `install` and `update` run `gh auth setup-git` for you, and
  an `ssh://` or `git@github.com:` origin copied from a laptop is rewritten
  to HTTPS so that helper is the credential git uses. A remote that isn't on
  github.com is skipped, not failed, and deployed with plain git;
  `--skip-github` skips the group (and the pipelines' `auth` step).
- **Database** — the external PostgreSQL database: reachable, credentials
  valid, database exists, can create tables, the `vector` extension
  (`pgvector`) installed or available to install — *required*, because the
  semantic-search migration cannot run without it, and a `warn` when it is
  available but the connecting role is not a superuser — and TLS.
- **DNS** and **TLS** — once `--domain` turns them on: the name resolves and
  points here (`--public-ip`, or `KVOX_PUBLIC_IP`, states this server's
  address when it sits behind NAT — no external echo service is ever asked),
  the certificate's presence and expiry, and that something renews it
  (`certbot.timer`, a cron line mentioning `certbot` or `renew` anywhere in
  `/etc/cron.d`, `/etc/crontab` or `crontab -l`, or the CLI's own
  `/etc/cron.d/kvox-certs-*`).

`--skip-proxy` makes every proxy, certificate, port and DNS check report
`skip` — it's how the pipeline runs on a box with no proxy at all, such as
CI.

```bash
kvox deploy doctor --json | jq '.checks[] | select(.status=="fail")'
```

Exits `6` (`EXIT.PRECONDITION`) when a required check fails, `0` when only
recommended checks fail — warnings never fail the run. `--json` prints a
machine-readable report on stdout and nothing on stderr.

Other flags, from `kvox deploy doctor --help`:

```
Options:
  --apps-root <dir>         Directory that holds one folder per app (default:
                            "/opt/infra/apps")
  --name <app>              App folder and compose project name
  --root <dir>              Deployment directory, overriding --apps-root/--name
  --proxy-root <path>       Shared reverse proxy directory (default:
                            "/opt/infra/proxy")
  --port <port>             Loopback port the proxy forwards to (default: "3535")
  --domain <domain>         Public domain; enables the DNS and TLS checks
  --proxy-container <name>  Verify this proxy container instead of finding one
  --public-ip <ip>          This server's public address, for the DNS check
                            behind NAT (env: KVOX_PUBLIC_IP)
  --skip-proxy              Skip the proxy, certificate, port and DNS checks
  --skip-github             Skip the GitHub CLI checks (a non-GitHub remote)
  --json                    Print a machine-readable report on stdout
  --no-color                Disable colour even on a terminal
```

`install` runs the required checks above as its own preflight step, and
`update` runs a named subset of them — the host, git, disk, the `devnet`
network, the proxy pair, and the **whole database chain** including
`pgvector`, because `update` migrates and those are preconditions of a step
it is about to run. (DNS and certificates are not re-litigated on a site that
is already serving.) So nothing either does is skipped by running `doctor`
first — but running it on its own first means you find out about a bad DNS
record or an unreachable database before you're mid-pipeline, not partway
through one.

### Installing

```bash
kvox deploy install --domain app.example.com
```

Runs preflight → network → auth → checkout → environment →
validate-environment → build → migrate → seed → start → health → publish →
verify, in that order, printing each step's result as it completes.
`--domain` is the one required flag. `network` creates the external `devnet`
Docker network the compose files declare when the host does not have it yet,
and is a no-op when it does. `auth` is where a logged-out GitHub CLI stops
the run — exit `6`, with the `gh auth login` command to fix it — *before*
anything is cloned; for a GitHub remote it runs `gh auth setup-git` so plain
`git` fetches with gh's token, and for any other remote it stands down.
Everything is written under `<apps-root>/<name>/`, and the `.env` it writes
carries `COMPOSE_PROJECT_NAME=<name>` so a hand-run `docker compose` in the
compose directory sees the same project the CLI does.

The repository and ref come from **this checkout's own git remote**, not a
value hardcoded in the CLI — a fork deploys itself with no configuration
change; see "Deploying a fork" below.

```bash
kvox deploy install --domain app.example.com --staging
kvox deploy install --non-interactive --domain app.example.com
```

Use `--staging` while you're still working out the setup — it requests a
Let's Encrypt **staging** certificate instead of a production one. Worth
doing before a first real attempt, because a failed production issuance
spends real rate-limit budget: five failures per hostname per hour, and 50
certificates per registered domain per week, shared with every subdomain on
that server. `--non-interactive` skips every prompt and fails, listing
what's unresolved, rather than asking; pair it with `--all` to review every
environment variable instead of only the essential dozen.

With `--all`, the interactive (ink) wizard's remaining "Everything else" step
is **paginated, one page per `.env.example` section banner** (issue #240),
capped at six keys a page. Rendering all ~37 leftover keys at once (74 rows —
each key costs a keep/edit/skip row plus a value row) pushed the focused
field off-screen, so the step could not be completed at all; splitting on the
template's own section headings (`Web Push`, `Observability`, …) instead of a
running count keeps a section's keys together and lets each page carry the
section name and a `page N of M` marker the operator can match against the
file they copied from. The rail still shows one entry for the whole step —
adjacent pages collapse into it — so the wizard still reads as ten steps no
matter how many pages the catch-all splits into. A key the template ships
with no value (commented out, or blank) now offers "Leave unset" in place of
"Keep", since there is nothing behind a blank field to keep.

The wizard also no longer asks about Web Push (`VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`), even under `--all` (issue #241): the
admin UI at `/admin/settings/push` generates, rotates and enables these live,
with no restart, and is the intended path. The three variables are still
read — `PushConfigService.resolveActiveVapidConfig()` falls back to them when
no configuration has been saved through that page — so an operator who wants
the environment-variable path can still set them by hand in `.env`; see
[`docs/runbooks/vapid-keys.md`](../../docs/runbooks/vapid-keys.md).

The environment is collected in **steps** — domain, database, secrets,
Google OAuth, admin, resources — and each is verified before the next
question: the DNS record when the domain is typed, the connection,
credentials, database and privileges when the database is. A failed check
re-enters the step with its remedy shown, so a wrong password is corrected
on the spot. Nothing is pre-filled for the database host. Secrets are
generated (on every path, including `--non-interactive`); the loopback
port, the job worker slots and the container memory limits are **measured
from the server and applied, not asked** (issue #257) — `min(4, cpus − 1)`,
a limit sized to the RAM, and the first port from 3535 that clears all three
port sources below. Each is printed as it is taken and appears in the Review
table with its reason, so nothing is applied without being shown; pass
`--answer APP_BIND_PORT=3600` to decide one yourself, or `--all` to be asked
about every one of them. A value already in the `.env` is never
second-guessed. The
OAuth step prints the exact redirect URI to register before asking for the
client id. The id is checked locally before anything reaches Google: one
that doesn't contain `.apps.googleusercontent.` is certainly the wrong field
(a project id, an API key) and hard-fails on the spot; one that does but
doesn't end `.apps.googleusercontent.com` — a well-formed placeholder on a
reserved TLD such as RFC 2606 `.invalid` or `.test` — only warns and skips
the probe entirely, since it can't be a client Google knows about and
probing it would send a credential to a third party for a value that isn't
real. A step's `onLeave` checks run in `--non-interactive` mode too
(`env-wizard.ts`), which is why that distinction matters for an unattended
install and not just an interactive one. Only an id actually ending
`.apps.googleusercontent.com` is verified against Google's own token
endpoint: a deliberately bogus authorization code gets `invalid_client` back
when the pair isn't real (a hard failure) or `invalid_grant` when it is (the
pass). That proves the credentials are a real pair, not that login will
work — a client secret can't be fully exercised without a browser round-trip,
and whether the redirect URI is actually registered isn't checkable from
here. Google being unreachable is a warning, not a failure — an operator on
a restricted network must still be able to install.

The **bind port** is chosen against three sources, because each sees
something the other two cannot (issue #257): the state files of the apps
under `--apps-root` (a stopped app this CLI installed), every host port
Docker has been told to publish — read from `HostConfig.PortBindings`, so a
**stopped** container this CLI did not install counts too — and a live
loopback bind probe (a stray process that is no container at all). The
reason shown beside the chosen port names whichever of the three passed the
earlier ones over ("3536: 3535 is held by container pgadmin"). Docker is not
a requirement of the scan: a query that fails, times out or returns nothing
parseable falls back to the other two sources rather than refusing to
suggest a port.

The port is then **re-verified immediately before `docker compose up -d`**,
because the build, migration and seed between choosing it and binding it
take minutes. If it was taken in that window the install stops and names the
port and, where Docker can say, the container now holding it. It is
deliberately not re-picked: an external proxy or a DNS record may already
point at that port, so the remedy is yours (`--answer APP_BIND_PORT=<n>`).
This deployment's **own** containers are not a collision — a `--resume`
after a failed health step finds its own `nginx` still on the port, which
`up -d` is about to recreate.

When the Database step's own checks fail specifically because the database
itself does not exist yet, the wizard offers to create it — naming the
database, host, port and user — then re-runs the step's checks so
`database-privileges` — "can this user create tables", which is what decides
whether the migrations will work — finally answers instead of staying skipped
(issue #238). Declining leaves the failure exactly as it was,
`createdb` remedy included. With a terminal, `--create-database` only sets
that confirmation's default answer; you're still asked by name. Under
`--non-interactive` there is nobody to ask, so `--create-database` is the
entire authorisation — without it an unattended run reports the missing
database and stops, same as before this flag existed. See
[`docs/specs/vps-deploy.md` §20](../../docs/specs/vps-deploy.md#20-creating-the-database-on-request-only-issue-238)
for the exact bounds (one statement, only when the database is genuinely
absent, no roles or extensions, never destructive).

`--answer KEY=VALUE` (repeatable) and `--answers-file <path>` (a `.env`-format
file; the file first, then the flags) seed values without a prompt. The
domain may be given in the file as `APP_DOMAIN`. Every value goes through
the same validator the prompt would apply, before anything runs:

```bash
kvox deploy install --non-interactive --answers-file answers.env
```

with only the domain, the database, the OAuth client and the admin email in
the file is a complete install — every secret generated, every resource
suggested and printed with its reason in the review table.

`install` is idempotent — if it fails partway through, fix whatever it
reported and run the same command again, or add `--resume` to continue from
the step that failed rather than re-running everything before it.
`--reinstall` installs over an existing deployment on purpose; `--force`
discards uncommitted changes in the checkout it manages; `--skip-doctor`,
`--skip-proxy` and `--skip-seed` each skip exactly the one stage they name.

**Which deployment `install` acts on** is decided before anything is read or
written, in three ranks (issue #266):

1. `--root <dir>` or `--name <app>`, and `--repo <url>` for the repository
   itself.
2. **The deployment you are standing in.** From a deploy root under
   `--apps-root` — or any directory inside one, such as
   `<root>/repo/infra/compose` — the state file there names the repository,
   the ref and the app, and that is what is used. This is what makes
   `cd /opt/infra/apps/<app> && kvox deploy install --resume` work, which is
   where the on-screen instruction after a failed install leaves you standing.
   The walk upward stops at the apps root: standing at the apps root itself,
   or above it, resolves nothing this way.
3. The `origin` of the git checkout around the current directory.

Rank 2 exists because rank 3 answered a question it could not answer: on a
server whose `/opt/infra` is itself a git repository — infrastructure as code,
with the apps underneath it — the walk went past the deploy root's own state
file and derived the app from the infrastructure repository. That is refused
outright (a checkout containing the apps root is never treated as the
application), and the refusal still stands for a directory that really does
imply nothing. Nothing is ever scanned for candidates: exactly one deployment
is implied by a directory, or none.

`--resume` is available after **any** failed run, including the first install
at a deploy root. A run that fails writes its deployment state before it
exits, recording the steps that did complete, the step that stopped it and
that it did not finish — so `--resume` re-enters at that step and skips the
clone, the image build and the migration that already succeeded. The failed
run does **not** write `deploy-info/`: that file is what the running
application reports about itself, and an install that did not finish has not
deployed what it would claim. `deploy status` says so on such a root ("the
last install failed at `<step>`") rather than reporting it as an ordinary
deployment, and re-running plain `install` there does **not** ask for
`--reinstall` — nothing was deployed for it to install over. A failed run
over a deployment that *had* previously completed still does.

`--resume` reads the state file inside the deploy root, so it needs that root
resolved first — which rank 2 above now does from the directory you are
standing in. Outside the apps root, name the deployment with `--name` (or
`--root`, or `--repo`) exactly as the original run did; with nothing to point
at, `--resume` refuses rather than starting a new install somewhere else.

The `publish` step talks to the shared proxy **container** only — there is
no host `nginx` or `certbot` on the server. Before spending any Let's
Encrypt rate-limit budget it writes a nonce under the proxy's ACME webroot
and fetches it over `http://<domain>/.well-known/acme-challenge/…` — the
exact path the HTTP-01 challenge takes — and fails, naming the domain and
what answered instead, when the nonce does not come back (a wrong DNS
record, or a proxy not serving the webroot). The certificate is then issued
with `docker run --rm … certbot/certbot certonly --webroot`, the vhost is
written with the paths the container sees (`/var/www/certbot`,
`/etc/letsencrypt/live/<domain>/…`), and it is validated and reloaded with
`docker exec <container> nginx -t` / `nginx -s reload`, rolled back if `-t`
fails. The container is `--proxy-container`, else whatever `doctor` found
publishing `:443`, else `proxy-nginx`, and is recorded in the state so
`update` reuses it. `--no-ipv6` renders the vhost without `[::]` listeners
for a host with IPv6 disabled (the reload, not `nginx -t`, is what fails
there). When this deployment has no renewal entry yet, one is written to
`/etc/cron.d/kvox-certs-<name>` (see [Certificates](#certificates) below);
`--install-cron` writes it regardless, `--no-install-cron` never does. The
gate is whether an entry exists, not whether this run issued a certificate,
so a re-run over an existing certificate installs the missing schedule
instead of silently leaving it out.

**`/etc/cron.d` is root-owned, so this one step may need you.** The CLI runs
as an ordinary user on purpose — running it under `sudo` resets `HOME` and
logs `gh` out — so on a standard server it cannot write that file. That does
**not** fail the install: the certificate is issued, the vhost is live, the
site serves HTTPS, and the run finishes with an `Action required:` block
carrying the error and one line to paste, e.g.

```bash
sudo install -m 644 /opt/infra/apps/<name>/kvox-certs-<name> /etc/cron.d/kvox-certs-<name>
```

The file named there is the exact one the CLI would have written; it is
staged in the deploy root so you can read it first. Verify afterwards with:

```bash
ls /etc/cron.d/kvox-certs-*
```

`doctor`'s `cron-dir-writable` check tells you in advance whether this step
will be needed. It is `recommended`, never `required` — a root-owned
`/etc/cron.d` is the ordinary case, not a broken server.

Other flags, from `kvox deploy install --help`:

```
Options:
  --apps-root <dir>    Directory that holds one folder per app (default:
                       "/opt/infra/apps")
  --name <app>         App folder and compose project name
  --root <dir>         Deployment directory, overriding --apps-root/--name
  --domain <domain>    Public domain to publish under
  --proxy-root <path>  Shared reverse proxy directory (default:
                       "/opt/infra/proxy")
  --port <port>        Loopback port the proxy forwards to (default: suggested,
                       from 3535)
  --repo <url>         Repository to deploy (default: this checkout's origin)
  --ref <ref>          Branch, tag or commit (default: the remote default
                       branch)
  --email <email>      Certificate registration address
  --group <name>       Optional feature group; repeat for more (default: [])
  --all                Review every environment variable, not only the essential
                       ones
  --non-interactive    Never prompt; fail listing anything unresolved
  --answer <KEY=VALUE>  Supply one environment value without a prompt; repeat
                       for more (default: [])
  --answers-file <path>  Supply environment values from a .env-format file
  --reinstall          Install over an existing deployment
  --resume             Continue from the step that failed
  --skip-doctor        Skip the prerequisite checks
  --skip-proxy         Do not touch the reverse proxy or request a certificate
  --skip-seed          Do not run the database seed
  --create-database    Create the PostgreSQL database when it does not exist
  --skip-github        Never consult the GitHub CLI, even for a GitHub remote
  --no-cache           Rebuild images without the layer cache
  --force              Discard uncommitted changes in the checkout
  --staging            Use Let's Encrypt staging while working out the setup
  --proxy-container <name>  Publish through this proxy container instead of
                       finding one
  --no-ipv6            Render the vhost without [::] listeners (a host with
                       IPv6 disabled)
  --install-cron       Write the certificate renewal cron even when this
                       deployment already has one
  --no-install-cron    Never write the renewal cron
  --fresh              Discard this app's prior .env, state file and
                       deploy-info first, and install clean
  --json               Print a machine-readable result on stdout
```

`--fresh` is the "start over on the same server" flag, and it exists because
`.env` deliberately lives at `<deployRoot>/.env` — *outside* `repo/` — so
that `rm -rf repo` can't take your secrets with it. That's right for a
re-clone and wrong for a start-over, and it's how a corrupt `.env` survived
three consecutive install attempts and produced a failure whose symptom
pointed nowhere near its cause (issue #259). `--fresh` discards **this app's
local state only** — the `.env`, the state file and `deploy-info/` — after
copying the old `.env` to `<apps-root>/<name>.env.<timestamp>.bak` (0600),
and then installs normally. It implies `--reinstall`.

It deliberately does **not** touch the containers, the proxy vhost, the TLS
certificate or the database, and it needs no typed confirmation: nothing
irreversible is destroyed, because the backup is taken first and the clone is
re-fetched anyway. To remove a deployment outright, use `uninstall` below.

**`install` does not create an admin user.** The seed writes the allowlist
row for `INITIAL_ADMIN_EMAIL`, not a user account — nobody has access until
that address logs in through Google OAuth at `https://<domain>`. See "After
install: the first login" in the runbook linked above.

### Removing a deployment

```bash
kvox deploy uninstall --dry-run          # see exactly what would go
kvox deploy uninstall --confirm myapp    # then do it

# the data too, each with its own typed confirmation
kvox deploy uninstall --dry-run --drop-database --purge-storage
kvox deploy uninstall --confirm myapp \
    --purge-storage --confirm-bucket my-bucket \
    --drop-database --confirm-database appdb
```

It is also the `Uninstall` destination in `kvox tui` → Deploy, which drives
this exact command.

```
  --confirm <name>           Type the app's own name to authorise the removal
  --drop-database            ALSO drop the database (off by default)
  --confirm-database <name>  Type the database's own name to authorise it
  --purge-storage            ALSO empty this app's prefixes in the bucket
  --confirm-bucket <name>    Type the bucket's own name to authorise it
  --dry-run                  List everything that would be removed; change
                             nothing
  --certs                    Also delete the TLS certificate
  --keep-env                 Leave the .env in place (a backup is taken either
                             way)
  --non-interactive          Never prompt; every --confirm* is then required
  --skip-proxy               Do not touch the shared reverse proxy
  --proxy-root <path>        Shared reverse proxy directory
  --proxy-container <name>   Proxy container to reload
  --json                     Print a machine-readable result on stdout
```

**Removes**, in this order:

- **the compose project** — containers, project networks and named volumes,
  with `down -v --remove-orphans` through the same
  `-p <name> -f base -f prod -f vps` invocation `install` uses. `-v` is what
  makes it a removal rather than a stop.
- **the deploy root** — `repo/`, `.env`, `logs/`, `data/`, `deploy-info/` and
  the state file, named one by one so `--dry-run` can print a list.
- **this app's vhost** in the shared proxy, by its exact path and only when it
  still carries the `# Managed by appctl deploy` marker, then **reloads** the
  proxy (never restarts it — that would drop every other site's connections).
- **this app's certificate renewal cron**, `/etc/cron.d/kvox-certs-<name>` —
  but **only quietly when another entry survives**. Every such entry runs
  `certs renew --all`, so one entry renews *every* certificate behind the
  shared proxy, not just its own app's. If this was the **last** one, it is
  still removed (leaving it means a cron pointing at a deploy root that no
  longer exists, failing silently twice a day) and the run prints an
  `Action required:` block above everything else, saying that automatic
  renewal has stopped **for every app on the server** and giving the exact
  `kvox deploy certs renew --install-cron --apps-root <dir> --name <surviving-app>`
  to put it back — naming a real surviving deployment where there is one.
  `--dry-run` prints it too, which is when you actually want to know.

**Removes only if you ask for it by name** (issue #268). Both are off by
default, and neither is reachable by omission:

- **`--drop-database`** issues `DROP DATABASE "<name>"` against the `postgres`
  maintenance database, through the same one-off `psql` container every
  database check uses. It runs **after** the containers are down, so in the
  ordinary case nothing is connected and **no session is touched at all**. If
  the drop is refused with `55006` ("is being accessed by other users"), the
  open sessions are ended — **scoped to this one database**, never a bare
  terminate-all — and the number ended is reported. If they can't be ended,
  you get the `pg_stat_activity` query that names exactly what is holding it
  open, not psql's own sentence.
- **`--purge-storage`** empties the six prefixes this application writes —
  `avatars/`, `database-backups/`, `node-outputs/`, `notes/`, `transcripts/`,
  `uploads/` — and **reports anything else in the bucket without reading into
  it or deleting it**. There is no per-app key prefix: objects are written at
  bucket root, so "empty the bucket" and "delete this app's objects" coincide
  only when the bucket is dedicated. This is complete for a dedicated bucket
  and safe for a shared one. **The bucket itself is never deleted.** On a
  **versioned** bucket every version *and* delete marker is removed **by id**,
  because a plain delete there writes another marker and keeps the bytes and
  the bill; an unreadable `GetBucketVersioning` is treated as versioned rather
  than off. The `aws` client is borrowed from a one-off container, like
  `psql`, so no S3 SDK is added to this package and the credentials from your
  `.env` are passed by name, never in an argv.

**Each takes its own typed confirmation of that resource's real name.**
`--confirm-database <database>` and `--confirm-bucket <bucket>`, compared
against that resource and nothing else — a word typed for one can never
authorise the other. That is the convention the API already uses (the Danger
Zone's rule that *the confirmation IS the scope, uppercased*). Under
`--non-interactive` each must arrive as its flag; there is no combined
"delete the data too" switch and there will not be one.

**You see the numbers before you are asked.** Both print a full inventory
first — objects and bytes per prefix, everything in the bucket that is not
ours, the database's name, host, size and open session count — because you
cannot consent to a number you were never shown. `--dry-run` prints the same
inventory and destroys nothing, which is how to look before deciding. A
resource that could not be *read* is never confirmed and never destroyed; the
run reports why and removes the deployment anyway.

**Never removes** — each one a deliberate refusal, documented with its
reasoning in
[`docs/specs/vps-deploy.md` §21](../../docs/specs/vps-deploy.md#21-removing-a-deployment-what-it-refuses-to-remove-and-the-two-extras-that-must-be-asked-for-issues-261-268):

- **Your database, without `--drop-database`.** `deploy` validates it and
  never manages it; it holds your data and usually lives on another host. The
  `dropdb` command is **printed** — assembled from the deployment's own
  `.env`, read before anything is deleted, because afterwards nothing is left
  that knows the database's name — with no password in it.
- **Your object storage, without `--purge-storage`.**
- **The `devnet` network** and **the shared proxy container**. Both are shared
  with every other app on the server.
- **TLS certificates**, unless you pass `--certs`. Let's Encrypt allows only
  **5 duplicate certificates per week** for the same set of hostnames, and a
  reinstall re-requests the certificate — so destroying and re-requesting on
  each iteration of a broken install locks you out of issuing for your own
  domain for a week, with the app down. `--certs` uses `certbot delete
  --cert-name`, which knows all three of a certificate's linked directories.

**The confirmation is the app's own name, typed** — not a `y/N`. That is the
convention this project already uses for destructive API actions
(`confirmation: "RESTORE"`, `"ROLLBACK"`, `"REMOVE"`), and typing the name
additionally proves you're removing the deployment you think you are. With
`--non-interactive` it must arrive as `--confirm <name>`; a destructive
default reachable by omission is not a default. `--dry-run` needs no
confirmation, because it destroys nothing.

**The `.env` is backed up first**, to `<apps-root>/<name>.env.<timestamp>.bak`
(0600) — *outside* the directory being removed, or it wouldn't be a backup. It
holds generated secrets that may exist nowhere else. `--keep-env` leaves the
file in place as well, and the deploy root survives with just that file in it.

**A half-removed deployment uninstalls cleanly.** No containers, no clone, no
deploy root, or a state file this build can't parse: each is reported rather
than treated as an error, and the run continues. If the clone is gone the
compose project can't be torn down at all (compose needs its files), so the
`docker rm -f` command that works without them is printed instead.

`--dry-run` writes **nothing at all**, the run journal included, and starts no
subprocess. A successful uninstall deletes its own log along with `logs/`; a
*failed* one keeps it, which is the run you'd want a log for.

**The order is fixed**: the containers stop, then the storage is purged, then
the database is dropped, then the deployment is removed. Containers first
because nothing may write an object or open a connection mid-teardown; storage
before the database because the deployment's own rows are the only thing that
could ever reconcile an object the purge missed; the deployment last because
its `.env` holds the credentials the other two steps authenticate with. A
failed extra is reported under `Action required:` and does **not** fail the
uninstall — the deployment was going whatever the bucket said.

Exit `2` covers "nothing is installed here" and any confirmation that was
missing or wrong — the app's, the bucket's or the database's.

### Deploying a fork

You don't need to change anything in this CLI to deploy a fork. The
repository URL and ref are read from your own checkout's git remote (a fork
using `master` or `develop` as its default branch works with no `--ref`
needed — nothing here assumes `main`), and the environment wizard's
questions are parsed structurally from *your fork's own*
`infra/compose/.env.example` — not a list of field names hardcoded into the
CLI.

The wizard tries four sources for that file, in order, and uses the first
that answers: the repository's own copy read from the remote at the resolved
ref (`gh api`, the same credential the `checkout` step clones with); a
checkout already on this server, or the one the CLI is running from; the
copy `install.sh` saved beside the CLI when it was installed, if that copy
came from the repository actually being deployed; or, failing all three, a
refusal to install rather than an offer built from template defaults. Never
a sibling app's template at any step, and never one repository's file
answering another's questions — see
[`docs/specs/vps-deploy.md`](../../docs/specs/vps-deploy.md#61-where-the-template-file-comes-from-and-why-the-order-matters-issues-229-230-234-236)
for the four sources and why each is weaker than the one before it.

Because `install.sh` bundles the repository's own `.env.example` when it
builds the CLI, **a first install no longer needs `gh` at all** to ask the
right questions, as long as the CLI was installed (or last updated) from the
repository you're deploying now. The remote read is still tried first and is
the most current — it reflects the exact ref being deployed rather than
whatever commit the CLI happened to be built from — so it's still worth
having `gh` logged in. Remember that `gh`'s authentication is **per user**:
`sudo kvox deploy install` runs as root, and root needs its **own**
`gh auth login`, separate from whatever account you logged in as yourself. A
`gh` that can't answer is reported on the Welcome screen (not installed, not
logged in, no access to the repo, timed out, or an empty file) but never
fails the install by itself, as long as one of the other two sources can.

Rename the app, add a new secret to your `.env.example`, remove a feature
block: `kvox deploy install` follows all of it with no flag changes, for the
same reason `api <method> <path>` (above) doesn't go stale as endpoints
change — nothing about a specific repository's shape is baked into the tool.

### Updating

```bash
kvox deploy update
```

Brings an already-installed server up to the latest revision (or, with
`--ref`, to a specific one): auth, fetch, build, migrate, seed, restart,
verify. It refuses to run at all if nothing is installed under `--apps-root`
yet.

#### Adopting a deployment with no state file

`update` asks whether a **deployment** is there, not whether the CLI's own
record of one is. When `.appctl-deploy.json` is missing but a deployment
plainly is not — an install that stopped before the record was written, a
directory restored from a backup that skipped a dot-file, a record deleted by
hand — `update` rebuilds the record and carries on, rather than sending you to
`install`, whose own precondition is the opposite.

Two things must **be** there before it will: a git checkout at `<root>/repo`,
and a readable `.env`. Both, not either. Running containers are deliberately
not part of the gate — a deployment whose containers are stopped or pruned is
exactly the one you are trying to update. A directory with neither, or with
one, still gets the refusal it always got, plus a line naming the half that
was found.

What is rebuilt, and from where:

| Field | Read from |
|---|---|
| `repoUrl` | `git -C repo remote get-url origin` |
| `commitSha` | `git -C repo rev-parse HEAD` |
| `ref` | `--ref`, else the branch HEAD is on, else the remote's own default branch |
| `name` | `.env`'s `COMPOSE_PROJECT_NAME`, else the directory name |
| `bindPort` | `.env`'s `APP_BIND_PORT`, else 3535 |
| `domain` | `.env`'s `APP_URL` host, else the proxy vhost that forwards to `bindPort` |
| `installedAt` | `deploy-info/info.json`, when that survived — otherwise left **unknown** |

`installedAt` and `lastDeployedAt` are **never invented**. Neither is knowable
from a disk the CLI did not write, and a guessed timestamp would show up on the
About page as a fact. Absent means unknown, `deploy-info/info.json` carries
`null` for them, and About renders its unknown mark. The record instead carries
`adoptedAt` — when the bookkeeping was rebuilt, which is not the same thing as
when the deployment was made.

It says so once, before the pipeline runs, listing every field and its source;
the same block goes into the run journal, and `--json` carries it as `adopted`
on the result. Three things make it refuse rather than guess: a clone with no
`origin`, a clone with no HEAD, and a detached HEAD whose remote has no default
branch (pass `--ref`) — guessing `main` is how a fork on `master` gets deployed
from the wrong branch.

An existing state file is always used exactly as it is, and is never
reconstructed over.

A bare `kvox deploy update` with no `--name`/`--root` reaches this too:
discovering apps under `--apps-root` uses the same evidence gate, so a
directory that is a deployment is found whether or not it has a state file. Two
of them with nothing named refuses exactly as two installed apps always did —
`Several apps are installed under …: alpha, beta. Pass --name <app> to say
which one.` — and a recorded app beside an unrecorded one refuses the same way,
with no silent preference for either.

⚠ `status`, `about` and a named `certs` are **not** part of this. They still
want a state file, because each is a read-only reporter and adopting from one
would mean writing the CLI's private record from a command that only reports.
Run `update` once to restore the record and they work again.

```bash
kvox deploy update --check
kvox deploy update --ref v1.4.0
```

`--check` answers "is there anything to update, and what?" without doing
it: it fetches, then prints `current <sha12> → latest <sha12>, N commits
behind` followed by the commit subjects (or `already up to date at
<sha12>`), records the result as `remote` in `deploy-info/info.json` —
which is what the About page reads — and exits `0` either way, with nothing
checked out, built or written to the state file. `--json` prints that
object (`current`, `latest`, `commitsBehind`, `commits`, `checkedAt`) on
stdout. A plain `update` prints the same block before it builds, so you see
what is about to be applied; there is deliberately no auto-update when
behind and no update cron.

If the resolved ref's commit hasn't moved since the last successful run,
`update` exits `0` **without doing anything** — no rebuild, no restart —
which is what makes it safe to run unattended, e.g. from cron. `--force`
rebuilds anyway even when the revision is unchanged.

The `auth` step runs `gh auth status` and `gh auth setup-git` on every
update for a GitHub remote — idempotently, so a server whose git config was
reset heals here rather than stalling on git's own password prompt. A
logged-out `gh` stops the update with exit `6` before the fetch.

The database seed **re-runs by default** on every `update`. The seed is
entirely upserts, and re-running it is the only way a permission or role a
newer release adds actually reaches an already-installed server — skip it
and the feature ships, the permission doesn't exist, and it shows up later
as a confusing 403 with nothing in the logs to explain it. This is a
deliberate divergence from the shell scripts this replaces, which never
re-seeded; pass `--skip-seed` if you've hand-edited seeded rows and don't
want them upserted back.

There's no automatic rollback. A partly-applied database migration can't be
undone by checking out the old code, so on failure `update` prints the
previous revision and the exact command to redeploy it —
`kvox deploy update --ref <sha> --force` — and leaves that decision to you.

The `publish` step rewrites the vhost (keeping the upload limit from
`MAX_FILE_SIZE`, so an update never resets it), reloads the proxy container
only when the file actually changed, and — when the certificate expires
within 30 days — renews it through `docker run certbot/certbot renew`
rather than trusting that a cron exists.

Other flags, from `kvox deploy update --help`:

```
Options:
  --apps-root <dir>  Directory that holds one folder per app (default:
                     "/opt/infra/apps")
  --name <app>       App folder and compose project name
  --root <dir>       Deployment directory, overriding --apps-root/--name
  --check            Report what an update would apply, then stop; nothing is
                     changed
  --ref <ref>        Branch, tag or commit to move to
  --force            Rebuild even when the revision has not changed
  --no-cache         Rebuild images without the layer cache
  --non-interactive  Never prompt; fail listing anything unresolved
  --answer <KEY=VALUE>  Supply a value a new revision asks for; repeat for more
                     (default: [])
  --answers-file <path>  Supply such values from a .env-format file
  --skip-seed        Do not re-run the database seed
  --skip-proxy       Do not touch the reverse proxy
  --skip-github      Never consult the GitHub CLI, even for a GitHub remote
  --json             Print a machine-readable result on stdout
```

### Checking status

```bash
kvox deploy status
```

Reports whether the installed app is healthy: container state, an
immediate `/api/health/ready` poll, migration state, and — with `--domain` —
an external HTTPS check. It also runs the same fetch-and-compare
`update --check` does (bounded to ten seconds, never cloning) and renders it
as an `Update` line — `3 commits behind (latest <sha12>, checked just now)`
— refreshing `remote` in `deploy-info/info.json` on the way; `--json`
includes it as `remote`. When the remote can't be reached the line reads
`update check: unavailable (<reason>)` and the verdict is unaffected:
"is it serving?" and "is it current?" are different questions.

```bash
kvox deploy status --domain app.example.com
kvox deploy status --json || alert 'deployment unhealthy'
```

`/api/health/ready` returning 200 only proves the app can run `SELECT 1`
against the database — it passes against a completely empty, unmigrated one
just as readily as a fully migrated one. That's why `status` reports
migration state as its own fact rather than inferring it from the health
probe.

Exits `0` when serving and the schema is current, `1` when installed but
unhealthy, `2` when nothing is installed under `--apps-root` (or at
`--root`).

It reports the deployed revision as a single `Revision` line and points at
`kvox deploy about` for the rest — when it was installed and last updated,
by whom, and what machine it is on.

Other flags, from `kvox deploy status --help`:

```
Options:
  --apps-root <dir>  Directory that holds one folder per app (default:
                     "/opt/infra/apps")
  --name <app>       App folder and compose project name
  --root <dir>       Deployment directory, overriding --apps-root/--name
  --port <port>      Loopback port the proxy forwards to (default: "3535")
  --domain <domain>  Public domain; adds an external HTTPS check
  --json             Print a machine-readable report on stdout
  --no-color         Disable colour even on a terminal
```

### What is deployed here

```bash
kvox deploy about
```

The full picture, in three blocks mirroring the web Console's About page:

- **Application** — the app version recorded at deploy time, and (when a
  login for this deployment is available) the running process's API version,
  environment, Node, start time, server clock, PostgreSQL version and
  migration count, read from `GET /api/admin/about`.
- **Deployment** — revision and ref, repository, domain and bind port, when
  it was installed, when it was last updated, by which command and which CLI,
  the previous revision, the deploy root, the environment file and the proxy
  container — plus `Update: 3 commits behind (latest <sha12>)` and when that
  was last checked.
- **Server** — hostname, OS, kernel, architecture, CPU, memory, disk, Docker,
  Compose and Node as recorded at deploy time. A live value that has changed
  since is shown beside it: `3.8 GiB  (now 7.6 GiB)`.

Every timestamp is UTC with how long ago it was —
`2026-09-15 18:02:11 UTC (3 hours ago)` — so the terminal, the web card and
`deploy-info/info.json` never disagree about the same moment.

```bash
kvox deploy about --check
kvox deploy about --json | jq .deployment.updatedAt
kvox deploy about --server http://127.0.0.1:3535
```

`--check` fetches the remote first (the same computation `update --check`
runs, never cloning) and records the result in `deploy-info/info.json`;
without it the `Update` line reports what was last recorded, or
`never checked`. `--json` prints the report on stdout and nothing else, so it
pipes into `jq`; every timestamp there is the ISO-8601 `Z` string the file
carries, unformatted.

The Application block needs a token for **this** deployment's own domain. A
login stored for a different server is refused rather than reported as this
one's — pass `--server <url>` to ask an API explicitly, which is also how you
reach it over the loopback port while the domain is not yet serving. Without
either, the block reads `unavailable (not logged in)` and everything else
still renders.

**It is informational, never a health verdict.** A stopped API container, an
unreachable remote and a missing deployment record are all reported inline
and still exit `0`; only "nothing is installed under `--apps-root` (or at
`--root`)" is an error, and it exits `2` — the same code `status` uses, so a
script can tell "no deployment" from "a deployment whose API is down". Use
`kvox deploy status` for the check a monitor should act on.

Other flags, from `kvox deploy about --help`:

```
Options:
  --apps-root <dir>  Directory that holds one folder per app (default:
                     "/opt/infra/apps")
  --name <app>       App folder and compose project name
  --root <dir>       Deployment directory, overriding --apps-root/--name
  --check            Fetch the remote first, so the Update line is current
  --server <url>     Ask this API about itself instead of the deployment's own
                     domain
  --json             Print the report on stdout
```

### Certificates

```bash
kvox deploy certs renew
kvox deploy certs renew --dry-run
kvox deploy certs renew --install-cron
kvox deploy certs status
```

Certificates live behind the shared proxy, and are issued and renewed with
`docker run --rm certbot/certbot` against the proxy's own `letsencrypt/`
and `webroot/` directories — never a host `certbot`. `renew` runs certbot's
`renew` for this app's domain (or every certificate under the proxy with
`--all`); certbot decides what is due, and the proxy container is reloaded
with `docker exec` **only** when something was actually renewed, so a
scheduled run on a quiet day touches nothing. `--dry-run` passes certbot's
own `--dry-run` (a rehearsal against staging) and prints the argv.

`--install-cron` writes `/etc/cron.d/kvox-certs-<name>` — `root`, twice
daily at 03:xx and 15:xx with a minute derived from the app's name so
several apps on one box don't all fire together — calling
`kvox deploy certs renew --all --apps-root <…> --name <…>` and logging to
`/var/log/kvox-certs-<name>.log`. It is idempotent: a second run rewrites
nothing. `install` writes the same file whenever this deployment does not
already have one. `doctor`'s `certificate-renewal` check recognises it, and
its `cron-dir-writable` check says in advance whether the write will succeed.

Writing into `/etc/cron.d` needs root and this CLI is deliberately never run
under `sudo`, so on a standard server the write fails. `install` treats that
as non-fatal and prints a `sudo install -m 644 …` line to finish it by hand
(see [Installing](#installing) above); `certs renew --install-cron`,
where you asked for the cron explicitly, still reports the failure as one.

`status` lists every certificate under the proxy with its expiry; exits `0`
while all are valid, `1` when one has expired, `2` when there are none.

```
Options (renew):
  --apps-root <dir>         Directory that holds one folder per app
  --name <app>              App folder and compose project name
  --root <dir>              Deployment directory, overriding --apps-root/--name
  --proxy-root <path>       Shared reverse proxy directory (default: the app's,
                            else /opt/infra/proxy)
  --proxy-container <name>  Proxy container to reload (default: the app's, else
                            proxy-nginx)
  --all                     Every certificate under the proxy, not only this
                            app's
  --dry-run                 Rehearse with certbot's own --dry-run; nothing is
                            written or reloaded
  --install-cron            Also write /etc/cron.d/kvox-certs-<name> so this
                            runs twice a day
  --json                    Print a machine-readable result on stdout
```

```
Options (status):
  --apps-root <dir>    Directory that holds one folder per app
  --name <app>         App folder and compose project name
  --root <dir>         Deployment directory, overriding --apps-root/--name
  --proxy-root <path>  Shared reverse proxy directory (default: the app's,
                       else /opt/infra/proxy)
  --json               Print a machine-readable report on stdout
```

### Logs

Every `doctor`, `install` and `update` run writes a human-readable `.log`
and a matching machine-readable `.jsonl` under `<deployRoot>/logs/`, mode
`0600`, newest ten runs kept. Every value the CLI knows to be a secret —
whether you typed it or the wizard generated it — is redacted from both
files before a single byte reaches disk, so they're safe to attach to an
issue or hand to someone else for help.

### Testing the deploy pipeline locally

Every test under `src/deploy/` injects a fake `runCommand`, so none of them
runs `docker`. The pipeline as a whole — `docker compose build`, the migrate
step's `run --rm --no-deps api npm run prisma:migrate`, the `.env` symlink
into the clone, the `-p <name>` project naming — is exercised end to end by
the `Deploy E2E` workflow (`.github/workflows/deploy-e2e.yml`, issue #133),
which runs on any change under `src/deploy/`, `infra/compose/`, either
Dockerfile or `apps/api/prisma/`, plus nightly so base-image drift is caught
too.

You can run the same thing on your own machine. You need Docker, Compose v2,
and a PostgreSQL the containers can reach — the workflow uses a service
container at the docker0 gateway; locally, anything works as long as the
host and the containers agree on the address.

```bash
# From the repository root, in a clone you don't mind deploying from.
npm ci
npm run build --workspace=cli

# The CLI deploys a REPOSITORY, not a working tree, so HEAD must be a real
# branch that the clone can resolve.
git checkout -B e2e

# devnet is `external: true` in base.compose.yml; nothing creates it for you.
docker network create devnet

# Copy the CI answers and edit POSTGRES_* for your database. Every other
# value is a placeholder on a reserved name and can stay as it is.
cp .github/e2e/answers.env /tmp/answers.env

node apps/cli/dist/cli.js deploy doctor \
  --apps-root /tmp/apps --skip-proxy --skip-github --json | jq .

node apps/cli/dist/cli.js deploy install \
  --apps-root /tmp/apps --name e2e \
  --repo "file://$PWD" --ref e2e \
  --domain e2e.invalid --port 3535 \
  --skip-proxy --skip-github --non-interactive \
  --answers-file /tmp/answers.env

node apps/cli/dist/cli.js deploy status --apps-root /tmp/apps --json | jq .
node apps/cli/dist/cli.js deploy update --apps-root /tmp/apps \
  --skip-proxy --skip-github --check --json | jq .
```

Four flags make this work anywhere, and each is load-bearing:

- `--skip-proxy` — there is no shared reverse proxy and no public DNS, so
  the proxy, certificate and DNS checks report `skip` rather than failing.
  Nothing is published: the stack still binds `127.0.0.1:3535` only.
- `--skip-github` — a `file://` remote is not on GitHub, so `gh` is never
  consulted for the clone anyway; the flag is what also stands the three
  required `gh-*` prerequisite checks down on a machine where `gh` is
  installed and logged out.
- `--non-interactive` with `--answers-file` — every secret is generated with
  the CSPRNG and every resource limit suggested from the machine, so the
  answers file only carries the database, the OAuth client and the admin
  address.
- `--repo "file://$PWD"` — the scheme survives `normaliseRepoUrl` untouched
  (only GitHub remotes are rewritten to HTTPS), so the clone is a plain local
  `git clone`.

`--domain e2e.invalid` is a reserved name that can never resolve; it exists
so `APP_URL`, the derived OAuth callback and the state file are populated
exactly as a real install populates them.

To go round again, `deploy update --apps-root /tmp/apps --skip-proxy
--skip-github` after moving the branch (`git commit --allow-empty` is
enough — the SHA is all the pipeline compares). To clean up:

```bash
cd /tmp/apps/e2e/repo/infra/compose
docker compose -p e2e -f base.compose.yml -f prod.compose.yml -f vps.compose.yml down -v
rm -rf /tmp/apps/e2e
docker network rm devnet
```

The journal from each run is under `/tmp/apps/e2e/logs/`, redacted, and is
the first place to look when a step fails — see [Logs](#logs) above.

## Running a worker node

`kvox node` turns this machine into a worker for the application's job
queue (epic #254). A node claims jobs from the server, runs them locally,
and submits results — the same handler code the API server would have run,
on hardware you control. Nodes coordinate through nothing but the database,
so you can run as many as you like without configuring any of them to know
about the others.

### Enrolling a machine

```bash
kvox node enroll
```

One command from nothing to a machine that holds its own credential. It
runs the same device-authorization login `kvox login` does, then uses that
session to mint a **node credential** (`nod_…`) and stores it for you. You
never see or paste the secret.

A node credential is deliberately weaker than a personal access token: the
API refuses it on every route outside `/api/nodes/*` — including the route
that mints credentials — so a worker running unattended for months cannot
escalate, and cannot mint a second identity. That is why enrolling is worth
a separate command rather than just reusing your login token.

| Flag | Meaning |
|---|---|
| `-s, --server <url>` | Server URL, when this machine has no stored one |
| `-n, --name <name>` | Name for the credential in the web UI (default: `kvox node: user@host`) |
| `--expires-in-days <n>` | Expire the credential after N days (default: never — see below) |
| `--no-browser` | Print the verification URL instead of opening one |
| `--show-token` | Also print the credential on stdout, for provisioning another machine |

**Node credentials do not expire by default, on purpose.** A worker runs
unattended for months; a token expiry nobody scheduled taking a fleet down
at 3am is worse than a long-lived credential whose blast radius is already
confined to `/api/nodes/*`. Revocation is the control, and it is immediate —
revoke from the web UI and the next request fails.

If the server predates node credentials you get a named error, not a stack
trace, pointing at the fallback: create a PAT in the web UI, `kvox login
--token <pat>`, then register. That works, but the PAT carries your full
account authority.

### Registering the node

```bash
kvox node register --concurrency 4 --types example.checksum
```

Creates (or re-attaches to) this machine's row in the fleet. Registration is
idempotent: the server keys on your account plus the node name, so re-running
it reattaches rather than creating a second row — and the command tells you
which of the two happened, because an unexpected reattach means a name
collision you want to know about.

| Flag | Meaning |
|---|---|
| `-n, --name <name>` | Node name; reattachment keys on it (default: the hostname) |
| `-c, --concurrency <n>` | How many jobs to run at once, 1–64 |
| `-t, --types <csv>` | Job types to claim (default: every node-eligible type) |
| `--json` | Emit the registered node as JSON on stdout |

`--types` is checked against what the server actually advertises at
`GET /api/nodes/job-types`, so a typo is refused with the valid list rather
than producing a node that registers happily and then claims nothing.

**`db.backup.run` — taking the deployment's database backups here.** This node
type is offered only when an administrator has enabled *both*
`nodes.jobSecretBrokerEnabled` and `databaseBackup.nodeOffloadEnabled`, and the
server can actually mint a per-job database role; until then it is absent from
`GET /api/nodes/job-types` and the API takes its own backups. On this machine
it needs `pg_dump` on `PATH` (a startup self-test refuses to declare the type
without it) and a network route to the database — there is no tunnelling, by
design. `psql` is optional: without it the backup still runs, and two audit
fields are recorded as `null`.

⚠ The database credential is fetched **per job**, held in memory for the length
of that job, and revoked when it settles. It is never written to
`~/.<cli>/config.json`, never written to the state directory, and never logged.
Nothing about running this type requires you to put a database password on this
machine.

**`media.audio.transcode` — producing the playback rendition here.** The
easiest type to offload: it needs no credential and no database route at all,
only `ffmpeg` and `ffprobe` on `PATH` (the same startup self-test refuses to
declare the type without *both* — they ship in one package, but the executor
runs them as two programs). `kvox node install-deps` installs them on
Debian/RHEL/Alpine; the container image already has them. It is offered
whenever an administrator leaves `transcription.transcodeNodeOffloadEnabled`
on, which is the default — there is no second switch, because there is no
credential to broker.

### Inspecting the resolved settings

```bash
kvox node config          # human-readable, on stderr
kvox node config --json   # machine-readable, on stdout — never includes the token
```

### Running the worker

```bash
kvox node start                 # foreground, attachable
kvox node start --daemon        # detached, logging to ~/.kvox/node/logs/node.log
kvox node start --headless      # container/service mode
```

**Every run hosts the control socket**, foreground or detached — a worker you
can only inspect if you started it a particular way is a worker nobody
inspects. The socket lives in the state directory at mode `0600`, so the
control channel is bounded by the same filesystem permission that protects
your token.

`--headless` changes exactly one thing, and it matters: on `SIGTERM` the
worker **drains without deregistering**, so a restarting container re-attaches
to its existing node row instead of leaking a new one on every restart.
Interactive Ctrl-C does deregister — a human stopping a worker on their laptop
means it is going away.

### Inspecting and controlling a running worker

```bash
kvox node status                # live snapshot from the running worker
kvox node status --json
kvox node logs -n 200           # recent lines
kvox node logs --follow         # attach and stream
kvox node set-concurrency 8     # applies live; persists either way
kvox node stop
```

`status` is never simply unavailable: with no worker running it falls back to
this machine's stored settings, so the command always answers something useful.

`set-concurrency` works whether or not a worker is running — live over the
control socket when one is, persisted for the next start when not. The cap is
re-read on every claim pass, so a live change takes effect on the next
iteration rather than at restart.

`stop` is a three-rung ladder, each rung bounded: ask the worker over the
socket (clean drain and deregister) → `SIGTERM` the pid in the pidfile (its
handler drains) → deregister server-side so no further work is dispatched to a
process that is already gone. That last rung matters more than it looks:
without it a `SIGKILL`ed worker keeps its `online` row until the liveness cron
notices, and every lease handed to it in the meantime has to expire before the
work is retried elsewhere.

### Logs

JSONL under `<state dir>/logs/node.log`, one rollover generation at 5 MiB.
Writes are synchronous, so the lines written immediately before a crash — the
only ones anybody wants after a crash — are on disk.

**Secrets are redacted before anything reaches the file**, recursively, through
nested objects and arrays: tokens, API keys, passwords, and **presigned storage
URLs**. That last one is not hygiene theatre — a presigned URL is a bearer
capability over an object, and a log file is a thing people attach to issues.

### Health checks, dependencies and running as a service

```bash
kvox node doctor                 # three independent groups of checks
kvox node install-deps --dry-run # the dependency step framework
kvox node service install        # systemd user unit
kvox node service status
kvox node service uninstall
```

`doctor` checks **this machine**, **the server** and **the worker**
independently — a failure in one never masks the others — and distinguishes
"cannot reach the server" from "reached it and was refused", which look
identical in a stack trace and have entirely different fixes.

For database-backup offload (`db.backup.run`) it also reports the `pg_dump`
client version and, with `--db-host`, a TCP probe of the database:

```bash
kvox node doctor --db-host db.internal:5432
```

Both are **warnings, never failures**. Most nodes in a fleet will never take
the backups, and failing `doctor` on a machine that simply is not the one doing
it would be wrong. A node that cannot reach the database must not declare the
type — which is a `--types` decision, not a health problem. The host is a flag
rather than a stored setting on purpose: **a worker node holds no database
configuration at all**; the connection arrives per job, from the server, and is
dropped when the job settles.

`install-deps` ships as a **framework**, not a set of real installs: this
template has no native dependencies, so it provides the ordered-step structure,
per-step outcomes, distro detection and `--dry-run`, and a fork fills in its own
steps. See [`docs/deployment/worker-nodes.md`](../../docs/deployment/worker-nodes.md).

`service install` writes a systemd **user** unit (no root needed) whose name
and description derive from the CLI and app names. It sets
`Restart=on-failure`, which is required rather than decorative — the memory
watchdog exits deliberately after draining, and without a supervisor that
successful drain leaves the worker down. Run `loginctl enable-linger $USER`
afterwards, or the unit stops when you log out.

### Memory: heap tuning, the watchdog and snapshots

A worker is a long-lived process doing repetitive work — the shape that turns a
small per-job leak into an OOM kill hours later. Three things address that, and
all three are on by default.

**Heap tuning.** Node's default old-space limit is low for a machine whose
whole job is being a worker: a 32 GB box can OOM at a fraction of it. On start
the worker re-execs itself once with an explicit, RAM-aware
`--max-old-space-size`, and the original process becomes a signal-forwarding
shim — so a container `SIGTERM` still reaches the worker and still drains, and
a signal-killed child makes the shim die of the *same* signal rather than
reporting a clean exit to its supervisor. Set `KVOX_HEAP_LIMIT_MB=0` to turn
re-tuning off entirely (the right answer when a cgroup or a PaaS already
manages memory).

**The memory watchdog** samples `rss`, `heapUsed`, `heapTotal`, `external` and
`arrayBuffers`, and once the samples span a real window reports a least-squares
growth trend in MB/hour. A single reading cannot tell a leak from GC sawtooth;
the trend is what turns "it died" into "it was climbing 40 MB/hour".

**The pre-OOM valve** fires once, when `heapUsed / heapLimit` crosses
`KVOX_MEMORY_THRESHOLD` (default 0.9), in this order:

1. write a heap snapshot — **first**, before the drain collects the evidence away
2. log the decision with the sample
3. drain in-flight work, **keeping** the node row
4. exit `71`, for a supervised restart

> ⚠️ **The valve requires a supervisor.** It exits deliberately after a clean
> drain, so without `Restart=on-failure` (`kvox node service install` sets
> this) or `restart: unless-stopped` in compose, a *successful* drain leaves
> the worker down.

Why not V8's own `--heapsnapshot-near-heap-limit`? It fires only at genuine
near-OOM, which is *above* this threshold — so on a worker hardened with this
valve it would never fire at all, the process would recycle cleanly forever,
and the retainer could never be named.

```bash
kvox node heap-snapshot   # ask the LIVE daemon to write one
```

Asking the live daemon is the point: restarting to attach a diagnostic flag
discards exactly the accumulated state that names the retainer. Snapshots go to
`<state dir>/heap-snapshots`, newest five kept, and are skipped with a clear
reason when free disk is under 1.5× the live heap. `KVOX_HEAP_SNAPSHOTS=false`
disables all three snapshot paths at once.

### Running a fleet in containers

The recommended way to run workers is containers, not a per-machine install.

```bash
cd infra/compose
cp .env.worker.example .env.worker      # fill in the server URL and the token
docker compose --env-file .env.worker -f worker.compose.yml up -d --scale worker=4
```

Four replicas, no coordination configured anywhere. Each registers as its own
node — its name derives from the container hostname, which Docker makes unique
— and they load-balance through the server's `FOR UPDATE SKIP LOCKED` claim, so
two replicas can never receive the same job.

> **Do not set `KVOX_NODE_NAME` or `KVOX_NODE_ID` when scaling.** Every
> replica would reattach to the *same* node row, and the server's per-node
> claim cap would be shared between processes that each think they own it.

Only `KVOX_SERVER_URL` and `KVOX_TOKEN` are required: with no config file
the worker synthesises everything else from the environment and starts.

Two settings in `worker.compose.yml` are load-bearing rather than decorative:

- **`restart: unless-stopped`** — the memory watchdog exits deliberately after
  a clean drain, so without it a successful drain leaves the worker down.
- **`stop_grace_period: 300s`** — Docker sends `SIGTERM`, waits, then
  `SIGKILL`s. A job killed mid-flight has to wait out its lease before the
  server retries it anywhere.

The image's `ENTRYPOINT` is in **exec form** for the same reason: shell form
wraps the process in `/bin/sh -c`, which does not forward `SIGTERM`, so the
drain would never run.

To build from source instead of pulling the published image:

```bash
docker compose -f worker.compose.yml -f worker.build.compose.yml up --build
```

CI publishes `ghcr.io/<owner>/<repo>-worker` alongside the api and web images,
with the same tag conventions.

### The interactive dashboard

Run `kvox` with no arguments in a real terminal and choose **Worker node**.
It offers a live dashboard, `doctor`, the log, and both `register` and
`enroll` — all calling the same functions the subcommands call, so there is no
second implementation of anything.

**Attaching is read-only.** The dashboard renders the event stream the daemon
already pushes and sends nothing back, so you can inspect a systemd unit or a
container running production work without perturbing it, and Esc leaves it
running untouched. `set-concurrency` and `stop` stay one-line commands
deliberately — a TUI that can stop a fleet member from a highlighted row is a
liability.

With no worker running, press `s` to start a **detached** one and attach to it.
That is not laziness: an interactive process cannot re-exec itself to raise its
heap ceiling without destroying raw-mode input, so an in-process engine would
silently run at the low default old-space limit — the least suitable
configuration for exactly the long jobs a node exists to take.

### Worker environment variables

Every setting can come from the environment instead of the config file, which
is how a container runs with no interactive setup at all. Environment values
win over the file, **per field** — override one without restating the rest.

⚠️ **Generated — do not edit the table below by hand.** It is built from
`WORKER_ENV` (`src/node/worker-env.ts`) and the JSDoc comment already written
above each of its entries, so it cannot drift the way a hand-typed copy would.
Run `npm run docs:worker-env --workspace=cli` to regenerate it after changing
`WORKER_ENV`; `worker-env-table.test.ts` fails the build if this block and
`WORKER_ENV` disagree.

<!-- GENERATED:WORKER_ENV_TABLE:START -->
| Variable | Description |
| --- | --- |
| `KVOX_SERVER_URL` | `KVOX_SERVER_URL` — reused from `config.ts`, never minted again. |
| `KVOX_TOKEN` | `KVOX_TOKEN` — reused from `config.ts`. A `nod_` credential, normally. |
| `KVOX_NODE_ID` | The node row this process re-attaches to, so a restart is not a new node. |
| `KVOX_NODE_NAME` | Display name; defaults to the hostname. Reattachment keys on it server-side. |
| `KVOX_CONCURRENCY` | How many jobs this process runs at once. 1–64, per the server's own cap. |
| `KVOX_ELIGIBLE_TYPES` | Comma-separated job types this node will claim. Empty means "all it can". |
| `KVOX_POLL_INTERVAL_MS` | Idle poll interval in milliseconds. |
| `KVOX_HEADLESS` | `true` to run without a TTY and drain on SIGTERM WITHOUT deregistering. |
| `KVOX_STATE_DIR` | Overrides the state directory. The one variable a container almost always sets. |
| `KVOX_HEAP_LIMIT_MB` | Old-space limit in MB for the re-exec (#277). `0` disables re-tuning entirely. |
| `KVOX_HEAP_TUNED` | The re-exec LATCH (#277). Set by the parent shim on the child it spawns. Not an operator knob — it exists so the re-exec cannot loop. It is still declared here rather than read as a literal, because the rule this map enforces has no exceptions: a variable the code reads is a variable a rename must reach. |
| `KVOX_MEMORY_WATCHDOG` | `false` to disable the memory watchdog and its pre-OOM valve (#277). |
| `KVOX_MEMORY_THRESHOLD` | heapUsed/heapLimit fraction at which the valve fires. Default ~0.9 (#277). |
| `KVOX_HEAP_SNAPSHOTS` | `false` to disable ALL THREE heap-snapshot paths (#277). |
<!-- GENERATED:WORKER_ENV_TABLE:END -->

With `KVOX_SERVER_URL` and `KVOX_TOKEN` set and no config file at all, the
worker synthesises its settings from the environment and starts. If it cannot
write the file back (a read-only container home is common), it warns and keeps
going — set `KVOX_NODE_ID` so a restart re-attaches instead of registering
again.

## CI usage

In CI there's no browser to complete the device flow in and no persistent
home directory to have logged in from earlier, so skip `login` entirely and
set:

```bash
export KVOX_SERVER_URL=https://app.example.com
export KVOX_TOKEN=pat_...
```

The environment always wins over `~/.kvox/config.json` when both are
present, specifically so a pipeline's service token can't be shadowed by
whatever a developer happens to have logged in as on a shared runner.

Create and revoke the token itself from the web UI's **Access Tokens** page
(under user settings) — there's no CLI command to mint a PAT out of thin air
for CI use; the device flow is how the CLI gets one for a human logging in
interactively.

`kvox` also refuses to launch its interactive menu unless stdout and stdin
are both real terminals, `TERM` is set to something other than `dumb`, and
neither `CI` nor `CONTINUOUS_INTEGRATION` is set — so `kvox api ...` in a
pipeline behaves identically whether or not those variables happen to be
set. If you need to force that refusal in an environment that looks like a
terminal but isn't one you want to interact with, set `KVOX_NO_TUI` to
any truthy value (anything except empty, `0`, `false`, or `no`); every
explicit subcommand ignores this gate entirely and is unaffected by it.

## Renaming this for a fork

There are two identities here, and they are deliberately independent.

**The product name** — the half of the CLI banner in `--help` and the
interactive UI that names the product rather than the executable — is not set
in this package at all. It comes from `packages/shared/identity.json`, the one
manifest every app reads its identity from, so renaming the product renames
the CLI banner, the browser wordmark and the email templates together:

```json
// packages/shared/identity.json
{
  "productName": "Your Product Name"
}
```

See [`docs/RENAMING.md`](../../docs/RENAMING.md) for the full rebrand
walkthrough — this section only covers what's specific to the CLI.

**The executable's own identity** — the command name shown in `--help` and
errors, the config directory (`~/.kvox/`), and the `KVOX_`
environment-variable prefix — is derived from a separate constant:

```ts
// apps/cli/src/branding.ts
export const CLI_NAME = 'kvox';
```

The split is intentional: a product called "Acme" may perfectly well still
ship a command called `kvox`, and renaming the binary moves a filesystem
path and an environment-variable prefix, which renaming the product must not.

Change that one line (see the comment above it in `branding.ts` for the
naming constraints — lowercase ASCII letters, digits and hyphens only, since
it becomes both a filesystem path and part of an environment variable name)
and the config directory, the env var prefix, and every place the CLI refers
to itself by name follow automatically. The one place it can't reach is the
`bin` key in `apps/cli/package.json` — npm reads that before any of this
code runs, so it has to be updated by hand to match, and a test in
`apps/cli/src/branding.test.ts` asserts the two stay in sync.

Note that the env var prefix is `KVOX_`, not `APP_` — a bare `APP_` prefix
is generic enough to collide with unrelated variables in a shared CI shell,
so the prefix is derived from the (longer, more specific) binary name
instead. If you've seen `APP_SERVER_URL` / `APP_TOKEN` mentioned elsewhere,
that's what it would have been under a shorter, collision-prone prefix;
`KVOX_SERVER_URL` / `KVOX_TOKEN` is what the code actually reads.

`install.sh`'s default `KVOX_REPO` (the git URL it clones when
`KVOX_SRC` isn't set) is a second place a fork has to edit by hand,
alongside the `bin` key above. It's a standalone shell script that runs
*before* any of this repo's own code executes — `git clone`s the source
first — so it has no way to read `CLI_NAME` out of `branding.ts` and derive
the clone URL itself; the URL is hard-coded near the top of `install.sh`
under its own "Defaults" comment block and has to be changed there directly.

## Building from source (development)

The install path above is for end users. If you're developing the CLI
itself inside this monorepo, build and run it from the workspace instead.

Building inside the workspace needs Node **>= 24** — the monorepo root's own
`engines.node` floor (`package.json`), which covers the full dev toolchain
across `apps/api`, `apps/web` and `apps/cli` together. That's higher than
the `>= 20` the [Requirements](#requirements) table above states, and the
two aren't in tension: that table is `apps/cli`'s own floor for the
*installed*, standalone CLI, built by `install.sh` outside this monorepo
against `apps/cli/package.json` alone.

```bash
# from the repo root, after the workspace's node_modules are installed
npm run build --workspace=cli
```

This runs `tsc` against `apps/cli/tsconfig.build.json`, emitting
`apps/cli/dist/`, and marks `dist/cli.js` executable. From there you can run
it straight from the workspace without installing or publishing anything:

```bash
node apps/cli/dist/cli.js --help
```

or, from inside `apps/cli`:

```bash
node dist/cli.js --help
```

If you want the bare `kvox` command on your PATH without publishing, `npm
link` from `apps/cli` (`package.json`'s `bin` field maps `kvox` to
`./dist/cli.js`) does that using the standard npm mechanism.

For iterating on the CLI's own source without rebuilding on every change,
`npm run dev --workspace=cli` runs `tsx src/cli.ts` directly — same behavior,
no build step.

## Running tests

```bash
npm run test:run --workspace=cli
```
