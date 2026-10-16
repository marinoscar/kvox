# =============================================================================
# Web Dockerfile - Multi-stage build
# =============================================================================
# IMPORTANT: the build context is the REPOSITORY ROOT, not apps/web.
#
# apps/web is an npm workspace member and has no lockfile of its own; the only
# package-lock.json lives at the repo root. Building from the root is what
# makes that lockfile visible to the builder, so every stage can install with
# `npm ci` instead of `npm install`. Without this, each image build re-resolves
# the whole dependency tree and can ship versions that differ from what CI
# tested.
#
#   docker build -f apps/web/Dockerfile .
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /app

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
# `@app/shared` is a real dependency of this app, so `npm ci` has to resolve it
# and the workspace symlink it creates has to point at a populated directory.
# The whole package is copied rather than just its manifest so the build stage
# inherits it through `COPY --from=deps /app ./` — Vite inlines the constant
# into the bundle, so nginx's production stage needs nothing further.
# Every workspace package under packages/ (`@app/shared` and the four
# domain packages the apps depend on): whole directories, not just manifests, for
# the same reason as above.
COPY packages ./packages/
# The root postinstall (patch-react-transition-group.js) runs during npm ci
COPY scripts ./scripts
# `@marinoscar/kvox-contract` is selected too, so its devDependencies (TypeScript,
# Zod, @types/node) exist for the contract build below (issue #488).
RUN npm ci --workspace=web --workspace=@marinoscar/kvox-contract --include-workspace-root

# -----------------------------------------------------------------------------
# Development stage
# -----------------------------------------------------------------------------
FROM base AS development
# Brings node_modules from both the root and the workspace, plus the manifests
COPY --from=deps /app ./
# The contract package is TypeScript with its output in `dist/`, which
# .dockerignore drops, so it is built inside the image (issue #488).
COPY tsconfig.base.json ./
RUN npm run build --workspace=@marinoscar/kvox-contract
COPY apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./
# Build the contract BEFORE the app: Vite resolves it from `dist/esm` (issue #488).
RUN npm run build --workspace=@marinoscar/kvox-contract
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN npm run build

# -----------------------------------------------------------------------------
# Production stage (nginx to serve static files)
# -----------------------------------------------------------------------------
FROM nginx:1.30-alpine AS production
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# 5173, not 80, and deliberately the same port the development stage exposes:
# infra/nginx/nginx.conf reaches this container as `web:5173` in BOTH modes, so
# one proxy config serves both. See the header of apps/web/nginx.conf.
EXPOSE 5173
CMD ["nginx", "-g", "daemon off;"]
