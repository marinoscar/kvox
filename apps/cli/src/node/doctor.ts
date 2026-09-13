import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

import { CLI_NAME } from '../branding.js';
import { ApiError, NetworkError } from '../errors.js';
import { probeCapabilities, evaluateCapabilities, isWritable, type CapabilityProbe } from './capabilities.js';
import { PG_DUMP_COMMAND } from './pg-dump.js';
import { readLiveStatus } from './lifecycle.js';
import type { NodeApi } from './node-api.js';
import type { ResolvedNodeConfig } from './node-config.js';

// =============================================================================
// `node doctor`  (issue #276, epic #254)
// =============================================================================
//
// One command over THREE INDEPENDENT THINGS an operator routinely conflates:
//
//   1. local capabilities — can this machine do the work?
//   2. the server — can we reach it, and does it accept this credential?
//   3. the daemon — is a worker actually running here?
//
// They are independent by construction: a failure in one MUST NOT mask the
// others, because the common real-world case is two of them being wrong at
// once, and a doctor that stops at the first failure makes you run it three
// times to find that out.
//
// The most valuable distinction it draws is between "cannot reach the server"
// and "reached it and was refused". Those look identical in a stack trace and
// have completely different fixes — a firewall or a wrong URL on one side, a
// revoked credential or a missing permission on the other.
// =============================================================================

/** The type whose two extra dependencies this command checks (#352). */
const BACKUP_JOB_TYPE = 'db.backup.run';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  group: 'capabilities' | 'api' | 'daemon';
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Only present when there is something to do. */
  action?: string | undefined;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  probe: CapabilityProbe;
}

export interface DoctorOptions {
  config: ResolvedNodeConfig;
  socketPath: string;
  pidPath: string;
  stateDir: string;
  /** Injected so `doctor` needs neither a network nor a running daemon in tests. */
  api?: NodeApi | undefined;
  probe?: CapabilityProbe | undefined;
  readStatus?: typeof readLiveStatus | undefined;
  /**
   * `host[:port]` of the PostgreSQL server this node would dump, for the
   * reachability probe (#352).
   *
   * ⚠ AN ARGUMENT, NOT A STORED SETTING, AND DELIBERATELY SO. A worker node
   * holds NO database configuration: the connection arrives per job, from the
   * broker, and is dropped when the job settles (epic #345). Storing a host
   * here so `doctor` could find it would be the first line of exactly the
   * persisted-connection file this epic exists to not have. Absent means the
   * check is SKIPPED, not failed — an operator asks this question when they
   * are debugging offload, and nobody else should have to answer it.
   */
  databaseHost?: string | undefined;
  /** Seams, so the two probes below need neither `pg_dump` nor a socket in tests. */
  readPgDumpVersion?: (() => Promise<string | null>) | undefined;
  probeTcp?: ((host: string, port: number) => Promise<true | string>) | undefined;
}

/** How long the TCP probe waits before calling a host unreachable. */
export const TCP_PROBE_TIMEOUT_MS = 3_000;

