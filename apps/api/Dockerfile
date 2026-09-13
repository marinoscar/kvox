# =============================================================================
# API Dockerfile - Multi-stage build
# =============================================================================
# IMPORTANT: the build context is the REPOSITORY ROOT, not apps/api.
#
# apps/api is an npm workspace member and has no lockfile of its own; the only
# package-lock.json lives at the repo root. Building from the root is what
# makes that lockfile visible to the builder, so every stage can install with
# `npm ci` instead of `npm install`. Without this, each image build re-resolves
# the whole dependency tree and can ship versions that differ from what CI
# tested.
#
#   docker build -f apps/api/Dockerfile .
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /app
# Prisma needs the OpenSSL RUNTIME to pick its query-engine binary on musl.
#
# NOT `openssl-dev`. That package is headers and static libraries, for
# compiling against OpenSSL - and nothing in this image compiles anything.
# Every stage below installs prebuilt npm packages and runs `tsc`; there is no
# node-gyp step, no native addon built from source. It was pulling roughly two
# megabytes of build-only files into the base stage that every later stage
# inherits, including production, and it is what the failing `apk add` in #203
# choked on.
#
# `postgresql17-client` is pg_dump and pg_restore, for the database backup and
# restore (epic #254, issue #280). It lands in the BASE stage, not just in
# production, because `development` and `production` both descend from it and
# a backup that only works in one of them is a backup nobody exercises until
# the night it is needed.
#
# THE MAJOR IS PINNED EXPLICITLY, and that is the whole point of this line.
# The floating `postgresql-client` meta-package tracks whatever major the
# Alpine release underneath `node:24-alpine` currently ships, so a base-image
# refresh - something nobody reviews as a database change - can move the
# client backwards or forwards without a single line of this repository
# changing. `pg_dump` REFUSES to dump a server newer than itself, and the
# application's PostgreSQL is external to this compose stack (there is no `db`
# service in infra/compose/base.compose.yml), so client and server majors
# drift independently. The resulting failure is silent, total and permanent:
# every backup from that moment on exits non-zero, and the first person to
# find out is whoever needed a restore.
#
# The pinned number here is asserted against MIN_PG_CLIENT_MAJOR in
# src/db-backup/pg-version.util.ts by test/pg-client-version.spec.ts - moving
# one without the other fails the suite. See
# docs/runbooks/postgres-client-version.md for how to bump the pair.
RUN apk add --no-cache openssl postgresql17-client

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
# Copy manifests first so this layer caches on dependency changes only.
# Every workspace manifest is required: `npm ci` validates the whole workspace
# set against the lockfile, even when installing a single workspace.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
# `@app/shared` is a real runtime dependency of this app, so `npm ci` has to
# resolve it — and the workspace symlink it creates (node_modules/@app/shared)
# has to point at a directory that actually contains files.
#
# The WHOLE package is copied here, not just its manifest, precisely so that
# every later stage inherits it through `COPY --from=deps /app ./`. That
# includes the production stage, which otherwise copies only `dist/` and would
# ship a symlink pointing at an empty directory — an image that builds clean
# and then dies at boot with ERR_MODULE_NOT_FOUND. Nothing in CI would catch
# it: no PR job builds images, and `smoke` boots from the workspace checkout.
#
# The cost is that editing the package busts this layer's npm ci cache. It
# holds one string that changes only when the product is renamed, so that is a
# trade worth making to remove the failure mode entirely.
COPY packages/shared ./packages/shared/
# Prisma schema and config are needed by `prisma generate` below
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/prisma.config.ts ./apps/api/
RUN npm ci --workspace=api --include-workspace-root --ignore-scripts
# --ignore-scripts skips Prisma's postinstall, so generate the client
# explicitly. DATABASE_URL is a build-time placeholder; `generate` reads the
# schema only and never opens a connection.
RUN cd apps/api && \
    DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# -----------------------------------------------------------------------------
# Development stage
# -----------------------------------------------------------------------------
FROM base AS development
# Brings node_modules from both the root and the workspace, plus the manifests
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npm run build

# -----------------------------------------------------------------------------
# Production stage
# -----------------------------------------------------------------------------
FROM base AS production
COPY --from=deps /app ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/prisma.config.ts ./apps/api/
# The migration entry points are npm scripts that shell into this directory:
# `prisma:migrate` is `node scripts/prisma-env.js migrate deploy`, resolved
# from the WORKDIR below. Without it the image starts perfectly - CMD runs
# `node dist/main` and never touches these - and then cannot migrate, which
# is only discovered by whatever tries to deploy it.
#
# NOT the same as `COPY scripts ./scripts` below, which copies the
# REPOSITORY-ROOT scripts/ directory. The similar name is most likely why
# this one was missed.
COPY apps/api/scripts ./apps/api/scripts/
COPY scripts ./scripts
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
