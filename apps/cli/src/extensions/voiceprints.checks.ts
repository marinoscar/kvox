import { totalmem } from 'node:os';

import { CLI_NAME } from '@app/shared';
import type { DeployCheck, DeployCheckContext, DeployCheckResult } from '@marinoscar/platform-cli/deploy';

import {
  VOICEPRINT_MODEL_SCRIPT,
  execInContainer,
  findApiContainer,
  lastJsonLine,
  runDocker,
  type DockerRun,
} from './api-container.js';
import {
  EGRESS_PROBE_TIMEOUT_MS,
  VOICEPRINT_DOWNLOAD_HOSTS,
  VOICEPRINT_MODEL_URL,
  VOICEPRINT_REQUIRED_HOSTS,
  containerEgressArgv,
  hostEgressProbe,
  type EgressProbe,
} from './voiceprint-egress.js';

// =============================================================================
// Doctor checks for the speaker voiceprint feature  (issue #831)
// =============================================================================
//
// Voice matching needs five things a deploy used to leave unchecked: a route to the
// model's download host, enough API memory for the embedder worker (~300 MB), the
// pgvector extension in the application database, ffmpeg in the image, and the model
// itself on disk. Each is one `DeployCheck`; all are `recommended` (advice) except
// `pgvector-extension`, which is `required` but SKIPS whenever no api container is
// running, so a fresh install is never blocked by it.
//
// Every check that needs the container skips, never fails, when Docker cannot be asked
// or no api container of THIS deployment runs: the `docker-daemon` check owns the first,
// and the second is the normal state of a host before install. Docker and the host
// probes are injectable (`VoiceprintCheckDeps`) so the tests never shell out.
// =============================================================================

/** Every check that execs into the container shares this budget for the command itself. */
const EXEC_TIMEOUT_MS = 20_000;

/** The seams of the checks. */
export interface VoiceprintCheckDeps {
  run: DockerRun;
  hostProbe: EgressProbe;
  /** Physical memory of the host in bytes. */
  hostMemoryBytes: () => number;
}

const DEFAULT_DEPS: VoiceprintCheckDeps = { run: runDocker, hostProbe: hostEgressProbe, hostMemoryBytes: totalmem };

/** The API memory limit the overlay applies when `.env` sets none (`app.prod.memory-limits.compose.yml`). */
export const DEFAULT_API_MEM_LIMIT = '1G';

/** Below this the embedder worker (~300 MB) plus the API itself risk an out-of-memory kill. */
export const MIN_API_MEMORY_BYTES = 1024 ** 3;

/** Above this share of host RAM the limit leaves the host, the database and the proxy too little. */
export const MAX_API_MEMORY_SHARE = 0.75;

/** A Docker size (`512M`, `1g`, `2048m`, `1073741824`) as bytes; undefined when unparsable. */
export function parseMemorySize(value: string): number | undefined {
  const match = /^(\d+)([kmg]?)b?$/i.exec(value.trim());
  if (match === null) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  return Number(match[1]) * factor;
}

function mebibytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function apiQuery(context: DeployCheckContext) {
  return { deployRoot: context.deployRoot, composeProject: context.composeProject };
}

const SKIP_NO_API = (reason: string): DeployCheckResult => ({ status: 'skip', detail: reason });

