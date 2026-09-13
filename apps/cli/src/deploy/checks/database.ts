import { connect } from 'node:net';

import type { Check, CheckContext, CheckResult } from './types.js';

// =============================================================================
// The database this deployment points at  (issue #177, epic #168)
// =============================================================================
//
// This application has no PostgreSQL of its own - base.compose.yml declares no
// `db` service - so every deployment points at an external instance. Wrong
// host, wrong password, missing database and a pg_hba.conf that does not
// permit the connection all present IDENTICALLY from the outside: a container
// that starts, passes liveness, and cannot serve a request.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT
//
//   1. NO CONNECTION STRING IS EVER BUILT OR REPORTED. psql is given -h/-p/-U
//      /-d as separate arguments and the password through PGPASSWORD, so there
//      is no URL to leak into a detail, a remedy or a journal line. Host, port,
//      user and database name are reported; the password never is.
//   2. THE FAILURE MODES ARE KEPT APART. "Connection refused", 28P01 (bad
//      credentials) and 3D000 (no such database) have three different causes
//      and three different fixes. Collapsing them into "cannot connect" throws
//      away the only useful information the attempt produced.
// =============================================================================

/** Pinned to the version CI runs its Postgres service container on. */
const PSQL_IMAGE = 'postgres:16-alpine';

const CONNECT_TIMEOUT_MS = 5_000;

interface DatabaseSettings {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

/** Reads the POSTGRES_* values the deployment will actually use. */
export function databaseSettings(
  env: ReadonlyMap<string, string> | undefined,
): DatabaseSettings | undefined {
  if (env === undefined) return undefined;
  return {
    host: env.get('POSTGRES_HOST') ?? 'localhost',
    port: env.get('POSTGRES_PORT') ?? '5432',
    user: env.get('POSTGRES_USER') ?? 'postgres',
    password: env.get('POSTGRES_PASSWORD') ?? '',
    database: env.get('POSTGRES_DB') ?? 'appdb',
    ssl: env.get('POSTGRES_SSL') === 'true',
  };
}

const NO_ENVIRONMENT: CheckResult = {
  status: 'skip',
  // Skipped rather than failed: before an install there is no .env to read,
  // and reporting that as a broken database would be misleading.
  detail: 'no environment resolved yet',
};

/** A TCP connect, to separate "unreachable" from "reachable but refused me". */
export async function probeTcp(
  host: string,
  port: number,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<{ ok: boolean; reason: 'refused' | 'timeout' | 'dns' | 'other' | undefined }> {
  return await new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (
      ok: boolean,
      reason: 'refused' | 'timeout' | 'dns' | 'other' | undefined,
    ): void => {
      socket.destroy();
      resolve({ ok, reason });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, undefined));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') return done(false, 'refused');
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return done(false, 'dns');
      done(false, 'other');
    });
  });
}

/**
 * Runs one statement as the configured user.
 *
 * Uses a one-off psql container rather than adding a Postgres client to this
 * package: docker is already a hard prerequisite, the image is small, and it
 * behaves identically on a host with no psql installed.
 */
