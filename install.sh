#!/usr/bin/env bash
# install.sh — kvox CLI installer / updater  (issue #166, epic #110)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh | bash
#   # or, locally:
#   bash install.sh
#   bash install.sh --uninstall
#   bash install.sh --help
#
# Configuration (set via environment variables before running):
#   KVOX_REPO     Git repo URL (default: https://github.com/marinoscar/kvox.git)
#   KVOX_REF      Branch/tag/commit to install (default: main)
#   KVOX_HOME     App install root (default: $HOME/.kvox — the same directory
#                 the CLI itself already stores config.json in, see branding.ts)
#   KVOX_BIN_DIR  Directory for the `kvox` shim (default: $HOME/.local/bin)
#   GITHUB_TOKEN  Optional GitHub PAT for private-repo clones
#   KVOX_SRC      Optional: local directory to install from (skips git clone).
#                 Useful for offline installs and local testing:
#                   KVOX_SRC=/path/to/repo bash install.sh
#
# A pre-1.0 installation made under the old `appctl` name ($HOME/.appctl plus an
# `appctl` shim) is detected and cleaned up on install, and the stored
# credentials are carried across to $KVOX_HOME/config.json.
#
# NOTE: The public `curl | bash` flow requires the repository to be public (or
# GITHUB_TOKEN set for private repos). The KVOX_SRC path lets you verify
# installer logic locally without any network access.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# ANSI color helpers (honor NO_COLOR)
# ---------------------------------------------------------------------------
_use_color() {
  [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]
}

_c() {
  # _c <code> <text>
  if _use_color; then
    printf '\033[%sm%s\033[0m' "$1" "$2"
  else
    printf '%s' "$2"
  fi
}

GREEN=32; CYAN=36; YELLOW=33; RED=31; BOLD=1; DIM=2

ok()   { printf '%s %s\n'  "$(_c $GREEN  "✔")" "$1"; }
err()  { printf '%s %s\n'  "$(_c $RED    "✖")" "$1" >&2; }
warn() { printf '%s %s\n'  "$(_c $YELLOW "⚠")" "$1"; }
info() { printf '%s %s\n'  "$(_c $CYAN   "ℹ")" "$1"; }
step() { printf '\n%s %s\n' "$(_c $BOLD  "→")" "$(_c $BOLD "$1")"; }
dim()  { printf '  %s\n'   "$(_c $DIM   "$1")"; }