/** Builds the five checks over the given seams. */
export function createVoiceprintChecks(deps: VoiceprintCheckDeps = DEFAULT_DEPS): DeployCheck[] {
  const { run } = deps;

  const egress: DeployCheck = {
    id: 'voiceprint-model-egress',
    title: 'Voice model download reachable',
    severity: 'recommended',
    async run(context) {
      const problems: string[] = [];
      const reached: string[] = [];

      const host = await deps.hostProbe(VOICEPRINT_MODEL_URL, VOICEPRINT_DOWNLOAD_HOSTS, EGRESS_PROBE_TIMEOUT_MS);
      if (host.ok) reached.push('the host');
      else problems.push(`the host cannot reach it (${host.reason ?? 'unknown'})`);

      const container = await findApiContainer(apiQuery(context), run);
      if (container.kind === 'found') {
        const result = await execInContainer(container.id, containerEgressArgv(), EGRESS_PROBE_TIMEOUT_MS + 10_000, run);
        const verdict = lastJsonLine(result.stdout) as { ok?: unknown; reason?: unknown } | undefined;
        if (verdict?.ok === true) reached.push('the api container');
        else if (verdict === undefined) problems.push('the api container could not run the probe');
        else problems.push(`the api container cannot reach it (${typeof verdict.reason === 'string' ? verdict.reason : 'unknown'})`);
      }

      if (problems.length > 0) {
        return {
          status: 'warn',
          detail: problems.join('; '),
          remedy: `Allow outbound HTTPS to ${VOICEPRINT_REQUIRED_HOSTS} (the model is about 30 MB, checked against a pinned SHA-256), or voice matching stays unavailable.`,
        };
      }
      return {
        status: 'pass',
        detail: `reachable from ${reached.join(' and ')}${container.kind === 'found' ? '' : ' (the api container is not running)'}`,
      };
    },
  };

  const memory: DeployCheck = {
    id: 'api-memory-limit',
    title: 'API memory limit',
    severity: 'recommended',
    async run(context) {
      if (context.env === undefined) {
        return SKIP_NO_API(`no environment yet; a new deployment defaults to ${DEFAULT_API_MEM_LIMIT}`);
      }
      const configured = context.env.get('API_MEM_LIMIT');
      const raw = configured !== undefined && configured.trim() !== '' ? configured.trim() : DEFAULT_API_MEM_LIMIT;
      const bytes = parseMemorySize(raw);
      if (bytes === undefined) {
        return {
          status: 'warn',
          detail: `API_MEM_LIMIT is "${raw}", which is not a size`,
          remedy: `Set API_MEM_LIMIT to a size such as 1G in ${context.deployRoot}/repo/infra/compose/.env and run ${CLI_NAME} deploy update --force`,
        };
      }
      const ram = deps.hostMemoryBytes();
      if (bytes < MIN_API_MEMORY_BYTES) {
        return {
          status: 'warn',
          detail: `${raw} is below the recommended 1G: the speaker voiceprint embedder adds about 300 MB on top of the API`,
          remedy: `Set API_MEM_LIMIT=1G in ${context.deployRoot}/repo/infra/compose/.env and run ${CLI_NAME} deploy update --force`,
        };
      }
      if (ram > 0 && bytes > ram * MAX_API_MEMORY_SHARE) {
        return {
          status: 'warn',
          detail: `${raw} is more than ${Math.round(MAX_API_MEMORY_SHARE * 100)}% of this host's ${mebibytes(ram)} of RAM`,
          remedy: `Lower API_MEM_LIMIT in ${context.deployRoot}/repo/infra/compose/.env so the database, proxy and OS keep headroom, then run ${CLI_NAME} deploy update --force`,
        };
      }
      return { status: 'pass', detail: `${raw}${configured === undefined || configured.trim() === '' ? ' (the default)' : ''}` };
    },
  };

  const pgvector: DeployCheck = {
    id: 'pgvector-extension',
    title: 'pgvector extension',
    severity: 'required',
    requires: ['docker-daemon'],
    async run(context) {
      const container = await findApiContainer(apiQuery(context), run);
      if (container.kind !== 'found') return SKIP_NO_API(`${container.reason}; nothing to check yet`);

      const result = await execInContainer(container.id, ['node', '-e', PGVECTOR_SCRIPT], EXEC_TIMEOUT_MS, run);
      const report = lastJsonLine(result.stdout) as { ok?: unknown; available?: unknown; installed?: unknown; error?: unknown } | undefined;
      if (report === undefined || report.ok !== true) {
        const why = typeof report?.error === 'string' ? ` (${report.error})` : '';
        return SKIP_NO_API(`the database could not be queried from the api container${why}`);
      }
      if (report.installed === true) return { status: 'pass', detail: 'installed in the application database' };
      return {
        status: 'fail',
        detail:
          report.available === true
            ? 'available on the server but not installed in the application database'
            : 'not available on the database server (the server image has no pgvector)',
        remedy:
          'Run CREATE EXTENSION IF NOT EXISTS vector; as a superuser in the application database (a pgvector-enabled Postgres image is needed first when it is not available); ' +
          'see docs/runbooks/application-role.md',
      };
    },
  };

  const ffmpeg: DeployCheck = {
    id: 'api-ffmpeg',
    title: 'ffmpeg in the API container',
    severity: 'recommended',
    requires: ['docker-daemon'],
    async run(context) {
      const container = await findApiContainer(apiQuery(context), run);
      if (container.kind !== 'found') return SKIP_NO_API(container.reason);
      const result = await execInContainer(container.id, ['ffmpeg', '-version'], EXEC_TIMEOUT_MS, run);
      if (result.exitCode === 0) {
        const firstLine = result.stdout.split('\n')[0]?.trim() ?? '';
        return { status: 'pass', detail: firstLine.length > 0 ? firstLine.slice(0, 80) : 'present' };
      }
      return {
        status: 'warn',
        detail: 'ffmpeg is missing or does not run in the api container; voice matching decodes audio with it',
        remedy: `Rebuild the image: ${CLI_NAME} deploy update --force (the production Dockerfile installs ffmpeg)`,
      };
    },
  };

  const modelCache: DeployCheck = {
    id: 'voiceprint-model-cache',
    title: 'Voice model cached',
    severity: 'recommended',
    requires: ['docker-daemon'],
    async run(context) {
      const container = await findApiContainer(apiQuery(context), run);
      if (container.kind !== 'found') return SKIP_NO_API(container.reason);
      const result = await execInContainer(container.id, ['node', VOICEPRINT_MODEL_SCRIPT, 'status'], EXEC_TIMEOUT_MS, run);
      const report = lastJsonLine(result.stdout) as { installed?: unknown; dir?: unknown } | undefined;
      if (result.exitCode !== 0 || report === undefined || typeof report.installed !== 'boolean') {
        return {
          status: 'warn',
          detail: 'the model status could not be read from the api container',
          remedy: `Run ${CLI_NAME} deploy update --force to rebuild the image and install the model`,
        };
      }
      if (report.installed) {
        return { status: 'pass', detail: `installed${typeof report.dir === 'string' ? ` in ${report.dir}` : ''}` };
      }
      return {
        status: 'warn',
        detail: 'not installed yet',
        remedy: `Run ${CLI_NAME} deploy update --force to install it now, or leave it: the first voice job downloads it (needs egress to ${VOICEPRINT_REQUIRED_HOSTS})`,
      };
    },
  };

  return [egress, memory, pgvector, ffmpeg, modelCache];
}

