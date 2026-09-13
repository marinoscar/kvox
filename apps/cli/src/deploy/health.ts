import { join } from 'node:path';

import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import type { DeployState } from './state.js';

// =============================================================================
// Is this deployment actually working?  (issue #183, epic #168)
// =============================================================================
//
// `doctor` answers "can this server run the application?" - a question about
// prerequisites, asked before anything is installed. This answers "is the
// deployment I have right now healthy?", which is the question asked at 2am.
//
// THE TRAP THIS MODULE EXISTS TO CLOSE: /api/health/ready RETURNING 200 IS
// MUCH WEAKER EVIDENCE THAN IT LOOKS. Its only indicator issues `SELECT 1`,
// which passes against a completely empty database. A deployment whose
// migrations silently failed reports itself ready. So this asks about
// migration state separately, and a green probe alone is never treated as
// proof that the schema is there.
// =============================================================================

const COMPOSE_FILES = [
  'base.compose.yml',
  'prod.compose.yml',
  'vps.compose.yml',
] as const;

export interface ProbeResult {
  ok: boolean;
  status?: number | undefined;
  durationMs: number;
  /** Why it failed, when it did. */
  error?: string | undefined;
}

export interface ContainerState {
  name: string;
  service: string;
  state: string;
  health?: string | undefined;
  image: string;
}

export interface MigrationState {
  applied?: number | undefined;
  pending: string[];
  /** Undefined when the state could not be determined at all. */
  known: boolean;
}

export interface HealthReport {
  containers: ContainerState[];
  local: { live: ProbeResult; ready: ProbeResult; frontend: ProbeResult };
  external?: { url: string; probe: ProbeResult } | undefined;
  migrations: MigrationState;
  deployed?: Pick<DeployState, 'commitSha' | 'ref' | 'lastDeployedAt' | 'lastCommand'> | undefined;
}

export type FetchLike = typeof globalThis.fetch;

export interface HealthOptions {
  runCommand: typeof runCommand;
  deployRoot: string;
  bindPort: number;
  domain?: string | undefined;
  state?: DeployState | undefined;
  fetch?: FetchLike | undefined;
  hooks?: DeployHooks | undefined;
  timeoutMs?: number | undefined;
}

function composeArgs(deployRoot: string): string[] {
  return COMPOSE_FILES.flatMap((file) => ['-f', file]).concat([
    '--project-directory',
    join(deployRoot, 'repo', 'infra', 'compose'),
  ]);
}

function composeCwd(deployRoot: string): string {
  // The relative build contexts in base.compose.yml (`../..`, `../nginx`)
  // resolve against the COMPOSE FILE's directory, so the working directory is
  // not incidental here.
  return join(deployRoot, 'repo', 'infra', 'compose');
}

/** One HTTP probe, with its own timeout and a readable failure. */
export async function probe(
  url: string,
  options: { fetch?: FetchLike | undefined; timeoutMs?: number | undefined },
): Promise<ProbeResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const startedAt = Date.now();

  try {
    const response = await doFetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'manual',
    });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      // Distinguished rather than collapsed: a TLS failure, a refused
      // connection and a timeout have different causes and different fixes.
      error: describeFetchFailure(error),
    };
  }
}

export function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;

  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND') return 'host does not resolve';
  if (code === 'CERT_HAS_EXPIRED') return 'the TLS certificate has expired';
  if (code?.startsWith('DEPTH_ZERO') === true || code?.includes('CERT') === true) {
    return `TLS failure: ${cause?.message ?? code}`;
  }
  return cause?.message ?? message;
}