# ---------------------------------------------------------------------------
# Box printer (ANSI, no external deps)
# ---------------------------------------------------------------------------
print_box() {
  local title="${1:-}"
  shift
  local lines=("$@")
  local width=60
  local pad="  "

  local border_h
  border_h=$(printf '─%.0s' $(seq 1 $width))

  if _use_color; then
    printf '\033[36m╭%s╮\033[0m\n' "$border_h"
    if [[ -n "$title" ]]; then
      local tpad=$(( (width - ${#title} - 2) / 2 ))
      printf '\033[36m│\033[0m%*s\033[1m%s\033[0m%*s\033[36m│\033[0m\n' \
        "$tpad" "" "$title" "$tpad" ""
      printf '\033[36m├%s┤\033[0m\n' "$border_h"
    fi
    for line in "${lines[@]}"; do
      printf '\033[36m│\033[0m %s%-*s \033[36m│\033[0m\n' \
        "${pad}" "$((width - ${#pad} - 1))" "$line"
    done
    printf '\033[36m╰%s╯\033[0m\n' "$border_h"
  else
    printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
    if [[ -n "$title" ]]; then
      printf '| %-*s |\n' "$((width - 1))" "$title"
      printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
    fi
    for line in "${lines[@]}"; do
      printf '| %-*s |\n' "$((width - 1))" "${pad}${line}"
    done
    printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
  fi
}

# ---------------------------------------------------------------------------
# Environment detection helpers
# ---------------------------------------------------------------------------
# Detect Windows Subsystem for Linux (WSL 1 or 2). WSL exports WSL_DISTRO_NAME
# and the kernel release / /proc/version advertise "microsoft" or "WSL".
is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
  grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null && return 0
  uname -r 2>/dev/null | grep -qiE '(microsoft|wsl)' && return 0
  return 1
}

# Best-effort guess at the interactive shell's rc file so PATH guidance points
# at the right place. Defaults to ~/.bashrc (the WSL default shell).
detect_shell_rc() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    *)     printf '%s' "$HOME/.bashrc" ;;
  esac
}

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
KVOX_REPO="${KVOX_REPO:-https://github.com/marinoscar/kvox.git}"
KVOX_REF="${KVOX_REF:-main}"

# ---------------------------------------------------------------------------
# Where the install lands, and why root gets a different answer (#226)
# ---------------------------------------------------------------------------
# `sudo` does not carry the invoking user's PATH. It replaces it with
# `secure_path` from /etc/sudoers, which never contains anyone's
# $HOME/.local/bin — so a shim installed under a home directory is invisible
# to `sudo kvox`, while every `kvox deploy` command in docs/deployment/vps.md
# is written for a root shell. That combination produced `sudo: kvox: command
# not found` in the middle of a deploy, which reads like a broken install.
#
# Installing AS root therefore defaults to the system locations: the shim to
# /usr/local/bin (on secure_path on Debian and Ubuntu) and the app tree to
# /usr/local/lib/kvox, which is world-readable — so ONE install serves `kvox`
# and `sudo kvox` alike. Keeping the app under /root/.kvox would only move the
# failure rather than fix it: reachable by root, permission-denied for every
# other user on the box.
#
# This moves no credentials. The CLI derives its own config directory at
# runtime from the RUNNING user's home — `configDirPath()` in
# apps/cli/src/config.ts joins `os.homedir()` with CONFIG_DIR_NAME — so tokens
# stay per-user no matter where the code was unpacked. KVOX_HOME decides where
# the CODE lives, nothing else.
#
# An explicit KVOX_HOME / KVOX_BIN_DIR still wins over both branches, so
# bootstrap-vps.sh (which sets KVOX_BIN_DIR=/usr/local/bin) is unaffected.
if [[ "$(id -u)" -eq 0 ]]; then
  KVOX_HOME="${KVOX_HOME:-/usr/local/lib/kvox}"
  KVOX_BIN_DIR="${KVOX_BIN_DIR:-/usr/local/bin}"
else
  KVOX_HOME="${KVOX_HOME:-$HOME/.kvox}"
  KVOX_BIN_DIR="${KVOX_BIN_DIR:-$HOME/.local/bin}"
fi

KVOX_SRC="${KVOX_SRC:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

APP_DIR="$KVOX_HOME/app"
BIN_SHIM="$KVOX_BIN_DIR/kvox"

# ---------------------------------------------------------------------------
# The pre-rebrand layout  (the binary used to be called `appctl`)
# ---------------------------------------------------------------------------
# These three paths are the ONLY place this script still writes `appctl`, and
# they exist purely to clean up after the old name. $KVOX_HOME now defaults to
# $HOME/.kvox, which is the directory the CLI itself derives from CONFIG_DIR_NAME
# (see apps/cli/src/branding.ts), so an old install is a genuinely separate tree.
LEGACY_HOME="$HOME/.appctl"
LEGACY_APP_DIR="$LEGACY_HOME/app"
LEGACY_SHIM="$KVOX_BIN_DIR/appctl"

# True only when the shim at $1 is one THIS installer wrote under the old name.
# Checked before anything is deleted: a binary called `appctl` that points
# somewhere else belongs to another tool, and removing it would be vandalism.
legacy_shim_is_ours() {
  [[ -f "$1" ]] || return 1
  grep -q '\.appctl/app/dist/cli\.js' "$1" 2>/dev/null
}

# Is there anything from the `appctl` era to clean up? Answering "no" keeps the
# whole legacy section silent, which is the normal case for a fresh install.
#
# The first test is a safety interlock: somebody who explicitly set
# KVOX_HOME=$HOME/.appctl has pointed the NEW install at the OLD directory, and
# "cleaning up the old one" would then delete the install we are about to make.
has_legacy_install() {
  [[ "$KVOX_HOME" != "$LEGACY_HOME" ]] || return 1
  [[ -d "$LEGACY_APP_DIR" ]] && return 0
  [[ -f "$LEGACY_HOME/config.json" ]] && return 0
  legacy_shim_is_ours "$LEGACY_SHIM" && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Remove the `appctl`-era installation, carrying its credentials across.
#
# Deliberately NOT `rm -rf "$LEGACY_HOME"`: that directory holds config.json,
# i.e. the user's stored token. Only $LEGACY_HOME/app and a shim this installer
# recognises are removed; the directory itself goes only if it ends up empty.
# ---------------------------------------------------------------------------
cleanup_legacy_install() {
  has_legacy_install || return 0

  step "Cleaning up the previous appctl installation"

  if [[ -d "$LEGACY_APP_DIR" ]]; then
    rm -rf "$LEGACY_APP_DIR"
    ok "Removed legacy app directory: $LEGACY_APP_DIR"
  fi

  if legacy_shim_is_ours "$LEGACY_SHIM"; then
    rm -f "$LEGACY_SHIM"
    ok "Removed legacy shim: $LEGACY_SHIM"
  elif [[ -e "$LEGACY_SHIM" ]]; then
    warn "Left $LEGACY_SHIM alone: it does not run $LEGACY_APP_DIR/dist/cli.js, so this installer did not write it."
  fi

  # Move the token across rather than leaving it behind, so an update does not
  # silently log the user out. An existing destination always wins.
  if [[ -f "$LEGACY_HOME/config.json" ]]; then
    if [[ -e "$KVOX_HOME/config.json" ]]; then
      warn "Kept $LEGACY_HOME/config.json: $KVOX_HOME/config.json already exists."
    else
      mkdir -p "$KVOX_HOME"
      mv "$LEGACY_HOME/config.json" "$KVOX_HOME/config.json"
      chmod 600 "$KVOX_HOME/config.json"
      ok "Moved saved credentials: $LEGACY_HOME/config.json -> $KVOX_HOME/config.json"
    fi
  fi

  if [[ -d "$LEGACY_HOME" ]]; then
    if rmdir "$LEGACY_HOME" 2>/dev/null; then
      ok "Removed empty legacy directory: $LEGACY_HOME"
    else
      info "Left $LEGACY_HOME in place: it still contains other files."
    fi
  fi
}

# The uninstall half: the app directory and a shim we wrote, never config.json.
cleanup_legacy_uninstall() {
  [[ "$KVOX_HOME" != "$LEGACY_HOME" ]] || return 0

  if [[ -d "$LEGACY_APP_DIR" ]]; then
    rm -rf "$LEGACY_APP_DIR"
    ok "Removed legacy app directory: $LEGACY_APP_DIR"
  fi

  if legacy_shim_is_ours "$LEGACY_SHIM"; then
    rm -f "$LEGACY_SHIM"
    ok "Removed legacy shim: $LEGACY_SHIM"
  fi
}

# ---------------------------------------------------------------------------
# Read the "version" field from a package.json using node (a hard dependency).
# Falls back to a grep/sed parse if node is unavailable for any reason.
# ---------------------------------------------------------------------------
read_pkg_version() {
  local pkg_file="$1"
  [[ -f "$pkg_file" ]] || { printf 'unknown'; return; }
  if command -v node &>/dev/null; then
    node -p "require('$pkg_file').version" 2>/dev/null && return
  fi
  grep -m1 '"version"' "$pkg_file" 2>/dev/null \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
    || printf 'unknown'
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --help|-h)   ACTION="help" ;;
    --no-color)  export NO_COLOR=1 ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
show_help() {
  cat <<EOF

$(_c $BOLD "kvox CLI Installer")

USAGE
  bash install.sh [options]

OPTIONS
  (none)        Install or update the CLI
  --uninstall   Remove the CLI and its shim
  --help        Show this message
  --no-color    Disable ANSI colors

ENVIRONMENT VARIABLES
  KVOX_REPO     Git clone URL  (default: $KVOX_REPO)
  KVOX_REF      Branch/tag     (default: $KVOX_REF)
  KVOX_HOME     Install root   (default: \$HOME/.kvox)
  KVOX_BIN_DIR  Shim directory (default: \$HOME/.local/bin)
  GITHUB_TOKEN  GitHub PAT for private repos (optional)
  KVOX_SRC      Local source directory — skip git clone (optional)
                Example: KVOX_SRC=/path/to/repo bash install.sh

NOTE
  The public curl | bash flow requires the repo to be public (or GITHUB_TOKEN
  set). Use KVOX_SRC for offline / local testing.

EOF
}

if [[ "$ACTION" == "help" ]]; then
  show_help
  exit 0
fi

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
do_uninstall() {
  step "Uninstalling kvox CLI"

  if [[ -d "$APP_DIR" ]]; then
    rm -rf "$APP_DIR"
    ok "Removed app directory: $APP_DIR"
  else
    warn "App directory not found: $APP_DIR"
  fi

  if [[ -f "$BIN_SHIM" ]]; then
    rm -f "$BIN_SHIM"
    ok "Removed shim: $BIN_SHIM"
  else
    warn "Shim not found: $BIN_SHIM"
  fi

  cleanup_legacy_uninstall

  # $KVOX_HOME itself is NEVER removed: it is now the same directory the CLI
  # keeps config.json in (CONFIG_DIR_NAME = `.kvox`), so `rm -rf "$KVOX_HOME"`
  # here would destroy the user's stored token. Only $KVOX_HOME/app goes.
  info "Config and credentials at $KVOX_HOME/config.json (if any) are left in place."
  ok "kvox CLI uninstalled."
}

if [[ "$ACTION" == "uninstall" ]]; then
  do_uninstall
  exit 0
fi

# ---------------------------------------------------------------------------
# Install / update
# ---------------------------------------------------------------------------

# Print header
printf '\n'
if _use_color; then
  printf '\033[36m  kvox CLI Installer\033[0m\n'
else
  printf '  kvox CLI Installer\n'
fi
printf '\n'

# Detect update vs fresh install, and capture the currently-installed version
# (if any) so we can show an old → new transition at the end.
PREV_VERSION=""
if [[ -d "$APP_DIR" ]]; then
  PREV_VERSION="$(read_pkg_version "$APP_DIR/package.json")"
  info "Updating existing installation at $APP_DIR"
  [[ -n "$PREV_VERSION" && "$PREV_VERSION" != "unknown" ]] && dim "Currently installed: v$PREV_VERSION"
else
  info "Installing kvox CLI to $APP_DIR"
fi

# Silent unless there is genuinely an `appctl`-era install to tidy away.

# ---------------------------------------------------------------------------
# Step 1: Dependency checks
# ---------------------------------------------------------------------------
step "Checking dependencies"

UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_M="$(uname -m 2>/dev/null || echo unknown)"
info "Platform  $(_c $DIM "${UNAME_S} ${UNAME_M}")"

check_tool() {
  local name="$1"
  local min_major="${2:-0}"
  if ! command -v "$name" &>/dev/null; then
    err "$name is required but not found."
    case "$name" in
      node) warn "Install Node.js >= 20 from https://nodejs.org or via nvm: https://github.com/nvm-sh/nvm" ;;
      npm)  warn "npm ships with Node.js; reinstall from https://nodejs.org" ;;
      git)  warn "Install git from https://git-scm.com" ;;
      curl) warn "Install curl via your package manager (e.g. apt install curl)" ;;
    esac
    exit 1
  fi

  local version
  version="$("$name" --version 2>&1 | head -1)"

  # Node.js version gate — 20 is apps/cli's own engines.node floor. (The repo
  # root's package.json asks for >=24 for the full monorepo dev toolchain,
  # but building just the cli workspace only needs what its own package.json
  # requires.)
  if [[ "$name" == "node" && "$min_major" -gt 0 ]]; then
    local major
    major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
    if [[ "$major" -lt "$min_major" ]]; then
      err "Node.js >= ${min_major} is required (found: $version)"
      warn "Upgrade via nvm: nvm install --lts"
      exit 1
    fi
  fi

  ok "$name  $(_c $DIM "$version")"
}

