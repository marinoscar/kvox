#!/usr/bin/env bash
# install.sh — appctl CLI installer / updater  (issue #166, epic #110)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marinoscar/EnterpriseAppBase/main/install.sh | bash
#   # or, locally:
#   bash install.sh
#   bash install.sh --uninstall
#   bash install.sh --help
#
# Configuration (set via environment variables before running):
#   APPCTL_REPO     Git repo URL (default: https://github.com/marinoscar/EnterpriseAppBase.git)
#   APPCTL_REF      Branch/tag/commit to install (default: main)
#   APPCTL_HOME     App install root (default: $HOME/.appctl — the same directory
#                   the CLI itself already stores config.json in, see branding.ts)
#   APPCTL_BIN_DIR  Directory for the `appctl` shim (default: $HOME/.local/bin)
#   GITHUB_TOKEN    Optional GitHub PAT for private-repo clones
#   APPCTL_SRC      Optional: local directory to install from (skips git clone).
#                   Useful for offline installs and local testing:
#                     APPCTL_SRC=/path/to/repo bash install.sh
#
# NOTE: The public `curl | bash` flow requires the repository to be public (or
# GITHUB_TOKEN set for private repos). The APPCTL_SRC path lets you verify
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
APPCTL_REPO="${APPCTL_REPO:-https://github.com/marinoscar/EnterpriseAppBase.git}"
APPCTL_REF="${APPCTL_REF:-main}"
APPCTL_HOME="${APPCTL_HOME:-$HOME/.appctl}"
APPCTL_BIN_DIR="${APPCTL_BIN_DIR:-$HOME/.local/bin}"
APPCTL_SRC="${APPCTL_SRC:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

APP_DIR="$APPCTL_HOME/app"
BIN_SHIM="$APPCTL_BIN_DIR/appctl"

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

$(_c $BOLD "appctl CLI Installer")

USAGE
  bash install.sh [options]

OPTIONS
  (none)        Install or update the CLI
  --uninstall   Remove the CLI and its shim
  --help        Show this message
  --no-color    Disable ANSI colors

ENVIRONMENT VARIABLES
  APPCTL_REPO      Git clone URL  (default: $APPCTL_REPO)
  APPCTL_REF       Branch/tag     (default: $APPCTL_REF)
  APPCTL_HOME      Install root   (default: \$HOME/.appctl)
  APPCTL_BIN_DIR   Shim directory (default: \$HOME/.local/bin)
  GITHUB_TOKEN     GitHub PAT for private repos (optional)
  APPCTL_SRC       Local source directory — skip git clone (optional)
                   Example: APPCTL_SRC=/path/to/repo bash install.sh

NOTE
  The public curl | bash flow requires the repo to be public (or GITHUB_TOKEN
  set). Use APPCTL_SRC for offline / local testing.

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
  step "Uninstalling appctl CLI"

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

  info "Config and credentials at $APPCTL_HOME/config.json (if any) are left in place."
  ok "appctl CLI uninstalled."
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
  printf '\033[36m  appctl CLI Installer\033[0m\n'
else
  printf '  appctl CLI Installer\n'
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
  info "Installing appctl CLI to $APP_DIR"
fi

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

# Warn (don't fail) if the install target looks low on free space. appctl has
# no native modules, so the footprint is small — a few tens of MB for
# commander/ink/react and their transitive deps.
if command -v df &>/dev/null; then
  avail_kb="$(df -Pk "$APPCTL_HOME" 2>/dev/null || df -Pk "$HOME" 2>/dev/null)"
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

if [[ -n "$APPCTL_SRC" ]]; then
  if [[ ! -d "$APPCTL_SRC" ]]; then
    err "APPCTL_SRC directory not found: $APPCTL_SRC"
    exit 1
  fi
  info "Using local source: $APPCTL_SRC"
  # Copy to a temp dir so we don't pollute the working tree
  TMP_DIR="$(mktemp -d)"
  cp -r "$APPCTL_SRC/." "$TMP_DIR/"
  ok "Copied source to temp dir"
else
  TMP_DIR="$(mktemp -d)"
  local_repo="$APPCTL_REPO"

  # Inject GitHub token for private-repo support
  if [[ -n "$GITHUB_TOKEN" ]]; then
    # Replace https://github.com/ with https://<token>@github.com/
    local_repo="${APPCTL_REPO/https:\/\/github.com\//https:\/\/$GITHUB_TOKEN@github.com\/}"
    info "Using GITHUB_TOKEN for authentication"
  fi

  info "Cloning $APPCTL_REPO @ $APPCTL_REF …"
  git clone --depth 1 --branch "$APPCTL_REF" "$local_repo" "$TMP_DIR" 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done || {
    err "Git clone failed. If the repo is private, set GITHUB_TOKEN or use APPCTL_SRC."
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
    ok "Installing appctl CLI $(_c $BOLD "v$SRC_VERSION")"
  elif [[ "$PREV_VERSION" == "$SRC_VERSION" ]]; then
    ok "Reinstalling appctl CLI $(_c $BOLD "v$SRC_VERSION") (same version)"
  else
    ok "Updating appctl CLI $(_c $BOLD "v$PREV_VERSION") → $(_c $BOLD "v$SRC_VERSION")"
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

# Copy only the built artifacts + package manifest (not the full repo).
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

mkdir -p "$APPCTL_BIN_DIR"

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
if echo ":$PATH:" | grep -q ":$APPCTL_BIN_DIR:"; then
  BIN_ON_PATH=1
fi

# Plain PATH guidance for non-WSL shells. WSL users get a dedicated, nicer
# call-out box printed after the completion summary (see below), so we skip
# this generic block for them to avoid duplicate messaging.
if [[ "$BIN_ON_PATH" != "1" ]] && ! is_wsl; then
  warn "$APPCTL_BIN_DIR is not on your PATH"
  printf '\n'
  info "Add the following line to your shell config (~/.bashrc or ~/.zshrc):"
  printf '\n'
  printf '    %s\n' "export PATH=\"\$PATH:$APPCTL_BIN_DIR\""
  printf '\n'
  info "Then reload: source ~/.bashrc  (or source ~/.zshrc)"
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
  "  appctl login" \
  "  appctl api GET /api/auth/me" \
  "  appctl --help"

# ---------------------------------------------------------------------------
# Step 8: Windows / WSL PATH call-out
# ---------------------------------------------------------------------------
# On Windows 11 + WSL the default shell rarely has ~/.local/bin on PATH, so the
# freshly-installed `appctl` command is "not found" until the user appends it.
# Print an explicit, copy-pasteable box with the exact two commands.
if is_wsl && [[ "$BIN_ON_PATH" != "1" ]]; then
  RC_FILE="$(detect_shell_rc)"
  RC_SHORT="${RC_FILE/#"$HOME"/\~}"
  printf '\n'
  print_box "Windows 11 · WSL — one more step" \
    "Detected Windows Subsystem for Linux (WSL)." \
    "" \
    "The 'appctl' command was installed to:" \
    "$APPCTL_BIN_DIR" \
    "but that directory is not on your PATH yet, so" \
    "your shell reports 'command not found'." \
    "" \
    "Run these two commands to finish setup:" \
    "" \
    "echo 'export PATH=\"\$PATH:$APPCTL_BIN_DIR\"' >> $RC_SHORT" \
    "source $RC_SHORT" \
    "" \
    "Then verify it works:" \
    "appctl --version"
  printf '\n'
fi
