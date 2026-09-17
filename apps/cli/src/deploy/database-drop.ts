import { databaseSettings, runPsql, type DatabaseSettings } from './checks/database.js';
import { databaseNameProblem, quoteIdentifier } from './database-create.js';
import type { CheckContext } from './checks/types.js';

// =============================================================================
// Dropping the database, once and only when asked  (issue #268)
// =============================================================================
//
// `database-create.ts` (#238) ends on a line this file has to answer for:
//
//     "There is no DROP here and there never will be. Creating an empty
//      database is recoverable by deleting it; the inverse is not."
//
// That sentence is still correct about `install`, and it is why this is a
// SEPARATE MODULE reached only from `uninstall --drop-database` behind a typed
// confirmation of the database's own name. The asymmetry it describes is
// exactly why the two live apart: the create is offered automatically when a
// check fails, and this one can never be offered - it has to be asked for, by
// name, by somebody who has already been shown what is in the database.
//
// `docs/specs/vps-deploy.md`'s "deploy validates the database, never creates
// or manages it" therefore now has a SECOND explicit exception, recorded in
// §21 beside #238's, rather than left to drift.
//
// WHY `postgres` AND NOT THE TARGET
//
// The same reason `createDatabase` gives, inverted: `DROP DATABASE` cannot run
// from inside the database being dropped. `postgres` is also the database
// `database-credentials` already authenticated against, so no new reachability
// assumption is introduced.
//
// THE SAME ONE-OFF `psql` CONTAINER, THROUGH `runPsql`. Not a second
// invocation: `runPsql` is where the image, the timeout, the SSL handling and
// - most importantly - the rule that PGPASSWORD is passed BY NAME and never in
// an argv all live. Two copies of that is how a connection string ends up in
// a journal.
//
// -----------------------------------------------------------------------------
// TERMINATING OTHER SESSIONS: THE DECISION, AND THE ARGUMENT FOR IT
// -----------------------------------------------------------------------------
//
// `DROP DATABASE` fails with 55006 while ANY session is connected. `uninstall`
// brings this app's containers down first, so the ordinary case is clean - but
// a psql left open in another terminal, a pooler, a colleague's GUI, a second
// replica of the app on another host, all block it, and the operator is left
// staring at `ERROR: database is being accessed by other users` with no idea
// which of those it was.
//
// `pg_terminate_backend` fixes that, and it is a WRITE AGAINST SESSIONS THAT
// ARE NOT OURS - the reason this needs an argument rather than a shrug. The
// shape chosen:
//
//   1. TRY THE PLAIN DROP FIRST. In the ordinary case nothing is connected and
//      NO SESSION IS EVER TOUCHED. Termination is not part of the happy path;
//      it is the specific remedy for one specific failure.
//   2. ONLY ON 55006, terminate - scoped by `WHERE datname = <this database>
//      AND pid <> pg_backend_pid()`. Never a bare terminate-all: the operator
//      authorised destroying ONE database, and a session against a DIFFERENT
//      database is not theirs to end.
//   3. REPORT HOW MANY WERE ENDED, in the result and in the run log. An
//      operator who learns after the fact that something was killed on their
//      server has been badly served, even when it was the right call.
//
// Why terminating is defensible at all: by the time step 2 runs, the operator
// has typed this database's own name to authorise its destruction. A session
// connected to a database that is about to cease existing cannot lose anything
// the drop was not already going to destroy - its transaction dies either way,
// three seconds later. The alternative - report and give up - leaves a
// half-uninstalled deployment and hands the operator the identical manual step
// with less information than this file already has.
//
// Why NOT `DROP DATABASE ... WITH (FORCE)`, which does the same thing in one
// statement: it is PostgreSQL 13+, and this deployment's database is
// operator-supplied and may be older - where it fails as a syntax error that
// says nothing about connections. It is also SILENT about what it killed,
// which is the one thing step 3 exists to avoid.
// =============================================================================

/** PostgreSQL's `object_in_use`, plus the English it comes wrapped in. */
const IN_USE_PATTERN = /55006|is being accessed by other users/i;

/** `invalid_catalog_name` - it is already gone, which is the asked-for state. */
const MISSING_PATTERN = /3D000|database ".*" does not exist/i;

export interface DatabaseDropTarget {
  settings: DatabaseSettings;
  /** One line naming what would be dropped and where, for the confirmation. */
  description: string;
}

/**
 * The database this deployment used, from its own `.env`, or `undefined`.
 *
 * Read BEFORE anything is deleted, for `dropDatabaseCommand`'s reason: once
 * the deploy root is gone nothing on the server knows which database this
 * deployment used.
 */
