# KVox

[![CI](https://github.com/marinoscar/kvox/actions/workflows/ci.yml/badge.svg)](https://github.com/marinoscar/kvox/actions)

From voice to knowledge.

OAuth authentication, RBAC authorization, a background job queue with a
distributed worker fleet, and a flexible settings framework — wired together
and ready to build on.

## Technology stack

- **Backend** — Node.js + TypeScript, NestJS with the Fastify adapter
- **Frontend** — React + TypeScript, Material UI
- **CLI** — TypeScript, Commander with an ink interactive menu
- **Database** — PostgreSQL with Prisma ORM
- **Auth** — Passport strategies (Google OAuth)
- **Testing** — Jest + Supertest (API), Vitest + React Testing Library (web), Vitest (CLI)
- **Observability** — OpenTelemetry, Uptrace, Pino structured logging
- **Runtime** — Docker Compose behind an Nginx same-origin reverse proxy

## Getting started

```bash
git clone https://github.com/marinoscar/kvox.git
cd kvox
npm install
cp infra/compose/.env.example infra/compose/.env
```

Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET` and
`INITIAL_ADMIN_EMAIL` in `infra/compose/.env`, then start the stack:

```bash
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up
```

| Surface | URL |
|---|---|
| Application | http://localhost:3535 |
| API reference (Scalar) | http://localhost:3535/api/docs |
| Uptrace (with the `otel` overlay) | http://localhost:14318 |

The first sign-in from `INITIAL_ADMIN_EMAIL` bypasses the email allowlist and
becomes the Admin account.

## Repository layout

```
kvox/
  apps/
    api/        Backend API, Prisma schema and migrations
    web/        React frontend
    cli/        First-party command-line client
  packages/     Shared workspace packages
  docs/         Specifications, runbooks and architecture notes
  infra/        Compose overlays, Nginx and OpenTelemetry configuration
  tests/        End-to-end and visual regression suites
```

## Tests

```bash
npm test --workspace=api
npm run test:run --workspace=web
npm run test:run --workspace=cli
```

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture rules and conventions for contributors
- [`docs/RENAMING.md`](docs/RENAMING.md) — rebranding this template for a new product
- [`docs/specs/`](docs/specs/) — design documents with rationale and rejected alternatives
- [`docs/runbooks/`](docs/runbooks/) — operator procedures
- [`apps/cli/README.md`](apps/cli/README.md) — CLI usage, install and CI setup
