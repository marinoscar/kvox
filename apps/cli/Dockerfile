# =============================================================================
# Worker node image  (issue #278, epic #254)
# =============================================================================
# IMPORTANT: the build context is the REPOSITORY ROOT, not apps/cli.
#
#   docker build -f apps/cli/Dockerfile .
#
# Same reason as apps/api/Dockerfile: apps/cli is an npm workspace member with
# no lockfile of its own, and `@app/shared` is a real runtime dependency whose
# workspace symlink has to point at a directory that actually contains files.
# Building from the root is what makes the single root lockfile visible, so
# every stage installs with `npm ci` rather than re-resolving the tree.
#
# -----------------------------------------------------------------------------
# WHY THIS IMAGE IS SO SMALL
# -----------------------------------------------------------------------------
# The application this design is ported from forces its worker onto a glibc
# base because of a native ML runtime, then adds layers for ffmpeg, image
# libraries and baked model files. NONE OF THAT APPLIES HERE: this worker has
# no native dependencies at all — the example job type streams bytes and hashes
# them. So the base is `node:24-alpine`, matching the API image, and the
# Dockerfile is short. A fork that adds a native dependency adds it here.
#
# -----------------------------------------------------------------------------
# NO PRODUCT, APP OR REPOSITORY NAME APPEARS IN THIS FILE
# -----------------------------------------------------------------------------
# A Dockerfile cannot call TypeScript, so the environment-variable names below
# are the one unavoidable second copy of what `apps/cli/src/node/worker-env.ts`
# declares. `worker-env.test.ts` guards that duplication in BOTH directions:
# a variable renamed in the map but not here fails, and a variable added here
# that no code reads fails too.
# =============================================================================

# -----------------------------------------------------------------------------
# Base
# -----------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /app

# -----------------------------------------------------------------------------
# Dependencies
# -----------------------------------------------------------------------------
FROM base AS deps
# Manifests first, so this layer caches on dependency changes only. Every
# workspace manifest is required: `npm ci` validates the whole workspace set
# against the lockfile even when installing one workspace.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/cli/package.json ./apps/cli/
# The WHOLE shared package, not just its manifest — the production stage
# inherits this directory, and a symlink pointing at an empty one produces an
# image that builds clean and dies at boot with ERR_MODULE_NOT_FOUND.
COPY packages/shared ./packages/shared/
RUN npm ci --workspace=cli --include-workspace-root --ignore-scripts

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY apps/cli ./apps/cli
WORKDIR /app/apps/cli
RUN npm run build

# -----------------------------------------------------------------------------
# Production
# -----------------------------------------------------------------------------
FROM base AS production
COPY --from=deps /app ./
COPY --from=build /app/apps/cli/dist ./apps/cli/dist

# The worker's state directory. Mounted as a volume in the compose bundle so a
# restart re-attaches to the same node row rather than registering a new one.
ENV APPCTL_STATE_DIR=/var/lib/worker
# Containers have no terminal and must drain on SIGTERM WITHOUT deregistering.
ENV APPCTL_HEADLESS=true

# ---------------------------------------------------------------------------
# Everything the worker reads, declared for `docker inspect` and for the guard
# ---------------------------------------------------------------------------
# Deliberately left EMPTY rather than given defaults: an empty variable is
# treated as unset everywhere in the CLI, so these document the surface without
# overriding anything a compose file or an orchestrator supplies.
ENV APPCTL_SERVER_URL=""
ENV APPCTL_TOKEN=""
ENV APPCTL_NODE_ID=""
ENV APPCTL_NODE_NAME=""
ENV APPCTL_CONCURRENCY=""
ENV APPCTL_ELIGIBLE_TYPES=""
ENV APPCTL_POLL_INTERVAL_MS=""
ENV APPCTL_HEAP_LIMIT_MB=""
ENV APPCTL_HEAP_TUNED=""
ENV APPCTL_MEMORY_WATCHDOG=""
ENV APPCTL_MEMORY_THRESHOLD=""
ENV APPCTL_HEAP_SNAPSHOTS=""

RUN mkdir -p /var/lib/worker && chown -R node:node /var/lib/worker /app
# Non-root. A worker reads one config file and talks HTTPS to one server; it
# has no reason whatsoever to be root.
USER node
VOLUME ["/var/lib/worker"]

# EXEC FORM, and this is not a style preference. Shell form wraps the process
# in `/bin/sh -c`, which does NOT forward SIGTERM to its child — so the drain
# handler never runs and every restart abandons in-flight jobs, leaving their
# leases to expire before the work is retried anywhere.
ENTRYPOINT ["node", "/app/apps/cli/dist/cli.js", "node", "start", "--headless"]