/** The port assumed when `--db-host` names no port. */
export const DEFAULT_PG_PORT = 5432;

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const probe = options.probe ?? probeCapabilities();

  // ---- 1. Capabilities -------------------------------------------------------
  checks.push({
    id: 'runtime',
    group: 'capabilities',
    label: 'Node.js runtime',
    status: 'pass',
    detail: `${probe.nodeVersion} on ${probe.platform}/${probe.arch}, ${probe.cpus} CPU(s), ${probe.totalMemoryMb} MB RAM`,
  });

  const selfTest = evaluateCapabilities(options.config.node.eligibleTypes, probe);
  checks.push({
    id: 'job-capabilities',
    group: 'capabilities',
    label: 'Capabilities for the advertised job types',
    status: selfTest.ok ? (selfTest.missingDegradable.length > 0 ? 'warn' : 'pass') : 'fail',
    detail: selfTest.ok
      ? selfTest.missingDegradable.length > 0
        ? `Reduced function: ${selfTest.missingDegradable.map((gap) => `${gap.capability} (${gap.type})`).join(', ')}`
        : 'Every advertised type has what it needs'
      : `Missing: ${selfTest.missingRequired.map((gap) => `${gap.capability} (${gap.type})`).join(', ')}`,
    action: selfTest.ok
      ? undefined
      : `Install the missing dependencies, or drop those types with \`${CLI_NAME} node register --types ...\`.`,
  });

  // ---- 1b. The database backup type's two dependencies (#352) -----------------
  //
  // ⚠ BOTH ARE WARNINGS, NEVER FAILURES, and that is the whole design of this
  // pair. A node that cannot reach the database, or has no `pg_dump`, simply
  // MUST NOT DECLARE `db.backup.run` — which `evaluateCapabilities` above
  // already enforces for the binary, and which an operator enforces for the
  // network by not asking for the type. Failing `doctor` over either would tell
  // every node in a fleet that it is broken because it is not the one taking
  // backups, which is the ordinary case: most nodes will never run this type.
  checks.push(...(await checkBackupDependencies(options, probe)));

  checks.push({
    id: 'state-dir',
    group: 'capabilities',
    label: 'State directory is writable',
    status: isWritable(options.stateDir) ? 'pass' : 'warn',
    detail: options.stateDir,
    action: isWritable(options.stateDir)
      ? undefined
      : 'The worker will still run, but cannot persist its node id, logs or heap snapshots.',
  });

  // ---- 2. The server ---------------------------------------------------------
  // Each API check is separate, and a failure in one does not skip the rest.
  if (options.api === undefined) {
    checks.push({
      id: 'api-auth',
      group: 'api',
      label: 'Server reachable and credential accepted',
      status: 'skip',
      detail: 'No API client was supplied',
    });
  } else {
    const auth = await checkApi(options.api, options.config);
    checks.push(...auth);
  }

  // ---- 3. The daemon ---------------------------------------------------------
  const readStatus = options.readStatus ?? readLiveStatus;
  const status = await readStatus({ socketPath: options.socketPath, pidPath: options.pidPath, timeoutMs: 1_000 });
  checks.push({
    id: 'daemon',
    group: 'daemon',
    label: 'Worker running on this machine',
    status: status.live ? 'pass' : 'warn',
    detail: status.live
      ? `Running (${status.snapshot?.status}, concurrency ${status.snapshot?.concurrency}, ` +
        `${status.snapshot?.activeJobs.length ?? 0} active)`
      : status.pid !== undefined
        ? `A process (pid ${status.pid}) holds the pidfile but is not answering on the control socket`
        : 'No worker is running here',
    action: status.live ? undefined : `Start one with \`${CLI_NAME} node start\`.`,
  });

  return { checks, ok: checks.every((check) => check.status !== 'fail'), probe };
}

/**
 * Reachability, authentication and authorization — as THREE ANSWERS, not one.
 *
 * `GET /api/nodes` rather than `/api/auth/me`, deliberately: a `nod_`
 * credential is refused everywhere outside `/api/nodes/*`, so probing
 * `/auth/me` would report a perfectly good worker credential as forbidden and
 * send the operator to fix something that is working exactly as designed.
 */