async function psql(
  context: CheckContext,
  settings: DatabaseSettings,
  database: string,
  statement: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const argv = [
    'docker', 'run', '--rm', '--network', 'host',
    '-e', 'PGPASSWORD',
    '-e', 'PGCONNECT_TIMEOUT=5',
    ...(settings.ssl ? ['-e', 'PGSSLMODE=require'] : []),
    PSQL_IMAGE,
    'psql',
    '-h', settings.host,
    '-p', settings.port,
    '-U', settings.user,
    '-d', database,
    '-tAc', statement,
  ];

  try {
    const result = await context.runCommand(argv, {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      // PGPASSWORD is passed by NAME above and its value only here, so it
      // never appears in an argv that could be logged.
      env: { ...process.env, PGPASSWORD: settings.password },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { result?: { stdout?: string; stderr?: string } };
    return {
      ok: false,
      stdout: (failure.result?.stdout ?? '').trim(),
      stderr:
        (failure.result?.stderr ?? '').trim() ||
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

const databaseReachable: Check = {
  id: 'database-reachable',
  title: 'Database reachable',
  severity: 'required',
  async run(context) {
    const settings = databaseSettings(context.env);
    if (settings === undefined) return NO_ENVIRONMENT;

    const { ok, reason } = await probeTcp(settings.host, Number(settings.port));
    const where = `${settings.host}:${settings.port}`;

    if (ok) return { status: 'pass', detail: where };

    if (reason === 'dns') {
      return {
        status: 'fail',
        detail: `${settings.host} does not resolve`,
        remedy: 'Check POSTGRES_HOST. A private hostname may need this server to use the right resolver.',
      };
    }
    if (reason === 'refused') {
      return {
        status: 'fail',
        detail: `connection refused to ${where}`,
        remedy: 'PostgreSQL is not listening there, or a firewall drops it. Check POSTGRES_PORT and that the server accepts connections from this host.',
      };
    }
    return {
      status: 'fail',
      detail: `no response from ${where} (${reason ?? 'unknown'})`,
      remedy: 'Usually a firewall or security group silently dropping the connection.',
    };
  },
};

const databaseCredentials: Check = {
  id: 'database-credentials',
  title: 'Database credentials',
  severity: 'required',
  requires: ['database-reachable'],
  async run(context) {
    const settings = databaseSettings(context.env);
    if (settings === undefined) return NO_ENVIRONMENT;

    // Against `postgres`, which every cluster has, so a missing application
    // database cannot be mistaken for a rejected password.
    const result = await psql(context, settings, 'postgres', 'select 1');
    if (result.ok) return { status: 'pass', detail: `${settings.user} authenticated` };

    if (/28P01|password authentication failed/i.test(result.stderr)) {
      return {
        status: 'fail',
        detail: `password authentication failed for ${settings.user}`,
        remedy: 'Check POSTGRES_USER and POSTGRES_PASSWORD.',
      };
    }
    if (/no pg_hba\.conf entry/i.test(result.stderr)) {
      return {
        status: 'fail',
        detail: 'rejected by pg_hba.conf',
        remedy: `The server reachable but does not permit ${settings.user} from this host. Add a pg_hba.conf entry for it.`,
      };
    }
    return {
      status: 'fail',
      detail: firstLine(result.stderr),
      remedy: 'Check the POSTGRES_* values against the server.',
    };
  },
};

const databaseExists: Check = {
  id: 'database-exists',
  title: 'Database exists',
  severity: 'required',
  requires: ['database-credentials'],
  async run(context) {
    const settings = databaseSettings(context.env);
    if (settings === undefined) return NO_ENVIRONMENT;

    const result = await psql(context, settings, settings.database, 'select 1');
    if (result.ok) return { status: 'pass', detail: settings.database };

    if (/3D000|database ".*" does not exist/i.test(result.stderr)) {
      return {
        status: 'fail',
        detail: `database "${settings.database}" does not exist`,
        remedy: `Create it: createdb -h ${settings.host} -U ${settings.user} ${settings.database}. Migrations create tables, never the database itself.`,
      };
    }
    return {
      status: 'fail',
      detail: firstLine(result.stderr),
      remedy: `Check POSTGRES_DB.`,
    };
  },
};

const databasePrivileges: Check = {
  id: 'database-privileges',
  title: 'Can create tables',
  severity: 'recommended',
  requires: ['database-exists'],
  async run(context) {
    const settings = databaseSettings(context.env);
    if (settings === undefined) return NO_ENVIRONMENT;

    const result = await psql(
      context,
      settings,
      settings.database,
      "select has_schema_privilege(current_user, 'public', 'CREATE')",
    );

    if (!result.ok) {
      return {
        status: 'warn',
        detail: 'could not determine privileges',
        remedy: 'Migrations will tell you for certain; this is only a preflight.',
      };
    }
    return result.stdout.startsWith('t')
      ? { status: 'pass', detail: `${settings.user} can create tables` }
      : {
          status: 'warn',
          detail: `${settings.user} cannot create in schema public`,
          remedy: `Migrations will fail. Grant it: GRANT CREATE ON SCHEMA public TO ${settings.user};`,
        };
  },
};

const databaseSsl: Check = {
  id: 'database-ssl',
  title: 'Database TLS',
  severity: 'recommended',
  requires: ['database-credentials'],
  async run(context) {
    const settings = databaseSettings(context.env);
    if (settings === undefined) return NO_ENVIRONMENT;

    if (!settings.ssl) {
      return {
        status: 'skip',
        detail: 'POSTGRES_SSL is not true',
      };
    }

    const result = await psql(
      context,
      settings,
      'postgres',
      'select ssl from pg_stat_ssl where pid = pg_backend_pid()',
    );

    if (!result.ok) {
      return {
        status: 'warn',
        detail: 'TLS was requested but the connection failed',
        remedy: firstLine(result.stderr) || 'Check that the server offers TLS.',
      };
    }
    return result.stdout.startsWith('t')
      ? { status: 'pass', detail: 'negotiated' }
      : {
          status: 'warn',
          detail: 'POSTGRES_SSL is true but the session is not encrypted',
          remedy: 'The server accepted a plaintext connection. Require TLS server-side, or the setting is giving false assurance.',
        };
  },
};

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? 'failed';
}

export const DATABASE_CHECKS: readonly Check[] = [
  databaseReachable,
  databaseCredentials,
  databaseExists,
  databasePrivileges,
  databaseSsl,
];