/**
 * Asks the application database about pgvector from inside the api container, with
 * the connection built the way `scripts/prisma-env.js` builds it (`DATABASE_URL` wins,
 * else the `POSTGRES_*` pieces). Prints one JSON line; an error carries only a code or
 * name, never a message (a message can echo a connection string).
 */
export const PGVECTOR_SCRIPT = `
const { Client } = require('pg');
const e = process.env;
const url = e.DATABASE_URL || ('postgresql://' + encodeURIComponent(e.POSTGRES_USER || 'postgres') + ':' + encodeURIComponent(e.POSTGRES_PASSWORD || 'postgres') + '@' + (e.POSTGRES_HOST || 'localhost') + ':' + (e.POSTGRES_PORT || '5432') + '/' + (e.POSTGRES_DB || 'appdb') + (e.POSTGRES_SSL === 'true' ? '?sslmode=require' : ''));
const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
const out = (v) => { console.log(JSON.stringify(v)); };
c.connect()
  .then(() => c.query("SELECT (SELECT count(*)::int FROM pg_available_extensions WHERE name = 'vector') AS available, (SELECT count(*)::int FROM pg_extension WHERE extname = 'vector') AS installed"))
  .then((r) => { out({ ok: true, available: r.rows[0].available > 0, installed: r.rows[0].installed > 0 }); return c.end(); })
  .catch((x) => { out({ ok: false, error: String((x && (x.code || x.name)) || 'error') }); process.exit(0); });
`;

/** The checks `createCli({ deployChecks })` registers. */
export const voiceprintChecks: DeployCheck[] = createVoiceprintChecks();