export function droppableDatabase(
  env: ReadonlyMap<string, string> | undefined,
): DatabaseDropTarget | undefined {
  const settings = databaseSettings(env);
  if (settings === undefined) return undefined;
  if (settings.database === '') return undefined;
  return {
    settings,
    description: `${settings.database} on ${settings.host}:${settings.port} as ${settings.user}`,
  };
}

export interface DatabaseFacts {
  database: string;
  host: string;
  port: string;
  user: string;
  /** `pg_database_size`, pretty-printed, or undefined when it could not be read. */
  size?: string | undefined;
  /** Sessions connected to this database right now, excluding our own. */
  connections?: number | undefined;
  /** Set when the database could not be reached or does not exist. */
  problem?: string | undefined;
}

/**
 * What is there, read before any confirmation is asked for.
 *
 * ⚠ READ-ONLY, and it must stay that way. This is the "inventory before
 * consent" half of the issue's requirement 2, and it runs on a deployment the
 * operator may still decide to keep - `--dry-run` calls it too. Nothing here
 * creates, drops, renames or terminates.
 *
 * Every field is optional because every one of them can be unavailable on a
 * perfectly ordinary managed server: `pg_database_size` needs CONNECT on the
 * database, and `pg_stat_activity` shows other users' rows only to a role with
 * `pg_read_all_stats` or superuser. A missing number is reported as missing,
 * never as zero - "0 connections" that actually means "I could not see them"
 * is precisely the reassurance that gets an operator to consent.
 */
export async function databaseFacts(
  context: Pick<CheckContext, 'runCommand'>,
  settings: DatabaseSettings,
): Promise<DatabaseFacts> {
  const facts: DatabaseFacts = {
    database: settings.database,
    host: settings.host,
    port: settings.port,
    user: settings.user,
  };

  const checkContext = asCheckContext(context);

  const size = await runPsql(
    checkContext,
    settings,
    'postgres',
    `select pg_size_pretty(pg_database_size(${literal(settings.database)}))`,
  );
  if (size.ok && size.stdout !== '') {
    facts.size = size.stdout;
  } else if (!size.ok && MISSING_PATTERN.test(size.stderr)) {
    facts.problem = `${settings.database} does not exist on ${settings.host}:${settings.port}`;
    return facts;
  } else if (!size.ok) {
    facts.problem = firstLine(size.stderr);
    return facts;
  }

  const connections = await runPsql(
    checkContext,
    settings,
    'postgres',
    `select count(*) from pg_stat_activity where datname = ${literal(settings.database)} and pid <> pg_backend_pid()`,
  );
  if (connections.ok && /^\d+$/.test(connections.stdout)) {
    facts.connections = Number(connections.stdout);
  }

  return facts;
}

export type DatabaseDropOutcome =
  | {
      readonly ok: true;
      readonly detail: string;
      /** Sessions ended to make the drop possible. Zero on the ordinary path. */
      readonly terminated: number;
    }
  | { readonly ok: false; readonly detail: string; readonly remedy: string };

/**
 * Drops the database. See the header for the termination argument.
 *
 * The name is validated by `databaseNameProblem` and quoted by
 * `quoteIdentifier` - `database-create.ts`'s own pair, reused rather than
 * restated, because "correct-looking quoting decays when someone builds a
 * second statement beside it" is exactly what this file is.
 */