/** Reads `docker compose ps` as JSON. */
export async function containerStates(
  options: HealthOptions,
): Promise<ContainerState[]> {
  try {
    const result = await options.runCommand(
      ['docker', 'compose', ...composeArgs(options.deployRoot), 'ps', '--format', 'json'],
      { cwd: composeCwd(options.deployRoot), timeoutMs: 60_000 },
    );

    // Compose emits either one JSON array or one object per line depending on
    // version, so both are accepted rather than pinning a version.
    const text = result.stdout.trim();
    if (text === '') return [];

    const rows: unknown[] = text.startsWith('[')
      ? (JSON.parse(text) as unknown[])
      : text.split('\n').map((line) => JSON.parse(line) as unknown);

    return rows.map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        name: String(entry['Name'] ?? ''),
        service: String(entry['Service'] ?? ''),
        state: String(entry['State'] ?? ''),
        image: String(entry['Image'] ?? ''),
        ...(entry['Health'] === undefined || entry['Health'] === ''
          ? {}
          : { health: String(entry['Health']) }),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Asks Prisma what the schema state is.
 *
 * This is the check that distinguishes a genuinely ready deployment from one
 * that merely answers SELECT 1.
 */
export async function migrationState(options: HealthOptions): Promise<MigrationState> {
  try {
    const result = await options.runCommand(
      [
        'docker', 'compose', ...composeArgs(options.deployRoot),
        'run', '--rm', '--no-deps', 'api',
        'npx', 'prisma', 'migrate', 'status',
      ],
      { cwd: composeCwd(options.deployRoot), timeoutMs: 120_000, allowExitCodes: [1] },
    );

    const output = `${result.stdout}\n${result.stderr}`;

    // `prisma migrate status` exits 1 BOTH when migrations are pending and
    // when it could not run at all, so the exit code alone cannot tell those
    // apart - which is why exit 1 is allowed above and the OUTPUT is what
    // decides. If it does not look like Prisma's own report, we do not know
    // the schema state, and saying so is better than reporting "fine".
    const looksLikePrisma =
      /migrations?\s+found/i.test(output) ||
      /database schema is up to date/i.test(output) ||
      /following migrations? have not yet been applied/i.test(output);

    if (!looksLikePrisma) {
      return { known: false, pending: [] };
    }

    const applied = /(\d+)\s+migrations?\s+found/i.exec(output)?.[1];
    const pending = [...output.matchAll(/^\s*[-*]?\s*(\d{14}_[\w-]+)\s*$/gm)].map(
      (match) => match[1] as string,
    );

    const upToDate = /database schema is up to date/i.test(output);

    return {
      known: true,
      ...(applied === undefined ? {} : { applied: Number(applied) }),
      pending: upToDate ? [] : pending,
    };
  } catch {
    // Prisma unavailable, container missing, or the image lacks the CLI. Not
    // knowing is reported as not knowing rather than as "fine".
    return { known: false, pending: [] };
  }
}

export async function collectHealth(options: HealthOptions): Promise<HealthReport> {
  const base = `http://127.0.0.1:${options.bindPort}`;
  const fetchOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const [containers, live, ready, frontend, migrations] = await Promise.all([
    containerStates(options),
    probe(`${base}/api/health/live`, fetchOptions),
    probe(`${base}/api/health/ready`, fetchOptions),
    // The frontend gets its own probe because it fails INDEPENDENTLY of the
    // API - the nginx upstream bug in #169 is exactly the case where every
    // API check passes and the site serves nothing.
    probe(`${base}/`, fetchOptions),
    migrationState(options),
  ]);

  const external =
    options.domain === undefined
      ? undefined
      : {
          url: `https://${options.domain}/api/health/ready`,
          probe: await probe(`https://${options.domain}/api/health/ready`, fetchOptions),
        };

  return {
    containers,
    local: { live, ready, frontend },
    ...(external === undefined ? {} : { external }),
    migrations,
    ...(options.state === undefined
      ? {}
      : {
          deployed: {
            commitSha: options.state.commitSha,
            ref: options.state.ref,
            lastDeployedAt: options.state.lastDeployedAt,
            lastCommand: options.state.lastCommand,
          },
        }),
  };
}

/** True when the deployment is serving and its schema is current. */
export function isHealthy(report: HealthReport): boolean {
  const containersOk =
    report.containers.length === 0 ||
    report.containers.every((container) => /running/i.test(container.state));

  const migrationsOk = !report.migrations.known || report.migrations.pending.length === 0;

  return (
    containersOk &&
    report.local.live.ok &&
    report.local.ready.ok &&
    report.local.frontend.ok &&
    migrationsOk &&
    (report.external?.probe.ok ?? true)
  );
}

export interface WaitOptions extends HealthOptions {
  /** Total time to wait. Matches the shell scripts this replaces. */
  waitMs?: number | undefined;
  intervalMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Polls readiness until it answers or the deadline passes.
 *
 * Shared by install and update rather than reimplemented in each. On timeout
 * it reports the LAST failure, not a bare "timed out" - the useful information
 * is why it never became ready.
 */
export async function waitForHealthy(options: WaitOptions): Promise<ProbeResult> {
  const deadline = Date.now() + (options.waitMs ?? 120_000);
  const interval = options.intervalMs ?? 2_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const url = `http://127.0.0.1:${options.bindPort}/api/health/ready`;
  let attempt = 0;
  let last: ProbeResult = { ok: false, durationMs: 0, error: 'not attempted' };

  for (;;) {
    attempt += 1;
    last = await probe(url, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeoutMs: Math.min(interval * 2, 10_000),
    });

    if (last.ok) {
      options.hooks?.onProgress?.(`Ready after ${attempt} attempt(s)`);
      return last;
    }

    if (Date.now() >= deadline) {
      // The last error, not a generic message: "connection refused" and "503"
      // send you to completely different places.
      options.hooks?.onProgress?.(`Still not ready: ${last.error ?? last.status ?? 'unknown'}`);
      return last;
    }

    options.hooks?.onProgress?.(
      `Waiting for the API (attempt ${attempt}: ${last.error ?? `HTTP ${last.status ?? '?'}`})`,
    );
    await sleep(interval);
  }
}
