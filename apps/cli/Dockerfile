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
# WHY THIS IMAGE IS STILL SMALL
# -----------------------------------------------------------------------------
# The application this design is ported from forces its worker onto a glibc
# base because of a native ML runtime, then adds layers for ffmpeg, image
# libraries and baked model files. Only one of those applies here: `ffmpeg`,
# for `media.audio.transcode` (epic #19, issue #26). Everything else this
# worker runs is pure Node — the example job type streams bytes and hashes
# them — so the base is `node:24-alpine`, matching the API image, and the
# Dockerfile stays short. A fork that adds another native dependency adds it
# beside the `apk add` below.
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

# `ffmpeg` (which ships `ffprobe`) for `media.audio.transcode`, epic #19.
#
# IN THE BASE STAGE, matching `apps/api/Dockerfile`, so `production` inherits
# it. It has to be present in the RUNTIME image specifically: the node's
# startup self-test (`src/node/capabilities.ts`) probes for both binaries and
# refuses to declare this job type without them, so an image that built the
# worker without ffmpeg would start, look healthy, and quietly never claim a
# transcode.
#
# A node running OUTSIDE a container gets the same two binaries from
# `appctl node install-deps`, which has a matching step.
RUN apk add --no-cache ffmpeg

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
ENV KVOX_STATE_DIR=/var/lib/worker
# Containers have no terminal and must drain on SIGTERM WITHOUT deregistering.
ENV KVOX_HEADLESS=true

# ---------------------------------------------------------------------------
# Everything the worker reads, declared for `docker inspect` and for the guard
# ---------------------------------------------------------------------------
# Deliberately left EMPTY rather than given defaults: an empty variable is
# treated as unset everywhere in the CLI, so these document the surface without
# overriding anything a compose file or an orchestrator supplies.
ENV KVOX_SERVER_URL=""
ENV KVOX_TOKEN=""
ENV KVOX_NODE_ID=""
ENV KVOX_NODE_NAME=""
ENV KVOX_CONCURRENCY=""
ENV KVOX_ELIGIBLE_TYPES=""
ENV KVOX_POLL_INTERVAL_MS=""
ENV KVOX_HEAP_LIMIT_MB=""
ENV KVOX_HEAP_TUNED=""
ENV KVOX_MEMORY_WATCHDOG=""
ENV KVOX_MEMORY_THRESHOLD=""
ENV KVOX_HEAP_SNAPSHOTS=""

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
