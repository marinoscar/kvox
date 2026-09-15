#!/usr/bin/env bash
# bootstrap-vps.sh — from a fresh root shell to the deploy wizard in one
# command  (issue #130, epic #168)
#
# Usage:
#   bash bootstrap-vps.sh --repo <owner>/<name> [--ref <branch>] [--yes]
#                         [--no-tui] [--update] [--dry-run]
#
# What it does, in six steps, each printed before it runs:
#   1. Preconditions — root, Ubuntu/Debian, Docker with the Compose v2 plugin.
#      It never installs Docker: if Docker is missing it prints the apt
#      commands from docs.docker.com and stops.
#   2. GitHub CLI — installs `gh` from GitHub's apt repository when missing,
#      then logs in interactively (the ONE interactive step) when not logged
#      in, and configures git to use gh's token.
#   3. Node.js — asks (y/N) before installing Node 22 from NodeSource when
#      node is missing or older than 20; `--yes` skips the question. An
#      existing Node >= 20 is never touched.
#   4. CLI checkout — clones <owner>/<name> to /opt/infra/cli/<name> with gh
#      and runs the repository's own install.sh from that checkout, with the
#      shim written to /usr/local/bin so it is on every root shell's PATH.
#   5. Deploy folder — `mkdir -p /opt/infra/apps`, nothing more.
#   6. Launch — `kvox deploy doctor --skip-proxy` (read-only), then the
#      interactive menu, or with --no-tui the exact next command to run.
#
# The CLI checkout at /opt/infra/cli/<name> is deliberately NOT the
# deployment's own clone (/opt/infra/apps/<name>/repo, which `kvox deploy
# install` creates). The running CLI must never rebuild its own dist/ in the
# middle of a deploy pipeline, so the two checkouts stay separate — the first
# is where kvox is BUILT FROM, the second is what kvox DEPLOYS.
#
# Re-running is a no-op: every step checks before it acts. `--update` is the
# one exception — it pulls the CLI checkout and rebuilds, which is the CLI's
# own self-update path (separate from `kvox deploy update`, which updates the
# deployed application).
#
# This is a thin wrapper around install.sh (repository root), which already
# honours KVOX_SRC (build from a local checkout instead of cloning) and
# KVOX_BIN_DIR (where the shim goes). install.sh is not changed by this
# script's existence and keeps working on a laptop exactly as before.
#
# Style: explicit commands, a verification after each step, no clever Bash.
# `--dry-run` prints every command and runs none; it probes nothing on the
# host (not root, not docker, not gh, not node) and assumes nothing is
# installed, so its output is identical on any machine — a test compares it
# to a committed fixture.
#
# Exit codes: 0 done, 1 a step failed (the step is named), 2 usage.
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Fixed locations. These are the deploy layout `kvox deploy` expects
# (--apps-root defaults to /opt/infra/apps); the CLI checkout sits beside it.
# ---------------------------------------------------------------------------
CLI_ROOT=/opt/infra/cli
APPS_ROOT=/opt/infra/apps
BIN_DIR=/usr/local/bin
NODE_MIN_MAJOR=20
NODE_INSTALL_MAJOR=22

# ---------------------------------------------------------------------------
# Usage and argument parsing
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage: bash bootstrap-vps.sh --repo <owner>/<name> [options]

Take a fresh root shell on an Ubuntu/Debian VPS to the kvox deploy wizard.

Options:
  --repo <owner>/<name>  GitHub repository to build the CLI from (required)
  --ref <branch>         Branch to check out (default: the repository's
                         default branch)
  --yes                  Install Node.js without asking when it is missing
  --no-tui               Print the next command instead of opening the menu
  --update               Pull the CLI checkout and rebuild kvox
  --dry-run              Print every command; run none, probe nothing
  -h, --help             Show this message

Exit codes: 0 done, 1 a step failed (named in the output), 2 usage error.
EOF
}

usage_error() {
  printf 'bootstrap-vps: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

REPO_SLUG=""
REF=""
ASSUME_YES=0
NO_TUI=0
UPDATE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || usage_error "--repo needs a value: --repo <owner>/<name>"
      REPO_SLUG="$2"
      shift 2
      ;;
    --ref)
      [ $# -ge 2 ] || usage_error "--ref needs a value: --ref <branch>"
      REF="$2"
      shift 2
      ;;
    --yes)     ASSUME_YES=1; shift ;;
    --no-tui)  NO_TUI=1; shift ;;
    --update)  UPDATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         usage_error "unknown argument: $1" ;;
  esac
done