check_tool node 20
check_tool npm
check_tool git
check_tool curl

# Warn (don't fail) if the install target looks low on free space. kvox has
# no native modules, so the footprint is small — a few tens of MB for
# commander/ink/react and their transitive deps.
if command -v df &>/dev/null; then
  avail_kb="$(df -Pk "$KVOX_HOME" 2>/dev/null || df -Pk "$HOME" 2>/dev/null)"
  avail_kb="$(printf '%s\n' "$avail_kb" | awk 'NR==2 {print $4}')"
  if [[ -n "${avail_kb:-}" && "$avail_kb" =~ ^[0-9]+$ ]]; then
    if (( avail_kb < 51200 )); then
      warn "Low disk space at install target ($(( avail_kb / 1024 )) MB free; ~50 MB needed)"
    else
      ok "Disk space  $(_c $DIM "$(( avail_kb / 1024 )) MB free")"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Get source (clone or use local)
# ---------------------------------------------------------------------------
step "Preparing source"

TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
    dim "Cleaned up temp dir: $TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -n "$KVOX_SRC" ]]; then
  if [[ ! -d "$KVOX_SRC" ]]; then
    err "KVOX_SRC directory not found: $KVOX_SRC"
    exit 1
  fi
  info "Using local source: $KVOX_SRC"
  # Copy to a temp dir so we don't pollute the working tree
  TMP_DIR="$(mktemp -d)"
  cp -r "$KVOX_SRC/." "$TMP_DIR/"
  ok "Copied source to temp dir"
