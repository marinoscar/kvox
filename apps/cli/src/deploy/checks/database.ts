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
//
// WHY pgvector IS A PREFLIGHT AND NOT A MIGRATION CONCERN  (issue #179, epic #165)
//
// Semantic search needs the `vector` extension, and `vector` is NOT a trusted
// extension in PG16: `CREATE EXTENSION vector` needs a superuser, or at least a
// role the extension's control file permits. `docs/specs/vps-deploy.md` locks in
// operator-supplied external PostgreSQL - "deploy validates it, never creates or
// manages it" - so this server may well be handed a database on a role that
// cannot install anything.
//
// Without this check that operator loses the deploy of the WHOLE application
// over one feature, and loses it in the worst possible place: mid-`prisma
// migrate deploy`, as a Prisma stack trace with no remedy in it, after the
// repository has been cloned and .env written. `database-vector-extension` moves
// that to the one moment it is cheap - before anything has been changed - and
// answers it with a command to paste.
//
// REJECTED: wrapping `CREATE EXTENSION` in a `DO` block that skips when the
// extension is absent. It is the tempting fix and it is the wrong one. It turns
// a loud, fixable, pre-deploy refusal into permanent PER-DEPLOYMENT SCHEMA
// DRIFT, which every search query then has to probe for at runtime, forever.
// "Layer 1 (full-text search) applied, layer 2 (pgvector) refused" is a state
// you can diagnose and fix; "some deployments have these three tables and some
// don't" is not.
// =============================================================================

/**
 * The image this check borrows a `psql` CLIENT from — pinned to PostgreSQL 16,
 * the major this repository targets.
 *
 * ⚠ DELIBERATELY NOT `pgvector/pgvector:pg16`, which is what CI and the two
 * local compose overlays now run (issue #178, epic #165). Nothing here needs
 * the `vector` extension: `vector` is a SERVER-side control file, so whether it
 * is available is a fact about the operator's database, never about the client
 * that connects to it. Pulling ~180 MB more onto a VPS to run `psql -c 'select
 * 1'` would buy nothing. The sibling extension preflight asks the server, using
 * this same small client.
 */
const PSQL_IMAGE = 'postgres:16-alpine';

const CONNECT_TIMEOUT_MS = 5_000;

