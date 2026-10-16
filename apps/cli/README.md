# CLI (`kvox`)

First-party command-line client for the API. It authenticates with the same
device authorization flow as any other headless client, stores a personal
access token, and then lets you call any API endpoint from a shell, check and
deploy a server, and run a machine as a worker node for the job queue.

**The engine is [`@marinoscar/platform-cli`](https://www.npmjs.com/package/@marinoscar/platform-cli)**
(pinned in `package.json`): the `init`, `login`, `api`, `config`, `node` and
`deploy` commands, the interactive ink menu, the VPS deploy pipeline and the
worker-node engine are the platform's, built by one `createCli()` call
(`src/cli.ts` -> `src/app.ts`). This app adds only what the platform does not
have; everything else is documented in the package's README and in
`kvox <command> --help`, and this document does not restate it.

| Where | What it holds |
| --- | --- |
| `src/app.ts` | `APP_CLI_OPTIONS`: the identity (from `packages/shared/identity.json`), the version (`package.json`), the node executor, this app's `.env.example` key metadata, one deploy check and the proxy stream paths |
| `src/executors/media-audio-transcode.executor.ts` | the node executor for `media.audio.transcode` and its `ffmpeg` + `ffprobe` requirement (a node without them refuses to claim the type, naming the missing tool) |
| `src/extensions/` | the pre-platform `deploy` flags and commands the platform lacks ([the table below](#flags-and-commands-that-changed-in-110)), `deploy update --check`, the `deploy uninstall` name confirmation and `.env` backup, the `bind-port-not-promised` and `docker-network-devnet` checks, the app env-key metadata |
| `src/run.ts` | one invocation: translate legacy flags, answer `update --check`, otherwise `createCli(...).run` |

Run with no arguments in an interactive terminal and it opens a full-screen
menu (login, call an endpoint, view config, deploy this server, worker node,
logout) built with [ink](https://github.com/vadimdemedes/ink). Everything that
menu can do is also a plain subcommand, and the subcommands are what this
document covers: they're what you'd script or run in CI.

`kvox --version` prints `<cli version> (platform <engine version>)`, for
example `1.10.0 (platform 0.1.0-next.5)`.

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
kvox --version      # 1.10.0 (platform 0.1.0-next.5)
kvox --help
```

The installer already does this for you as its last step: it runs the new
shim's `--version` (comparing its first word, the CLI version), prints an install summary (version, install size, and
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
   dependencies (`@marinoscar/platform-cli`, which brings commander and ink,
   and react). `KVOX_HOME` defaults to `~/.kvox` — or to
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
rewrites (the mechanics are the platform engine's). The token itself is never printed by any command; if
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

Eight subcommands (`doctor`, `install`, `uninstall`, `update`, `status`,
`about`, `list`, `certs`) take this repository, or your fork of it, from an
empty VPS to running, migrated, seeded, and served over HTTPS at a real
domain, and back to the latest revision on every subsequent deploy. They run
**on the VPS itself**: SSH in with your own credentials, install `kvox` there
(see [Fresh server in three commands](#fresh-server-in-three-commands)), and
run these. There's no SSH client in `kvox` and no laptop-driven
orchestration: it never dials out to a server on your behalf.

The pipeline, its steps, the answers file, consent, edge config, renewal
scheduling and run records are the platform's; see the
[`@marinoscar/platform-cli` deploy README](https://www.npmjs.com/package/@marinoscar/platform-cli)
for the mechanics. For the walkthrough, prerequisites, the manual step after
install and troubleshooting, see
[`docs/deployment/vps.md`](../../docs/deployment/vps.md); for the design and the
`deploy-info/info.json` schema, [`docs/specs/vps-deploy.md`](../../docs/specs/vps-deploy.md)
(both were written for the engine this app carried before the platform one, and
open with a note saying so).

The exit codes that matter for scripting:

| Exit | Meaning | Which commands use it |
|---|---|---|
| `0` | Success | all |
| `1` | A step failed / installed but unhealthy | `bootstrap-vps.sh`; `status` (unhealthy); `certs` (a certificate is due, or the reload failed) |
| `2` | Usage error, or nothing is installed where asked | `bootstrap-vps.sh`; `status`, `about`, `list` (nothing under `--apps-root`/`--root`); a flag this CLI no longer has (see below) |
| `6` | A required `doctor` check failed before anything was changed | `doctor`; `install`/`update`'s own preflight step |

`about` is informational and never a health verdict: it reads the deployment
record off disk and exits `0` when there is none; only "nothing is installed"
at the path asked for is an error.

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
6. **Launch** — `kvox deploy doctor` for a first read-only look
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
  --apps-root <path>  Directory holding the deployments (default:
                      "/opt/infra/apps")
  --name <app>        Which deployment to act on, by name
  --root <path>       Deployment directory (an explicit path)
```

`install` defaults `--name` to the repository's own name (`…/kvox.git`
installs as `kvox`). With neither flag, every other subcommand resolves in
this order:

1. `--root` — a path, verbatim. The escape hatch.
2. `--name` — a name under the apps root. It still wins from anywhere, so
   `--name vault` typed inside another app's folder means `vault`.
3. **The app you are standing in.** From `/opt/infra/apps/kvox`, or anywhere
   below it, the commands act on `kvox` — no flag needed, however many apps
   the server hosts. The walk stops at the apps root, so standing *there*, or
   above it, resolves nothing; an app installed outside the apps root with
   `--root` is not found this way either, because `--root` is how it was
   named in the first place.
4. The one app installed under `--apps-root`.

With several installed, none named, and none of them the folder you are in,
they refuse and list them until `--name` says which.
`kvox deploy list` shows what they found.

### Deploying a fork

`kvox deploy` reads the repository and branch to deploy from the git remote of
the checkout it is run in, unless you pass `--repo` and `--ref`, so a fork
deploys itself with no configuration. The CLI checkout is not the
deployment's own `repo/` clone: `deploy install` clones that separately.

### The application version

Install and update stamp a release version: by default a patch bump of the
current `APP_VERSION`, written back to the repository's default branch.
`--app-version <version>` chooses the number and `--no-version-bump` deploys
the current version with no write, no commit and no push. An update with
nothing new to apply bumps nothing.

### Command reference

Generated from `kvox deploy <command> --help` for this version. Every command
also takes `-h, --help`.

#### `kvox deploy doctor`

Check that this server meets the prerequisites

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--proxy-root <path>` | Shared reverse proxy directory (default: "/opt/infra/proxy") |
| `--port <port>` | Loopback port the proxy forwards to (default: "3535") |
| `--domain <domain>` | Public domain; enables the DNS and TLS checks |
| `--proxy-container <name>` | Name of the shared proxy container (default: as recorded, else proxy-nginx) |
| `--proxy-mode <mode>` | How the shared proxy runs: container or host (default: as recorded, else detected) |
| `--repo <url>` | Repository whose access to check (default: the recorded one, then this checkout's origin) |
| `--json` | Print a machine-readable report on stdout |
| `--no-color` | Disable colour even on a terminal |

#### `kvox deploy install`

Install this application on this server

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--domain <domain>` | Public domain to publish under |
| `--proxy-root <path>` | Shared reverse proxy directory (default: "/opt/infra/proxy") |
| `--proxy-container <name>` | Name of the shared proxy container (default: as recorded, else proxy-nginx) |
| `--proxy-mode <mode>` | How the shared proxy runs: container or host (default: as recorded, else detected) |
| `--port <port>` | Loopback port the proxy forwards to (default: "3535") |
| `--repo <url>` | Repository to deploy (default: this checkout's origin) |
| `--ref <ref>` | Branch, tag or commit (default: the remote default branch) |
| `--email <email>` | Certificate registration address |
| `--group <name>` | Optional feature group; repeat for more (default: []) |
| `--all` | Review every environment variable, not only the essential ones |
| `--non-interactive` | Never prompt; fail listing anything unresolved |
| `--answer <key=value>` | Supply one environment answer; repeat for more (default: {}) |
| `--answers-file <path>` | Read answers from a KEY=value file (like .env) |
| `--reinstall` | Install over an existing deployment |
| `--resume` | Continue from the step that failed |
| `--skip-doctor` | Skip the prerequisite checks |
| `--skip-proxy` | Do not touch the reverse proxy or request a certificate |
| `--skip-seed` | Do not run the database seed |
| `--bootstrap-proxy` | Create the shared proxy if this server has none (no prompt) |
| `--create-database` | Create the database if it does not exist (no prompt) |
| `--app-db-user <name>` | Name of the dedicated application database role (default: <app>_app) |
| `--admin-user <name>` | Administrative database login that provisions the role (password: $KVOX_DB_ADMIN_PASSWORD or DB_ADMIN_PASSWORD in the answers file; never a flag) |
| `--skip-role-provisioning` | Create no role; POSTGRES_USER must already be an ordinary role |
| `--allow-superuser` | Run the API as a superuser/BYPASSRLS login anyway (tenant isolation OFF) |
| `--rotate-app-password` | Generate a new password for the application role |
| `--provision-app-role` | Consent: create the role when the database login is a superuser (no prompt) |
| `--transfer-ownership` | Consent: change the owner of an existing database's objects to the role (no prompt) |
| `--allow-reduced-role` | Consent: accept a role the server would not give CREATEROLE/createrole_self_grant |
| `--show-credentials` | Print the generated application login once at the end (never journaled) |
| `--skip-renewal` | Do not schedule certificate renewal |
| `--skip-oauth-check` | Do not verify the Google OAuth credentials with Google |
| `--no-cache` | Rebuild images without the layer cache |
| `--force` | Discard uncommitted changes in the checkout |
| `--staging` | Use Let's Encrypt staging while working out the setup |
| `--app-version <version>` | Release version to deploy (default: a patch bump of the current one) |
| `--no-version-bump` | Deploy the current version: no write, no commit, no push |
| `--json` | Print a machine-readable result on stdout |

#### `kvox deploy update`

Bring this server up to the latest revision

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--ref <ref>` | Branch, tag or commit to move to |
| `--force` | Rebuild even when the revision has not changed |
| `--no-cache` | Rebuild images without the layer cache |
| `--non-interactive` | Never prompt; fail listing anything unresolved |
| `--answer <key=value>` | Supply one environment answer; repeat for more (default: {}) |
| `--answers-file <path>` | Read answers from a KEY=value file (like .env) |
| `--skip-seed` | Do not re-run the database seed |
| `--skip-proxy` | Do not touch the reverse proxy |
| `--create-database` | Create the database if it does not exist (no prompt) |
| `--app-db-user <name>` | Name of the dedicated application database role (default: <app>_app) |
| `--admin-user <name>` | Administrative database login that provisions the role (password: $KVOX_DB_ADMIN_PASSWORD or DB_ADMIN_PASSWORD in the answers file; never a flag) |
| `--skip-role-provisioning` | Create no role; POSTGRES_USER must already be an ordinary role |
| `--allow-superuser` | Run the API as a superuser/BYPASSRLS login anyway (tenant isolation OFF) |
| `--rotate-app-password` | Generate a new password for the application role |
| `--provision-app-role` | Consent: create the role when the database login is a superuser (no prompt) |
| `--transfer-ownership` | Consent: change the owner of an existing database's objects to the role (no prompt) |
| `--allow-reduced-role` | Consent: accept a role the server would not give CREATEROLE/createrole_self_grant |
| `--show-credentials` | Print the generated application login once at the end (never journaled) |
| `--skip-renewal` | Do not schedule certificate renewal |
| `--skip-oauth-check` | Do not run the post-deploy OAuth sign-in smoke |
| `--proxy-container <name>` | Name of the shared proxy container (default: as recorded, else proxy-nginx) |
| `--proxy-mode <mode>` | How the shared proxy runs: container or host (default: as recorded, else detected) |
| `--app-version <version>` | Release version to deploy (default: a patch bump of the current one) |
| `--no-version-bump` | Deploy the current version: no write, no commit, no push |
| `--maintenance` | Serve a 503 from before the build until just after restart, instead of whatever the stop/migrate/restart window looks like underneath |
| `--json` | Print a machine-readable result on stdout |

#### `kvox deploy status`

Report whether the deployment on this server is healthy

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--port <port>` | Loopback port the proxy forwards to (default: "3535") |
| `--domain <domain>` | Public domain; adds an external HTTPS check |
| `--json` | Print a machine-readable report on stdout |
| `--no-color` | Disable colour even on a terminal |

#### `kvox deploy list`

List every deployment on this server

| Flag | Meaning |
| --- | --- |
| `--apps-root <path>` | Directory holding the deployments (default: "/opt/infra/apps") |
| `--json` | Print a machine-readable inventory on stdout |

#### `kvox deploy about`

Show what this server says it is running

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--json` | Print the record itself on stdout |

#### `kvox deploy certs`

Inspect or renew this deployment's TLS certificate

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--proxy-root <path>` | Shared reverse proxy directory (default: "/opt/infra/proxy") |
| `--domain <domain>` | Domain to act on (default: the recorded one) |
| `--proxy-container <name>` | Name of the shared proxy container (default: as recorded, else proxy-nginx) |
| `--proxy-mode <mode>` | How the shared proxy runs: container or host (default: as recorded, else detected) |
| `--renew` | Renew when the certificate is inside the renewal window |
| `--force` | Renew even when it is not due. Spends rate-limit budget. |
| `--email <email>` | Registration address (default: INITIAL_ADMIN_EMAIL) |
| `--staging` | Use Let's Encrypt staging, which is not trusted by browsers |
| `--json` | Print a machine-readable report on stdout |

#### `kvox deploy uninstall`

Remove a deployment from this server

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Deployment directory (rank 1: an explicit path) |
| `--apps-root <path>` | Directory holding the deployments (rank 3 walks up inside it) (default: "/opt/infra/apps") |
| `--name <app>` | Which deployment to act on, by name |
| `--proxy-root <path>` | Shared reverse proxy directory (default: "/opt/infra/proxy") |
| `--proxy-container <name>` | Name of the shared proxy container (default: as recorded, else proxy-nginx) |
| `--proxy-mode <mode>` | How the shared proxy runs: container or host (default: as recorded, else detected) |
| `--dry-run` | Report what would be removed and change nothing |
| `--drop-database` | Also DROP the PostgreSQL database named by POSTGRES_DB, after the stack stops (needs --confirm-database) |
| `--confirm-database <name>` | The database's own name, typed back |
| `--purge-storage` | Also delete every object in storage (needs --confirm-bucket) |
| `--confirm-bucket <name>` | The bucket's own name, typed back |
| `--json` | Print a machine-readable plan on stdout |


`deploy update --check` is not in the table: it is this app's own (below).

### Flags and commands that changed in 1.10

The CLI moved onto the platform's engine in 1.10. Every top-level command, every
`node` subcommand and every flag of `init`, `login`, `api`, `config`, `node *`,
`deploy list` and `deploy status` is unchanged. These `deploy` flags and
commands of 1.9 and earlier are not the platform's; each is handled in
`src/extensions/legacy-flags.ts` (the same table), and none is ever accepted and
then not honoured. **ignored** means the flag is dropped with a one-line note on
stderr; **refused** means the command stops with exit `2` and a message that says
what to do instead.

| Old | Now | Why |
| --- | --- | --- |
| `install\|update\|doctor --skip-github` | ignored | the GitHub CLI checks skip themselves when git can already read the repository or the remote is not an HTTPS GitHub URL |
| `install --no-install-cron` | `--skip-renewal` | |
| `install --install-cron` | ignored | install and update schedule renewal themselves, unless something else already renews the certificates |
| `install --fresh` | refused | use `deploy uninstall` then `install`, or `install --reinstall` |
| `install --no-ipv6` | refused | the platform's vhost always listens on `[::]`; no switch exists |
| `update --check` | **kept** | fetches the ref and prints `current -> latest, N commits behind` (`--json`: `{current, latest, commitsBehind, commits, checkedAt}`); changes nothing. It no longer records `remote` in `deploy-info/info.json` |
| `doctor --skip-proxy`, `doctor --public-ip <ip>` (and `KVOX_PUBLIC_IP`) | refused | the platform doctor has neither |
| `uninstall --confirm <name>` | **kept, now required** | a real uninstall needs the deployment's own name typed as `--confirm <name>`; there is no interactive prompt. `--dry-run` needs nothing |
| `uninstall` backup of `.env` | **kept** | copied to `<apps-root>/<name>.env.<timestamp>.bak` (mode 0600) before the platform deletes it |
| `uninstall --keep-env`, `--certs`, `--skip-proxy` | refused | the platform always removes `.env`, never removes the certificate, always removes the vhost |
| `uninstall --non-interactive` | ignored | uninstall never prompts |
| `about --check`, `about --server <url>` | ignored | `about` reads `deploy-info/info.json` off disk; it no longer asks the API or fetches the remote |
| `certs renew [--all --dry-run --install-cron --json]` | `certs --renew` | **cron files written by earlier versions call this**; they keep working. `--all` and `--install-cron` are dropped with a note, `--dry-run` reports without renewing |
| `certs status` | `certs` | reports and changes nothing |
| `node install-deps` installing `ffmpeg` | not done | the platform's step list has no `ffmpeg` and no extension point; install `ffmpeg` (it ships `ffprobe`) yourself. `node doctor` names what is missing; the worker image has it |
| preflight `database-vector-extension` (required in 1.9: the server must offer `vector`) | not done | the platform has no such check and an app check cannot read the database password, so a server without `vector` fails later, at the first migration (`extension "vector" is not available`). Use a pgvector image (`pgvector/pgvector`) and create the extensions as the bootstrap superuser before the first install (`infra/compose/postgres-init/20-kvox-extensions.sh`, `docs/runbooks/application-role.md` section 3.1) |
| server-fact suggestions for `APP_BIND_PORT`, `JOBS_WORKER_CONCURRENCY`, `API_MEM_LIMIT`, `WEB_MEM_LIMIT` | not done | these take the template default unless answered; `POSTGRES_SSL` is validated but no longer asked by default (pass `--all`, `--answer POSTGRES_SSL=true`) |

Other differences an operator can see:

- **The first write upgrades the state file.** `.appctl-deploy.json` (a fixed
  name: servers carry it) is read at version 1 and rewritten at version 2 by
  the first `install` or `update` of this build; 1.9 and earlier then refuse
  it. Read-only commands never rewrite it.
- `deploy status` has no "Update" line, and `deploy about` shows the record
  only.
- The environment file is `repo/infra/compose/.env`, written as a regular file;
  1.9 kept it in the app folder behind a symlink in the checkout. An unattended
  install must be given `JWT_SECRET`, `COOKIE_SECRET` and
  `SECRETS_ENCRYPTION_KEY` (the wizard no longer generates them without a
  terminal), and the version-bump commit is the deployed commit even when it
  could not be pushed.
- `deploy install` provisions a dedicated ordinary database role (`<app>_app`);
  a superuser login with no consent flag stops the install.
- `deploy uninstall --purge-storage` runs `npm run storage:purge` inside the
  API image, as the platform does, and empties every registered key prefix.

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
declare the type without *both*, naming the missing one: `Cannot run job type
"media.audio.transcode": required capability "binary:ffmpeg" is missing`; they
ship in one package, but the executor runs them as two programs). Install them
yourself (`apt-get install ffmpeg`, `dnf install ffmpeg`, `apk add ffmpeg`);
`kvox node doctor` lists both with their versions, and the container image
already has them. The executor is this app's own:
`src/executors/media-audio-transcode.executor.ts`. It is offered
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
kvox node install-deps --dry-run # the dependency steps
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

`install-deps` is the platform's framework (ordered steps, per-step outcomes,
distro detection and `--dry-run`) with its two generic steps: the state
directory and the Node.js version. It has no `ffmpeg` step (see the table
above). See [`docs/deployment/worker-nodes.md`](../../docs/deployment/worker-nodes.md).

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

The names are the platform engine's (`workerEnv()` in `@marinoscar/platform-cli`)
with this CLI's prefix. `src/worker-image.test.ts` fails the build if the engine
reads a variable the table, the worker `Dockerfile` or `worker.compose.yml`
does not carry, or the other way round.

| Variable | Description |
| --- | --- |
| `KVOX_SERVER_URL` | The server to talk to; overrides the stored URL. |
| `KVOX_TOKEN` | The credential; a `nod_` credential, normally. |
| `KVOX_NODE_ID` | The node row this process re-attaches to, so a restart is not a new node. |
| `KVOX_NODE_NAME` | Display name; defaults to the hostname. Reattachment keys on it server-side. |
| `KVOX_CONCURRENCY` | How many jobs this process runs at once. 1-64, per the server's own cap. |
| `KVOX_ELIGIBLE_TYPES` | Comma-separated job types this node will claim. Empty means "all it can". |
| `KVOX_POLL_INTERVAL_MS` | Idle poll interval in milliseconds. |
| `KVOX_HEADLESS` | `true` to run without a TTY and drain on SIGTERM WITHOUT deregistering. |
| `KVOX_STATE_DIR` | Overrides the state directory. The one variable a container almost always sets. |
| `KVOX_HEAP_LIMIT_MB` | Old-space limit in MB for the re-exec. `0` disables re-tuning entirely. |
| `KVOX_HEAP_TUNED` | The re-exec latch, set by the parent shim on the child it spawns. Not an operator knob: it exists so the re-exec cannot loop. |
| `KVOX_MEMORY_WATCHDOG` | `false` to disable the memory watchdog and its pre-OOM valve. |
| `KVOX_MEMORY_THRESHOLD` | heapUsed/heapLimit fraction at which the valve fires. Default about 0.9. |
| `KVOX_HEAP_SNAPSHOTS` | `false` to disable all three heap-snapshot paths. |

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

**The product name** (the half of the CLI banner in `--help` and the
interactive UI that names the product rather than the executable) is not set
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
walkthrough; this section only covers what's specific to the CLI.

**The executable's own identity** (the command name shown in `--help` and
errors, the config directory (`~/.kvox/`), the `KVOX_` environment-variable
prefix and the systemd unit) is derived from a separate field of the same
manifest:

```json
// packages/shared/identity.json
{
  "cliName": "kvox"
}
```

`@app/shared` exports it as `CLI_NAME`, `src/app.ts` hands it to the platform
CLI's `createCli({ identity })`, and the engine derives the rest. The split is
intentional: a product called "Acme" may perfectly well still ship a command
called `kvox`, and renaming the binary moves a filesystem path and an
environment-variable prefix, which renaming the product must not. `cliName`
is lowercase ASCII letters, digits and hyphens only, since it becomes both a
filesystem path and part of an environment variable name.

`scripts/rename.mjs --cli-name <name>` writes the manifest field and the `bin`
key. The `bin` key in `apps/cli/package.json` is the one place the constant
cannot reach (npm reads it before any code runs), so a test in
`apps/cli/src/app.test.ts` asserts the two stay in sync.

Two literals do **not** follow the name, on purpose, because servers already
deployed carry them: the deploy state file `.appctl-deploy.json` and the
`# Managed by appctl deploy` marker in proxy vhosts. They are the platform
engine's fixed values; never change them.

The env var prefix is `KVOX_`, not `APP_`: a bare `APP_` prefix is generic enough
to collide with unrelated variables in a shared CI shell, so the prefix is
derived from the (longer, more specific) binary name instead.

`install.sh`'s default `KVOX_REPO` (the git URL it clones when `KVOX_SRC`
isn't set) is a second place a fork has to edit by hand, alongside the `bin`
key above. It's a standalone shell script that runs *before* any of this repo's
own code executes (it `git clone`s the source first), so it has no way to read
the manifest and derive the clone URL itself; the URL is hard-coded near the
top of `install.sh` under its own "Defaults" comment block.

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

`src/conformance.test.ts` runs the platform CLI's conformance suites (env
template fragments, executor credential hygiene for every executor the worker
would run, the deploy registrations); `src/deploy-fixture.test.ts` reads a
deployment as CLI 1.8.0 wrote it.