else
  TMP_DIR="$(mktemp -d)"
  local_repo="$KVOX_REPO"

  # Inject GitHub token for private-repo support
  if [[ -n "$GITHUB_TOKEN" ]]; then
    # Replace https://github.com/ with https://<token>@github.com/
    local_repo="${KVOX_REPO/https:\/\/github.com\//https:\/\/$GITHUB_TOKEN@github.com\/}"
    info "Using GITHUB_TOKEN for authentication"
  fi

  info "Cloning $KVOX_REPO @ $KVOX_REF …"
  git clone --depth 1 --branch "$KVOX_REF" "$local_repo" "$TMP_DIR" 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done || {
    err "Git clone failed. If the repo is private, set GITHUB_TOKEN or use KVOX_SRC."
    exit 1
  }
  ok "Cloned repository"
fi

# ---------------------------------------------------------------------------
# Announce the version we are about to install (read from the source manifest),
# and classify the transition relative to any currently-installed version.
# ---------------------------------------------------------------------------
SRC_VERSION="$(read_pkg_version "$TMP_DIR/apps/cli/package.json")"
if [[ -n "$SRC_VERSION" && "$SRC_VERSION" != "unknown" ]]; then
  if [[ -z "$PREV_VERSION" || "$PREV_VERSION" == "unknown" ]]; then
    ok "Installing kvox CLI $(_c $BOLD "v$SRC_VERSION")"
  elif [[ "$PREV_VERSION" == "$SRC_VERSION" ]]; then
    ok "Reinstalling kvox CLI $(_c $BOLD "v$SRC_VERSION") (same version)"
  else
    ok "Updating kvox CLI $(_c $BOLD "v$PREV_VERSION") → $(_c $BOLD "v$SRC_VERSION")"
  fi