[ -n "$REPO_SLUG" ] || usage_error "--repo <owner>/<name> is required"
case "$REPO_SLUG" in
  */*/*|/*|*/) usage_error "--repo must be <owner>/<name>, got: $REPO_SLUG" ;;
  */*) ;;
  *) usage_error "--repo must be <owner>/<name>, got: $REPO_SLUG" ;;
esac
case "$REPO_SLUG" in
  *[!A-Za-z0-9_./-]*) usage_error "--repo must be <owner>/<name>, got: $REPO_SLUG" ;;
esac

# KVOX_REPO is the slug the CLI is built from. It has no default: the
# repository is whatever `--repo` names, so a fork never has to edit this file.
KVOX_REPO="$REPO_SLUG"
REPO_NAME="${REPO_SLUG#*/}"
CLI_DIR="$CLI_ROOT/$REPO_NAME"
SHIM="$BIN_DIR/kvox"

# apt must never stop to ask about a config file on an unattended box.
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# Output helpers. Plain text only — no colour, no cursor movement — so the
# --dry-run output is byte-stable and readable in a log.
# ---------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

STEP_NO=0
STEP_NAME=""
step() {
  STEP_NO="$1"
  STEP_NAME="$2"
  printf '\n==> Step %s/6: %s\n' "$STEP_NO" "$STEP_NAME"
}

# The one place a failed step is reported. Called explicitly for a precondition
# the script checked itself; also reached through the ERR trap below when a
# command in a step exits non-zero.
fail_step() {
  printf '\nStep %s (%s) failed: %s\n' "$STEP_NO" "$STEP_NAME" "$1" >&2
  exit 1
}

on_error() {
  local status="$1"
  local line="$2"
  fail_step "a command exited with status $status (bootstrap-vps.sh line $line)"
}
trap 'on_error "$?" "$LINENO"' ERR

# Print one argument the way a person would type it: bare when it is plain,
# double-quoted when it contains a space or a shell metacharacter.
quote_arg() {
  case "$1" in
    ''|*[!A-Za-z0-9_./:=@+,%-]*) printf '"%s"' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# run <command...> — print the command, then run it (unless --dry-run).
run() {
  local shown=""
  local arg
  for arg in "$@"; do
    shown="$shown $(quote_arg "$arg")"
  done
  printf '  +%s\n' "$shown"
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  "$@"
}

# write_line <path> <line> — the same, for the one file this script writes.
write_line() {
  local path="$1"
  local line="$2"
  printf '  + echo "%s" > %s\n' "$line" "$path"
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  printf '%s\n' "$line" > "$path"
}

# probe <what> <command...> — returns the command's status, quietly. In a dry
# run nothing is probed: it prints what WOULD be checked and reports "no", so
# every install branch below is printed and the output never depends on the
# host it ran on.
probe() {
  local what="$1"
  shift
  if [ "$DRY_RUN" = 1 ]; then
    note "would check: $what (dry run: assuming not)"
    return 1
  fi
  "$@" >/dev/null 2>&1
}

# ask <question> — y/N on the terminal. --yes answers yes; no terminal is a
# refusal with the reason, never a hang.
ask() {
  local question="$1"
  if [ "$ASSUME_YES" = 1 ]; then
    note "$question [y/N] -> yes (--yes)"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note "would ask: $question [y/N] (dry run: assuming yes)"
    return 0
  fi
  if [ ! -t 0 ]; then
    fail_step "no terminal to ask on. Re-run with --yes to answer yes to: $question"
  fi
  local answer
  read -r -p "    $question [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0'
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
say "bootstrap-vps: build kvox from $KVOX_REPO${REF:+ @ $REF} into $CLI_DIR"
if [ "$DRY_RUN" = 1 ]; then
  say "dry run: every command is printed, none is run, nothing on this host is probed."
fi

# ---------------------------------------------------------------------------
# Step 1: Preconditions. Nothing is installed here, ever.
# ---------------------------------------------------------------------------
step 1 "Preconditions"

DOCKER_INSTALL_HELP='Docker is not installed (or `docker compose version` failed). This script never installs Docker.
Install Docker Engine and the Compose plugin first, from https://docs.docker.com/engine/install/ubuntu/
(replace linux/ubuntu with linux/debian on Debian):

  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  docker compose version

Then re-run this script.'

if [ "$DRY_RUN" = 1 ]; then
  note "would check: id -u prints 0 (root) — refuses otherwise"
  note "would check: /etc/os-release names Ubuntu or Debian (ID or ID_LIKE) — refuses otherwise"
  note "would check: curl is installed — refuses otherwise"
  note "would check: docker is installed and 'docker compose version' succeeds — prints the Docker install commands and stops otherwise"
  note "(dry run: nothing probed; this step installs nothing on any run)"
else
  note "checking: running as root"
  if [ "$(id -u)" != 0 ]; then
    fail_step "this script must run as root (id -u printed $(id -u)). It writes under /etc/apt, /opt/infra and $BIN_DIR. Re-run from a root shell (sudo -i)."
  fi
  note "ok: root"

  note "checking: /etc/os-release is Ubuntu or Debian"
  OS_ID=""
  OS_LIKE=""
  if [ -r /etc/os-release ]; then
    OS_ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
    OS_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
  fi
  case " $OS_ID $OS_LIKE " in
    *" ubuntu "*|*" debian "*) note "ok: $OS_ID" ;;
    *) fail_step "/etc/os-release reports ID=${OS_ID:-?} ID_LIKE=${OS_LIKE:-?}; this script only knows apt-based Ubuntu and Debian." ;;
  esac

  note "checking: curl is installed"
  if ! have curl; then
    fail_step "curl is not installed. Run: apt-get update && apt-get install -y curl"
  fi
  note "ok: curl"

  note "checking: docker and the Compose v2 plugin"
  if ! have docker || ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' "$DOCKER_INSTALL_HELP" >&2
    fail_step "Docker is required and this script never installs it (see above)."
  fi
  note "ok: $(docker compose version 2>/dev/null | head -1)"
