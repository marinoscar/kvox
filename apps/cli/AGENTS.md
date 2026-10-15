# apps/cli rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply. This file is what to get right when editing the `kvox` CLI. Usage, install, flags, environment variables and CI setup: [README.md](README.md), the source of truth; do not restate it elsewhere.

## Layout

- `src/commands/`: `login`, `api`, `config`, `deploy`, `node`, `init` subcommands (Commander). `src/tui/`: interactive ink menu (real terminals only). `src/deploy/`, `src/node/`: the VPS deploy and worker-node engines.
- The CLI is a workspace package (`--workspace=cli`), built from this monorepo and not published. It logs in through the device authorization flow, stores a personal access token, and exposes one generic `api <method> <path>` command so it does not go stale as endpoints change.
- CLI environment variables take the `KVOX_` prefix; API-side variables never do.

## Version bump (root rule: CLI Version Bump on Improvement)

- The version lives **only** in `apps/cli/package.json` (today `1.8.0`). `src/package-info.ts` reads it at runtime and exports `CLI_VERSION`; never hardcode it or import `package.json` elsewhere (see that file's header).
- `CLI_VERSION` is recorded as `appctlVersion` in a deployment's state file, as `deployedBy.version` in `deploy-info/info.json`, and sent as the User-Agent on every API request. A stale version makes two installs indistinguishable in a deployment record.
- PATCH for an improvement or a set shipped together; MINOR for a new command or subcommand; **one bump per PR**. Then `npm install --package-lock-only` (the lockfile's `apps/cli` entry carries the version).
- Applies to `apps/cli`, `install.sh` and `apps/cli/bootstrap-vps.sh`. Adding only docs such as this file is not a CLI improvement.

## Deploying to a VPS

VPS deployment lives entirely in this CLI as `kvox deploy doctor|install|uninstall|update|status|about|list|certs`. There is no separate deploy script or Ansible playbook, and there should not be.

- Command reference: [README.md#deploying-to-a-server](README.md#deploying-to-a-server); worker nodes: [README.md#running-a-worker-node](README.md#running-a-worker-node).
- Design, `deploy-info/info.json` schema, what `uninstall` refuses to remove (shared `devnet` network, shared proxy, TLS certificates by default), and how `update` adopts a deployment with no state file: [docs/specs/vps-deploy.md](../../docs/specs/vps-deploy.md) §18, §19, §21, §23. Operator runbook: [docs/deployment/vps.md](../../docs/deployment/vps.md). Extend those three instead of restating them.
- Worker nodes: [docs/specs/worker-nodes.md](../../docs/specs/worker-nodes.md), [docs/deployment/worker-nodes.md](../../docs/deployment/worker-nodes.md).

## Rules

- **`parseEnvExample` reads any commented `# KEY=value` line** in `infra/compose/.env.example` as a declared optional variable. Never add an illustrative commented assignment there; `# MAINTENANCE_MODE=false` is the one allowed. A second one fails the CLI's env-spec test.
- A node never persists a job-scoped credential (root queue rule 3); only its own `nod_` identity token is stored.
- Server-only artifacts (exports, PDFs) are rendered by the API, never by the CLI; a second copy would diverge.
- A behaviour change carries tests in the same or the next commit.

Run: `npm run test:run --workspace=cli`, `npm run typecheck --workspace=cli`.