else
  warn "Could not determine the version from the source manifest"
fi

# ---------------------------------------------------------------------------
# Step 3: Build the CLI workspace
# ---------------------------------------------------------------------------
step "Building CLI"

info "Installing CLI workspace dependencies …"
# --workspace=cli installs only the cli workspace's deps (plus what npm needs
# at the root to resolve the workspace), without triggering api/web installs.
(
  cd "$TMP_DIR"
  npm install --workspace=cli --no-audit --no-fund 2>&1 \
    | grep -v "^$" \
    | grep -v "^npm warn deprecated" \
    | grep -v "^npm warn EBADENGINE" \
    | grep -v "^npm warn" \
    | while IFS= read -r line; do dim "$line"; done
) || {
  err "npm install failed"
  exit 1
}
ok "Dependencies installed"

info "Compiling TypeScript …"
(
  cd "$TMP_DIR"
  npm run build --workspace=cli --no-audit --no-fund 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done
) || {
  err "Build failed"
  exit 1
}
ok "Build complete"

# ---------------------------------------------------------------------------
# Step 4: Deploy standalone app
# ---------------------------------------------------------------------------
step "Deploying standalone app"

# Remove old install
if [[ -d "$APP_DIR" ]]; then
  rm -rf "$APP_DIR"
fi
mkdir -p "$APP_DIR"