fi

# ---------------------------------------------------------------------------
# Step 2: GitHub CLI — install, log in, wire git up to it.
# ---------------------------------------------------------------------------
step 2 "GitHub CLI"

if probe "gh is installed" have gh; then
  note "ok: gh already installed ($(gh --version | head -1))"
else
  # The apt lines from https://github.com/cli/cli/blob/trunk/docs/install_linux.md,
  # one command per line so each is printed, without `sudo` (step 1 already
  # requires root) and with the keyring fetched by curl (step 1 requires curl)
  # instead of the document's wget-into-tee.
  note "installing gh from GitHub's apt repository"
  if [ "$DRY_RUN" = 1 ]; then
    ARCH='$(dpkg --print-architecture)'
  else
    ARCH="$(dpkg --print-architecture)"
  fi
  run mkdir -p -m 755 /etc/apt/keyrings
  run curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  run chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  run mkdir -p -m 755 /etc/apt/sources.list.d
  write_line /etc/apt/sources.list.d/github-cli.list \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"
  run apt-get update
  run apt-get install -y gh
  note "verify:"
  run gh --version
fi

if probe "gh is logged in to github.com" gh auth status --hostname github.com; then
  note "ok: gh is logged in"
else
  note "logging in (interactive — this is the one step that needs you)"
  if [ "$DRY_RUN" != 1 ] && [ ! -t 0 ]; then
    fail_step "gh is not logged in and there is no terminal to log in on. Run: gh auth login --hostname github.com --git-protocol https"
  fi
  run gh auth login --hostname github.com --git-protocol https
  note "verify:"
  run gh auth status --hostname github.com
fi

# Idempotent, and needed on every run, not only after a fresh login: an
# operator who ran `gh auth login` themselves before this script (the README's
# three-command flow) has a token gh can use but git cannot — and `--update`
# runs plain `git pull` against a repository that may be private.
note "pointing git at gh's token for github.com"
run gh auth setup-git

# ---------------------------------------------------------------------------
# Step 3: Node.js >= 20 (install.sh's own floor; apps/cli's engines.node).
# ---------------------------------------------------------------------------
step 3 "Node.js"

NODE_OK=0
if probe "node is installed" have node; then
  CURRENT_MAJOR="$(node_major)"
  if [ "$CURRENT_MAJOR" -ge "$NODE_MIN_MAJOR" ]; then
    note "ok: $(node --version) is already installed (>= $NODE_MIN_MAJOR); leaving it alone"
    NODE_OK=1
  else
    note "found $(node --version), but >= $NODE_MIN_MAJOR is required"
  fi
fi

if [ "$NODE_OK" != 1 ]; then
  if ask "Install Node.js $NODE_INSTALL_MAJOR (LTS) from NodeSource?"; then
    run curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" -o /tmp/nodesource_setup.sh
    run bash /tmp/nodesource_setup.sh
    run apt-get install -y nodejs
    run rm -f /tmp/nodesource_setup.sh
    note "verify:"
    run node --version
    run npm --version
    if [ "$DRY_RUN" != 1 ] && [ "$(node_major)" -lt "$NODE_MIN_MAJOR" ]; then
      fail_step "node --version still reports $(node --version) after the install; >= $NODE_MIN_MAJOR is required."
    fi
  else
    fail_step "Node.js >= $NODE_MIN_MAJOR is required and you declined the install. Install it yourself, or re-run with --yes."
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: The CLI checkout, and kvox built from it onto the PATH.
# ---------------------------------------------------------------------------
step 4 "CLI checkout"

if probe "git is installed" have git; then
  note "ok: git already installed"
else
  run apt-get install -y git
fi