export async function dropDatabase(
  context: Pick<CheckContext, 'runCommand'>,
  settings: DatabaseSettings,
): Promise<DatabaseDropOutcome> {
  const manual = `dropdb -h ${settings.host} -p ${settings.port} -U ${settings.user} ${settings.database}`;

  const problem = databaseNameProblem(settings.database);
  if (problem !== undefined) {
    return {
      ok: false,
      detail: `cannot drop "${settings.database}": ${problem}`,
      remedy: `Drop it yourself: ${manual}`,
    };
  }

  const checkContext = asCheckContext(context);
  const statement = `DROP DATABASE ${quoteIdentifier(settings.database)}`;

  // Step 1: the plain drop. Nothing else's session is touched on this path.
  const first = await runPsql(checkContext, settings, 'postgres', statement);
  if (first.ok) return { ok: true, detail: `dropped ${settings.database}`, terminated: 0 };

  if (MISSING_PATTERN.test(first.stderr)) {
    // Already gone. That is the state that was asked for, and reporting a
    // failure would send the operator to fix something that is already right -
    // `createDatabase`'s treatment of 42P04, mirrored.
    return { ok: true, detail: `${settings.database} was already gone`, terminated: 0 };
  }

  if (!IN_USE_PATTERN.test(first.stderr)) {
    return { ...classify(first.stderr, settings, manual) };
  }

  // Step 2: something is connected. Scoped termination, then one retry.
  const terminate = await runPsql(
    checkContext,
    settings,
    'postgres',
    'select count(*) from (select pg_terminate_backend(pid) from pg_stat_activity ' +
      `where datname = ${literal(settings.database)} and pid <> pg_backend_pid()) as ended`,
  );

  if (!terminate.ok) {
    return {
      ok: false,
      detail:
        `${settings.database} is in use and ${settings.user} may not end the sessions holding it ` +
        `(${firstLine(terminate.stderr)})`,
      remedy:
        `Close whatever is connected - another psql, a pooler, a second copy of this app - then: ${manual}. ` +
        `To see them: psql -h ${settings.host} -p ${settings.port} -U ${settings.user} -d postgres ` +
        `-c "select pid, usename, application_name, client_addr from pg_stat_activity where datname = '${settings.database}'"`,
    };
  }

  const terminated = /^\d+$/.test(terminate.stdout) ? Number(terminate.stdout) : 0;

  const second = await runPsql(checkContext, settings, 'postgres', statement);
  if (second.ok) {
    return {
      ok: true,
      detail:
        `dropped ${settings.database} after ending ${terminated} open session(s) against it`,
      terminated,
    };
  }
  if (MISSING_PATTERN.test(second.stderr)) {
    return { ok: true, detail: `${settings.database} was already gone`, terminated };
  }

  if (IN_USE_PATTERN.test(second.stderr)) {
    // Something reconnected between the terminate and the retry - a pooler or
    // a supervised process restarting. Said plainly, because "it is in use"
    // twice in a row means something is actively holding it open, and a third
    // attempt would race the same way.
    return {
      ok: false,
      detail: `${settings.database} is still in use: ${terminated} session(s) were ended and something reconnected immediately`,
      remedy:
        'A connection pooler or a supervised process is reconnecting. Stop it first, then: ' +
        manual,
    };
  }

  return { ...classify(second.stderr, settings, manual) };
}

function classify(
  stderr: string,
  settings: DatabaseSettings,
  manual: string,
): { ok: false; detail: string; remedy: string } {
  if (/permission denied|must be (the )?(owner|superuser)|42501/i.test(stderr)) {
    return {
      ok: false,
      detail: `${settings.user} may not drop ${settings.database} on this server`,
      remedy: `It must own the database, or an administrator must run: ${manual}`,
    };
  }
  return {
    ok: false,
    detail: firstLine(stderr),
    remedy: `Drop it yourself: ${manual}`,
  };
}

/**
 * A single-quoted SQL string literal.
 *
 * ⚠ Used for the database name inside `pg_database_size(...)` and the
 * `pg_stat_activity` filters, where it is a VALUE rather than an identifier -
 * `quoteIdentifier` would produce `"appdb"`, which PostgreSQL reads as a
 * column. The name has already been through `databaseNameProblem` on the drop
 * path, but the read path above runs before any validation, so this doubles
 * embedded quotes rather than assuming there are none.
 */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `runPsql` takes a full `CheckContext` and reads exactly one field of it.
 *
 * Filled in here rather than widening `runPsql`'s signature: `checks/` is the
 * doctor's registry and its types are its own, and this module is not a check
 * (see the header, and `database-create.ts`'s "why this is not a check"). The
 * three other fields are inert - nothing on this path reads a deploy root, a
 * bind port or a proxy root.
 */
function asCheckContext(context: Pick<CheckContext, 'runCommand'>): CheckContext {
  return {
    runCommand: context.runCommand,
    deployRoot: '',
    bindPort: 0,
    proxyRoot: '',
  };
}

function firstLine(value: string): string {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, 200);
  }
  return 'no output';
}

/** The facts, as the lines shown BEFORE the confirmation is asked for. */
export function describeDatabase(facts: DatabaseFacts): string[] {
  const lines = [
    `Database ${facts.database} on ${facts.host}:${facts.port} as ${facts.user}`,
  ];
  if (facts.problem !== undefined) {
    lines.push(`Could not read it: ${facts.problem}`);
    return lines;
  }
  lines.push(`  Size        ${facts.size ?? 'could not be read'}`);
  lines.push(
    `  Sessions    ${
      facts.connections === undefined
        ? `could not be read (${facts.user} may not see other roles' sessions)`
        : `${facts.connections} other connection(s) open right now`
    }`,
  );
  if (facts.connections !== undefined && facts.connections > 0) {
    lines.push(
      '  Those sessions are ended before the drop, scoped to this database only.',
    );
  }
  return lines;
}