async function checkApi(api: NodeApi, config: ResolvedNodeConfig): Promise<DoctorCheck[]> {
  try {
    await api.listNodes();
  } catch (error) {
    if (error instanceof NetworkError) {
      return [
        {
          id: 'api-reachable',
          group: 'api',
          label: 'Server reachable',
          status: 'fail',
          detail: `Could not reach ${config.serverUrl}: ${error.message}`,
          action: 'Check the URL, DNS, and whether anything is blocking outbound HTTPS from this machine.',
        },
      ];
    }

    if (error instanceof ApiError) {
      // REACHED IT AND WAS REFUSED — a completely different fix from the above.
      const status: CheckStatus = 'fail';
      if (error.status === 401) {
        return [
          reachable(config),
          {
            id: 'api-auth',
            group: 'api',
            label: 'Credential accepted',
            status,
            detail: 'The server rejected this credential (401). It may be revoked, expired, or from another server.',
            action: `Run \`${CLI_NAME} node enroll\` to mint a new node credential.`,
          },
        ];
      }
      if (error.status === 403) {
        return [
          reachable(config),
          {
            id: 'api-permission',
            group: 'api',
            label: 'Credential has the node permissions',
            status,
            detail: 'Authenticated, but refused (403) — the account is missing `nodes:read`/`nodes:write`.',
            action: 'Ask an administrator to grant the node permissions to this account.',
          },
        ];
      }
      if (error.status === 404) {
        return [
          reachable(config),
          {
            id: 'api-support',
            group: 'api',
            label: 'Server supports worker nodes',
            status,
            detail: `${config.serverUrl} has no /api/nodes routes (404) — it predates worker nodes.`,
            action: 'Upgrade the server.',
          },
        ];
      }
      return [
        reachable(config),
        {
          id: 'api-auth',
          group: 'api',
          label: 'Credential accepted',
          status,
          detail: `The server answered ${error.status}: ${error.message}`,
        },
      ];
    }

    return [
      {
        id: 'api-reachable',
        group: 'api',
        label: 'Server reachable',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }

  return [
    reachable(config),
    {
      id: 'api-auth',
      group: 'api',
      label: 'Credential accepted',
      status: 'pass',
      detail: `Authenticated against ${config.serverUrl} (token from ${config.tokenSource}).`,
    },
  ];
}

/**
 * The two things `db.backup.run` needs that nothing else does: a client, and a
 * route to the database.
 *
 * Reported whether or not this node declares the type, because the question an
 * operator has is usually "COULD this node take the backups?" — and answering
 * it requires running the checks on a node that does not yet declare it. The
 * detail line says which case the reader is in.
 */
async function checkBackupDependencies(
  options: DoctorOptions,
  probe: CapabilityProbe,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const declared = options.config.node.eligibleTypes.includes(BACKUP_JOB_TYPE);

  const version = probe.binaries[PG_DUMP_COMMAND] === true
    ? await readVersion(options)
    : null;

  checks.push({
    id: 'pg-dump',
    group: 'capabilities',
    label: 'PostgreSQL client (database backups)',
    status: version !== null ? 'pass' : 'warn',
    detail:
      version !== null
        ? version
        : `No usable \`${PG_DUMP_COMMAND}\` on PATH${declared ? ' — but this node declares ' + BACKUP_JOB_TYPE : ''}`,
    ...(version !== null
      ? {}
      : {
          action: declared
            ? `Install a postgresql-client package, or drop ${BACKUP_JOB_TYPE} from this node's --types.`
            : `Only needed to run ${BACKUP_JOB_TYPE}, which this node does not declare.`,
        }),
  });

  // ⚠ A VERSION MISMATCH IS NOT CHECKED HERE, and cannot be: comparing the
  // client against the server needs a connection to the server, which needs
  // the credential this node deliberately does not hold outside a job. The
  // SERVER performs that comparison (`pg-version.util.ts`) and refuses to
  // enqueue a dump it knows cannot succeed; `docs/runbooks/postgres-client-
  // version.md` is the diagnosis when it does.

  if (options.databaseHost === undefined || options.databaseHost.length === 0) {
    checks.push({
      id: 'database-reachable',
      group: 'capabilities',
      label: 'Database reachable from here',
      status: 'skip',
      detail: 'No --db-host was given, and a node stores no database connection of its own',
      action: `Run \`${CLI_NAME} node doctor --db-host db.internal:5432\` to test the route.`,
    });

    return checks;
  }

  const { host, port } = splitHostPort(options.databaseHost);
  const outcome = await (options.probeTcp ?? probeTcp)(host, port);

  checks.push({
    id: 'database-reachable',
    group: 'capabilities',
    label: 'Database reachable from here',
    status: outcome === true ? 'pass' : 'warn',
    detail:
      outcome === true
        ? `TCP connect to ${host}:${port} succeeded`
        : `Could not reach ${host}:${port}: ${outcome}`,
    ...(outcome === true
      ? {}
      : {
          // Not a failure: this is the documented reason a deployment leaves
          // node offload off. `docs/specs/worker-nodes.md` is explicit that
          // there is no tunnelling — a node needs a real network route, which
          // for most deployments means sitting inside the same private network.
          action:
            `A node that cannot reach the database must not declare ${BACKUP_JOB_TYPE}. ` +
            'Put this node on the database’s network, or leave node offload off and let the ' +
            'server take its own backups.',
        }),
  });

  return checks;
}

/** `pg_dump --version`, bounded and never throwing. */
async function readVersion(options: DoctorOptions): Promise<string | null> {
  if (options.readPgDumpVersion !== undefined) return options.readPgDumpVersion();

  try {
    const { stdout } = await promisify(execFile)(PG_DUMP_COMMAND, ['--version'], {
      timeout: TCP_PROBE_TIMEOUT_MS,
    });

    const line = stdout.split('\n')[0]?.trim() ?? '';

    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/**
 * One TCP connect, or the reason it failed.
 *
 * A BARE TCP CONNECT, not a PostgreSQL handshake: the question is whether a
 * route and a listening port exist, and answering it needs no protocol, no
 * credential and no `pg` client. A server that answers the connect and then
 * refuses the login is a credential problem, which is the broker's business
 * and not this machine's.
 */
async function probeTcp(host: string, port: number): Promise<true | string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (outcome: true | string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => finish(`no answer within ${TCP_PROBE_TIMEOUT_MS}ms`));
    socket.once('connect', () => finish(true));
    socket.once('error', (error: Error) => finish(error.message));
  });
}

/** `host`, `host:port`, or a bracketed IPv6 literal. */
export function splitHostPort(value: string): { host: string; port: number } {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(value);

  if (bracketed !== null) {
    return { host: bracketed[1] as string, port: Number(bracketed[2] ?? DEFAULT_PG_PORT) };
  }

  const index = value.lastIndexOf(':');

  // A bare IPv6 address contains colons and no port. Only a SINGLE trailing
  // colon-number is a port; anything else is the host, whole.
  if (index === -1 || value.indexOf(':') !== index) {
    return { host: value, port: DEFAULT_PG_PORT };
  }

  const port = Number(value.slice(index + 1));

  return Number.isInteger(port) && port > 0 && port < 65536
    ? { host: value.slice(0, index), port }
    : { host: value, port: DEFAULT_PG_PORT };
}

function reachable(config: ResolvedNodeConfig): DoctorCheck {
  return {
    id: 'api-reachable',
    group: 'api',
    label: 'Server reachable',
    status: 'pass',
    detail: config.serverUrl,
  };
}

const SYMBOL: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗', skip: '·' };

/** Render the report as a table. Human output, so it goes to stderr. */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.label.length));
  const lines: string[] = [];
  let group: DoctorCheck['group'] | '' = '';

  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push('', GROUP_TITLES[group]);
    }
    lines.push(`  ${SYMBOL[check.status]} ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.action !== undefined) lines.push(`  ${' '.repeat(width + 3)}→ ${check.action}`);
  }

  lines.push('', report.ok ? 'No blocking problems found.' : 'At least one check failed.');
  return `${lines.join('\n')}\n`;
}

const GROUP_TITLES: Record<DoctorCheck['group'], string> = {
  capabilities: 'This machine',
  api: 'The server',
  daemon: 'The worker',
};