# Copy the built artifacts, the package manifest and the environment
# template (issue #236) - not the full repo.
# Most of apps/cli's runtime deps (commander, ink, react, ...) are ordinary
# public npm packages. @app/shared is not: it is an internal workspace package
# (epic #161) that is `private: true` and never published, so the `npm install`
# below — which runs OUTSIDE the monorepo, with no workspace to link against —
# would go looking for it on the public registry and fail the whole install.
#
# So vendor it next to the app and rewrite the dependency to a `file:`
# specifier npm can resolve locally. The whole packages/ tree is copied rather
# than the one directory by name, so adding a second shared package later
# cannot silently reintroduce this failure.
cp -r "$TMP_DIR/apps/cli/dist"        "$APP_DIR/dist"
cp    "$TMP_DIR/apps/cli/package.json" "$APP_DIR/package.json"
if [[ -f "$TMP_DIR/apps/cli/README.md" ]]; then
  cp "$TMP_DIR/apps/cli/README.md" "$APP_DIR/README.md"
fi

# The repository's environment template, kept beside the CLI (issue #236).
#
# The install wizard has to know which variables to ask about BEFORE it clones
# anything, so on a first install it reads this file from the REMOTE through
# the GitHub CLI. That credential is per-user, this installer deliberately
# supports running as root, and root's `gh` is commonly logged out - at which
# point the wizard had no template, asked no questions about the database, the
# secrets, the OAuth client or the administrator, and refused to install.
#
# We are holding the file right now. Keeping one small text file costs nothing
# and removes the network and the credential from the ordinary first install.
#
# source.json records WHICH repository it came from, and the CLI refuses to use
# the copy for any other one: a template belongs to the repository that
# declared it, and handing one repository's variable list to another is the
# very bug this whole resolution chain exists to avoid.
TEMPLATE_SRC="$TMP_DIR/infra/compose/.env.example"
if [[ -f "$TEMPLATE_SRC" ]]; then
  # The URL git itself would push to, so a local-source install records the
  # real repository rather than the temp directory it was copied through.
  SRC_REPO_URL="$(git -C "$TMP_DIR" remote get-url origin 2>/dev/null || true)"
  [[ -n "$SRC_REPO_URL" ]] || SRC_REPO_URL="$KVOX_REPO"
  if [[ -n "$KVOX_SRC" ]]; then
    SRC_REF="$(git -C "$TMP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [[ "$SRC_REF" != "HEAD" ]] || SRC_REF=""
  else
    SRC_REF="$KVOX_REF"
  fi

  mkdir -p "$APP_DIR/template"
  cp "$TEMPLATE_SRC" "$APP_DIR/template/.env.example"
  # Written by node rather than a printf so the URL and ref are JSON-escaped
  # by something that knows the rules, not by hand.
  node -e '
    const fs = require("node:fs");
    fs.writeFileSync(
      process.argv[1],
      JSON.stringify({ repoUrl: process.argv[2], ref: process.argv[3] }, null, 2) + "\n",
    );
  ' "$APP_DIR/template/source.json" "$SRC_REPO_URL" "$SRC_REF" || {
    err "Failed to record the bundled template source"
    exit 1
  }
  ok "Bundled the environment template from $SRC_REPO_URL"
