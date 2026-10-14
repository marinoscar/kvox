# apps/cli rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply. This file is what to get right when editing `kvox`, the first-party CLI. Usage, flags, env vars and CI setup: [README.md](README.md), the source of truth; do not restate it.

## Layout

- `src/commands/` (`login`, `api`, `config` and more), `src/deploy/`, `src/tui/` (ink menu, real terminals only), `src/package-info.ts`.
- Built from this monorepo (`--workspace=cli`), not published.
- It logs in through the device authorization flow, stores the resulting personal access token, and exposes a generic `api <method> <path>` command so it never goes stale as endpoints change. Do not add per-endpoint commands for that.

## Version bump (every CLI improvement)

- The version lives ONLY in `apps/cli/package.json` (currently `1.8.0`). `src/package-info.ts` reads it at runtime and exports `CLI_VERSION`; never hardcode it or import `package.json` elsewhere (the file header says why).
- It is not cosmetic. `CLI_VERSION` is recorded as `appctlVersion` in a deployment's state file, as `deployedBy.version` in `deploy-info/info.json`, and sent as the User-Agent on every API request. A stale version makes two installs indistinguishable.
- PATCH by default (`1.8.0` to `1.8.1`). MINOR for a genuinely new user-facing capability (a new command or subcommand).
- One bump per PR, not per commit.
- Then run `npm install --package-lock-only` from the repo root: the `apps/cli` workspace entry in `package-lock.json` carries the version, and the bump is incomplete without it.
- Applies equally to `install.sh` and `apps/cli/bootstrap-vps.sh`, which install the CLI.

## Deploy and worker nodes

- VPS deployment lives entirely in the CLI: `kvox deploy doctor|install|uninstall|update|status|about|list|certs`. There is no separate deploy script or Ansible playbook; do not add one.
- Reference: [README: Deploying to a server](README.md#deploying-to-a-server), [README: Running a worker node](README.md#running-a-worker-node), design [vps-deploy.md](../../docs/specs/vps-deploy.md), runbook [vps.md](../../docs/deployment/vps.md), nodes [worker-nodes.md](../../docs/specs/worker-nodes.md). Extend those; do not restate them in code comments or docs elsewhere.
- `parseEnvExample` (`src/deploy/env-spec.ts`) reads ANY commented `# KEY=value` line of `infra/compose/.env.example` as an optional variable declaration. Document a value in prose, never as an illustrative commented assignment, or the env-spec test fails.
- API-side env vars are bare (`POSTGRES_*`, `JOBS_*`); the CLI's own take the `KVOX_` prefix.

Run: `npm run test:run --workspace=cli`, `npm run typecheck --workspace=cli`.