export interface DatabaseSettings {
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
 * Exported for `database-create.ts` (#238), which issues the one statement in
 * this CLI that is not a check. It reuses this rather than building a second
 * psql invocation, so the container, the timeout, the SSL handling and - most
 * importantly - the rule that PGPASSWORD is passed BY NAME and never appears
 * in an argv stay in exactly one place.
 *
 * Uses a one-off psql container rather than adding a Postgres client to this
 * package: docker is already a hard prerequisite, the image is small, and it
 * behaves identically on a host with no psql installed.
 */
export async function runPsql(
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
    const result = await runPsql(context, settings, 'postgres', 'select 1');
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

    const result = await runPsql(context, settings, settings.database, 'select 1');
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

    const result = await runPsql(
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

/**
 * The remedy, which is a command and not a category (types.ts rule 2).
 *
 * Three things in this order, because that is the order the operator has to do
 * them in: the statement, the server-side package the statement needs to exist
 * first, and how much of the application is actually blocked - so nobody tears
 * down a working deployment over a feature they may not be using yet.
 */
function vectorRemedy(settings: DatabaseSettings, privilegeOnly: boolean): string {
  const install =
    `As a superuser, against ${settings.database}: CREATE EXTENSION vector;` +
    ` (psql -h ${settings.host} -p ${settings.port} -d ${settings.database}` +
    ` -c 'CREATE EXTENSION vector;')`;

  const packaged = privilegeOnly
    ? ''
    : ' That statement needs the server-side package installed first, on the' +
      ' machine PostgreSQL runs on: Debian/Ubuntu `apt install' +
      ' postgresql-16-pgvector` (no server restart needed). RDS, Cloud SQL and' +
      ' Azure Database for PostgreSQL all ship it already - there it only needs' +
      ' enabling, not installing.';

  return (
    `${install}.${packaged}` +
    ' This blocks semantic search only; nothing else in the application uses it.'
  );
}

/**
 * Can this database provide `vector`?  (issue #179, epic #165)
 *
 * `required`, and deliberately not `recommended` - see types.ts rule 3. This is
 * not advice. If the extension cannot be provided the migration WILL abort, so
 * reporting it as a warning would have doctor say "you're fine" and then have
 * install fail anyway, which is the exact failure this check exists to move
 * earlier. The file header above says why the migration is not softened instead.
 *
 * TWO PROBES, IN THIS ORDER, AND THE ORDER MATTERS:
 *
 *   1. ALREADY INSTALLED wins outright, whatever the connecting role may or may
 *      not be allowed to do. That is the ordinary managed-PostgreSQL case - an
 *      administrator ran CREATE EXTENSION once, out of band, and the application
 *      role has never been able to and never needs to. A check that only asked
 *      "can you install it?" would fail a perfectly working deployment.
 *   2. AVAILABLE TO INSTALL is the next-best answer; the migration itself runs
 *      `CREATE EXTENSION IF NOT EXISTS vector` and will do it.
 */
const databaseVectorExtension: Check = {
  id: 'database-vector-extension',
  title: 'pgvector available',
  severity: 'required',
  requires: ['database-exists'],
  async run(context) {
    const settings = databaseSettings(context.env);
    if (settings === undefined) return NO_ENVIRONMENT;

    // Probe 1. One statement answers both "installed?" and "which version",
    // so the pass can name it rather than just asserting it.
    const installed = await runPsql(
      context,
      settings,
      settings.database,
      "select extversion from pg_extension where extname = 'vector'",
    );
    if (!installed.ok) return catalogueUnreadable(installed.stderr);
    if (installed.stdout !== '') {
      return {
        status: 'pass',
        detail: `vector ${installed.stdout} installed in ${settings.database}`,
      };
    }

    // Probe 2.
    const available = await runPsql(
      context,
      settings,
      settings.database,
      "select default_version from pg_available_extensions where name = 'vector'",
    );
    if (!available.ok) return catalogueUnreadable(available.stderr);
    if (available.stdout === '') {
      return {
        status: 'fail',
        detail: `the server offers no vector extension to ${settings.database}`,
        remedy: vectorRemedy(settings, false),
      };
    }

    // Available, not installed - so somebody still has to run the statement,
    // and the connecting role may not be allowed to. ASYMMETRY ON PURPOSE:
    // "not a superuser" is a WARN, not a FAIL, because superuser is not the
    // only way a role may create an extension (a role the control file permits,
    // or a managed provider's own grant, both work and neither shows up in
    // pg_roles.rolsuper). Refusing outright would be wrong; saying nothing
    // would be worse, because this is the one remaining way the migration can
    // still abort after this check has passed.
    const privileged = await runPsql(
      context,
      settings,
      settings.database,
      'select rolsuper from pg_roles where rolname = current_user',
    );
    if (privileged.ok && privileged.stdout.startsWith('t')) {
      return {
        status: 'pass',
        detail: `vector ${available.stdout} available, not yet installed`,
      };
    }
    return {
      status: 'warn',
      detail: privileged.ok
        ? `vector ${available.stdout} available, but ${settings.user} is not a superuser`
        : `vector ${available.stdout} available; could not tell whether ${settings.user} may create it`,
      remedy: vectorRemedy(settings, true),
    };
  },
};

/**
 * An unreadable catalogue is a `warn`, never a `fail` - the same call
 * `databasePrivileges` makes. Not being able to ASK the question is not an
 * answer to it, and the migration will settle it for certain either way.
 */
function catalogueUnreadable(stderr: string): CheckResult {
  return {
    status: 'warn',
    detail: 'could not read the extension catalogue',
    remedy:
      `Migrations will tell you for certain; this is only a preflight. ` +
      `If they fail, install pgvector: CREATE EXTENSION vector; (${firstLine(stderr)})`,
  };
}

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

    const result = await runPsql(
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
  databaseVectorExtension,
  databaseSsl,
];