else
  warn "No infra/compose/.env.example in the source; the wizard will read it from the remote"
fi

if [[ -d "$TMP_DIR/packages" ]]; then
  info "Vendoring internal workspace packages …"
  mkdir -p "$APP_DIR/vendor"
  cp -r "$TMP_DIR/packages/." "$APP_DIR/vendor/"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const manifest = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const vendor = path.join(path.dirname(manifest), "vendor");
    let count = 0;
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(pkg[field] || {})) {
        if (!name.startsWith("@app/")) continue;
        const dir = name.slice("@app/".length);
        if (!fs.existsSync(path.join(vendor, dir))) {
          console.error("no vendored copy of " + name + " at vendor/" + dir);
          process.exit(1);
        }
        pkg[field][name] = "file:./vendor/" + dir;
        count++;
      }
    }
    fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
    console.log("rewrote " + count + " workspace dependency specifier(s)");
  ' "$APP_DIR/package.json" || {
    err "Failed to vendor internal workspace packages"
    exit 1
  }
fi

ok "Copied dist + package.json to $APP_DIR"

info "Installing runtime dependencies (omitting devDeps) …"
# This runs OUTSIDE the monorepo, so npm installs only the CLI's own runtime
# deps (commander, ink, ink-select-input, ink-spinner, ink-text-input, react).
(
  cd "$APP_DIR"
  npm install --omit=dev --no-audit --no-fund 2>&1 \
    | grep -v "^$" \
    | grep -v "^npm warn" \
    | while IFS= read -r line; do dim "$line"; done
) || {
  err "Runtime npm install failed"
  exit 1
}
ok "Runtime dependencies installed"

# ---------------------------------------------------------------------------
# Step 5: Write bin shim
# ---------------------------------------------------------------------------
step "Installing CLI shim"

mkdir -p "$KVOX_BIN_DIR"

# apps/cli's package.json points bin at ./dist/cli.js directly (it already
# carries a shebang and is chmod'd 0755 by the build's postbuild step) — there
# is no separate dist/index.js entrypoint to exec here.
cat > "$BIN_SHIM" <<SHIM
#!/usr/bin/env bash
exec node "$APP_DIR/dist/cli.js" "\$@"
SHIM

chmod +x "$BIN_SHIM"
ok "Shim written: $BIN_SHIM"

# ---------------------------------------------------------------------------
# Step 6: PATH check
# ---------------------------------------------------------------------------
BIN_ON_PATH=0
if echo ":$PATH:" | grep -q ":$KVOX_BIN_DIR:"; then
  BIN_ON_PATH=1
fi

# Plain PATH guidance for non-WSL shells. WSL users get a dedicated, nicer
# call-out box printed after the completion summary (see below), so we skip
# this generic block for them to avoid duplicate messaging.
if [[ "$BIN_ON_PATH" != "1" ]] && ! is_wsl; then
  warn "$KVOX_BIN_DIR is not on your PATH"
  printf '\n'
  info "Add the following line to your shell config (~/.bashrc or ~/.zshrc):"
  printf '\n'
  printf '    %s\n' "export PATH=\"\$PATH:$KVOX_BIN_DIR\""
  printf '\n'
  info "Then reload: source ~/.bashrc  (or source ~/.zshrc)"
  printf '\n'
fi