run mkdir -p "$CLI_ROOT"

NEED_BUILD=0
if probe "$CLI_DIR is already a git checkout" test -d "$CLI_DIR/.git"; then
  if [ "$UPDATE" = 1 ]; then
    note "updating the existing checkout (--update)"
    run git -C "$CLI_DIR" fetch --tags --prune origin
    if [ -n "$REF" ]; then
      run git -C "$CLI_DIR" checkout "$REF"
    fi
    run git -C "$CLI_DIR" pull --ff-only
    NEED_BUILD=1
  else
    note "ok: already cloned; leaving it alone (pass --update to pull and rebuild)"
  fi
else
  note "cloning with gh (uses gh's token, so a private repository works)"
  if [ -n "$REF" ]; then
    run gh repo clone "$KVOX_REPO" "$CLI_DIR" -- --branch "$REF"
  else
    run gh repo clone "$KVOX_REPO" "$CLI_DIR"
  fi
  NEED_BUILD=1
  if [ "$DRY_RUN" = 1 ] && [ "$UPDATE" = 1 ]; then
    note "(with --update and an existing checkout, these would run instead of the clone:)"
    run git -C "$CLI_DIR" fetch --tags --prune origin
    if [ -n "$REF" ]; then
      run git -C "$CLI_DIR" checkout "$REF"
    fi
    run git -C "$CLI_DIR" pull --ff-only
  fi
fi

if [ "$NEED_BUILD" != 1 ]; then
  if probe "$SHIM runs" "$SHIM" --version; then
    note "ok: $SHIM already works ($("$SHIM" --version | head -1)); not rebuilding (pass --update to rebuild)"
  else
    note "$SHIM is missing or broken; building"
    NEED_BUILD=1
  fi
fi

if [ "$NEED_BUILD" = 1 ]; then
  # install.sh does the clone-free build: KVOX_SRC makes it build from this
  # checkout instead of cloning its own copy (so no GITHUB_TOKEN is needed),
  # and KVOX_BIN_DIR puts the shim where every root shell's PATH already
  # looks. It installs the built CLI under $HOME/.kvox/app, the same directory
  # the CLI keeps its config in.
  note "building kvox from the checkout with the repository's install.sh"
  run env "KVOX_SRC=$CLI_DIR" "KVOX_BIN_DIR=$BIN_DIR" bash "$CLI_DIR/install.sh" --no-color
fi

note "verify:"
run "$SHIM" --version
if [ "$DRY_RUN" != 1 ]; then
  if ! have kvox; then
    note "warning: $BIN_DIR is not on this shell's PATH; use $SHIM, or open a new root login shell"
  fi
fi

# ---------------------------------------------------------------------------
# Step 5: The apps root `kvox deploy` installs into.
# ---------------------------------------------------------------------------
step 5 "Deploy folder"

run mkdir -p "$APPS_ROOT"
note "verify:"
run test -d "$APPS_ROOT"

# ---------------------------------------------------------------------------
# Step 6: A first read-only look, then the wizard.
# ---------------------------------------------------------------------------
step 6 "Launch"

# `kvox deploy` reads the repository and ref to deploy from the git checkout
# it is run inside (apps/cli/src/deploy/repo.ts). Run it from the CLI
# checkout, whose origin is exactly --repo, and `deploy install` needs no
# --repo/--ref of its own. It still clones its OWN copy under
# /opt/infra/apps/<name>/repo — this checkout is never deployed from directly.
note "running from $CLI_DIR so 'kvox deploy' picks up $KVOX_REPO from its git remote"
run cd "$CLI_DIR"

note "a first read-only look (exit 6 means a required check failed — fix those before 'deploy install'; it does not stop this script)"
if [ "$DRY_RUN" = 1 ]; then
  run "$SHIM" deploy doctor --skip-proxy
elif run "$SHIM" deploy doctor --skip-proxy; then
  note "ok: doctor passed"
else
  DOCTOR_STATUS=$?
  note "doctor exited $DOCTOR_STATUS; read its report above"
fi

print_next() {
  say ""
  say "Done. kvox is installed at $SHIM. Next, from a root shell:"
  say ""
  say "  cd $CLI_DIR"
  say "  kvox deploy install --domain <your-domain>"
  say ""
  say "or run 'kvox' with no arguments there for the interactive menu."
}

if [ "$NO_TUI" = 1 ]; then
  print_next
elif [ "$DRY_RUN" = 1 ]; then
  note "opening the interactive menu (pass --no-tui to print the next command instead)"
  run "$SHIM"
elif [ -t 0 ] && [ -t 1 ]; then
  note "opening the interactive menu (pass --no-tui to print the next command instead)"
  run "$SHIM"
else
  note "no terminal, so not opening the menu"
  print_next
fi
