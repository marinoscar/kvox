# KVox

[![CI](https://github.com/marinoscar/kvox/actions/workflows/ci.yml/badge.svg)](https://github.com/marinoscar/kvox/actions)

From voice to knowledge.

KVox turns uploaded audio into a corrected, versioned transcript, and turns
that transcript (or another note, or a document) into an AI-generated,
user-correctable note. The guiding principle, from [`VISION.md`](VISION.md),
is **"AI proposes. The user controls the truth."** — every AI output is a
draft: it is versioned, editable, and exportable, never a record you are
stuck with.

## What it does

### Transcripts

- Upload multi-GB audio over a resumable multipart upload — a dropped
  network connection or a page reload does not restart it.
- Diarized, timestamped transcription through a pluggable
  `TranscriptionProvider` registry; AssemblyAI is the first implementation
  (US/EU region, key stored encrypted, with a test-connection probe).
- A node-eligible `media.audio.transcode` job produces an AAC/m4a playback
  rendition so audio plays back on iOS.
- Correct the AI's output: edit text, rename/merge/reassign speakers, find &
  replace, split and join segments.
- Every save appends a version. **Version 1 — the AI's original — is always
  retrievable**, and restoring an old version appends a new version rather
  than rewriting history.
- Share a transcript as Viewer or Editor.
- Export to JSON (`kvox.transcript/v1`), Markdown or PDF.
- An audio player with tap-a-segment-to-play and per-speaker playback.

### Notes

- Note Templates are a reusable recipe — instructions, structure, tone,
  length, output format — with a seeded built-in set and a live preview
  before you save one.
- A Note is generated from exactly one source (a transcript, another note,
  or an uploaded PDF/TXT/MD) and stays permanently linked to it.
- Generation streams token-by-token over resumable SSE, and **closing the
  tab loses nothing** — the stream is a read-only view over durable state,
  never the delivery mechanism.
- Markdown editing with optimistic concurrency and full version history.
- Export to Markdown, PDF or Word.

### Bring your own key

There is no deployment-wide AI key and no shared spend. Each user saves
their own provider key (`user_ai_credentials`, encrypted, never returned by
any endpoint). An administrator configures *policy* only: the active
provider, which models are permitted, and token/timeout/document ceilings.

### Privacy, stated plainly

A transcript or note is somebody's private conversation. There is
deliberately no `transcripts:read_any` and no `notes:read_any` — not even
for an admin — and no-access answers **404, never 403**, so a stranger can't
even confirm a given transcript or note exists. The transcription provider's
copy of the audio is deleted once ingest completes.

## Platform foundation

The product above is built on a general-purpose application foundation:

- Google OAuth authentication and RBAC (Admin / Contributor / Viewer —
  Viewer is the default role) plus an email allowlist gating who may sign in
- A background job queue with a **distributed worker fleet**: worker nodes
  claim jobs under a lease, get presigned URLs for the data plane, and are
  issued short-lived, per-job credentials rather than long-lived secrets
- Database backup and restore, with node-offloadable backups
- Maintenance mode, admin notification broadcasts, and Web Push / PWA
  browser notifications
- Personal access tokens and RFC 8628 device authorization (what the CLI
  uses to log in)
- A registry-driven settings hub, admin and per-user

## Technology stack

- **Backend** — Node.js (>= 24) + TypeScript, NestJS with the Fastify adapter
- **Frontend** — React + TypeScript, Material UI
- **CLI** — TypeScript, Commander with an ink interactive menu
- **Database** — PostgreSQL with Prisma ORM
- **Auth** — Passport strategies (Google OAuth)
- **Testing** — Jest + Supertest (API), Vitest + React Testing Library (web), Vitest (CLI)
- **Observability** — OpenTelemetry, Uptrace, Pino structured logging
- **Runtime** — Docker Compose behind an Nginx same-origin reverse proxy

## Getting started

Prerequisites: Node.js >= 24, Docker Desktop (or another Docker Compose v2
engine), and Google OAuth credentials. PostgreSQL itself is provided by the
Compose stack — nothing to install separately.

```bash
git clone https://github.com/marinoscar/kvox.git
cd kvox
npm install
```

Generate a local `infra/compose/.env` — either the ergonomic way:

```bash
npm run setup
```

or explicitly:

```bash
cp infra/compose/.env.example infra/compose/.env
```

Either way, fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`
(minimum 32 characters) and `INITIAL_ADMIN_EMAIL` in `infra/compose/.env`.
Also set `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`) before you
store any runtime credential — an AssemblyAI key, an SMTP password, or a
user's own AI provider key. Then start the stack:

```bash
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up
```

| Surface | URL |
|---|---|
| Application | http://localhost:3535 |
| API reference (Scalar) | http://localhost:3535/api/docs |
| Uptrace (with the `otel` overlay) | http://localhost:14318 |

Add `-f otel.compose.yml` for observability, or swap `dev.compose.yml` for
`prod.compose.yml` for production mode.

The first sign-in from `INITIAL_ADMIN_EMAIL` bypasses the email allowlist and
becomes the Admin account.

## Command-line client

`kvox` is the first-party CLI. Install it with:

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/kvox/main/install.sh | bash
```

This builds `kvox` from the repo into `~/.kvox/app` and writes a shim to
`~/.local/bin/kvox`; re-running it is also how you update. Once installed,
`kvox` logs in through the device authorization flow, then exposes a
generic `kvox api <method> <path>` command so it never goes stale as
endpoints are added or renamed, plus subcommands for running a worker node
and deploying to a server (below). Full usage, install options and CI setup:
[`apps/cli/README.md`](apps/cli/README.md#install).

## Deploying

Deploying to a VPS is `kvox deploy doctor|install|update|status` — there
is no separate deploy script or Ansible playbook. Operator runbook:
[`docs/deployment/vps.md`](docs/deployment/vps.md); design rationale:
[`docs/specs/vps-deploy.md`](docs/specs/vps-deploy.md).

Attaching a worker node to offload eligible jobs (audio transcoding, backups)
from the API process is covered in
[`docs/deployment/worker-nodes.md`](docs/deployment/worker-nodes.md).

## Repository layout

```
kvox/
  apps/
    api/        Backend API, Prisma schema and migrations
    web/        React frontend
    cli/        First-party command-line client
  packages/
    shared/     Workspace package shared by api/web/cli
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

See [`docs/TESTING.md`](docs/TESTING.md) for the full testing strategy.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture rules and conventions for contributors
- [`VISION.md`](VISION.md) — product principle and direction
- [`CHANGELOG.md`](CHANGELOG.md) — released changes
- [`docs/API.md`](docs/API.md) — API reference
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — local development guide
- [`docs/SECURITY-ARCHITECTURE.md`](docs/SECURITY-ARCHITECTURE.md) — security model
- [`docs/TESTING.md`](docs/TESTING.md) — testing strategy
- [`docs/specs/`](docs/specs/) — design documents with rationale and rejected alternatives
- [`docs/runbooks/`](docs/runbooks/) — operator procedures
- [`docs/deployment/`](docs/deployment/) — deployment guides (VPS, worker nodes)
- [`docs/RENAMING.md`](docs/RENAMING.md) — rebranding this template for a new product
- [`apps/cli/README.md`](apps/cli/README.md) — CLI usage, install and CI setup