# A user-scope install is invisible to `sudo`, which replaces PATH with
# secure_path from /etc/sudoers — a list that never contains a home directory.
# Say so HERE rather than letting it surface later as `sudo: kvox: command not
# found` partway through a deploy, where it reads like a broken install (#226).
# Only worth saying when there is a sudo to be confused by.
if [[ "$(id -u)" -ne 0 && "$KVOX_BIN_DIR" == "$HOME"/* ]] && command -v sudo >/dev/null 2>&1; then
  warn "Installed for this user only — \`sudo kvox\` will NOT find it"
  printf '\n'
  info "sudo replaces PATH with secure_path from /etc/sudoers, which never"
  info "contains a home directory. This matters on a server: every"
  info "\`kvox deploy\` command in docs/deployment/vps.md assumes a root shell."
  printf '\n'
  info "To install system-wide as well (shim in /usr/local/bin):"
  printf '\n'
  if [[ -n "$KVOX_SRC" ]]; then
    printf '    %s\n' "sudo KVOX_SRC=\"$KVOX_SRC\" bash install.sh"
  else
    printf '    %s\n' "sudo bash install.sh"
  fi
  printf '\n'
fi

# ---------------------------------------------------------------------------
# Step 7: Print installed version
# ---------------------------------------------------------------------------
step "Verifying installation"

INSTALLED_VERSION="$("$BIN_SHIM" --version 2>/dev/null | head -1 || echo "unknown")"
if [[ "$INSTALLED_VERSION" == "unknown" || -z "$INSTALLED_VERSION" ]]; then
  err "Installed binary did not report a version — the install may be broken."
  dim "  Try running: $BIN_SHIM --version"
  exit 1
fi
ok "Installed version: $(_c $BOLD "v$INSTALLED_VERSION")"

# Sanity check: the running binary should report the version we just built.
if [[ -n "$SRC_VERSION" && "$SRC_VERSION" != "unknown" && "$INSTALLED_VERSION" != "$SRC_VERSION" ]]; then
  warn "Version mismatch: expected v$SRC_VERSION from source but binary reports v$INSTALLED_VERSION"
fi

# Only now, with a verified-working `kvox` on disk, is it safe to remove the
# installation the old name left behind. Doing this any earlier — before the
# dependency checks, the build, or this verification — would mean a run that
# fails partway through has already destroyed a working `appctl` and moved the
# user's credentials out from under it.
cleanup_legacy_install

INSTALL_SIZE="unknown"
if command -v du &>/dev/null; then
  INSTALL_SIZE="$(du -sh "$APP_DIR" 2>/dev/null | cut -f1)"
fi
ok "Install size: $INSTALL_SIZE"

VERSION_LINE="CLI version : v$INSTALLED_VERSION"
if [[ -n "$PREV_VERSION" && "$PREV_VERSION" != "unknown" && "$PREV_VERSION" != "$INSTALLED_VERSION" ]]; then
  VERSION_LINE="CLI version : v$PREV_VERSION -> v$INSTALLED_VERSION"
fi

print_box "Installation Complete" \
  "$VERSION_LINE" \
  "Install size: $INSTALL_SIZE" \
  "Location    : $APP_DIR" \
  "Shim        : $BIN_SHIM" \
  "" \
  "Get started:" \
  "  kvox login" \
  "  kvox api GET /api/auth/me" \
  "  kvox --help"

# ---------------------------------------------------------------------------
# Step 8: Windows / WSL PATH call-out
# ---------------------------------------------------------------------------
# On Windows 11 + WSL the default shell rarely has ~/.local/bin on PATH, so the
# freshly-installed `kvox` command is "not found" until the user appends it.
# Print an explicit, copy-pasteable box with the exact two commands.
if is_wsl && [[ "$BIN_ON_PATH" != "1" ]]; then
  RC_FILE="$(detect_shell_rc)"
  RC_SHORT="${RC_FILE/#"$HOME"/\~}"
  printf '\n'
  print_box "Windows 11 · WSL — one more step" \
    "Detected Windows Subsystem for Linux (WSL)." \
    "" \
    "The 'kvox' command was installed to:" \
    "$KVOX_BIN_DIR" \
    "but that directory is not on your PATH yet, so" \
    "your shell reports 'command not found'." \
    "" \
    "Run these two commands to finish setup:" \
    "" \
    "echo 'export PATH=\"\$PATH:$KVOX_BIN_DIR\"' >> $RC_SHORT" \
    "source $RC_SHORT" \
    "" \
    "Then verify it works:" \
    "kvox --version"
  printf '\n'
fi
